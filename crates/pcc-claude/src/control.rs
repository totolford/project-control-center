//! A short-lived Claude Code process used only for control requests
//! (`initialize`, `mcp_status`, `get_context_usage`, ...). No user message is
//! ever sent, so it never calls a model and costs nothing.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::process::command;
use pcc_core::{Error, Result};

pub struct ControlClient {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next: u64,
}

impl ControlClient {
    /// Starts `claude -p` in stream-json mode in `cwd`, with the user's normal settings.
    pub async fn start(claude: &Path, cwd: &Path) -> Result<ControlClient> {
        let mut child = command(claude)
            .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::Process(format!("cannot start Claude Code: {e}")))?;
        let stdin = child.stdin.take().ok_or_else(|| Error::Process("no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| Error::Process("no stdout".into()))?;
        Ok(ControlClient { child, stdin, lines: BufReader::new(stdout).lines(), next: 0 })
    }

    /// Sends a control request and waits for its response body.
    pub async fn request(&mut self, subtype: &str, args: Value, timeout: Duration) -> Result<Value> {
        self.next += 1;
        let id = format!("nexus-{}", self.next);
        let mut request = json!({"subtype": subtype});
        if let (Some(obj), Some(extra)) = (request.as_object_mut(), args.as_object()) {
            obj.extend(extra.clone());
        }
        let mut line = json!({"type": "control_request", "request_id": id, "request": request}).to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
        let read = async {
            while let Some(l) = self.lines.next_line().await? {
                let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
                if v["type"] == "control_response" && v["response"]["request_id"] == id.as_str() {
                    let r = &v["response"];
                    return if r["subtype"] == "success" {
                        Ok(r.get("response").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(Error::Process(r["error"].as_str().unwrap_or("control request failed").to_string()))
                    };
                }
            }
            Err(Error::Process("Claude Code exited before answering".into()))
        };
        tokio::time::timeout(timeout, read)
            .await
            .map_err(|_| Error::Process(format!("`{subtype}` timed out after {}s", timeout.as_secs())))?
    }

    pub async fn close(mut self) {
        let _ = self.child.kill().await;
    }
}

/// Runs one control request in a fresh process (e.g. a persistent `mcp_toggle`).
pub async fn one_shot(claude: &Path, cwd: &Path, subtype: &str, args: Value) -> Result<Value> {
    let mut c = ControlClient::start(claude, cwd).await?;
    let out = c.request(subtype, args, Duration::from_secs(60)).await;
    c.close().await;
    out
}
