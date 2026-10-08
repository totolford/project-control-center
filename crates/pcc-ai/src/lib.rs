//! Local AI for NEXUS: hardware detection, local runtimes (Ollama, LM Studio,
//! llama.cpp), the `LocalAiProvider` implementations, a verified model catalog
//! with recommendations, and the `ModelRouter` that decides between Claude and
//! the local model.

pub mod capability;
pub mod catalog;
pub mod hardware;
pub mod provider;
pub mod router;
pub mod runtime;

use std::sync::OnceLock;
use std::time::Duration;

use pcc_core::{AiEngineSettings, Error, FallbackPolicy, Result};

use provider::LocalAiProvider;
use router::LocalCapacity;
use runtime::{RuntimeKind, RuntimeManager};

/// Runtime processes started by NEXUS, shared by the app and the orchestrator.
pub fn manager() -> &'static RuntimeManager {
    static M: OnceLock<RuntimeManager> = OnceLock::new();
    M.get_or_init(RuntimeManager::new)
}

/// Blocking (a few HTTP requests): what the configured local endpoint can do now.
pub fn capacity(settings: &AiEngineSettings) -> LocalCapacity {
    let ep = &settings.local;
    let mut cap = LocalCapacity { runtime: ep.runtime.clone(), model: ep.model.clone(), ..Default::default() };
    let p = provider::for_endpoint(&ep.runtime, &ep.base_url);
    let h = p.health();
    if !h.ok {
        cap.reason = Some(format!("{} is not answering on {}", runtime_name(&ep.runtime), ep.base_url));
        return cap;
    }
    let models = p.list_models().unwrap_or_default();
    let norm = |s: &str| s.strip_suffix(":latest").unwrap_or(s).to_string();
    cap.embedding_model =
        models.iter().find(|m| norm(&m.name) == catalog::AI_TOWN_EMBEDDING_MODEL).map(|m| m.name.clone());
    let Some(model) = ep.model.as_deref().filter(|m| !m.trim().is_empty()) else {
        cap.reason = Some("no local model selected".into());
        return cap;
    };
    let found = models.iter().find(|m| m.name == model || norm(&m.name) == norm(model));
    let Some(found) = found else {
        cap.reason = Some(format!("model {model} is not installed in {}", runtime_name(&ep.runtime)));
        return cap;
    };
    cap.tools = match &found.capabilities {
        Some(c) => c.iter().any(|c| c == "tools"),
        None => catalog::find(model).is_some_and(|m| m.tools),
    };
    // A capability test measured on this machine wins over what the model declares.
    if let Some(r) = capability::latest(&ep.runtime, model) {
        cap.tools = r.central_mode == capability::CentralMode::Full;
    }
    cap.context = catalog::find(model).map(|m| m.context).unwrap_or(8_192);
    cap.available = true;
    cap
}

pub fn runtime_name(id: &str) -> &'static str {
    RuntimeKind::parse(id).map(RuntimeKind::name).unwrap_or("The local runtime")
}

/// Environment that makes Claude Code use a local runtime's Anthropic-compatible
/// endpoint (Ollama >= 0.14 serves `/v1/messages`) with `model` for every role.
/// `ANTHROPIC_API_KEY` is emptied so the user's own key or login is never sent.
pub fn claude_code_env(base_url: &str, model: &str) -> Vec<(String, String)> {
    let mut env = vec![
        ("ANTHROPIC_BASE_URL".to_string(), base_url.trim_end_matches('/').to_string()),
        ("ANTHROPIC_AUTH_TOKEN".to_string(), "ollama".to_string()),
        ("ANTHROPIC_API_KEY".to_string(), String::new()),
    ];
    for k in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        env.push((k.to_string(), model.to_string()));
    }
    env.push(("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into()));
    env
}

/// Outcome of checking the local runtime before an agent starts on it.
#[derive(Debug, Clone, PartialEq)]
pub enum LocalCheck {
    Ready(LocalCapacity),
    /// Policy `switch_to_claude`: run on Claude; the reason is journaled.
    UseClaude(String),
}

/// Blocking. Applies the fallback policy when the local runtime is down.
pub fn check_local_for_agent(settings: &AiEngineSettings) -> Result<LocalCheck> {
    let mut cap = capacity(settings);
    if !cap.available && cap.model.is_some() {
        match settings.fallback {
            FallbackPolicy::Retry => {
                for wait in [1, 2, 4] {
                    std::thread::sleep(Duration::from_secs(wait));
                    cap = capacity(settings);
                    if cap.available {
                        break;
                    }
                }
            }
            FallbackPolicy::Restart => {
                if let Ok(kind) = RuntimeKind::parse(&settings.local.runtime) {
                    match manager().restart(kind, Some(&settings.local.base_url), None) {
                        Ok(_) => cap = capacity(settings),
                        Err(e) => tracing::warn!("restarting {} failed: {e}", kind.name()),
                    }
                }
            }
            FallbackPolicy::SwitchToClaude | FallbackPolicy::Ask => {}
        }
    }
    if cap.available && !cap.tools {
        let why = format!(
            "{} has no tool calling, which NEXUS agents need; choose a model with tools (e.g. qwen3:8b)",
            cap.model.as_deref().unwrap_or("the local model")
        );
        return match settings.fallback {
            FallbackPolicy::SwitchToClaude => Ok(LocalCheck::UseClaude(why)),
            _ => Err(Error::invalid(format!("Local AI unavailable: {why}."))),
        };
    }
    if cap.available {
        return Ok(LocalCheck::Ready(cap));
    }
    let why = cap.reason.unwrap_or_else(|| "local runtime unavailable".into());
    match settings.fallback {
        FallbackPolicy::SwitchToClaude => Ok(LocalCheck::UseClaude(why)),
        _ => Err(Error::invalid(format!(
            "Local AI unavailable: {why}. Retry, restart the local runtime or switch to Claude (AI Engines)."
        ))),
    }
}

/// Can AI Town's own LLM townspeople run on the local runtime now?
#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TownspeopleReadiness {
    pub ready: bool,
    pub chat_model: Option<String>,
    pub embedding_model: Option<String>,
    /// Why they cannot run, when they cannot.
    pub reasons: Vec<String>,
    /// Convex environment of the AI Town deployment (`ai-town/convex/util/llm.ts`).
    pub env: Vec<(String, String)>,
}

/// AI Town townspeople need Ollama (AI Town's Ollama config uses 1024-dimension
/// embeddings), a chat model and the embedding model, all installed. They are
/// local-only: there is no Claude path for them.
pub fn townspeople_readiness(settings: &AiEngineSettings, cap: &LocalCapacity) -> TownspeopleReadiness {
    let mut r = TownspeopleReadiness {
        chat_model: cap.model.clone(),
        embedding_model: cap.embedding_model.clone(),
        ..Default::default()
    };
    if settings.local.runtime != "ollama" {
        r.reasons.push(format!(
            "AI Town townspeople need Ollama; the local runtime is {}",
            runtime_name(&settings.local.runtime)
        ));
    }
    if !cap.available {
        r.reasons.push(cap.reason.clone().unwrap_or_else(|| "local AI unavailable".into()));
    }
    if cap.embedding_model.is_none() {
        r.reasons.push(format!(
            "the embedding model {} is not installed (~670 MB download)",
            catalog::AI_TOWN_EMBEDDING_MODEL
        ));
    }
    r.ready = r.reasons.is_empty();
    if r.ready {
        r.env = vec![
            ("OLLAMA_HOST".into(), settings.local.base_url.trim_end_matches('/').to_string()),
            ("OLLAMA_MODEL".into(), cap.model.clone().unwrap_or_default()),
            ("OLLAMA_EMBEDDING_MODEL".into(), cap.embedding_model.clone().unwrap_or_default()),
        ];
    }
    r
}

/// Provider of the configured endpoint.
pub fn provider_for(settings: &AiEngineSettings) -> Box<dyn LocalAiProvider> {
    provider::for_endpoint(&settings.local.runtime, &settings.local.base_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn townspeople_need_ollama_a_model_and_embeddings() {
        let mut s = AiEngineSettings::default();
        let mut cap = LocalCapacity {
            available: true,
            runtime: "ollama".into(),
            model: Some("llama3:latest".into()),
            context: 8192,
            ..Default::default()
        };
        let r = townspeople_readiness(&s, &cap);
        assert!(!r.ready);
        assert!(r.reasons[0].contains("mxbai-embed-large"), "{:?}", r.reasons);
        cap.embedding_model = Some("mxbai-embed-large:latest".into());
        let r = townspeople_readiness(&s, &cap);
        assert!(r.ready);
        assert!(r.env.contains(&("OLLAMA_MODEL".into(), "llama3:latest".into())));
        assert!(r.env.contains(&("OLLAMA_HOST".into(), "http://127.0.0.1:11434".into())));
        s.local.runtime = "lmstudio".into();
        let r = townspeople_readiness(&s, &cap);
        assert!(!r.ready && r.env.is_empty());
        cap.available = false;
        cap.reason = Some("Ollama is not answering".into());
        s.local.runtime = "ollama".into();
        assert_eq!(townspeople_readiness(&s, &cap).reasons, vec!["Ollama is not answering".to_string()]);
    }

    #[test]
    fn claude_code_env_points_every_model_at_the_local_runtime() {
        let env = claude_code_env("http://127.0.0.1:11434/", "qwen3:8b");
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("ANTHROPIC_BASE_URL"), Some("http://127.0.0.1:11434"));
        assert_eq!(get("ANTHROPIC_API_KEY"), Some(""));
        assert_eq!(get("ANTHROPIC_DEFAULT_HAIKU_MODEL"), Some("qwen3:8b"));
        assert_eq!(get("ANTHROPIC_SMALL_FAST_MODEL"), Some("qwen3:8b"));
    }

    /// Needs the local Ollama with llama3 (no tool calling): readable, but no agent may run on it.
    #[test]
    #[ignore]
    fn live_llama3_is_refused_for_agents() {
        let mut s = AiEngineSettings::default();
        s.local.model = Some("llama3".into());
        let cap = capacity(&s);
        assert!(cap.available, "{cap:?}");
        assert!(!cap.tools);
        let err = check_local_for_agent(&s).unwrap_err().to_string();
        assert!(err.contains("no tool calling"), "{err}");
        s.fallback = FallbackPolicy::SwitchToClaude;
        assert!(matches!(check_local_for_agent(&s).unwrap(), LocalCheck::UseClaude(_)));
    }

    #[test]
    fn unreachable_runtime_follows_the_fallback_policy() {
        let mut s = AiEngineSettings::default();
        // Nothing listens on port 9 (discard) on loopback.
        s.local.base_url = "http://127.0.0.1:9".into();
        s.local.model = Some("qwen3:8b".into());
        let err = check_local_for_agent(&s).unwrap_err().to_string();
        assert!(err.contains("Local AI unavailable"), "{err}");
        s.fallback = FallbackPolicy::SwitchToClaude;
        assert!(matches!(check_local_for_agent(&s).unwrap(), LocalCheck::UseClaude(_)));
    }
}
