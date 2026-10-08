//! Typed configuration and health checks per connection kind.

use std::collections::BTreeMap;
use std::path::Path;
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
    /// `stdio` (default), `http` or `sse`.
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    /// Non-secret environment variables.
    pub env: BTreeMap<String, String>,
    /// Environment variables whose values live in the credential store.
    pub secret_env: Vec<String>,
    /// Server URL for `http` / `sse`.
    pub url: String,
    /// Non-secret HTTP headers.
    pub headers: BTreeMap<String, String>,
    /// HTTP headers whose values live in the credential store.
    pub secret_headers: Vec<String>,
}

impl McpConfig {
    pub fn is_remote(&self) -> bool {
        matches!(self.transport.as_str(), "http" | "sse")
    }
}

/// GitLab through a personal access token (env `GITLAB_TOKEN` for agents / `glab`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitlabConfig {
    /// Defaults to `gitlab.com`.
    pub host: String,
    /// `group/project`.
    pub project: String,
}

/// A local shell the agents' commands run in (PowerShell, CMD, WSL...).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalConfig {
    /// `powershell`, `pwsh`, `cmd`, `wsl`, `bash` or `wt` (Windows Terminal).
    pub shell: String,
    /// WSL distribution name (optional).
    pub distro: String,
}

/// An HTTP API: agents get its base URL and, if set, the token as an environment variable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HttpConfig {
    pub base_url: String,
    /// Path requested by the health check (default `/`).
    pub health_path: String,
    /// Header carrying the token, e.g. `Authorization` (value `Bearer <token>`) or `X-Api-Key`.
    pub auth_header: String,
}

/// Name of the environment variable holding a connection's token for agents.
pub fn token_env_var(c: &Connection) -> String {
    format!("PCC_{}_TOKEN", c.id.replace('-', "_").to_ascii_uppercase())
}

/// Environment variables (name, value) given to sessions of agents granted `c`.
/// Values come from the credential store and are only set on the session process.
pub fn session_env(c: &Connection) -> Result<Vec<(String, String)>> {
    let secret = |key: &str| -> Result<Option<String>> {
        Ok(match &c.credential_ref {
            Some(r) => secrets::get(r)?.get(key).cloned(),
            None => None,
        })
    };
    Ok(match c.kind {
        ConnectionKind::Gitlab => {
            let cfg: GitlabConfig = parse(c)?;
            let mut v = vec![("GITLAB_HOST".to_string(), gitlab_host(&cfg))];
            if let Some(t) = secret("token")? {
                v.push(("GITLAB_TOKEN".into(), t));
            }
            v
        }
        ConnectionKind::Http => match secret("token")? {
            Some(t) => vec![(token_env_var(c), t)],
            None => vec![],
        },
        _ => vec![],
    })
}

fn gitlab_host(cfg: &GitlabConfig) -> String {
    if cfg.host.trim().is_empty() {
        "gitlab.com".into()
    } else {
        cfg.host.trim().trim_start_matches("https://").trim_end_matches('/').to_string()
    }
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
        ConnectionKind::Ssh | ConnectionKind::Sftp => {
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
            if c.is_remote() {
                if !(c.url.starts_with("http://") || c.url.starts_with("https://")) {
                    return Err(Error::invalid("remote MCP servers need an http(s) URL"));
                }
            } else if !matches!(c.transport.as_str(), "" | "stdio") {
                return Err(Error::invalid(format!("unknown MCP transport `{}`", c.transport)));
            } else if c.command.trim().is_empty() {
                return Err(Error::invalid("MCP connections need a command"));
            }
            for k in c.env.keys().chain(&c.secret_env) {
                if k.is_empty() || !k.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
                    return Err(Error::invalid(format!("invalid environment variable name `{k}`")));
                }
            }
        }
        ConnectionKind::Http => {
            let c: HttpConfig = serde_json::from_value(config.clone()).map_err(|e| Error::invalid(e.to_string()))?;
            if !(c.base_url.starts_with("http://") || c.base_url.starts_with("https://")) {
                return Err(Error::invalid("HTTP connections need an http(s) base URL"));
            }
        }
        ConnectionKind::Terminal => {
            let c: TerminalConfig =
                serde_json::from_value(config.clone()).map_err(|e| Error::invalid(e.to_string()))?;
            if !matches!(
                c.shell.as_str(),
                "powershell" | "pwsh" | "cmd" | "wsl" | "bash" | "zsh" | "fish" | "sh" | "wt"
            ) {
                return Err(Error::invalid("shell must be powershell, pwsh, cmd, wsl, bash, zsh, fish, sh or wt"));
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
    let values = match &c.credential_ref {
        Some(r) => secrets::get(r)?,
        None => BTreeMap::new(),
    };
    let mut process_env = Vec::new();
    // Secret values are referenced as ${VAR}; Claude Code expands them from its environment.
    let mut reference = |key: &str| -> Option<String> {
        let v = values.get(key)?;
        let var = format!(
            "PCC_SECRET_{}_{}",
            c.id.replace('-', "_").to_ascii_uppercase(),
            key.replace('-', "_").to_ascii_uppercase()
        );
        process_env.push((var.clone(), v.clone()));
        Some(format!("${{{var}}}"))
    };
    let config = if cfg.is_remote() {
        let mut headers: serde_json::Map<String, Value> =
            cfg.headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        for k in &cfg.secret_headers {
            if let Some(r) = reference(k) {
                headers.insert(k.clone(), json!(r));
            }
        }
        json!({"type": cfg.transport, "url": cfg.url, "headers": headers})
    } else {
        let mut env: serde_json::Map<String, Value> = cfg.env.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        for k in &cfg.secret_env {
            if let Some(r) = reference(k) {
                env.insert(k.clone(), json!(r));
            }
        }
        json!({"type": "stdio", "command": cfg.command, "args": cfg.args, "env": env})
    };
    Ok(Some(McpServerEntry { name: mcp_server_name(c), config, env: process_env }))
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
        ConnectionKind::Ssh | ConnectionKind::Sftp => match parse::<SshConfig>(c) {
            Ok(cfg) => blocking(move || check_ssh(&cfg)).await,
            Err(e) => CheckResult::err(e.to_string()),
        },
        ConnectionKind::Mcp | ConnectionKind::RobloxStudio => {
            let McpRuntime { config: cfg, env, headers } = match mcp_runtime(c) {
                Ok(x) => x,
                Err(e) => return CheckResult::err(e.to_string()),
            };
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
            let target = if cfg.is_remote() {
                mcp::Target::Http { url: &cfg.url, headers: &headers }
            } else {
                mcp::Target::Stdio { program: &cfg.command, args: &cfg.args, env: &env, cwd: root }
            };
            match mcp::probe(target, Duration::from_secs(20)).await {
                Ok(p) => {
                    let mut d = format!(
                        "MCP connected · {} · {} tool(s) · {} ms",
                        p.server_name.unwrap_or_else(|| "server".into()),
                        p.tools.len(),
                        p.latency_ms
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
        ConnectionKind::Gitlab => match parse::<GitlabConfig>(c) {
            Ok(cfg) => {
                let token =
                    c.credential_ref.as_ref().and_then(|r| secrets::get(r).ok()).and_then(|m| m.get("token").cloned());
                blocking(move || check_gitlab(&cfg, token.as_deref())).await
            }
            Err(e) => CheckResult::err(e.to_string()),
        },
        ConnectionKind::Http => match parse::<HttpConfig>(c) {
            Ok(cfg) => {
                let token =
                    c.credential_ref.as_ref().and_then(|r| secrets::get(r).ok()).and_then(|m| m.get("token").cloned());
                blocking(move || check_http(&cfg, token.as_deref())).await
            }
            Err(e) => CheckResult::err(e.to_string()),
        },
        ConnectionKind::Terminal => match parse::<TerminalConfig>(c) {
            Ok(cfg) => blocking(move || check_terminal(&cfg)).await,
            Err(e) => CheckResult::err(e.to_string()),
        },
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

/// Resolved configuration of an MCP connection, with secret values filled in.
pub struct McpRuntime {
    pub config: McpConfig,
    pub env: Vec<(String, String)>,
    pub headers: BTreeMap<String, String>,
}

pub fn mcp_runtime(c: &Connection) -> Result<McpRuntime> {
    let cfg: McpConfig = parse(c)?;
    let secrets = match &c.credential_ref {
        Some(r) => secrets::get(r)?,
        None => BTreeMap::new(),
    };
    let mut env: Vec<(String, String)> = cfg.env.clone().into_iter().collect();
    env.extend(secrets.iter().filter(|(k, _)| cfg.secret_env.contains(k)).map(|(k, v)| (k.clone(), v.clone())));
    let mut headers = cfg.headers.clone();
    headers.extend(secrets.into_iter().filter(|(k, _)| cfg.secret_headers.contains(k)));
    Ok(McpRuntime { config: cfg, env, headers })
}

fn http_get(url: &str, header: Option<(&str, String)>) -> std::result::Result<u16, String> {
    let mut req = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build().get(url);
    if let Some((k, v)) = header {
        req = req.set(k, &v);
    }
    match req.call() {
        Ok(r) => Ok(r.status()),
        Err(ureq::Error::Status(code, _)) => Ok(code),
        Err(e) => Err(e.to_string()),
    }
}

fn check_http(cfg: &HttpConfig, token: Option<&str>) -> CheckResult {
    let path = if cfg.health_path.is_empty() { "/" } else { cfg.health_path.as_str() };
    let url = format!("{}{}", cfg.base_url.trim_end_matches('/'), path);
    let header = match (token, cfg.auth_header.trim()) {
        (Some(t), h) if !h.is_empty() => Some((
            h,
            if h.eq_ignore_ascii_case("authorization") && !t.contains(' ') {
                format!("Bearer {t}")
            } else {
                t.to_string()
            },
        )),
        _ => None,
    };
    match http_get(&url, header) {
        Ok(code) if code < 400 => CheckResult::ok(format!("HTTP {code} from {url}")),
        Ok(code @ (401 | 403)) => CheckResult::down(format!("HTTP {code}: authentication refused")),
        Ok(code) => CheckResult::down(format!("HTTP {code} from {url}")),
        Err(e) => CheckResult::down(e),
    }
}

fn check_gitlab(cfg: &GitlabConfig, token: Option<&str>) -> CheckResult {
    let host = gitlab_host(cfg);
    let Some(token) = token else {
        return CheckResult::down("no access token stored for this connection");
    };
    match http_get(&format!("https://{host}/api/v4/user"), Some(("PRIVATE-TOKEN", token.to_string()))) {
        Ok(200) => CheckResult::ok(format!("authenticated on {host}")),
        Ok(code) => CheckResult::down(format!("{host} answered HTTP {code}")),
        Err(e) => CheckResult::down(e),
    }
}

fn check_terminal(cfg: &TerminalConfig) -> CheckResult {
    let (program, args): (&str, Vec<&str>) = match cfg.shell.as_str() {
        "powershell" => ("powershell", vec!["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
        "pwsh" => ("pwsh", vec!["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
        "cmd" => ("cmd", vec!["/C", "ver"]),
        "wsl" => ("wsl", vec!["--status"]),
        "bash" => ("bash", vec!["--version"]),
        "zsh" => ("zsh", vec!["--version"]),
        "fish" => ("fish", vec!["--version"]),
        "sh" => {
            return match pcc_platform::find_program("sh") {
                Some(p) => CheckResult::ok(format!("sh · {}", p.display())),
                None => CheckResult::down("sh is not installed"),
            }
        }
        "wt" => {
            return match pcc_platform::find_program("wt") {
                Some(p) => CheckResult::ok(format!("wt · {}", p.display())),
                None if !cfg!(windows) => CheckResult::down("Windows Terminal is only available on Windows"),
                None => CheckResult::down("wt is not installed"),
            }
        }
        other => return CheckResult::err(format!("unknown shell `{other}`")),
    };
    if !cfg!(windows) && matches!(program, "powershell" | "cmd" | "wsl") {
        return CheckResult::down(format!("{} is only available on Windows", cfg.shell));
    }
    match std_command(program).args(&args).output() {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout).replace('\0', "");
            let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("available");
            CheckResult::ok(format!("{} · {first}", cfg.shell))
        }
        Ok(_) => CheckResult::down(format!("{} is installed but did not answer", cfg.shell)),
        Err(_) => CheckResult::down(format!("{} is not installed", cfg.shell)),
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

/// Roblox Studio exists only on Windows: elsewhere it is reported as not
/// installed (MCP candidates are still listed).
pub fn roblox_detect() -> RobloxDetection {
    let mut d = RobloxDetection::default();
    if let Some(local) = pcc_platform::paths::local_data_dir().filter(|_| cfg!(windows)) {
        let versions = local.join("Roblox").join("Versions");
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
    d.studio_running = d.studio_installed
        && pcc_platform::process::list().iter().any(|p| p.name.eq_ignore_ascii_case("RobloxStudioBeta.exe"));
    d.mcp_candidates = known_mcp_servers()
        .into_iter()
        .filter(|c| {
            let hay = format!("{} {} {}", c.name, c.config.command, c.config.args.join(" ")).to_ascii_lowercase();
            hay.contains("roblox") || hay.contains("rbx")
        })
        .collect();
    d
}

/// Converts a Claude Code / Claude Desktop server entry into a NEXUS MCP config.
/// Environment and header values may be secrets: only their names are kept and
/// the user enters the values again (they then go to the credential store).
pub fn mcp_config_from_claude(s: &Value) -> Option<McpConfig> {
    let names = |k: &str| -> Vec<String> {
        s.get(k).and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default()
    };
    match s.get("type").and_then(Value::as_str).unwrap_or("stdio") {
        t @ ("http" | "sse") => Some(McpConfig {
            transport: t.into(),
            url: s.get("url").and_then(Value::as_str)?.to_string(),
            secret_headers: names("headers"),
            ..Default::default()
        }),
        "stdio" => Some(McpConfig {
            transport: "stdio".into(),
            command: s.get("command").and_then(Value::as_str)?.to_string(),
            args: s
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            secret_env: names("env"),
            ..Default::default()
        }),
        _ => None,
    }
}

/// MCP servers registered in the user's Claude Code (`~/.claude.json`) and Claude Desktop configs.
pub fn known_mcp_servers() -> Vec<McpCandidate> {
    let mut out = Vec::new();
    let mut files = vec![(pcc_platform::paths::home_dir().join(".claude.json"), "Claude Code")];
    // %APPDATA%\Claude on Windows, ~/.config/Claude on Linux.
    if let Some(a) = pcc_platform::paths::config_dir() {
        files.push((a.join("Claude").join("claude_desktop_config.json"), "Claude Desktop"));
    }
    for (f, source) in files {
        let Some(v) = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
            continue;
        };
        if let Some(servers) = v.get("mcpServers").and_then(Value::as_object) {
            for (name, s) in servers {
                if let Some(config) = mcp_config_from_claude(s) {
                    out.push(McpCandidate { name: name.clone(), source: source.into(), config });
                }
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
            enabled: true,
            last_used: None,
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
    fn new_kinds_validation() {
        assert!(validate(ConnectionKind::Mcp, &json!({"transport": "http", "url": "https://x/mcp"})).is_ok());
        assert!(validate(ConnectionKind::Mcp, &json!({"transport": "http", "url": "ftp://x"})).is_err());
        assert!(validate(ConnectionKind::Mcp, &json!({"transport": "carrier-pigeon", "command": "x"})).is_err());
        assert!(validate(ConnectionKind::Http, &json!({"baseUrl": "https://api.example.com"})).is_ok());
        assert!(validate(ConnectionKind::Http, &json!({"baseUrl": "api.example.com"})).is_err());
        assert!(validate(ConnectionKind::Terminal, &json!({"shell": "pwsh"})).is_ok());
        assert!(validate(ConnectionKind::Terminal, &json!({"shell": "zsh"})).is_ok());
        assert!(validate(ConnectionKind::Terminal, &json!({"shell": "tcsh"})).is_err());
        assert!(validate(ConnectionKind::Sftp, &json!({"host": "h", "user": "u", "auth": "key"})).is_ok());
    }

    #[test]
    fn remote_mcp_entry() {
        let c = conn(
            ConnectionKind::Mcp,
            json!({"transport": "http", "url": "https://mcp.example.com/mcp", "headers": {"X-Team": "a"}}),
        );
        let entry = mcp_server_entry(&c).unwrap().unwrap();
        assert_eq!(entry.config["type"], "http");
        assert_eq!(entry.config["url"], "https://mcp.example.com/mcp");
        assert_eq!(entry.config["headers"]["X-Team"], "a");
        assert_eq!(token_env_var(&c), "PCC_ROBLOX_STUDIO_TOKEN");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn terminal_check_finds_cmd() {
        let c = conn(ConnectionKind::Terminal, json!({"shell": "cmd"}));
        assert_eq!(check_connection(&c, Path::new(".")).await.status, ConnectionStatus::Connected);
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
