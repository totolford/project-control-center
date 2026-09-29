//! Agent providers: the runtimes an agent can run on.
//!
//! Only providers with a working adapter can be selected. Others are listed
//! with their detection status so the UI can show them as unavailable instead
//! of pretending to support them.

use serde::Serialize;

use pcc_claude::process::std_command;
use pcc_core::{Error, Result, CLAUDE_CODE_PROVIDER};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// An adapter exists and the runtime is installed: agents can use it.
    pub available: bool,
    /// The runtime was found on this machine (even if no adapter exists yet).
    pub installed: bool,
    pub detail: String,
}

/// A runtime able to host an agent session.
pub trait AgentProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    /// Whether this build ships an adapter that drives the runtime.
    fn has_adapter(&self) -> bool;
    /// Installation detection: `Some(detail)` when installed.
    fn detect(&self) -> Option<String>;

    fn info(&self) -> ProviderInfo {
        let found = self.detect();
        let installed = found.is_some();
        let available = installed && self.has_adapter();
        let detail = match (self.has_adapter(), found) {
            (true, Some(d)) => d,
            (true, None) => "Not installed".into(),
            (false, Some(d)) => format!("{d} detected · adapter not available yet"),
            (false, None) => "Unavailable · adapter not available yet".into(),
        };
        ProviderInfo {
            id: self.id().into(),
            name: self.name().into(),
            description: self.description().into(),
            available,
            installed,
            detail,
        }
    }
}

struct ClaudeCode;

impl AgentProvider for ClaudeCode {
    fn id(&self) -> &'static str {
        CLAUDE_CODE_PROVIDER
    }
    fn name(&self) -> &'static str {
        "Claude Code"
    }
    fn description(&self) -> &'static str {
        "Anthropic's Claude Code CLI, driven through its stream-json protocol"
    }
    fn has_adapter(&self) -> bool {
        true
    }
    fn detect(&self) -> Option<String> {
        let path = pcc_claude::find_claude()?;
        let version = std_command(&path)
            .arg("--version")
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().next().map(str::to_string));
        Some(format!("Claude Code {}", version.unwrap_or_else(|| "installed".into())))
    }
}

/// A CLI we can detect but cannot drive yet.
struct DetectOnly {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    program: Option<&'static str>,
}

impl AgentProvider for DetectOnly {
    fn id(&self) -> &'static str {
        self.id
    }
    fn name(&self) -> &'static str {
        self.name
    }
    fn description(&self) -> &'static str {
        self.description
    }
    fn has_adapter(&self) -> bool {
        false
    }
    fn detect(&self) -> Option<String> {
        let program = self.program?;
        let out = std_command(program).arg("--version").output().ok()?;
        out.status.success().then(|| {
            let v = String::from_utf8_lossy(&out.stdout);
            v.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).unwrap_or_else(|| self.name.into())
        })
    }
}

pub fn registry() -> Vec<Box<dyn AgentProvider>> {
    vec![
        Box::new(ClaudeCode),
        Box::new(DetectOnly {
            id: "codex",
            name: "Codex CLI",
            description: "OpenAI Codex command-line agent",
            program: Some("codex"),
        }),
        Box::new(DetectOnly {
            id: "custom-cli",
            name: "Other CLI",
            description: "Any command-line agent through a generic adapter",
            program: None,
        }),
        Box::new(DetectOnly {
            id: "mcp-worker",
            name: "MCP Worker",
            description: "A worker backed directly by an MCP server",
            program: None,
        }),
    ]
}

/// Blocking: runs detection commands.
pub fn list() -> Vec<ProviderInfo> {
    registry().iter().map(|p| p.info()).collect()
}

/// Rejects providers without an adapter.
pub fn ensure_supported(id: &str) -> Result<()> {
    match registry().into_iter().find(|p| p.id() == id) {
        Some(p) if p.has_adapter() => Ok(()),
        Some(p) => Err(Error::invalid(format!("{} agents are not supported yet", p.name()))),
        None => Err(Error::invalid(format!("unknown agent provider `{id}`"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claude_code_is_selectable() {
        assert!(ensure_supported(CLAUDE_CODE_PROVIDER).is_ok());
        assert!(ensure_supported("codex").is_err());
        assert!(ensure_supported("nope").is_err());
        let ids: Vec<String> = registry().iter().map(|p| p.id().to_string()).collect();
        assert_eq!(ids[0], CLAUDE_CODE_PROVIDER);
        let custom = registry().into_iter().find(|p| p.id() == "custom-cli").unwrap().info();
        assert!(!custom.available);
    }
}
