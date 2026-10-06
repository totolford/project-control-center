//! ModelRouter: decides, with fixed rules, whether a piece of AI work runs on
//! Claude (through Claude Code) or on the local runtime, and says why. Every
//! decision can be journaled (`Journal`).

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use pcc_core::{AgentKind, AiEngineSettings, AiMode, EngineProvider};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    /// AI Town townspeople / NPC dialogue.
    NpcDialogue,
    /// World simulation (plans, reflections, character generation).
    Simulation,
    Summary,
    Embedding,
    Classification,
    SimpleAnalysis,
    CodeEdit,
    MissionPlanning,
    Architecture,
    FinalReview,
    /// A whole agent session (Central or a worker).
    AgentSession,
    Other,
}

impl TaskKind {
    fn claude_only(self) -> bool {
        matches!(self, TaskKind::MissionPlanning | TaskKind::Architecture | TaskKind::FinalReview)
    }
    fn light(self) -> bool {
        matches!(
            self,
            TaskKind::NpcDialogue
                | TaskKind::Simulation
                | TaskKind::Summary
                | TaskKind::Classification
                | TaskKind::SimpleAnalysis
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    #[default]
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RouteRequest {
    pub task: TaskKind,
    pub complexity: Level,
    /// Estimated prompt size in tokens.
    pub context_tokens: u32,
    /// The work needs tool calling.
    pub required_tools: bool,
    /// Data must stay on this PC.
    pub private: bool,
    /// How much low latency matters.
    pub latency: Level,
    /// How much saving Claude usage matters.
    pub cost: Level,
    pub agent_role: Option<String>,
    pub agent_kind: Option<AgentKind>,
}

impl Default for RouteRequest {
    fn default() -> Self {
        Self {
            task: TaskKind::Other,
            complexity: Level::Low,
            context_tokens: 0,
            required_tools: false,
            private: false,
            latency: Level::Low,
            cost: Level::Low,
            agent_role: None,
            agent_kind: None,
        }
    }
}

/// What the local runtime can do right now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalCapacity {
    /// Runtime answering and a model chosen.
    pub available: bool,
    pub runtime: String,
    pub model: Option<String>,
    pub context: u32,
    pub tools: bool,
    pub embedding_model: Option<String>,
    /// Why it is unavailable, when it is.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    Claude,
    Local,
    /// Nothing can do it under the current mode; `reason` says why.
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecision {
    pub provider: Route,
    pub model: Option<String>,
    pub reason: String,
    /// Identifier of the rule that decided.
    pub rule: String,
}

fn claude(rule: &str, reason: impl Into<String>) -> RouteDecision {
    RouteDecision { provider: Route::Claude, model: None, reason: reason.into(), rule: rule.into() }
}

fn local(cap: &LocalCapacity, rule: &str, reason: impl Into<String>, embedding: bool) -> RouteDecision {
    let model = if embedding { cap.embedding_model.clone() } else { cap.model.clone() };
    RouteDecision { provider: Route::Local, model, reason: reason.into(), rule: rule.into() }
}

fn unavailable(rule: &str, reason: impl Into<String>) -> RouteDecision {
    RouteDecision { provider: Route::Unavailable, model: None, reason: reason.into(), rule: rule.into() }
}

fn role_needs_claude(role: &str) -> bool {
    let r = role.to_ascii_lowercase();
    ["architect", "review", "plan", "lead", "security", "orchestr"].iter().any(|k| r.contains(k))
}

/// Why the local model cannot take this request, if it cannot.
fn local_limit(req: &RouteRequest, cap: &LocalCapacity) -> Option<String> {
    if !cap.available {
        return Some(cap.reason.clone().unwrap_or_else(|| "local AI unavailable".into()));
    }
    if req.task == TaskKind::Embedding {
        return cap.embedding_model.is_none().then(|| "no local embedding model".into());
    }
    if (req.required_tools || req.task == TaskKind::AgentSession) && !cap.tools {
        return Some(format!("{} has no tool calling", cap.model.as_deref().unwrap_or("the local model")));
    }
    if cap.context > 0 && req.context_tokens > cap.context * 8 / 10 {
        return Some(format!("needs ~{} tokens of context, the local model has {}", req.context_tokens, cap.context));
    }
    None
}

pub fn route(mode: AiMode, req: &RouteRequest, cap: &LocalCapacity) -> RouteDecision {
    let limit = local_limit(req, cap);
    let emb = req.task == TaskKind::Embedding;
    if emb {
        // Claude Code has no embedding API.
        return match limit {
            None => local(cap, "embedding-local", "embeddings only exist on the local runtime", true),
            Some(why) => unavailable("embedding-unavailable", format!("embeddings need a local model: {why}")),
        };
    }
    if req.private {
        return match limit {
            None => local(cap, "private-local", "private data stays on this PC", false),
            Some(why) => unavailable("private-unavailable", format!("private work cannot leave this PC and {why}")),
        };
    }
    match mode {
        AiMode::Claude => claude("mode-claude", "AI mode is Claude"),
        AiMode::Local => match limit {
            None => local(cap, "mode-local", "AI mode is Local", false),
            Some(why) => unavailable("mode-local-unavailable", format!("AI mode is Local but {why}")),
        },
        AiMode::Hybrid => {
            if req.task.claude_only() {
                return claude("hybrid-claude-task", format!("{:?} needs Claude's reasoning", req.task));
            }
            if req.complexity == Level::High {
                return claude("hybrid-complex", "high complexity");
            }
            if req.agent_kind == Some(AgentKind::Central) {
                return claude("hybrid-central", "Central plans missions and coordinates agents");
            }
            if let Some(role) = req.agent_role.as_deref().filter(|r| role_needs_claude(r)) {
                return claude("hybrid-role", format!("role \"{role}\" needs Claude"));
            }
            if let Some(why) = limit {
                return claude("hybrid-local-limit", format!("on Claude because {why}"));
            }
            if req.task.light() {
                return local(cap, "hybrid-light-local", format!("{:?} is light work: local model", req.task), false);
            }
            if req.complexity == Level::Low || req.cost == Level::High || req.latency == Level::High {
                return local(cap, "hybrid-simple-local", "simple work: local model", false);
            }
            claude("hybrid-default", "medium complexity: Claude")
        }
    }
}

/// Engine of an agent session (before health checks): Claude or Local, with the reason.
pub fn agent_engine(
    settings: &AiEngineSettings,
    kind: AgentKind,
    role: &str,
    override_: Option<EngineProvider>,
    cap: &LocalCapacity,
) -> RouteDecision {
    let chosen = override_.unwrap_or(match kind {
        AgentKind::Central => settings.central,
        AgentKind::Worker => settings.workers,
    });
    let req = RouteRequest {
        task: TaskKind::AgentSession,
        complexity: Level::Medium,
        required_tools: true,
        agent_role: Some(role.to_string()),
        agent_kind: Some(kind),
        ..Default::default()
    };
    match chosen {
        EngineProvider::Claude => claude("agent-claude", "agent provider is Claude"),
        EngineProvider::Local => route(AiMode::Local, &req, cap),
        EngineProvider::Hybrid => {
            // Hybrid agents: workers with ordinary roles run locally when possible.
            let mut r = req;
            r.complexity = Level::Low;
            route(AiMode::Hybrid, &r, cap)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub ts: String,
    /// Who asked (e.g. `ai-town`, `agent:central`, `world`).
    pub source: String,
    pub mode: AiMode,
    pub request: RouteRequest,
    pub decision: RouteDecision,
}

/// Append-only JSONL journal of routing decisions.
pub struct Journal {
    path: PathBuf,
}

impl Journal {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn record(&self, source: &str, mode: AiMode, request: &RouteRequest, decision: &RouteDecision) {
        let entry = JournalEntry {
            ts: pcc_core::now(),
            source: source.into(),
            mode,
            request: request.clone(),
            decision: decision.clone(),
        };
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.path)?;
            writeln!(f, "{}", serde_json::to_string(&entry).unwrap_or_default())
        };
        if let Err(e) = write() {
            tracing::warn!("cannot write the routing journal {}: {e}", self.path.display());
        }
    }

    /// Most recent entries first.
    pub fn recent(&self, limit: usize) -> Vec<JournalEntry> {
        let text = std::fs::read_to_string(&self.path).unwrap_or_default();
        text.lines().rev().filter_map(|l| serde_json::from_str(l).ok()).take(limit).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(tools: bool) -> LocalCapacity {
        LocalCapacity {
            available: true,
            runtime: "ollama".into(),
            model: Some("qwen3:8b".into()),
            context: 40_960,
            tools,
            embedding_model: Some("mxbai-embed-large".into()),
            reason: None,
        }
    }

    fn down() -> LocalCapacity {
        LocalCapacity { reason: Some("Ollama is not running".into()), ..Default::default() }
    }

    fn task(t: TaskKind) -> RouteRequest {
        RouteRequest { task: t, ..Default::default() }
    }

    #[test]
    fn hybrid_rules() {
        let c = cap(true);
        let r = route(AiMode::Hybrid, &task(TaskKind::NpcDialogue), &c);
        assert_eq!(r.provider, Route::Local);
        assert_eq!(r.model.as_deref(), Some("qwen3:8b"));
        assert_eq!(route(AiMode::Hybrid, &task(TaskKind::MissionPlanning), &c).provider, Route::Claude);
        assert_eq!(route(AiMode::Hybrid, &task(TaskKind::FinalReview), &c).provider, Route::Claude);
        assert_eq!(route(AiMode::Hybrid, &task(TaskKind::SimpleAnalysis), &c).provider, Route::Local);
        let complex = RouteRequest { complexity: Level::High, ..task(TaskKind::Summary) };
        assert_eq!(route(AiMode::Hybrid, &complex, &c).rule, "hybrid-complex");
        let big = RouteRequest { context_tokens: 100_000, ..task(TaskKind::Summary) };
        let d = route(AiMode::Hybrid, &big, &c);
        assert_eq!(d.provider, Route::Claude);
        assert!(d.reason.contains("context"));
        // Local down: hybrid falls back to Claude for light work.
        let d = route(AiMode::Hybrid, &task(TaskKind::NpcDialogue), &down());
        assert_eq!(d.provider, Route::Claude);
        assert!(d.reason.contains("not running"));
        let medium = RouteRequest { complexity: Level::Medium, ..task(TaskKind::CodeEdit) };
        assert_eq!(route(AiMode::Hybrid, &medium, &c).provider, Route::Claude);
    }

    #[test]
    fn modes_and_special_cases() {
        let c = cap(false);
        assert_eq!(route(AiMode::Claude, &task(TaskKind::NpcDialogue), &c).provider, Route::Claude);
        assert_eq!(route(AiMode::Local, &task(TaskKind::NpcDialogue), &c).provider, Route::Local);
        let d = route(AiMode::Local, &task(TaskKind::NpcDialogue), &down());
        assert_eq!(d.provider, Route::Unavailable);
        // Tools needed but the local model has none.
        let tools = RouteRequest { required_tools: true, ..task(TaskKind::SimpleAnalysis) };
        assert_eq!(route(AiMode::Local, &tools, &c).provider, Route::Unavailable);
        // Embeddings are local even in Claude mode.
        let e = route(AiMode::Claude, &task(TaskKind::Embedding), &c);
        assert_eq!((e.provider, e.model.as_deref()), (Route::Local, Some("mxbai-embed-large")));
        // Private work never goes to Claude.
        let p = RouteRequest { private: true, ..task(TaskKind::MissionPlanning) };
        assert_eq!(route(AiMode::Claude, &p, &c).provider, Route::Local);
        assert_eq!(route(AiMode::Claude, &p, &down()).provider, Route::Unavailable);
    }

    #[test]
    fn agent_engines() {
        let mut s = AiEngineSettings::default();
        let c = cap(true);
        assert_eq!(agent_engine(&s, AgentKind::Central, "Orchestrator", None, &c).provider, Route::Claude);
        s.central = EngineProvider::Local;
        assert_eq!(agent_engine(&s, AgentKind::Central, "Orchestrator", None, &c).provider, Route::Local);
        // llama3 has no tools: a local agent is impossible.
        let d = agent_engine(&s, AgentKind::Central, "Orchestrator", None, &cap(false));
        assert_eq!(d.provider, Route::Unavailable);
        assert!(d.reason.contains("tool calling"));
        s.workers = EngineProvider::Hybrid;
        assert_eq!(agent_engine(&s, AgentKind::Worker, "Frontend developer", None, &c).provider, Route::Local);
        assert_eq!(agent_engine(&s, AgentKind::Worker, "Code reviewer", None, &c).provider, Route::Claude);
        assert_eq!(
            agent_engine(&s, AgentKind::Worker, "dev", Some(EngineProvider::Claude), &c).provider,
            Route::Claude
        );
        s.central = EngineProvider::Hybrid;
        assert_eq!(agent_engine(&s, AgentKind::Central, "Orchestrator", None, &c).rule, "hybrid-central");
    }

    #[test]
    fn journal_appends_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::new(dir.path().join("ai").join("routing.jsonl"));
        let req = task(TaskKind::NpcDialogue);
        let d = route(AiMode::Hybrid, &req, &cap(true));
        j.record("ai-town", AiMode::Hybrid, &req, &d);
        j.record("world", AiMode::Claude, &req, &route(AiMode::Claude, &req, &cap(true)));
        let recent = j.recent(10);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].source, "world");
        assert_eq!(recent[1].decision.provider, Route::Local);
    }
}
