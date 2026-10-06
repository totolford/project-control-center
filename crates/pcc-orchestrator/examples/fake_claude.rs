//! Test double of the Claude Code CLI speaking the stream-json protocol.
//! Used only by the orchestrator integration tests; never shipped.
//!
//! Script:
//! * "NEW MISSION"  -> creates agent `builder` and two dependent tasks.
//! * "[TASK X]"     -> asks permission for `echo hi`, reports progress, completes X.
//! * notification mentioning the second task completed -> completes the mission.
//! * "CONNECT PI" / "CONNECT AGAIN" -> environment tools (connection, capabilities).
//! * "DANGER"       -> asks permission for `rm -rf build` and reports the decision.
//! * Hierarchy: "PLAN HIERARCHY" (Central creates lieutenant `lua-lead` and its task);
//!   a lieutenant (detected from its system prompt) delegates "[TASK …] Analyse Lua" to
//!   specialist `lua-files` and completes with a synthesis once its result arrives;
//!   "TRY CREATE" / "CREATE DEEP" try to create agents; "ROUTE TO <id>" sends a message.
//! * Recovery: "HANG" starts a long Bash call that never returns (a turn stuck in a
//!   tool); "SILENT" goes quiet mid-turn without any tool running.

use std::collections::VecDeque;
use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

struct Io {
    lines: io::Lines<io::StdinLock<'static>>,
    queued: VecDeque<Value>,
    next: u64,
    session: String,
}

impl Io {
    fn out(&self, v: Value) {
        let mut o = io::stdout().lock();
        writeln!(o, "{v}").unwrap();
        o.flush().unwrap();
    }

    fn read(&mut self) -> Option<Value> {
        if let Some(v) = self.queued.pop_front() {
            return Some(v);
        }
        loop {
            let line = self.lines.next()?.ok()?;
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                return Some(v);
            }
        }
    }

    /// Sends a control request and waits for its response, queueing other input.
    fn request(&mut self, request: Value) -> Value {
        self.next += 1;
        let rid = format!("fc-{}", self.next);
        self.out(json!({"type": "control_request", "request_id": rid, "request": request}));
        loop {
            let v = self.lines.next().and_then(|l| l.ok()).and_then(|l| serde_json::from_str::<Value>(&l).ok());
            let Some(v) = v else { std::process::exit(0) };
            if v["type"] == "control_response" && v["response"]["request_id"] == rid {
                return v["response"]["response"].clone();
            }
            self.queued.push_back(v);
        }
    }

    fn tool(&mut self, name: &str, args: Value) -> String {
        self.next += 1;
        let id = self.next;
        self.out(json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": format!("toolu_{id}"), "name": format!("mcp__pcc__{name}"), "input": args}]}, "parent_tool_use_id": null}));
        let resp = self.request(json!({"subtype": "mcp_message", "server_name": "pcc",
            "message": {"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": args}}}));
        resp["mcp_response"]["result"]["content"][0]["text"].as_str().unwrap_or("").to_string()
    }

    fn permission(&mut self, command: &str) -> String {
        let resp = self.request(json!({"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": command}, "tool_use_id": "toolu_perm"}));
        resp["behavior"].as_str().unwrap_or("?").to_string()
    }

    fn say(&self, text: &str) {
        self.out(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}, "parent_tool_use_id": null}));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let session = args
        .windows(2)
        .find(|w| w[0] == "--session-id" || w[0] == "--resume")
        .map(|w| w[1].clone())
        .unwrap_or_else(|| "fake-session".into());
    let stdin: &'static io::Stdin = Box::leak(Box::new(io::stdin()));
    let mut io = Io { lines: stdin.lock().lines(), queued: VecDeque::new(), next: 0, session };
    let mut initialised = false;
    let prompt = args
        .windows(2)
        .find(|w| w[0] == "--append-system-prompt-file")
        .and_then(|w| std::fs::read_to_string(&w[1]).ok())
        .unwrap_or_default();
    let lieutenant = prompt.contains("You are a **lieutenant**");
    let mut own_task = String::new();

    while let Some(msg) = io.read() {
        match msg["type"].as_str() {
            Some("control_request") => {
                // initialize handshake
                io.out(json!({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": {"commands": []}}}));
            }
            Some("user") => {
                if !initialised {
                    initialised = true;
                    // Real CLI lists the SDK server tools during start-up.
                    let list = io.request(json!({"subtype": "mcp_message", "server_name": "pcc", "message": {"jsonrpc": "2.0", "id": 0, "method": "tools/list"}}));
                    let n = list["mcp_response"]["result"]["tools"].as_array().map(|a| a.len()).unwrap_or(0);
                    io.out(json!({"type": "system", "subtype": "init", "session_id": io.session, "model": "fake", "tools": vec!["Read"; n]}));
                }
                let text = msg["message"]["content"].as_str().unwrap_or("").to_string();
                if text.contains("HANG") {
                    io.out(json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_hang", "name": "Bash",
                        "input": {"command": "npm run build", "description": "Long build"}}]}, "parent_tool_use_id": null}));
                    std::thread::sleep(std::time::Duration::from_secs(600));
                } else if text.contains("SILENT") {
                    io.say("thinking");
                    std::thread::sleep(std::time::Duration::from_secs(600));
                } else if text.contains("PLAN HIERARCHY") {
                    let d = io.tool("record_delegation_decision", json!({"needs_sub_agents": true, "reason": "Lua is a separate domain",
                        "children": [{"name": "Lua Lead", "role": "Lua domain lead", "rank": "lieutenant", "reason": "many files"}]}));
                    io.say(&format!("decision: {d}"));
                    let r = io.tool("create_agent", json!({"name": "Lua Lead", "id": "lua-lead", "role": "Lua domain lead", "rank": "lieutenant", "isolation": "shared"}));
                    io.say(&format!("created: {r}"));
                    io.tool(
                        "create_task",
                        json!({"title": "Analyse Lua", "description": "Analyse the Lua code", "agent": "lua-lead"}),
                    );
                } else if lieutenant && text.contains("[TASK ") && text.contains("Analyse Lua") {
                    own_task = text.split("[TASK ").nth(1).and_then(|r| r.split(']').next()).unwrap_or("").to_string();
                    io.tool(
                        "record_delegation_decision",
                        json!({"needs_sub_agents": true, "reason": "files can be analysed by a specialist",
                        "children": [{"name": "Lua Files", "role": "Lua file analyst"}]}),
                    );
                    let r = io.tool("create_agent", json!({"name": "Lua Files", "id": "lua-files", "role": "Lua file analyst", "isolation": "shared"}));
                    io.say(&format!("sub-agent: {r}"));
                    let t = io.tool(
                        "create_task",
                        json!({"title": "Scan files", "description": "Scan", "agent": "lua-files"}),
                    );
                    io.say(&format!("delegated: {t}"));
                } else if lieutenant && text.contains("completed by lua-files") && !own_task.is_empty() {
                    let r = io.tool("complete_task", json!({"task_id": own_task, "summary": "Lua Agent: 120 files analysed, 3 problems found, 2 fixed, 1 needs validation"}));
                    io.say(&format!("synthesis sent: {r}"));
                } else if text.contains("TRY CREATE") {
                    let r = io.tool("create_agent", json!({"name": "Helper", "role": "helps"}));
                    io.say(&format!("create attempt: {r}"));
                } else if text.contains("CREATE DEEP") {
                    io.tool("record_delegation_decision", json!({"needs_sub_agents": true, "reason": "deep"}));
                    let r = io.tool(
                        "create_agent",
                        json!({"name": "Deep Lead", "role": "deeper", "rank": "lieutenant", "isolation": "shared"}),
                    );
                    io.say(&format!("deep attempt: {r}"));
                } else if let Some(to) = text.split("ROUTE TO ").nth(1).and_then(|r| r.split_whitespace().next()) {
                    let r =
                        io.tool("send_message", json!({"to": to, "body": "Need the API contract", "kind": "request"}));
                    io.say(&format!("routed: {r}"));
                } else if text.contains("NEW MISSION") {
                    io.tool("create_agent", json!({"name": "Builder", "role": "Builds things", "isolation": "shared", "decision_reason": "one builder"}));
                    let first = io
                        .tool("create_task", json!({"title": "Build it", "description": "Build", "agent": "builder"}));
                    let id = first.split_whitespace().next().unwrap_or("").to_string();
                    io.tool(
                        "create_task",
                        json!({"title": "Test it", "description": "Test", "agent": "builder", "dependencies": [id]}),
                    );
                    io.say("Planned two tasks.");
                } else if text.contains("[TASK ") {
                    let id = text.split("[TASK ").nth(1).and_then(|r| r.split(']').next()).unwrap_or("").to_string();
                    let decision = io.permission("echo hi");
                    io.say(&format!("permission {decision}"));
                    io.tool("report_progress", json!({"task_id": id, "percent": 50, "action": "Building"}));
                    io.tool("complete_task", json!({"task_id": id, "summary": format!("done {id}"), "files_changed": ["a.txt"], "tests": "1 passed"}));
                } else if text.contains("CONNECT PI") {
                    let first = io.tool(
                        "find_or_create_connection",
                        json!({"kind": "ssh", "host": "192.168.1.157", "user": "pi"}),
                    );
                    io.say(&format!("first: {first}"));
                    let caps = io.tool("list_capabilities", json!({}));
                    io.say(&format!("capabilities received: {}", caps.contains("localTools")));
                } else if text.contains("CONNECT AGAIN") {
                    let again = io.tool(
                        "find_or_create_connection",
                        json!({"kind": "ssh", "host": "192.168.1.157", "user": "PI"}),
                    );
                    io.say(&format!("again: {again}"));
                } else if text.contains("DANGER") {
                    let decision = io.permission("rm -rf build");
                    io.say(&format!("dangerous command {decision}"));
                } else if text.contains("TASK-0002") && text.contains("completed by") {
                    let r = io.tool("complete_mission", json!({"mission_id": "M-0001", "summary": "All done"}));
                    io.say(&r);
                } else {
                    io.say("ack");
                }
                io.out(json!({"type": "result", "subtype": "success", "is_error": false, "result": "ok", "total_cost_usd": 0.01, "num_turns": 1, "duration_ms": 5}));
            }
            _ => {}
        }
    }
}
