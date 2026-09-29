//! Typed configuration and health checks per connection kind.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pcc_claude::process::std_command;
use pcc_core::{Connection, ConnectionKind, ConnectionStatus, Error, Result};

use crate::{github, mcp, secrets};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SshConfig {
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    /// Path to a private key file (the key itself is never copied).
    pub key_path: Option<String>,
    /// `key`, `agent` or `password`.
    pub auth: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    pub command: String,
    pub args: Vec<String>,
    /// Non-secret environment variables.
    pub env: BTreeMap<String, String>,
    /// Environment variables whose values live in the credential store.
    pub secret_env: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub status: ConnectionStatus,
    pub detail: String,
}

impl CheckResult {
    fn ok(d: impl Into<String>) -> Self {
        CheckResult { status: ConnectionStatus::Connected, detail: d.into() }
    }
    fn down(d: impl Into<String>) -> Self {
        CheckResult { status: ConnectionStatus::Disconnected, detail: d.into() }
    }
    fn err(d: impl Into<String>) -> Self {
        CheckResult { status: ConnectionStatus::Error, detail: d.into() }
    }
}

pub fn parse<T: for<'de> Deserialize<'de>>(c: &Connection) -> Result<T> {
    serde_json::from_value(c.config.clone())
        .map_err(|e| Error::invalid(format!("invalid configuration for {}: {e}", c.name)))
}

/// Validates a configuration before it is saved.
pub fn validate(kind: ConnectionKind, config: &Value) -> Result<()> {
    match kind {
        ConnectionKind::Ssh => {
            let c: SshConfig = serde_json::from_value(config.clone()).map_err(|e| Error::invalid(e.to_string()))?;
            if c.host.trim().is_empty() || c.user.trim().is_empty() {
                return Err(Error::invalid("SSH connections need a host and a user"));
            }
            if c.host.contains(char::is_whitespace) || c.user.contains(char::is_whitespace) {
                return Err(Error::invalid("host and user cannot contain spaces"));
            }
        }
        ConnectionKind::Mcp | ConnectionKind::RobloxStudio => {
            let c: McpConfig = serde_json::from_value(config.clone()).map_err(|e| Error::invalid(e.to_string()))?;
            if c.command.trim().is_empty() {
                return Err(Error::invalid("MCP connections need a command"));
            }
            for k in c.env.keys().chain(&c.secret_env) {
                if k.is_empty() || !k.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
                    return Err(Error::invalid(format!("invalid environment variable name `{k}`")));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Name under which an MCP connection is exposed to agents (`mcp__<name>__tool`).
pub fn mcp_server_name(c: &Connection) -> String {
    c.id.clone()
}

/// An MCP server to add to an agent's `--mcp-config`.
#[derive(Debug, Clone, PartialEq)]
pub struct McpServerEntry {
    pub name: String,
    pub config: Value,
    /// Environment variables carrying secret values for the session process.
    pub env: Vec<(String, String)>,
}

/// Builds the MCP entry of a connection. Secret values are referenced as
/// `${VAR}` in the config file so they never touch the disk.
pub fn mcp_server_entry(c: &Connection) -> Result<Option<McpServerEntry>> {
    if !matches!(c.kind, ConnectionKind::Mcp | ConnectionKind::RobloxStudio) {
        return Ok(None);
    }
    let cfg: McpConfig = parse(c)?;
    let mut env: serde_json::Map<String, Value> = cfg.env.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    let mut process_env = Vec::new();
    if let Some(r) = &c.credential_ref {
        let values = secrets::get(r)?;
        for k in &cfg.secret_env {
            if let Some(v) = values.get(k) {
                let var = format!("PCC_SECRET_{}_{}", c.id.replace('-', "_").to_ascii_uppercase(), k);
                env.insert(k.clone(), json!(format!("${{{var}}}")));
                process_env.push((var, v.clone()));
            }
        }
    }
    Ok(Some(McpServerEntry {
        name: mcp_server_name(c),
        config: json!({"type": "stdio", "command": cfg.command, "args": cfg.args, "env": env}),
        env: process_env,
    }))
}

pub async fn check_connection(c: &Connection, root: &Path) -> CheckResult {
    match c.kind {
        ConnectionKind::Local => {
            if root.is_dir() {
                CheckResult::ok(root.display().to_string())
            } else {
                CheckResult::down("project folder is missing")
            }
        }
        ConnectionKind::Git => {
            let root = root.to_path_buf();
            blocking(move || {
                match std_command("git").args(["rev-parse", "--abbrev-ref", "HEAD"]).current_dir(&root).output() {
                    Ok(o) if o.status.success() => {
                        CheckResult::ok(format!("branch {}", String::from_utf8_lossy(&o.stdout).trim()))
                    }
                    Ok(_) => CheckResult::down("not a git repository"),
                    Err(e) => CheckResult::err(format!("git not available: {e}")),
                }
            })
            .await
        }
        ConnectionKind::Github => {
            let root = root.to_path_buf();
            let repo_cfg = c.config.get("repo").and_then(Value::as_str).map(str::to_string);
            blocking(move || {
                let remote = std_command("git")
                    .args(["remote", "get-url", "origin"])
                    .current_dir(&root)
                    .output()
                    .ok()
                    .filter(|o| o.status.success())
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
                let st = github::status(&root, remote.as_deref());
                let repo = repo_cfg.or(st.repo.clone());
                match (st.authenticated, repo) {
                    (true, Some(r)) => CheckResult::ok(format!("{} · {r}", st.account.unwrap_or_default())),
                    (true, None) => CheckResult::down("signed in, but no GitHub remote named `origin`"),
                    (false, _) => CheckResult::down(st.detail.unwrap_or_else(|| "not signed in".into())),
                }
            })
            .await
        }
        ConnectionKind::Ssh => match parse::<SshConfig>(c) {
            Ok(cfg) => blocking(move || check_ssh(&cfg)).await,
            Err(e) => CheckResult::err(e.to_string()),
        },
        ConnectionKind::Mcp | ConnectionKind::RobloxStudio => {
            let cfg: McpConfig = match parse(c) {
                Ok(c) => c,
                Err(e) => return CheckResult::err(e.to_string()),
            };
            let mut env: Vec<(String, String)> = cfg.env.clone().into_iter().collect();
            if let Some(r) = &c.credential_ref {
                match secrets::get(r) {
                    Ok(vals) => env.extend(vals.into_iter().filter(|(k, _)| cfg.secret_env.contains(k))),
                    Err(e) => return CheckResult::err(e.to_string()),
                }
            }
            let studio = if c.kind == ConnectionKind::RobloxStudio {
                let rd = roblox_detect();
                Some(if rd.studio_running {
                    "Studio running"
                } else if rd.studio_installed {
                    "Studio not running"
                } else {
                    "Studio not installed"
                })
            } else {
                None
            };
            match mcp::probe(&cfg.command, &cfg.args, &env, root, Duration::from_secs(20)).await {
                Ok(p) => {
                    let mut d = format!(
                        "MCP connected · {} · {} tool(s)",
                        p.server_name.unwrap_or_else(|| "server".into()),
                        p.tools.len()
                    );
                    if let Some(s) = studio {
                        d.push_str(&format!(" · {s}"));
                    }
                    CheckResult::ok(d)
                }
                Err(e) => CheckResult::down(match studio {
                    Some(s) => format!("MCP: {e} · {s}"),
                    None => format!("MCP: {e}"),
                }),
            }
        }
        ConnectionKind::Docker => {
            blocking(|| match std_command("docker").args(["info", "--format", "{{.ServerVersion}}"]).output() {
                Ok(o) if o.status.success() => {
                    CheckResult::ok(format!("Docker engine {}", String::from_utf8_lossy(&o.stdout).trim()))
                }
                Ok(o) => CheckResult::down(
                    String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("engine not reachable").to_string(),
                ),
                Err(_) => CheckResult::down("Docker CLI not installed"),
            })
            .await
        }
    }
}

async fn blocking<F: FnOnce() -> CheckResult + Send + 'static>(f: F) -> CheckResult {
    tokio::task::spawn_blocking(f).await.unwrap_or_else(|e| CheckResult::err(e.to_string()))
}

/// `ssh -o BatchMode=yes` never prompts, so password auth cannot be verified
/// non-interactively; key and agent auth can.
fn check_ssh(cfg: &SshConfig) -> CheckResult {
    if cfg.auth == "password" {
        return CheckResult::down(
            "password authentication cannot be used non-interactively; configure an SSH key or ssh-agent",
        );
    }
    let mut args: Vec<String> = vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
    ];
    if let Some(p) = cfg.port {
        args.extend(["-p".into(), p.to_string()]);
    }
    if let Some(k) = cfg.key_path.as_ref().filter(|k| !k.is_empty()) {
        args.extend(["-i".into(), k.clone()]);
    }
    args.push(format!("{}@{}", cfg.user, cfg.host));
    args.push("echo pcc-ok".into());
    match std_command("ssh").args(&args).output() {
        Ok(o) if String::from_utf8_lossy(&o.stdout).contains("pcc-ok") => {
            CheckResult::ok(format!("{}@{} reachable", cfg.user, cfg.host))
        }
        Ok(o) => CheckResult::down(
            String::from_utf8_lossy(&o.stderr).trim().lines().last().unwrap_or("connection failed").to_string(),
        ),
        Err(e) => CheckResult::err(format!("OpenSSH client not available: {e}")),
    }
}

// ------------------------------------------------------------ Roblox Studio

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpCandidate {
    pub name: String,
    pub source: String,
    pub config: McpConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RobloxDetection {
    pub studio_installed: bool,
    pub studio_path: Option<String>,
    pub studio_running: bool,
    /// Roblox-related MCP servers already registered in Claude Code / Claude Desktop.
    pub mcp_candidates: Vec<McpCandidate>,
}

pub fn roblox_detect() -> RobloxDetection {
    let mut d = RobloxDetection::default();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let versions = PathBuf::from(local).join("Roblox").join("Versions");
        if let Ok(rd) = std::fs::read_dir(&versions) {
            for e in rd.flatten() {
                let exe = e.path().join("RobloxStudioBeta.exe");
                if exe.is_file() {
                    d.studio_installed = true;
                    d.studio_path = Some(exe.to_string_lossy().into_owned());
                    break;
                }
            }
        }
    }
    d.studio_running = std_command("tasklist")
        .args(["/FI", "IMAGENAME eq RobloxStudioBeta.exe", "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("RobloxStudioBeta.exe"))
        .unwrap_or(false);
    d.mcp_candidates = known_mcp_servers()
        .into_iter()
        .filter(|c| {
            let hay = format!("{} {} {}", c.name, c.config.command, c.config.args.join(" ")).to_ascii_lowercase();
            hay.contains("roblox") || hay.contains("rbx")
        })
        .collect();
    d
}

/// MCP servers registered in the user's Claude Code (`~/.claude.json`) and Claude Desktop configs.
pub fn known_mcp_servers() -> Vec<McpCandidate> {
    let mut out = Vec::new();
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    let mut files = Vec::new();
    if let Some(h) = &home {
        files.push((h.join(".claude.json"), "Claude Code"));
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        files.push((PathBuf::from(a).join("Claude").join("claude_desktop_config.json"), "Claude Desktop"));
    }
    for (f, source) in files {
        let Some(v) = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
            continue;
        };
        if let Some(servers) = v.get("mcpServers").and_then(Value::as_object) {
            for (name, s) in servers {
                let Some(command) = s.get("command").and_then(Value::as_str) else { continue };
                out.push(McpCandidate {
                    name: name.clone(),
                    source: source.into(),
                    config: McpConfig {
                        command: command.into(),
                        args: s
                            .get("args")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                            .unwrap_or_default(),
                        // Values may be secrets: only keep names; the user re-enters values.
                        env: BTreeMap::new(),
                        secret_env: s
                            .get("env")
                            .and_then(Value::as_object)
                            .map(|o| o.keys().cloned().collect())
                            .unwrap_or_default(),
                    },
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(kind: ConnectionKind, config: Value) -> Connection {
        Connection {
            id: "roblox-studio".into(),
            name: "Roblox Studio".into(),
            kind,
            config,
            credential_ref: None,
            status: ConnectionStatus::Unknown,
            status_detail: None,
            last_checked: None,
            created_at: pcc_core::now(),
        }
    }

    #[test]
    fn validation() {
        assert!(validate(ConnectionKind::Ssh, &json!({"host": "10.0.0.1", "user": "admin", "auth": "key"})).is_ok());
        assert!(validate(ConnectionKind::Ssh, &json!({"host": "", "user": "admin"})).is_err());
        assert!(validate(ConnectionKind::Mcp, &json!({"command": "x", "secretEnv": ["BAD-NAME"]})).is_err());
        assert!(validate(ConnectionKind::Mcp, &json!({"command": ""})).is_err());
    }

    #[test]
    fn mcp_entry_without_secrets() {
        let c = conn(
            ConnectionKind::RobloxStudio,
            json!({"command": "rbx-studio-mcp.exe", "args": ["--stdio"], "env": {"MODE": "x"}}),
        );
        let entry = mcp_server_entry(&c).unwrap().unwrap();
        assert_eq!(entry.name, "roblox-studio");
        assert_eq!(entry.config["args"], json!(["--stdio"]));
        assert_eq!(entry.config["env"]["MODE"], "x");
        assert!(entry.env.is_empty());
        assert!(mcp_server_entry(&conn(ConnectionKind::Ssh, json!({}))).unwrap().is_none());
    }

    #[tokio::test]
    async fn mcp_probe_reports_failure_for_missing_binary() {
        let c = conn(ConnectionKind::Mcp, json!({"command": "definitely-not-a-real-mcp-server-binary"}));
        let r = check_connection(&c, Path::new(".")).await;
        assert_eq!(r.status, ConnectionStatus::Disconnected);
        assert!(r.detail.contains("cannot start"), "{}", r.detail);
    }
}
