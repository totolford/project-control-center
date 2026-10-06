//! AI engine settings: which engine (Claude through Claude Code, or a local
//! model served by a local runtime) runs the agents and NEXUS's own AI work.
//! Pure data; detection, providers and routing live in `pcc-ai`.

use serde::{Deserialize, Serialize};

/// Project-wide routing mode for NEXUS's AI work (AI Town, summaries...).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AiMode {
    /// Everything on Claude (Claude Code). The behaviour before 0.4.
    #[default]
    Claude,
    /// Everything on the local runtime.
    Local,
    /// Light work local, planning/architecture/review on Claude.
    Hybrid,
}

/// Engine of an agent session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum EngineProvider {
    /// Claude Code with the user's Claude account.
    #[default]
    Claude,
    /// Claude Code against the local runtime's Anthropic-compatible endpoint.
    Local,
    /// Decided per agent by the router (role, task).
    Hybrid,
}

/// What NEXUS does when the local runtime does not answer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FallbackPolicy {
    /// Stop and tell the user ("Local AI unavailable").
    #[default]
    Ask,
    /// Retry the health check a few times before giving up.
    Retry,
    /// Restart the local runtime once, then give up.
    Restart,
    /// Run on Claude instead (journaled).
    SwitchToClaude,
}

/// The local runtime agents and NEXUS talk to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalEndpoint {
    /// `ollama`, `lmstudio`, `llamacpp` or `openai` (any OpenAI-compatible server).
    pub runtime: String,
    /// Base URL without trailing slash, e.g. `http://127.0.0.1:11434`.
    pub base_url: String,
    /// Model for agents and chat (`None` = not chosen yet).
    pub model: Option<String>,
}

impl Default for LocalEndpoint {
    fn default() -> Self {
        Self { runtime: "ollama".into(), base_url: "http://127.0.0.1:11434".into(), model: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AiEngineSettings {
    pub mode: AiMode,
    /// Central Agent provider.
    pub central: EngineProvider,
    /// Default provider of workers (an agent's profile may override it).
    pub workers: EngineProvider,
    pub local: LocalEndpoint,
    pub fallback: FallbackPolicy,
}

impl AiEngineSettings {
    /// A local engine was configured with a model.
    pub fn local_ready(&self) -> bool {
        self.local.model.as_deref().is_some_and(|m| !m.trim().is_empty()) && !self.local.base_url.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_keep_claude() {
        let s: AiEngineSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.central, EngineProvider::Claude);
        assert_eq!(s.mode, AiMode::Claude);
        assert!(!s.local_ready());
        let s: AiEngineSettings =
            serde_json::from_str(r#"{"central":"local","local":{"model":"qwen3:8b"},"fallback":"switch_to_claude"}"#)
                .unwrap();
        assert!(s.local_ready());
        assert_eq!(s.local.base_url, "http://127.0.0.1:11434");
        assert_eq!(s.fallback, FallbackPolicy::SwitchToClaude);
    }
}
