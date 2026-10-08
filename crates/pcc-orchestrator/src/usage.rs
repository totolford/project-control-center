//! AI usage of agent sessions: every Claude Code turn's `result` message is
//! turned into usage records (one per model) attributed to the agent, its
//! task and mission. Claude Code reports cumulative counters per process;
//! per-turn deltas come from [`ClaudeSessionTracker`].

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use serde_json::Value;

use pcc_core::usage::{self, ClaudeSessionTracker, UsageCategory, UsageRecord, UsageSummary};
use pcc_core::{AgentKind, Result, TaskStatus};
use pcc_store::{ProjectStore, TaskFilter, UsageFilter};

use crate::engine::Engine;

/// Router rule recorded for turns of agent sessions running on the local runtime.
pub const LOCAL_SESSION_RULE: &str = "agent-session-local";

#[derive(Default)]
pub(crate) struct SessionUsage {
    epoch: u64,
    model: Option<String>,
    tracker: ClaudeSessionTracker,
}

/// Per-agent usage trackers of live sessions.
#[derive(Default)]
pub(crate) struct UsageRuntime {
    sessions: HashMap<String, SessionUsage>,
}

/// Routes usage recorded outside the engine (one-shot calls) to this store.
/// Holds a weak reference: a closed project receives nothing.
pub fn install_sink(store: &Arc<ProjectStore>) {
    let weak: Weak<ProjectStore> = Arc::downgrade(store);
    usage::set_sink(Some(Arc::new(move |mut r: UsageRecord| {
        if let Some(s) = weak.upgrade() {
            if let Err(e) = s.insert_usage(&mut r) {
                tracing::warn!("AI usage not recorded: {e}");
            }
        }
    })));
}

/// When the turn that just ended began (RFC 3339 UTC, like task timestamps);
/// one second of slack covers clock rounding between the two.
fn turn_start(duration_ms: Option<u64>) -> String {
    let back = chrono::Duration::milliseconds(duration_ms.unwrap_or(0).min(86_400_000) as i64 + 1000);
    (chrono::Utc::now() - back).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Engine {
    /// Observes a raw stream-json line of `agent`'s session (`epoch`).
    pub(crate) fn usage_observe(&mut self, agent: &str, epoch: u64, raw: &str) {
        // Cheap pre-filter: only init and result lines matter.
        if !raw.contains("\"result\"") && !raw.contains("\"init\"") {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(raw) else { return };
        let entry = self.usage.sessions.entry(agent.to_string()).or_default();
        if entry.epoch != epoch {
            *entry = SessionUsage { epoch, ..Default::default() };
        }
        if v.get("type").and_then(Value::as_str) == Some("system")
            && v.get("subtype").and_then(Value::as_str) == Some("init")
        {
            entry.model = v.get("model").and_then(Value::as_str).map(str::to_string);
            return;
        }
        let Some(result) = usage::parse_claude_result(&v) else { return };
        let fallback = entry.model.clone();
        let shares = entry.tracker.turn(&result, fallback.as_deref());
        if shares.is_empty() || self.store.read_only() {
            return;
        }
        if let Err(e) = self.usage_record_turn(agent, shares, result.duration_ms) {
            tracing::warn!("AI usage of {agent} not recorded: {e}");
        }
    }

    fn usage_record_turn(
        &mut self,
        agent: &str,
        shares: Vec<usage::TurnShare>,
        duration_ms: Option<u64>,
    ) -> Result<()> {
        let a = self.store.agent(agent)?;
        let local = self.sessions.get(agent).is_some_and(|l| l.local_engine);
        let task = if a.kind == AgentKind::Worker {
            let tasks = self.store.list_tasks(&TaskFilter { agent: Some(agent.into()), ..Default::default() })?;
            // The task in progress, or the one the agent finished during this turn
            // (complete_task runs before the turn's result message arrives).
            let turn_start = turn_start(duration_ms);
            tasks.iter().find(|t| t.status == TaskStatus::InProgress).cloned().or_else(|| {
                tasks
                    .iter()
                    .filter(|t| t.completed_at.as_deref().is_some_and(|c| c >= turn_start.as_str()))
                    .max_by(|x, y| x.completed_at.cmp(&y.completed_at))
                    .cloned()
            })
        } else {
            None
        };
        let category = match (a.kind, &task) {
            (AgentKind::Central, _) => UsageCategory::CentralAgent,
            (AgentKind::Worker, Some(_)) => UsageCategory::ProductionAgent,
            (AgentKind::Worker, None) => UsageCategory::BackgroundAgent,
        };
        let runtime = local.then(|| self.store.settings().ai.local.runtime);
        let n = shares.len();
        for (i, s) in shares.into_iter().enumerate() {
            let c = s.counters;
            let mut r = UsageRecord::new(runtime.clone().unwrap_or_else(|| "claude".into()), category, "session")
                .tokens(Some(c.input), Some(c.output), Some(c.cache_read), Some(c.cache_write))
                .agent(
                    Some(agent),
                    task.as_ref().and_then(|t| t.mission_id.as_deref()),
                    task.as_ref().map(|t| t.id.as_str()),
                );
            r.model = if local { self.hier.local_models.get(agent).cloned().or(s.model) } else { s.model };
            if local {
                // Claude Code prices local tokens as if they were Claude's: not real spending.
                r = r.local_run();
                r.route_rule = Some(LOCAL_SESSION_RULE.into());
            } else {
                r = r.with_cost(c.cost_usd);
            }
            // The turn's duration belongs to the turn, not to each model of it.
            r.latency_ms = if i + 1 == n { duration_ms } else { None };
            self.store.insert_usage(&mut r)?;
        }
        Ok(())
    }

    pub fn usage_summary(&self, filter: &UsageFilter, tz_offset_minutes: i32) -> Result<UsageSummary> {
        Ok(usage::summarize(&self.store.usage(filter)?, tz_offset_minutes))
    }
}
