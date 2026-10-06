//! Minimal MCP client used to verify servers and list what they expose.
//! Supports stdio and streamable HTTP (including SSE-framed responses).

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use pcc_claude::process::command;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpItem {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProbe {
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub protocol_version: Option<String>,
    pub tools: Vec<McpItem>,
    /// `None` when the server does not implement the method.
    pub resources: Option<Vec<McpItem>>,
    pub prompts: Option<Vec<McpItem>>,
    /// Time to answer `initialize`.
    pub latency_ms: u64,
    /// Last lines the server wrote to stderr (stdio only).
    pub stderr_tail: Vec<String>,
}

/// Where to reach a server.
#[derive(Debug, Clone)]
pub enum Target<'a> {
    Stdio { program: &'a str, args: &'a [String], env: &'a [(String, String)], cwd: &'a Path },
    Http { url: &'a str, headers: &'a BTreeMap<String, String> },
}

pub async fn probe(target: Target<'_>, timeout: Duration) -> Result<McpProbe, String> {
    let fut = async {
        match target {
            Target::Stdio { program, args, env, cwd } => probe_stdio(program, args, env, cwd, timeout).await,
            Target::Http { url, headers } => {
                let (url, headers) = (url.to_string(), headers.clone());
                tokio::task::spawn_blocking(move || probe_http(&url, &headers)).await.map_err(|e| e.to_string())?
            }
        }
    };
    tokio::time::timeout(timeout, fut).await.map_err(|_| format!("no answer within {}s", timeout.as_secs()))?
}

fn init_request() -> Value {
    json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "nexus", "version": env!("CARGO_PKG_VERSION")}}
    })
}

fn items(v: &Value, key: &str) -> Vec<McpItem> {
    v.pointer(&format!("/result/{key}"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let name = t.get("name").or_else(|| t.get("uri")).and_then(Value::as_str)?;
                    Some(McpItem {
                        name: name.to_string(),
                        description: t.get("description").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Result of an optional list method: `None` if the server returned an error.
fn optional_items(v: Option<Value>, key: &str) -> Option<Vec<McpItem>> {
    v.filter(|r| r.get("error").is_none()).map(|r| items(&r, key))
}

fn assemble(init: &Value, latency_ms: u64, tools: Value, resources: Option<Value>, prompts: Option<Value>) -> McpProbe {
    let info = init.pointer("/result/serverInfo").cloned().unwrap_or(Value::Null);
    McpProbe {
        server_name: info.get("name").and_then(Value::as_str).map(str::to_string),
        server_version: info.get("version").and_then(Value::as_str).map(str::to_string),
        protocol_version: init.pointer("/result/protocolVersion").and_then(Value::as_str).map(str::to_string),
        tools: items(&tools, "tools"),
        resources: optional_items(resources, "resources"),
        prompts: optional_items(prompts, "prompts"),
        latency_ms,
        stderr_tail: vec![],
    }
}

fn capability(init: &Value, name: &str) -> bool {
    init.pointer(&format!("/result/capabilities/{name}")).is_some()
}

// ------------------------------------------------------------ stdio

async fn probe_stdio(
    program: &str,
    args: &[String],
    env: &[(String, String)],
    cwd: &Path,
    timeout: Duration,
) -> Result<McpProbe, String> {
    let mut cmd = command(program);
    cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot start `{program}`: {e}"))?;
    let pid = child.id();
    // Timeout inside, so the process tree is stopped on every path.
    let result = tokio::time::timeout(timeout.saturating_sub(Duration::from_millis(500)), talk_stdio(&mut child))
        .await
        .unwrap_or_else(|_| Err(format!("no answer within {}s", timeout.as_secs())));
    // `cmd.exe /c ... mcp.bat` leaves the real server as a grandchild: stop the whole tree.
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    let _ = child.kill().await;
    result
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = pcc_claude::process::std_command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
    #[cfg(not(windows))]
    let _ = pid;
}

async fn talk_stdio(child: &mut tokio::process::Child) -> Result<McpProbe, String> {
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    let mut stderr = child.stderr.take().ok_or("no stderr")?;

    let started = Instant::now();
    stdin.write_all(line(init_request()).as_bytes()).await.map_err(|e| e.to_string())?;
    let init = match read_response(&mut lines, 1).await {
        Ok(v) => v,
        Err(e) => {
            let _ = child.kill().await;
            let mut buf = String::new();
            let _ = tokio::time::timeout(Duration::from_millis(300), stderr.read_to_string(&mut buf)).await;
            let tail: Vec<&str> = buf.lines().rev().take(3).collect();
            return Err(if tail.is_empty() {
                e
            } else {
                format!("{e}: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" | "))
            });
        }
    };
    let latency_ms = started.elapsed().as_millis() as u64;
    let mut batch = line(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    batch.push_str(&line(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})));
    stdin.write_all(batch.as_bytes()).await.map_err(|e| e.to_string())?;
    let tools = read_response(&mut lines, 2).await?;
    let mut resources = None;
    let mut prompts = None;
    if capability(&init, "resources") {
        stdin
            .write_all(line(json!({"jsonrpc": "2.0", "id": 3, "method": "resources/list", "params": {}})).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        resources = read_response_raw(&mut lines, 3).await.ok();
    }
    if capability(&init, "prompts") {
        stdin
            .write_all(line(json!({"jsonrpc": "2.0", "id": 4, "method": "prompts/list", "params": {}})).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        prompts = read_response_raw(&mut lines, 4).await.ok();
    }
    Ok(assemble(&init, latency_ms, tools, resources, prompts))
}

fn line(v: Value) -> String {
    let mut s = v.to_string();
    s.push('\n');
    s
}

async fn read_response_raw<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
    id: i64,
) -> Result<Value, String> {
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("id").and_then(Value::as_i64) == Some(id) {
            return Ok(v);
        }
    }
    Err("server closed its output before answering".into())
}

async fn read_response<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
    id: i64,
) -> Result<Value, String> {
    let v = read_response_raw(lines, id).await?;
    match v.get("error") {
        Some(err) => Err(format!("server error: {err}")),
        None => Ok(v),
    }
}

// ------------------------------------------------------------ HTTP (streamable)

fn probe_http(url: &str, headers: &BTreeMap<String, String>) -> Result<McpProbe, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
    let mut session: Option<String> = None;
    let mut call = |body: Value, expect_reply: bool| -> Result<Option<Value>, String> {
        let mut req = agent
            .post(url)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .set("MCP-Protocol-Version", "2025-06-18");
        for (k, v) in headers {
            req = req.set(k, v);
        }
        if let Some(s) = &session {
            req = req.set("Mcp-Session-Id", s);
        }
        let resp = match req.send_string(&body.to_string()) {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                return Err(format!(
                    "HTTP {code}{}",
                    if text.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", text.chars().take(200).collect::<String>())
                    }
                ));
            }
            Err(e) => return Err(e.to_string()),
        };
        if let Some(s) = resp.header("Mcp-Session-Id") {
            session = Some(s.to_string());
        }
        if !expect_reply {
            return Ok(None);
        }
        let is_sse = resp.content_type().contains("event-stream");
        let text = resp.into_string().map_err(|e| e.to_string())?;
        let id = body.get("id").cloned();
        let parsed = if is_sse {
            text.lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
                .find(|v| v.get("id") == id.as_ref())
        } else {
            serde_json::from_str::<Value>(&text).ok()
        };
        parsed.map(Some).ok_or_else(|| "unexpected response from server".to_string())
    };
    let started = Instant::now();
    let init = call(init_request(), true)?.ok_or("no initialize answer")?;
    if let Some(err) = init.get("error") {
        return Err(format!("server error: {err}"));
    }
    let latency_ms = started.elapsed().as_millis() as u64;
    call(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}), false)?;
    let tools =
        call(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}), true)?.unwrap_or(Value::Null);
    let resources = if capability(&init, "resources") {
        call(json!({"jsonrpc": "2.0", "id": 3, "method": "resources/list", "params": {}}), true).ok().flatten()
    } else {
        None
    };
    let prompts = if capability(&init, "prompts") {
        call(json!({"jsonrpc": "2.0", "id": 4, "method": "prompts/list", "params": {}}), true).ok().flatten()
    } else {
        None
    };
    Ok(assemble(&init, latency_ms, tools, resources, prompts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Read, Write};

    #[test]
    fn items_and_optional_lists() {
        let v = json!({"result": {"tools": [{"name": "a", "description": "A"}, {"name": "b"}]}});
        assert_eq!(items(&v, "tools").len(), 2);
        assert_eq!(optional_items(Some(json!({"error": {"code": -32601}})), "prompts"), None);
        assert_eq!(optional_items(None, "prompts"), None);
    }

    /// A tiny streamable-HTTP MCP server answering with SSE frames.
    #[test]
    fn http_probe_against_local_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(4).flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                let req: Value = serde_json::from_slice(&body).unwrap();
                let result = match req["method"].as_str().unwrap() {
                    "initialize" => {
                        json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "local", "version": "9"}})
                    }
                    "tools/list" => json!({"tools": [{"name": "ping", "description": "Ping"}]}),
                    _ => json!({}),
                };
                let mut out = stream;
                if req.get("id").is_none() {
                    write!(out, "HTTP/1.1 202 Accepted\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").unwrap();
                    continue;
                }
                let payload = format!(
                    "event: message\ndata: {}\n\n",
                    json!({"jsonrpc": "2.0", "id": req["id"], "result": result})
                );
                // One request per connection: tell the client not to reuse it.
                write!(
                    out,
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/event-stream\r\nMcp-Session-Id: s1\r\nContent-Length: {}\r\n\r\n{}",
                    payload.len(),
                    payload
                )
                .unwrap();
            }
        });
        let p = probe_http(&format!("http://{addr}/mcp"), &BTreeMap::new()).unwrap();
        assert_eq!(p.server_name.as_deref(), Some("local"));
        assert_eq!(p.tools, vec![McpItem { name: "ping".into(), description: Some("Ping".into()) }]);
        assert_eq!(p.resources, None);
    }

    #[test]
    fn http_probe_reports_connection_errors() {
        let err = probe_http("http://127.0.0.1:1/mcp", &BTreeMap::new()).unwrap_err();
        assert!(!err.is_empty());
    }

    /// The Roblox Studio command shape (`cmd.exe /c "cd /d <dir> && .\mcp.bat"`)
    /// against a real stdio server (PowerShell); the server process tree is
    /// stopped after the probe.
    #[cfg(windows)]
    #[tokio::test]
    async fn stdio_probe_through_cmd_and_a_batch_file() {
        let dir = tempfile::tempdir().unwrap();
        let script = r#"
$pidFile = Join-Path $PSScriptRoot 'server.pid'
Set-Content -Path $pidFile -Value $PID
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $m = $line | ConvertFrom-Json
  if ($null -eq $m.id) { continue }
  switch ($m.method) {
    'initialize' { $r = @{ protocolVersion = '2025-06-18'; capabilities = @{ tools = @{}; prompts = @{} }; serverInfo = @{ name = 'fake-roblox'; version = '1.0' } } }
    'tools/list' { $r = @{ tools = @(@{ name = 'run_code' }, @{ name = 'get_script' }) } }
    'prompts/list' { $r = @{ prompts = @(@{ name = 'explain' }) } }
    default { $r = @{} }
  }
  [Console]::Out.WriteLine((@{ jsonrpc = '2.0'; id = $m.id; result = $r } | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
"#;
        std::fs::write(dir.path().join("server.ps1"), script).unwrap();
        std::fs::write(
            dir.path().join("mcp.bat"),
            "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0server.ps1\"\r\n",
        )
        .unwrap();
        let args = vec!["/c".to_string(), format!(r"cd /d {} && .\mcp.bat", dir.path().display())];
        let probe = probe(
            Target::Stdio { program: "cmd.exe", args: &args, env: &[], cwd: dir.path() },
            Duration::from_secs(60),
        )
        .await
        .unwrap();
        assert_eq!(probe.server_name.as_deref(), Some("fake-roblox"));
        assert_eq!(probe.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["run_code", "get_script"]);
        assert_eq!(probe.prompts.as_ref().map(Vec::len), Some(1));
        assert_eq!(probe.resources, None);
        // The PowerShell server (a grandchild of cmd.exe) does not outlive the probe.
        let pid: u32 = std::fs::read_to_string(dir.path().join("server.pid")).unwrap().trim().parse().unwrap();
        let alive = || {
            let out =
                std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
        };
        for _ in 0..20 {
            if !alive() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!alive(), "server process {pid} survived the probe");
    }
}
