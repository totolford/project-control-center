//! AI usage accounting: one record per real AI request NEXUS makes or
//! observes, the parsers that turn provider payloads into records, a small
//! API price table for labelled estimates, and period aggregation.
//!
//! Nothing here invents numbers: a field the provider does not expose stays
//! `None` (shown "N/A"). Costs are either reported by the provider (Claude
//! Code's `total_cost_usd` / `modelUsage.costUSD`), estimated from the price
//! table (always labelled), or zero for work served by a local runtime.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Usage categories of the AI Usage page.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum UsageCategory {
    /// AI World text: characters, plans, townspeople.
    AiWorld,
    /// Conversations between world characters.
    AgentConversation,
    /// Worker agents working on a task.
    ProductionAgent,
    CentralAgent,
    /// Worker turns without a task and NEXUS's own one-shot calls (mission analysis...).
    #[default]
    BackgroundAgent,
    Embedding,
}

impl UsageCategory {
    pub const ALL: [UsageCategory; 6] = [
        UsageCategory::AiWorld,
        UsageCategory::AgentConversation,
        UsageCategory::ProductionAgent,
        UsageCategory::CentralAgent,
        UsageCategory::BackgroundAgent,
        UsageCategory::Embedding,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            UsageCategory::AiWorld => "ai_world",
            UsageCategory::AgentConversation => "agent_conversation",
            UsageCategory::ProductionAgent => "production_agent",
            UsageCategory::CentralAgent => "central_agent",
            UsageCategory::BackgroundAgent => "background_agent",
            UsageCategory::Embedding => "embedding",
        }
    }

    pub fn parse(s: &str) -> UsageCategory {
        UsageCategory::ALL.into_iter().find(|c| c.as_str() == s).unwrap_or_default()
    }
}

/// Where a record's cost comes from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CostSource {
    /// Reported by the provider (Claude Code).
    Reported,
    /// Computed from [`PRICES`]; never a measured amount.
    Estimated,
    /// Served by a local runtime: no money spent.
    Local,
    /// The provider reported no cost.
    #[default]
    Unknown,
}

impl CostSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CostSource::Reported => "reported",
            CostSource::Estimated => "estimated",
            CostSource::Local => "local",
            CostSource::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> CostSource {
        match s {
            "reported" => CostSource::Reported,
            "estimated" => CostSource::Estimated,
            "local" => CostSource::Local,
            _ => CostSource::Unknown,
        }
    }
}

/// One AI request (or one Claude Code turn, per model).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageRecord {
    /// 0 until stored.
    pub id: i64,
    pub ts: String,
    /// `claude`, or the local runtime (`ollama`, `lmstudio`, `llamacpp`, `openai`).
    pub provider: String,
    pub model: Option<String>,
    pub agent_id: Option<String>,
    pub mission_id: Option<String>,
    pub task_id: Option<String>,
    pub category: UsageCategory,
    /// What made the request: `session`, `mission-analysis`, `ai-world`, ...
    pub source: String,
    /// Uncached input tokens.
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Input + cache creation + cache reads + output, when any of them is known.
    pub total_tokens: Option<u64>,
    /// Input tokens served from the prompt cache.
    pub cached_tokens: Option<u64>,
    /// Input tokens written to the prompt cache.
    pub cache_creation_tokens: Option<u64>,
    /// Not exposed by Claude Code nor Ollama: usually `None`.
    pub reasoning_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub cost_source: CostSource,
    /// Wall-clock duration of the request / turn.
    pub latency_ms: Option<u64>,
    /// Served by a local runtime on this PC.
    pub local: bool,
    /// ModelRouter rule that sent the request where it ran, when routed.
    pub route_rule: Option<String>,
}

impl UsageRecord {
    pub fn new(provider: impl Into<String>, category: UsageCategory, source: impl Into<String>) -> Self {
        Self { ts: crate::now(), provider: provider.into(), category, source: source.into(), ..Default::default() }
    }

    /// Sets the token fields and derives `total_tokens`.
    pub fn tokens(
        mut self,
        input: Option<u64>,
        output: Option<u64>,
        cache_read: Option<u64>,
        cache_write: Option<u64>,
    ) -> Self {
        self.input_tokens = input;
        self.output_tokens = output;
        self.cached_tokens = cache_read;
        self.cache_creation_tokens = cache_write;
        let parts = [input, output, cache_read, cache_write];
        self.total_tokens = parts.iter().any(Option::is_some).then(|| parts.iter().flatten().sum());
        self
    }

    /// A local request: no money spent, whatever the runtime reports.
    pub fn local_run(mut self) -> Self {
        self.local = true;
        self.cost_usd = Some(0.0);
        self.cost_source = CostSource::Local;
        self
    }

    pub fn with_cost(mut self, reported: Option<f64>) -> Self {
        if self.local {
            return self;
        }
        self.cost_usd = reported;
        self.cost_source = if reported.is_some() { CostSource::Reported } else { CostSource::Unknown };
        self
    }

    pub fn agent(mut self, agent: Option<&str>, mission: Option<&str>, task: Option<&str>) -> Self {
        self.agent_id = agent.map(str::to_string);
        self.mission_id = mission.map(str::to_string);
        self.task_id = task.map(str::to_string);
        self
    }

    /// Tokens that count for "tokens processed" figures.
    pub fn token_count(&self) -> u64 {
        self.total_tokens.unwrap_or(0)
    }
}

// ---------------------------------------------------------------- sink

type Sink = Arc<dyn Fn(UsageRecord) + Send + Sync>;

static SINK: RwLock<Option<Sink>> = RwLock::new(None);

/// Installs where records made outside the engine (one-shot calls in other
/// crates) are written: the open project's store. `None` removes it.
pub fn set_sink(sink: Option<Sink>) {
    if let Ok(mut s) = SINK.write() {
        *s = sink;
    }
}

/// Records a request. Without a sink (no project open) there is nowhere to
/// keep it and it is dropped.
pub fn record(r: UsageRecord) {
    let sink = SINK.read().ok().and_then(|s| s.clone());
    if let Some(f) = sink {
        f(r);
    }
}

// ---------------------------------------------------------------- Claude Code

fn u(v: &Value, k: &str) -> Option<u64> {
    v.get(k).and_then(Value::as_u64)
}

/// Cumulative counters of one model inside a Claude Code process.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ModelCounters {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: Option<f64>,
}

impl ModelCounters {
    fn minus(&self, prev: &ModelCounters) -> Option<ModelCounters> {
        // A counter going down means a new process: the new values are the delta.
        if self.input < prev.input
            || self.output < prev.output
            || self.cache_read < prev.cache_read
            || self.cache_write < prev.cache_write
        {
            return Some(*self);
        }
        let d = ModelCounters {
            input: self.input - prev.input,
            output: self.output - prev.output,
            cache_read: self.cache_read - prev.cache_read,
            cache_write: self.cache_write - prev.cache_write,
            cost_usd: match (self.cost_usd, prev.cost_usd) {
                (Some(a), Some(b)) => Some((a - b).max(0.0)),
                (a, _) => a,
            },
        };
        (d.input + d.output + d.cache_read + d.cache_write > 0 || d.cost_usd.is_some_and(|c| c > 0.0)).then_some(d)
    }
}

/// Usage fields of a Claude Code `result` message (stream-json or `-p --output-format json`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClaudeResultUsage {
    /// `modelUsage`: cumulative per model for the whole process.
    pub models: BTreeMap<String, ModelCounters>,
    /// `usage` block (used only when `modelUsage` is absent).
    pub usage: Option<ModelCounters>,
    /// Cumulative for the process.
    pub total_cost_usd: Option<f64>,
    /// Wall-clock time of this turn.
    pub duration_ms: Option<u64>,
}

/// Reads the usage fields of a `{"type":"result",...}` message. `None` for other messages.
pub fn parse_claude_result(v: &Value) -> Option<ClaudeResultUsage> {
    if v.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    let models = v
        .get("modelUsage")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(name, c)| {
                    (
                        name.clone(),
                        ModelCounters {
                            input: u(c, "inputTokens").unwrap_or(0),
                            output: u(c, "outputTokens").unwrap_or(0),
                            cache_read: u(c, "cacheReadInputTokens").unwrap_or(0),
                            cache_write: u(c, "cacheCreationInputTokens").unwrap_or(0),
                            cost_usd: c.get("costUSD").and_then(Value::as_f64),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let usage = v.get("usage").filter(|x| x.is_object()).map(|x| ModelCounters {
        input: u(x, "input_tokens").unwrap_or(0),
        output: u(x, "output_tokens").unwrap_or(0),
        cache_read: u(x, "cache_read_input_tokens").unwrap_or(0),
        cache_write: u(x, "cache_creation_input_tokens").unwrap_or(0),
        cost_usd: None,
    });
    Some(ClaudeResultUsage {
        models,
        usage,
        total_cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
        duration_ms: u(v, "duration_ms"),
    })
}

/// One model's share of a turn.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnShare {
    pub model: Option<String>,
    pub counters: ModelCounters,
}

/// Turns the cumulative counters of a long-lived Claude Code session into per-turn deltas.
#[derive(Debug, Clone, Default)]
pub struct ClaudeSessionTracker {
    models: HashMap<String, ModelCounters>,
    total_cost: f64,
}

impl ClaudeSessionTracker {
    /// Per-model usage of the turn that just ended. `fallback_model` names the
    /// session model when the message has no `modelUsage`.
    pub fn turn(&mut self, r: &ClaudeResultUsage, fallback_model: Option<&str>) -> Vec<TurnShare> {
        let turn_cost = r.total_cost_usd.map(|c| if c >= self.total_cost { c - self.total_cost } else { c });
        if let Some(c) = r.total_cost_usd {
            self.total_cost = c;
        }
        if r.models.is_empty() {
            // No per-model counters: the `usage` block, as reported for this result.
            let Some(mut c) = r.usage else { return Vec::new() };
            c.cost_usd = turn_cost;
            return vec![TurnShare { model: fallback_model.map(str::to_string), counters: c }];
        }
        let mut out = Vec::new();
        for (name, now) in &r.models {
            let prev = self.models.get(name).copied().unwrap_or_default();
            if let Some(d) = now.minus(&prev) {
                out.push(TurnShare { model: Some(name.clone()), counters: d });
            }
            self.models.insert(name.clone(), *now);
        }
        // Without per-model costs, the turn's total cost goes to the first model.
        if out.iter().all(|s| s.counters.cost_usd.is_none()) {
            if let Some(first) = out.first_mut() {
                first.counters.cost_usd = turn_cost;
            }
        }
        out
    }
}

/// Records of a one-shot `claude -p --output-format json` answer (one per model used).
pub fn oneshot_records(v: &Value, category: UsageCategory, source: &str, model: Option<&str>) -> Vec<UsageRecord> {
    let Some(r) = parse_claude_result(v) else { return Vec::new() };
    let shares = ClaudeSessionTracker::default().turn(&r, model);
    shares
        .into_iter()
        .map(|s| {
            let mut rec = UsageRecord::new("claude", category, source)
                .tokens(
                    Some(s.counters.input),
                    Some(s.counters.output),
                    Some(s.counters.cache_read),
                    Some(s.counters.cache_write),
                )
                .with_cost(s.counters.cost_usd);
            rec.model = s.model;
            rec.latency_ms = r.duration_ms;
            rec
        })
        .collect()
}

// ---------------------------------------------------------------- local runtimes

/// Ollama `/api/chat` or `/api/generate` final message: `prompt_eval_count`,
/// `eval_count`, `total_duration` (ns).
pub fn ollama_record(v: &Value, category: UsageCategory, source: &str) -> UsageRecord {
    let mut r = UsageRecord::new("ollama", category, source)
        .tokens(u(v, "prompt_eval_count"), u(v, "eval_count"), None, None)
        .local_run();
    r.model = v.get("model").and_then(Value::as_str).map(str::to_string);
    r.latency_ms = u(v, "total_duration").map(|ns| ns / 1_000_000);
    r
}

/// OpenAI-compatible chat completion or embeddings response (`usage` block).
pub fn openai_record(v: &Value, runtime: &str, category: UsageCategory, source: &str) -> UsageRecord {
    let us = &v["usage"];
    let input = u(us, "prompt_tokens");
    let output = u(us, "completion_tokens");
    let cached = us.pointer("/prompt_tokens_details/cached_tokens").and_then(Value::as_u64);
    // OpenAI counts cached tokens inside prompt_tokens: keep the uncached part as input.
    let uncached = match (input, cached) {
        (Some(i), Some(c)) => Some(i.saturating_sub(c)),
        (i, _) => i,
    };
    let mut r = UsageRecord::new(runtime, category, source).tokens(uncached, output, cached, None).local_run();
    if r.total_tokens.is_none() {
        r.total_tokens = u(us, "total_tokens");
    }
    r.reasoning_tokens = us.pointer("/completion_tokens_details/reasoning_tokens").and_then(Value::as_u64);
    r.model = v.get("model").and_then(Value::as_str).map(str::to_string);
    r
}

// ---------------------------------------------------------------- prices

/// List price of a Claude model family, USD per million tokens.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    /// Substring matched against the model id (first match wins).
    pub pattern: &'static str,
    pub label: &'static str,
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

/// Where [`PRICES`] come from. Estimates only; Claude Code's reported cost wins.
pub const PRICE_SOURCE: &str =
    "Anthropic API list prices (platform.claude.com/docs pricing), checked 2026-09-25; cache writes = 1.25 x input (5-minute TTL)";

const fn p(pattern: &'static str, label: &'static str, input: f64, output: f64, cache_read: f64) -> Price {
    Price { pattern, label, input, output, cache_write: input * 1.25, cache_read }
}

pub const PRICES: &[Price] = &[
    p("fable", "Claude Fable 5 / 5.1", 10.0, 50.0, 0.25),
    p("mythos", "Claude Mythos 5 / 5.1", 10.0, 50.0, 0.25),
    p("opus-5-5", "Claude Opus 5.5", 4.0, 20.0, 0.20),
    p("opus-4-1", "Claude Opus 4.1", 15.0, 75.0, 1.50),
    p("opus-4-0", "Claude Opus 4", 15.0, 75.0, 1.50),
    p("opus-4-2", "Claude Opus 4", 15.0, 75.0, 1.50),
    p("opus", "Claude Opus 5 / 4.5-4.8", 5.0, 25.0, 0.50),
    p("sonnet-5", "Claude Sonnet 5 / 5.5", 2.0, 10.0, 0.20),
    p("sonnet", "Claude Sonnet 4.x", 3.0, 15.0, 0.30),
    p("haiku-4", "Claude Haiku 4.5", 1.0, 5.0, 0.10),
    p("haiku", "Claude Haiku 3.5", 0.8, 4.0, 0.08),
];

/// Reference model for "money avoided" estimates (the current Sonnet).
pub const AVOIDED_REFERENCE_MODEL: &str = "claude-sonnet-5-5";

pub fn price_for(model: &str) -> Option<&'static Price> {
    let m = model.to_ascii_lowercase();
    PRICES.iter().find(|p| m.contains(p.pattern))
}

/// Estimated API cost of the record's tokens on `model`'s list price.
pub fn estimate_cost(r: &UsageRecord, model: &str) -> Option<f64> {
    let p = price_for(model)?;
    r.total_tokens?;
    let m = |n: Option<u64>, price: f64| n.unwrap_or(0) as f64 * price / 1_000_000.0;
    Some(
        m(r.input_tokens, p.input)
            + m(r.output_tokens, p.output)
            + m(r.cached_tokens, p.cache_read)
            + m(r.cache_creation_tokens, p.cache_write),
    )
}

// ---------------------------------------------------------------- avoided

/// Router rules under which Claude was a real alternative to the local model.
/// Not counted: embeddings (Claude Code has none) and private work (could not
/// leave this PC anyway).
pub fn claude_was_alternative(rule: Option<&str>) -> bool {
    matches!(rule, Some("mode-local" | "hybrid-light-local" | "hybrid-simple-local" | "agent-session-local"))
}

// ---------------------------------------------------------------- aggregation

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageGroup {
    pub key: String,
    pub requests: u64,
    pub tokens: u64,
    pub claude_tokens: u64,
    pub local_tokens: u64,
    /// Reported + estimated cloud cost (USD).
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    /// Local calendar day `YYYY-MM-DD`.
    pub day: String,
    pub requests: u64,
    pub claude_requests: u64,
    pub local_requests: u64,
    pub claude_tokens: u64,
    pub local_tokens: u64,
    pub cost_usd: f64,
}

/// "Tokens avoided": an estimate, never a measured saving.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AvoidedEstimate {
    pub label: String,
    pub tokens: u64,
    pub money_usd: f64,
    pub requests: u64,
    pub reference_model: String,
    pub method: String,
    pub price_source: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub requests: u64,
    pub claude_requests: u64,
    pub local_requests: u64,
    pub claude_tokens: u64,
    pub local_tokens: u64,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    /// Requests whose provider exposed no token counts.
    pub requests_without_tokens: u64,
    /// Sum of the costs Claude Code reported (USD).
    pub claude_cost_reported_usd: f64,
    /// Reported costs + price-table estimates for cloud requests without a reported cost.
    pub cloud_cost_estimated_usd: f64,
    /// Cloud requests with neither a reported cost nor a known price.
    pub cloud_requests_without_cost: u64,
    /// Always 0: local runtimes cost no money per request (electricity not counted).
    pub local_cost_usd: f64,
    pub avoided: AvoidedEstimate,
    pub avg_latency_ms: Option<f64>,
    /// Local tokens / all tokens.
    pub local_share: Option<f64>,
    pub days: Vec<UsageDay>,
    pub by_agent: Vec<UsageGroup>,
    pub by_mission: Vec<UsageGroup>,
    pub by_model: Vec<UsageGroup>,
    pub by_category: Vec<UsageGroup>,
    pub price_source: String,
}

fn local_day(ts: &str, tz_offset_minutes: i32) -> String {
    let Ok(t) = chrono::DateTime::parse_from_rfc3339(ts) else { return ts.chars().take(10).collect() };
    let off =
        chrono::FixedOffset::east_opt(tz_offset_minutes * 60).unwrap_or(chrono::FixedOffset::east_opt(0).unwrap());
    t.with_timezone(&off).format("%Y-%m-%d").to_string()
}

fn sorted(m: HashMap<String, UsageGroup>) -> Vec<UsageGroup> {
    let mut v: Vec<UsageGroup> = m.into_values().collect();
    v.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(b.requests.cmp(&a.requests)).then(a.key.cmp(&b.key)));
    v
}

/// Aggregates records (already filtered to the period). `tz_offset_minutes`
/// is the viewer's offset from UTC (east positive) for day buckets.
pub fn summarize(records: &[UsageRecord], tz_offset_minutes: i32) -> UsageSummary {
    let mut s = UsageSummary { price_source: PRICE_SOURCE.into(), ..Default::default() };
    let mut days: BTreeMap<String, UsageDay> = BTreeMap::new();
    let (mut agents, mut missions, mut models, mut cats) =
        (HashMap::new(), HashMap::new(), HashMap::new(), HashMap::<String, UsageGroup>::new());
    let (mut lat_sum, mut lat_n) = (0u64, 0u64);
    for r in records {
        let tokens = r.token_count();
        s.requests += 1;
        if r.total_tokens.is_none() {
            s.requests_without_tokens += 1;
        }
        s.input_tokens += r.input_tokens.unwrap_or(0);
        s.output_tokens += r.output_tokens.unwrap_or(0);
        s.cached_tokens += r.cached_tokens.unwrap_or(0);
        s.total_tokens += tokens;
        let cost = if r.local {
            s.local_requests += 1;
            s.local_tokens += tokens;
            if claude_was_alternative(r.route_rule.as_deref()) && tokens > 0 {
                s.avoided.requests += 1;
                s.avoided.tokens += tokens;
                s.avoided.money_usd += estimate_cost(r, AVOIDED_REFERENCE_MODEL).unwrap_or(0.0);
            }
            0.0
        } else {
            s.claude_requests += 1;
            s.claude_tokens += tokens;
            match (r.cost_source, r.cost_usd) {
                (CostSource::Reported, Some(c)) => {
                    s.claude_cost_reported_usd += c;
                    c
                }
                (_, Some(c)) => c,
                _ => match r.model.as_deref().and_then(|m| estimate_cost(r, m)) {
                    Some(c) => c,
                    None => {
                        s.cloud_requests_without_cost += 1;
                        0.0
                    }
                },
            }
        };
        s.cloud_cost_estimated_usd += cost;
        if let Some(l) = r.latency_ms {
            lat_sum += l;
            lat_n += 1;
        }
        let d = days.entry(local_day(&r.ts, tz_offset_minutes)).or_default();
        d.requests += 1;
        d.cost_usd += cost;
        if r.local {
            d.local_requests += 1;
            d.local_tokens += tokens;
        } else {
            d.claude_requests += 1;
            d.claude_tokens += tokens;
        }
        let add = |m: &mut HashMap<String, UsageGroup>, key: String| {
            let g = m.entry(key.clone()).or_insert_with(|| UsageGroup { key, ..Default::default() });
            g.requests += 1;
            g.tokens += tokens;
            g.cost_usd += cost;
            if r.local {
                g.local_tokens += tokens;
            } else {
                g.claude_tokens += tokens;
            }
        };
        add(&mut agents, r.agent_id.clone().unwrap_or_else(|| "(none)".into()));
        if let Some(m) = &r.mission_id {
            add(&mut missions, m.clone());
        }
        add(&mut models, r.model.clone().unwrap_or_else(|| format!("{} (model not reported)", r.provider)));
        add(&mut cats, r.category.as_str().to_string());
    }
    s.days = days
        .into_iter()
        .map(|(day, mut d)| {
            d.day = day;
            d
        })
        .collect();
    s.by_agent = sorted(agents);
    s.by_mission = sorted(missions);
    s.by_model = sorted(models);
    s.by_category = sorted(cats);
    s.avg_latency_ms = (lat_n > 0).then(|| lat_sum as f64 / lat_n as f64);
    s.local_share = (s.total_tokens > 0).then(|| s.local_tokens as f64 / s.total_tokens as f64);
    s.avoided.label = "Estimated tokens avoided".into();
    s.avoided.reference_model = AVOIDED_REFERENCE_MODEL.into();
    s.avoided.price_source = PRICE_SOURCE.into();
    s.avoided.method = "Requests really served by the local runtime that the ModelRouter could otherwise have sent to Claude (rules mode-local, hybrid-light-local, hybrid-simple-local, local agent sessions). Their real local token counts are used as a proxy for what Claude would have processed; money is that count priced at the reference model's list price. An estimate, not a measured saving.".into();
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(models: Value, cost: f64) -> Value {
        json!({"type": "result", "subtype": "success", "is_error": false, "duration_ms": 2846,
               "duration_api_ms": 4213, "num_turns": 1, "result": "ok", "session_id": "s",
               "total_cost_usd": cost,
               "usage": {"input_tokens": 4, "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 12000,
                         "output_tokens": 12, "server_tool_use": {"web_search_requests": 0}, "service_tier": "standard"},
               "modelUsage": models})
    }

    #[test]
    fn claude_session_turns_are_deltas() {
        let first = result(
            json!({"claude-sonnet-5-5": {"inputTokens": 10, "outputTokens": 100, "cacheReadInputTokens": 2000,
                   "cacheCreationInputTokens": 500, "webSearchRequests": 0, "costUSD": 0.03, "contextWindow": 1000000}}),
            0.03,
        );
        let second = result(
            json!({"claude-sonnet-5-5": {"inputTokens": 15, "outputTokens": 160, "cacheReadInputTokens": 5000,
                   "cacheCreationInputTokens": 500, "costUSD": 0.05},
                   "claude-haiku-4-5": {"inputTokens": 300, "outputTokens": 20, "cacheReadInputTokens": 0,
                   "cacheCreationInputTokens": 0, "costUSD": 0.001}}),
            0.051,
        );
        let mut t = ClaudeSessionTracker::default();
        let a = t.turn(&parse_claude_result(&first).unwrap(), None);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].counters.output, 100);
        let b = t.turn(&parse_claude_result(&second).unwrap(), None);
        assert_eq!(b.len(), 2);
        let haiku = b.iter().find(|s| s.model.as_deref() == Some("claude-haiku-4-5")).unwrap();
        assert_eq!(haiku.counters.input, 300);
        let sonnet = b.iter().find(|s| s.model.as_deref() == Some("claude-sonnet-5-5")).unwrap();
        assert_eq!((sonnet.counters.input, sonnet.counters.output, sonnet.counters.cache_read), (5, 60, 3000));
        assert!((sonnet.counters.cost_usd.unwrap() - 0.02).abs() < 1e-9);
        // Nothing new: no share.
        assert!(t.turn(&parse_claude_result(&second).unwrap(), None).is_empty());
        assert!(parse_claude_result(&json!({"type": "assistant"})).is_none());
    }

    #[test]
    fn claude_result_without_model_usage_uses_the_usage_block() {
        let v = json!({"type": "result", "total_cost_usd": 0.01, "duration_ms": 5,
                       "usage": {"input_tokens": 7, "output_tokens": 3}});
        let mut t = ClaudeSessionTracker::default();
        let s = t.turn(&parse_claude_result(&v).unwrap(), Some("opus"));
        assert_eq!(s[0].model.as_deref(), Some("opus"));
        assert_eq!(s[0].counters.input, 7);
        assert_eq!(s[0].counters.cost_usd, Some(0.01));
        // The old fake has neither: nothing recorded rather than invented.
        let bare = json!({"type": "result", "total_cost_usd": 0.01, "num_turns": 1});
        assert!(t.turn(&parse_claude_result(&bare).unwrap(), None).is_empty());
    }

    #[test]
    fn oneshot_json_output() {
        let v = result(
            json!({"claude-opus-5-5": {"inputTokens": 900, "outputTokens": 400, "cacheReadInputTokens": 0,
                   "cacheCreationInputTokens": 0, "costUSD": 0.0116}}),
            0.0116,
        );
        let recs = oneshot_records(&v, UsageCategory::BackgroundAgent, "mission-analysis", Some("opus"));
        assert_eq!(recs.len(), 1);
        let r = &recs[0];
        assert_eq!(r.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(r.total_tokens, Some(1300));
        assert_eq!(r.cost_source, CostSource::Reported);
        assert_eq!(r.latency_ms, Some(2846));
        assert!(!r.local);
    }

    #[test]
    fn local_payloads() {
        let ollama = json!({"model": "qwen3:8b", "created_at": "2026-10-07T10:00:00Z",
            "message": {"role": "assistant", "content": "hi"}, "done": true, "done_reason": "stop",
            "total_duration": 2_500_000_000u64, "load_duration": 1_000_000u64, "prompt_eval_count": 26,
            "prompt_eval_duration": 130_000_000u64, "eval_count": 298, "eval_duration": 2_200_000_000u64});
        let r = ollama_record(&ollama, UsageCategory::AiWorld, "ai-world");
        assert_eq!((r.input_tokens, r.output_tokens, r.total_tokens), (Some(26), Some(298), Some(324)));
        assert_eq!(r.latency_ms, Some(2500));
        assert!(r.local);
        assert_eq!(r.cost_usd, Some(0.0));
        assert_eq!(r.reasoning_tokens, None);

        let openai = json!({"id": "chatcmpl-1", "object": "chat.completion", "model": "qwen2.5-7b-instruct",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70,
                      "prompt_tokens_details": {"cached_tokens": 10},
                      "completion_tokens_details": {"reasoning_tokens": 5}}});
        let r = openai_record(&openai, "lmstudio", UsageCategory::AgentConversation, "ai-world");
        assert_eq!((r.input_tokens, r.cached_tokens, r.output_tokens), (Some(40), Some(10), Some(20)));
        assert_eq!(r.total_tokens, Some(70));
        assert_eq!(r.reasoning_tokens, Some(5));
        assert_eq!(r.provider, "lmstudio");

        let emb = json!({"object": "list", "data": [], "model": "nomic-embed-text",
                         "usage": {"prompt_tokens": 12, "total_tokens": 12}});
        let r = openai_record(&emb, "openai", UsageCategory::Embedding, "embeddings");
        assert_eq!((r.input_tokens, r.output_tokens, r.total_tokens), (Some(12), None, Some(12)));
        // No usage at all: N/A, not zero.
        let r = openai_record(&json!({"choices": []}), "llamacpp", UsageCategory::AiWorld, "x");
        assert_eq!(r.total_tokens, None);
    }

    #[test]
    fn prices_and_estimates() {
        assert_eq!(price_for("claude-opus-5-5").unwrap().input, 4.0);
        assert_eq!(price_for("claude-opus-4-1-20250805").unwrap().input, 15.0);
        assert_eq!(price_for("claude-opus-4-8").unwrap().input, 5.0);
        assert_eq!(price_for("claude-sonnet-4-5-20250929").unwrap().output, 15.0);
        assert_eq!(price_for("claude-sonnet-5-5").unwrap().output, 10.0);
        assert_eq!(price_for("claude-haiku-4-5").unwrap().input, 1.0);
        assert!(price_for("qwen3:8b").is_none());
        let r = UsageRecord::default().tokens(Some(1_000_000), Some(1_000_000), None, None);
        assert!((estimate_cost(&r, "claude-sonnet-5-5").unwrap() - 12.0).abs() < 1e-9);
        assert_eq!(estimate_cost(&UsageRecord::default(), "claude-sonnet-5-5"), None);
    }

    fn rec(ts: &str, local: bool, tokens: u64, cat: UsageCategory) -> UsageRecord {
        let mut r = UsageRecord::new(if local { "ollama" } else { "claude" }, cat, "t").tokens(
            Some(tokens / 2),
            Some(tokens - tokens / 2),
            None,
            None,
        );
        r.ts = ts.into();
        if local {
            r = r.local_run();
        } else {
            r = r.with_cost(Some(0.5));
        }
        r
    }

    #[test]
    fn summary_by_period_category_and_avoided() {
        let mut a = rec("2026-10-06T23:30:00.000Z", false, 1000, UsageCategory::CentralAgent);
        a.agent_id = Some("central".into());
        a.model = Some("claude-opus-5-5".into());
        a.latency_ms = Some(1000);
        let mut b = rec("2026-10-07T08:00:00.000Z", true, 400, UsageCategory::AiWorld);
        b.route_rule = Some("hybrid-light-local".into());
        b.latency_ms = Some(3000);
        let mut c = rec("2026-10-07T09:00:00.000Z", true, 600, UsageCategory::Embedding);
        c.route_rule = Some("embedding-local".into());
        let mut d = rec("2026-10-07T10:00:00.000Z", false, 0, UsageCategory::ProductionAgent);
        d.total_tokens = None;
        d.input_tokens = None;
        d.output_tokens = None;
        d.cost_usd = None;
        d.cost_source = CostSource::Unknown;
        d.mission_id = Some("M-0001".into());

        let s = summarize(&[a, b, c, d], 120);
        assert_eq!(s.requests, 4);
        assert_eq!((s.claude_tokens, s.local_tokens, s.total_tokens), (1000, 1000, 2000));
        assert_eq!(s.requests_without_tokens, 1);
        assert_eq!(s.cloud_requests_without_cost, 1);
        assert!((s.claude_cost_reported_usd - 0.5).abs() < 1e-9);
        assert_eq!(s.local_cost_usd, 0.0);
        assert_eq!(s.local_share, Some(0.5));
        assert_eq!(s.avg_latency_ms, Some(2000.0));
        // UTC+2: the 23:30Z request belongs to the 7th.
        assert_eq!(s.days.len(), 1);
        assert_eq!(s.days[0].day, "2026-10-07");
        // Only the routed light request counts; embeddings had no Claude alternative.
        assert_eq!(s.avoided.label, "Estimated tokens avoided");
        assert_eq!((s.avoided.tokens, s.avoided.requests), (400, 1));
        assert!((s.avoided.money_usd - (200.0 * 2.0 + 200.0 * 10.0) / 1e6).abs() < 1e-12);
        assert!(s.avoided.method.contains("estimate"));
        assert_eq!(s.by_mission[0].key, "M-0001");
        assert_eq!(s.by_category.len(), 4);
        assert!(s.by_model.iter().any(|g| g.key == "claude-opus-5-5"));
        let utc = summarize(&s_records(), 0);
        assert_eq!(utc.days.len(), 2);
    }

    fn s_records() -> Vec<UsageRecord> {
        vec![
            rec("2026-10-06T23:30:00.000Z", false, 10, UsageCategory::CentralAgent),
            rec("2026-10-07T08:00:00.000Z", false, 10, UsageCategory::CentralAgent),
        ]
    }

    #[test]
    fn sink_receives_records() {
        use std::sync::Mutex;
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        set_sink(Some(Arc::new(move |r: UsageRecord| g.lock().unwrap().push(r.source))));
        record(UsageRecord::new("claude", UsageCategory::AiWorld, "sink-test"));
        set_sink(None);
        record(UsageRecord::new("claude", UsageCategory::AiWorld, "dropped"));
        assert!(got.lock().unwrap().contains(&"sink-test".to_string()));
        assert!(!got.lock().unwrap().contains(&"dropped".to_string()));
    }
}
