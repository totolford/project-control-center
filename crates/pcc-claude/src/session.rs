//! A running Claude Code session process.

use std::path::PathBuf;
use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::process::{attach_to_app_job, command, kill_tree};
use crate::protocol::{self, Inbound};
use pcc_core::{Error, Result};

/// Everything needed to launch one agent session.
#[derive(Debug, Clone, Default)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// File whose content is appended to Claude Code's system prompt.
    pub system_prompt_file: Option<PathBuf>,
    /// Built-in tools to enable (`--tools`).
    pub tools: Vec<String>,
    /// File containing the `--mcp-config` JSON.
    pub mcp_config_file: Option<PathBuf>,
    /// SDK (in-process) MCP servers answered by the host.
    pub sdk_mcp_servers: Vec<String>,
    /// New session id (`--session-id`), mutually exclusive with `resume`.
    pub session_id: Option<String>,
    pub resume: Option<String>,
    pub setting_sources: Option<String>,
    pub add_dirs: Vec<PathBuf>,
    pub env: Vec<(String, String)>,
    pub max_budget_usd: Option<f64>,
    pub name: Option<String>,
    /// Reasoning effort (`--effort`).
    pub effort: Option<String>,
    /// Start without skills and slash commands (`--disable-slash-commands`).
    pub disable_skills: bool,
}

impl LaunchSpec {
    pub fn args(&self) -> Vec<String> {
        let mut a: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "default",
            "--permission-prompt-tool",
            "stdio",
            "--strict-mcp-config",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if let Some(m) = &self.model {
            a.extend(["--model".into(), m.clone()]);
        }
        if let Some(f) = &self.system_prompt_file {
            a.extend(["--append-system-prompt-file".into(), f.to_string_lossy().into_owned()]);
        }
        if !self.tools.is_empty() {
            a.extend(["--tools".into(), self.tools.join(",")]);
        }
        if let Some(f) = &self.mcp_config_file {
            a.extend(["--mcp-config".into(), f.to_string_lossy().into_owned()]);
        }
        if let Some(r) = &self.resume {
            a.extend(["--resume".into(), r.clone()]);
        } else if let Some(id) = &self.session_id {
            a.extend(["--session-id".into(), id.clone()]);
        }
        if let Some(s) = &self.setting_sources {
            a.extend(["--setting-sources".into(), s.clone()]);
        }
        for d in &self.add_dirs {
            a.extend(["--add-dir".into(), d.to_string_lossy().into_owned()]);
        }
        if let Some(b) = self.max_budget_usd {
            a.extend(["--max-budget-usd".into(), format!("{b:.2}")]);
        }
        if let Some(e) = &self.effort {
            a.extend(["--effort".into(), e.clone()]);
        }
        if self.disable_skills {
            a.push("--disable-slash-commands".into());
        }
        if let Some(n) = &self.name {
            a.extend(["--name".into(), n.clone()]);
        }
        a
    }
}

/// Output of a session, tagged by the caller-provided key.
#[derive(Debug, Clone)]
pub enum SessionOutput {
    Message {
        msg: Inbound,
        raw: String,
    },
    /// A stdout line that is not valid JSON.
    Garbage(String),
    Stderr(String),
    Exited(Option<i32>),
}

/// Handle to write to a session and stop it.
pub struct SessionHandle {
    pub pid: u32,
    stdin: mpsc::UnboundedSender<String>,
    kill: Option<oneshot::Sender<()>>,
}

impl SessionHandle {
    /// Queues one JSON line for the session's stdin.
    pub fn send_line(&self, line: String) -> Result<()> {
        self.stdin.send(line).map_err(|_| Error::Process("session stdin is closed".into()))
    }

    pub fn send_user(&self, text: &str) -> Result<()> {
        self.send_line(protocol::user_message(text))
    }

    pub fn interrupt(&self) -> Result<()> {
        self.send_line(protocol::interrupt_request(&uuid::Uuid::new_v4().to_string()))
    }

    /// Terminates the process tree. The `Exited` output still follows.
    pub fn kill(&mut self) {
        if let Some(k) = self.kill.take() {
            let _ = k.send(());
        }
    }
}

/// Spawns the session. Outputs are sent as `(tag, output)` until `Exited`.
pub fn spawn<T>(spec: &LaunchSpec, tag: T, out: mpsc::UnboundedSender<(T, SessionOutput)>) -> Result<SessionHandle>
where
    T: Clone + Send + 'static,
{
    let mut cmd = command(&spec.program);
    cmd.args(spec.args())
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // MCP tools are exposed directly instead of through deferred tool search,
        // so agents can call the orchestrator tools without an extra round-trip.
        .env("ENABLE_TOOL_SEARCH", "false")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| Error::Process(format!("cannot start {}: {e}", spec.program.display())))?;
    attach_to_app_job(&child);
    let pid = child.id().unwrap_or(0);

    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(mut line) = in_rx.recv().await {
            line.push('\n');
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });

    // The initialize handshake registers the in-process MCP servers.
    if !spec.sdk_mcp_servers.is_empty() {
        let _ =
            in_tx.send(protocol::initialize_request(&format!("init-{}", uuid::Uuid::new_v4()), &spec.sdk_mcp_servers));
    }

    let o = out.clone();
    let t = tag.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let item = match protocol::parse_line(&line) {
                Ok(msg) => SessionOutput::Message { msg, raw: line },
                Err(_) => SessionOutput::Garbage(line),
            };
            if o.send((t.clone(), item)).is_err() {
                break;
            }
        }
    });

    let o = out.clone();
    let t = tag.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = o.send((t.clone(), SessionOutput::Stderr(line)));
        }
    });

    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let status = tokio::select! {
            s = child.wait() => s.ok(),
            _ = kill_rx => {
                kill_tree(pid).await;
                let _ = child.kill().await;
                child.wait().await.ok()
            }
        };
        // Drain remaining stdout before reporting the exit.
        let _ = stdout_task.await;
        let _ = out.send((tag, SessionOutput::Exited(status.and_then(|s| s.code()))));
    });

    Ok(SessionHandle { pid, stdin: in_tx, kill: Some(kill_tx) })
}

/// Extracts a short human description of a tool call for "current action" displays.
pub fn describe_tool_use(name: &str, input: &Value) -> String {
    let arg = |k: &str| input.get(k).and_then(Value::as_str);
    let short = |p: &str| {
        let p = p.replace('\\', "/");
        p.rsplit('/').next().unwrap_or(&p).to_string()
    };
    match name {
        "Read" => format!("Reading {}", arg("file_path").map(short).unwrap_or_default()),
        "Edit" | "MultiEdit" => format!("Editing {}", arg("file_path").map(short).unwrap_or_default()),
        "Write" => format!("Writing {}", arg("file_path").map(short).unwrap_or_default()),
        "Glob" => format!("Finding files {}", arg("pattern").unwrap_or_default()),
        "Grep" => format!("Searching for {}", arg("pattern").unwrap_or_default()),
        "Bash" | "PowerShell" => {
            let c = arg("description").or_else(|| arg("command")).unwrap_or_default();
            format!("Running {}", c.chars().take(80).collect::<String>())
        }
        "WebFetch" => format!("Fetching {}", arg("url").unwrap_or_default()),
        "WebSearch" => format!("Searching web: {}", arg("query").unwrap_or_default()),
        "TodoWrite" => "Updating plan".into(),
        n if n.starts_with("mcp__pcc__") => format!("Coordinating: {}", &n[10..]),
        n if n.starts_with("mcp__") => format!("Using {}", n.trim_start_matches("mcp__").replace("__", " → ")),
        n => format!("Using {n}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_include_protocol_flags() {
        let spec = LaunchSpec {
            program: "claude".into(),
            cwd: ".".into(),
            model: Some("sonnet".into()),
            tools: vec!["Read".into(), "Edit".into()],
            resume: Some("abc".into()),
            session_id: Some("ignored".into()),
            ..Default::default()
        };
        let a = spec.args().join(" ");
        assert!(a.contains("--input-format stream-json"));
        assert!(a.contains("--permission-prompt-tool stdio"));
        assert!(a.contains("--tools Read,Edit"));
        assert!(a.contains("--resume abc"));
        assert!(!a.contains("--session-id"));
    }

    #[test]
    fn describes_tools() {
        assert_eq!(
            describe_tool_use("Read", &serde_json::json!({"file_path": r"C:\p\src\Formation.luau"})),
            "Reading Formation.luau"
        );
        assert_eq!(describe_tool_use("mcp__pcc__complete_task", &Value::Null), "Coordinating: complete_task");
    }
}
