//! Minimal MCP stdio client used to verify that a server starts and lists tools.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use pcc_claude::process::command;

#[derive(Debug, Clone, PartialEq)]
pub struct McpProbe {
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub tools: Vec<String>,
}

/// Starts the server, performs `initialize` + `tools/list`, then stops it.
pub async fn probe(
    program: &str,
    args: &[String],
    env: &[(String, String)],
    cwd: &Path,
    timeout: Duration,
) -> Result<McpProbe, String> {
    tokio::time::timeout(timeout, probe_inner(program, args, env, cwd))
        .await
        .map_err(|_| format!("no answer within {}s", timeout.as_secs()))?
}

async fn probe_inner(program: &str, args: &[String], env: &[(String, String)], cwd: &Path) -> Result<McpProbe, String> {
    let mut cmd = command(program);
    cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot start `{program}`: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();

    let send = |v: Value| {
        let mut s = v.to_string();
        s.push('\n');
        s
    };
    let init = send(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "project-control-center", "version": env!("CARGO_PKG_VERSION")}}
    }));
    stdin.write_all(init.as_bytes()).await.map_err(|e| e.to_string())?;
    let init_resp = read_response(&mut lines, 1).await?;
    let info = init_resp.pointer("/result/serverInfo").cloned().unwrap_or(Value::Null);

    let notif = send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    let list = send(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}));
    stdin.write_all(notif.as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.write_all(list.as_bytes()).await.map_err(|e| e.to_string())?;
    let list_resp = read_response(&mut lines, 2).await?;
    let tools = list_resp
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|t| t.get("name")?.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let _ = child.kill().await;
    Ok(McpProbe {
        server_name: info.get("name").and_then(Value::as_str).map(str::to_string),
        server_version: info.get("version").and_then(Value::as_str).map(str::to_string),
        tools,
    })
}

async fn read_response<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
    id: i64,
) -> Result<Value, String> {
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("id").and_then(Value::as_i64) == Some(id) {
            if let Some(err) = v.get("error") {
                return Err(format!("server error: {err}"));
            }
            return Ok(v);
        }
    }
    Err("server closed its output before answering".into())
}
