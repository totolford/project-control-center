//! Snapshot of what the installed Claude Code really exposes: models,
//! commands and skills, agents, MCP servers, context usage, rate limits,
//! effective settings and plugins. Everything comes from Claude Code itself;
//! a section it does not answer is reported in `unavailable` instead of guessed.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::control::ControlClient;
use crate::detect;
use crate::process::std_command;
use pcc_core::ClaudeInfo;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeEnvironment {
    pub cli: ClaudeInfo,
    pub captured_at: String,
    /// Models available to this account (`value`, `displayName`, `description`, effort support...).
    pub models: Vec<Value>,
    /// Slash commands and skills (`name`, `description`, `argumentHint`).
    pub commands: Vec<Value>,
    /// Sub-agents defined for Claude Code (`name`, `description`).
    pub agents: Vec<Value>,
    /// Account as reported by Claude Code (email, organization, subscription).
    pub account: Value,
    pub permission_mode: Option<String>,
    pub output_style: Option<String>,
    pub output_styles: Vec<Value>,
    pub fast_mode: Value,
    /// MCP servers with status, scope and transport config.
    pub mcp_servers: Vec<Value>,
    /// Context window usage of a fresh session in the project.
    pub context: Value,
    /// Session usage and subscription rate limits.
    pub usage: Value,
    /// Effective settings (environment variable values are hidden).
    pub settings: Value,
    /// Installed plugins (`claude plugin list --json`).
    pub plugins: Vec<Value>,
    /// Sections Claude Code did not answer, with the reason.
    pub unavailable: Vec<String>,
}

pub const REDACTED: &str = "••••••";

/// Hides `env` and `headers` values of an MCP server config (they often hold secrets).
pub fn redact_mcp_config(config: &Value) -> Value {
    let mut c = config.clone();
    for key in ["env", "headers"] {
        if let Some(Value::Object(map)) = c.get_mut(key) {
            for v in map.values_mut() {
                *v = json!(REDACTED);
            }
        }
    }
    c
}

/// Restores the real values of a redacted config by matching it against the
/// unredacted configs NEXUS read from Claude Code (they never leave the backend).
pub fn unredact_mcp_config(given: &Value, originals: &[Value]) -> Value {
    originals.iter().find(|o| &redact_mcp_config(o) == given).cloned().unwrap_or_else(|| given.clone())
}

/// Hides the values of `env` maps: they frequently hold secrets.
pub fn redact_settings(mut v: Value) -> Value {
    fn walk(v: &mut Value) {
        match v {
            Value::Object(map) => {
                for (k, child) in map.iter_mut() {
                    if k == "env" {
                        if let Value::Object(env) = child {
                            for val in env.values_mut() {
                                *val = json!("••••••");
                            }
                        }
                    } else {
                        walk(child);
                    }
                }
            }
            Value::Array(a) => a.iter_mut().for_each(walk),
            _ => {}
        }
    }
    walk(&mut v);
    v
}

fn array(v: &Value, key: &str) -> Vec<Value> {
    v.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Collects the environment. Takes a few seconds (one Claude Code start-up).
pub async fn inspect(cwd: &Path) -> ClaudeEnvironment {
    let cli = detect::detect().await;
    let mut env = ClaudeEnvironment { captured_at: pcc_core::now(), ..Default::default() };
    let Some(path) = cli.path.clone().map(std::path::PathBuf::from) else {
        env.unavailable.push("Claude Code is not installed".into());
        env.cli = cli;
        return env;
    };
    env.cli = cli;
    let timeout = Duration::from_secs(45);
    match ControlClient::start(&path, cwd).await {
        Ok(mut c) => {
            match c.request("initialize", json!({"hooks": null}), timeout).await {
                Ok(init) => {
                    env.models = array(&init, "models");
                    env.commands = array(&init, "commands");
                    env.agents = array(&init, "agents");
                    env.account = init.get("account").cloned().unwrap_or(Value::Null);
                    env.permission_mode =
                        init.get("current_permission_mode").and_then(Value::as_str).map(str::to_string);
                    env.output_style = init.get("output_style").and_then(Value::as_str).map(str::to_string);
                    env.output_styles = array(&init, "available_output_styles");
                    env.fast_mode = json!({"state": init.get("fast_mode_state"), "disabledReason": init.get("fast_mode_disabled_reason")});
                }
                Err(e) => env.unavailable.push(format!("initialize: {e}")),
            }
            match c.request("mcp_status", json!({}), timeout).await {
                Ok(v) => env.mcp_servers = array(&v, "mcpServers"),
                Err(e) => env.unavailable.push(format!("MCP status: {e}")),
            }
            match c.request("get_context_usage", json!({}), timeout).await {
                Ok(v) => env.context = v,
                Err(e) => env.unavailable.push(format!("context usage: {e}")),
            }
            match c.request("get_usage", json!({}), timeout).await {
                Ok(v) => env.usage = v,
                Err(e) => env.unavailable.push(format!("usage: {e}")),
            }
            match c.request("get_settings", json!({}), timeout).await {
                Ok(v) => env.settings = redact_settings(v),
                Err(e) => env.unavailable.push(format!("settings: {e}")),
            }
            c.close().await;
        }
        Err(e) => env.unavailable.push(format!("control session: {e}")),
    }
    let plugin_path = path.clone();
    match tokio::task::spawn_blocking(move || std_command(&plugin_path).args(["plugin", "list", "--json"]).output())
        .await
    {
        Ok(Ok(o)) if o.status.success() => match serde_json::from_slice::<Vec<Value>>(&o.stdout) {
            Ok(list) => env.plugins = list,
            Err(e) => env.unavailable.push(format!("plugins: unexpected output ({e})")),
        },
        Ok(Ok(o)) => env.unavailable.push(format!("plugins: {}", String::from_utf8_lossy(&o.stderr).trim())),
        Ok(Err(e)) => env.unavailable.push(format!("plugins: {e}")),
        Err(e) => env.unavailable.push(format!("plugins: {e}")),
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_configs_round_trip_through_redaction() {
        let real = json!({"type": "stdio", "command": "x", "env": {"API_KEY": "secret"}});
        let other = json!({"type": "http", "url": "https://a", "headers": {"Authorization": "Bearer t"}});
        let shown = redact_mcp_config(&real);
        assert_eq!(shown["env"]["API_KEY"], REDACTED);
        assert_eq!(unredact_mcp_config(&shown, &[other.clone(), real.clone()]), real);
        let typed = json!({"type": "stdio", "command": "y", "env": {"K": "v"}});
        assert_eq!(unredact_mcp_config(&typed, &[real]), typed);
    }

    #[test]
    fn redacts_env_values_everywhere() {
        let v = json!({"effective": {"env": {"API_KEY": "secret"}, "model": "opus"}, "sources": [{"settings": {"env": {"T": "x"}}}]});
        let r = redact_settings(v);
        assert_eq!(r["effective"]["env"]["API_KEY"], "••••••");
        assert_eq!(r["effective"]["model"], "opus");
        assert_eq!(r["sources"][0]["settings"]["env"]["T"], "••••••");
    }
}
