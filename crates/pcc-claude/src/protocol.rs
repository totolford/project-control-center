//! Claude Code stream-json protocol: parsing of stdout lines and builders for
//! stdin messages.

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text(String),
    Thinking(String),
    ToolUse { id: String, name: String, input: Value },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub tool_use_id: String,
    pub text: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ControlRequest {
    CanUseTool { tool_name: String, input: Value, tool_use_id: Option<String> },
    McpMessage { server_name: String, message: Value },
    Other { subtype: String, body: Value },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    Init {
        session_id: String,
        model: Option<String>,
        tools: Vec<String>,
    },
    Assistant {
        blocks: Vec<Block>,
        /// Set when the message comes from a sub-agent of this session.
        parent_tool_use_id: Option<String>,
    },
    ToolResults {
        results: Vec<ToolResult>,
        parent_tool_use_id: Option<String>,
    },
    /// End of a turn.
    Result {
        subtype: String,
        is_error: bool,
        text: Option<String>,
        total_cost_usd: Option<f64>,
        num_turns: Option<u64>,
        duration_ms: Option<u64>,
    },
    ControlRequest {
        request_id: String,
        request: ControlRequest,
    },
    ControlResponse {
        request_id: String,
        success: bool,
        error: Option<String>,
        /// Body of a successful response (`mcp_status` server list, ...).
        response: Value,
    },
    /// Anything else (rate limit notices, status, stream events, ...).
    Other {
        kind: String,
        subtype: Option<String>,
    },
}

pub fn parse_line(line: &str) -> Result<Inbound, serde_json::Error> {
    let v: Value = serde_json::from_str(line)?;
    Ok(parse_value(&v))
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

pub fn parse_value(v: &Value) -> Inbound {
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    let subtype = s(v, "subtype");
    match kind {
        "system" if subtype.as_deref() == Some("init") => Inbound::Init {
            session_id: s(v, "session_id").unwrap_or_default(),
            model: s(v, "model"),
            tools: v
                .get("tools")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        },
        "assistant" => {
            let blocks = v
                .pointer("/message/content")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                            Some("text") => s(b, "text").map(Block::Text),
                            Some("thinking") => s(b, "thinking").filter(|t| !t.is_empty()).map(Block::Thinking),
                            Some("tool_use") => Some(Block::ToolUse {
                                id: s(b, "id").unwrap_or_default(),
                                name: s(b, "name").unwrap_or_default(),
                                input: b.get("input").cloned().unwrap_or(Value::Null),
                            }),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            Inbound::Assistant { blocks, parent_tool_use_id: s(v, "parent_tool_use_id") }
        }
        "user" => {
            let results = v
                .pointer("/message/content")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                        .map(|b| ToolResult {
                            tool_use_id: s(b, "tool_use_id").unwrap_or_default(),
                            text: content_text(b.get("content")),
                            is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Inbound::ToolResults { results, parent_tool_use_id: s(v, "parent_tool_use_id") }
        }
        "result" => Inbound::Result {
            subtype: subtype.unwrap_or_default(),
            is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            text: s(v, "result"),
            total_cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            num_turns: v.get("num_turns").and_then(Value::as_u64),
            duration_ms: v.get("duration_ms").and_then(Value::as_u64),
        },
        "control_request" => {
            let req = v.get("request").cloned().unwrap_or(Value::Null);
            let sub = s(&req, "subtype").unwrap_or_default();
            let request = match sub.as_str() {
                "can_use_tool" => ControlRequest::CanUseTool {
                    tool_name: s(&req, "tool_name").unwrap_or_default(),
                    input: req.get("input").cloned().unwrap_or(Value::Null),
                    tool_use_id: s(&req, "tool_use_id"),
                },
                "mcp_message" => ControlRequest::McpMessage {
                    server_name: s(&req, "server_name").unwrap_or_default(),
                    message: req.get("message").cloned().unwrap_or(Value::Null),
                },
                _ => ControlRequest::Other { subtype: sub, body: req },
            };
            Inbound::ControlRequest { request_id: s(v, "request_id").unwrap_or_default(), request }
        }
        "control_response" => {
            let r = v.get("response").cloned().unwrap_or(Value::Null);
            Inbound::ControlResponse {
                request_id: s(&r, "request_id").unwrap_or_default(),
                success: s(&r, "subtype").as_deref() == Some("success"),
                error: s(&r, "error"),
                response: r.get("response").cloned().unwrap_or(Value::Null),
            }
        }
        other => Inbound::Other { kind: other.to_string(), subtype },
    }
}

/// Flattens a tool_result `content` (string or array of blocks) to text.
fn content_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => s(b, "text"),
                Some("image") => Some("[image]".into()),
                Some(t) => Some(format!("[{t}]")),
                None => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// ------------------------------------------------------------ outbound

pub fn user_message(text: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
}

pub fn initialize_request(request_id: &str, sdk_mcp_servers: &[String]) -> String {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {"subtype": "initialize", "hooks": null, "sdkMcpServers": sdk_mcp_servers}
    })
    .to_string()
}

pub fn interrupt_request(request_id: &str) -> String {
    json!({"type": "control_request", "request_id": request_id, "request": {"subtype": "interrupt"}}).to_string()
}

pub fn control_success(request_id: &str, response: Value) -> String {
    json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request_id, "response": response}
    })
    .to_string()
}

pub fn control_error(request_id: &str, error: &str) -> String {
    json!({
        "type": "control_response",
        "response": {"subtype": "error", "request_id": request_id, "error": error}
    })
    .to_string()
}

pub fn permission_allow(request_id: &str, input: &Value) -> String {
    control_success(request_id, json!({"behavior": "allow", "updatedInput": input}))
}

pub fn permission_deny(request_id: &str, message: &str) -> String {
    control_success(request_id, json!({"behavior": "deny", "message": message}))
}

/// Wraps a JSON-RPC response (or `None` for notifications) for an `mcp_message` request.
pub fn mcp_reply(request_id: &str, rpc: Option<Value>) -> String {
    control_success(request_id, json!({"mcp_response": rpc.unwrap_or_else(|| json!({}))}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_lines() {
        let init = r#"{"type":"system","subtype":"init","cwd":"C:\\x","session_id":"61c2","tools":["Bash","Read"],"model":"claude-haiku"}"#;
        assert_eq!(
            parse_line(init).unwrap(),
            Inbound::Init {
                session_id: "61c2".into(),
                model: Some("claude-haiku".into()),
                tools: vec!["Bash".into(), "Read".into()]
            }
        );

        let tool = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"x"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo hi"}}]},"parent_tool_use_id":null}"#;
        match parse_line(tool).unwrap() {
            Inbound::Assistant { blocks, parent_tool_use_id } => {
                assert_eq!(parent_tool_use_id, None);
                assert_eq!(blocks.len(), 1, "empty thinking is dropped");
                assert!(matches!(&blocks[0], Block::ToolUse { name, .. } if name == "Bash"));
            }
            other => panic!("{other:?}"),
        }

        let result = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":"delivered"}]}]}}"#;
        assert_eq!(
            parse_line(result).unwrap(),
            Inbound::ToolResults {
                results: vec![ToolResult { tool_use_id: "toolu_1".into(), text: "delivered".into(), is_error: false }],
                parent_tool_use_id: None
            }
        );

        let perm = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a"},"tool_use_id":"toolu_2"}}"#;
        assert!(matches!(
            parse_line(perm).unwrap(),
            Inbound::ControlRequest { request: ControlRequest::CanUseTool { ref tool_name, .. }, .. } if tool_name == "Write"
        ));

        let mcp = r#"{"type":"control_request","request_id":"r2","request":{"subtype":"mcp_message","server_name":"pcc","message":{"method":"tools/list","jsonrpc":"2.0","id":1}}}"#;
        assert!(matches!(
            parse_line(mcp).unwrap(),
            Inbound::ControlRequest { request: ControlRequest::McpMessage { ref server_name, .. }, .. } if server_name == "pcc"
        ));

        let done = r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.06,"num_turns":3}"#;
        assert!(matches!(parse_line(done).unwrap(), Inbound::Result { total_cost_usd: Some(c), .. } if c > 0.05));

        assert!(matches!(parse_line(r#"{"type":"rate_limit_event"}"#).unwrap(), Inbound::Other { .. }));
        assert!(parse_line("not json").is_err());
    }

    #[test]
    fn builds_messages() {
        let m: Value = serde_json::from_str(&user_message("hi")).unwrap();
        assert_eq!(m["message"]["content"], "hi");
        let d: Value = serde_json::from_str(&permission_deny("r", "no")).unwrap();
        assert_eq!(d["response"]["response"]["behavior"], "deny");
        let r: Value = serde_json::from_str(&mcp_reply("r", None)).unwrap();
        assert_eq!(r["response"]["response"]["mcp_response"], json!({}));
    }
}
