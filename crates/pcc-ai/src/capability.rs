//! AI Runtime capability test: what a local model can really do for NEXUS,
//! measured against the runtime (never assumed from its name):
//!
//! 1. chat — answers a plain instruction;
//! 2. structured output — returns a JSON object NEXUS can parse;
//! 3. tool call — calls an offered tool with the right arguments;
//! 4. multi-step — two dependent tool calls (the second uses the first's result);
//! 5. context — finds a fact in the middle of a long prompt;
//! 6. recovery — handles a tool error (retries correctly or reports it).
//!
//! Each test is ✓ pass, ⚠ limited or ✗ fail. A model that cannot call tools
//! makes the Central Agent run in "Limited Tool Mode": NEXUS never claims it
//! controls tools.
//!
//! The evaluation of every answer is a pure function (tested without a
//! server); `run` drives the real requests.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pcc_core::Result;

use crate::provider::{ChatMessage, ChatRequest, ChatResponse, LocalAiProvider, ToolCall, ToolSpec};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityTest {
    Chat,
    StructuredOutput,
    ToolCall,
    MultiStep,
    Context,
    Recovery,
}

impl CapabilityTest {
    pub const ALL: [CapabilityTest; 6] = [
        CapabilityTest::Chat,
        CapabilityTest::StructuredOutput,
        CapabilityTest::ToolCall,
        CapabilityTest::MultiStep,
        CapabilityTest::Context,
        CapabilityTest::Recovery,
    ];

    pub fn label(self) -> &'static str {
        match self {
            CapabilityTest::Chat => "Chat",
            CapabilityTest::StructuredOutput => "Structured output",
            CapabilityTest::ToolCall => "Tool call",
            CapabilityTest::MultiStep => "Multi-step tools",
            CapabilityTest::Context => "Long context",
            CapabilityTest::Recovery => "Tool error recovery",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Pass,
    Limited,
    Fail,
    /// Not run: an earlier test showed it cannot pass (no tool calling).
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResult {
    pub test: CapabilityTest,
    pub status: CapabilityStatus,
    /// What was observed, in one sentence.
    pub detail: String,
    pub ms: u64,
}

/// How the Central Agent can run on this model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CentralMode {
    /// Tools work, including dependent calls.
    Full,
    /// "Central Agent: Limited Tool Mode": chat only, tools are not controlled by the model.
    LimitedTools,
    /// The model does not even answer a chat.
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub runtime: String,
    pub base_url: String,
    pub model: String,
    pub at: String,
    pub results: Vec<CapabilityResult>,
    pub central_mode: CentralMode,
    pub summary: String,
}

// ---------------------------------------------------------------- evaluation (pure)

type Verdict = (CapabilityStatus, String);

/// A request the runtime refused because the model has no tool support.
pub fn is_no_tools_error(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("does not support tools")
        || e.contains("tools not supported")
        || e.contains("tool use is not supported")
        || e.contains("does not support function")
}

pub const CHAT_TOKEN: &str = "NEXUS-OK";

pub fn eval_chat(content: &str) -> Verdict {
    let c = content.trim();
    if c.is_empty() {
        (CapabilityStatus::Fail, "empty answer".into())
    } else if c.contains(CHAT_TOKEN) {
        (CapabilityStatus::Pass, format!("answered \"{}\"", short(c, 60)))
    } else {
        (CapabilityStatus::Limited, format!("answered but did not follow the instruction: \"{}\"", short(c, 80)))
    }
}

/// The first JSON object of a text: the whole answer, a ```json fence, or `{…}` inside prose.
pub fn extract_json(text: &str) -> Option<(Value, bool)> {
    let t = text.trim();
    if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(t) {
        return Some((v, true));
    }
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    (end > start)
        .then(|| serde_json::from_str::<Value>(&t[start..=end]).ok())
        .flatten()
        .filter(Value::is_object)
        .map(|v| (v, false))
}

pub fn eval_structured(content: &str) -> Verdict {
    match extract_json(content) {
        None => (CapabilityStatus::Fail, format!("no JSON object in the answer: \"{}\"", short(content, 80))),
        Some((v, clean)) => {
            let city_ok = v["city"].as_str().is_some_and(|c| c.to_lowercase().contains("paris"));
            let country_ok = v["country"].as_str().is_some_and(|c| c.to_lowercase().contains("france"));
            let typed = v["population_millions"].is_number();
            match (city_ok && country_ok && typed, clean) {
                (true, true) => (CapabilityStatus::Pass, "valid JSON with the requested fields and types".into()),
                (true, false) => (
                    CapabilityStatus::Limited,
                    "correct JSON, but wrapped in other text (NEXUS has to extract it)".into(),
                ),
                (false, _) => (
                    CapabilityStatus::Limited,
                    format!("JSON with wrong or missing fields: {}", short(&v.to_string(), 100)),
                ),
            }
        }
    }
}

fn arg_str<'a>(c: &'a ToolCall, key: &str) -> Option<&'a str> {
    c.arguments.get(key).and_then(Value::as_str)
}

pub fn eval_tool_call(r: &std::result::Result<ChatResponse, String>) -> Verdict {
    match r {
        Err(e) if is_no_tools_error(e) => {
            (CapabilityStatus::Fail, format!("the runtime refused tools: {}", short(e, 120)))
        }
        Err(e) => (CapabilityStatus::Fail, format!("request failed: {}", short(e, 120))),
        Ok(resp) => match resp.tool_calls.first() {
            None => (
                CapabilityStatus::Fail,
                format!("no tool call; answered in text instead: \"{}\"", short(&resp.content, 80)),
            ),
            Some(c)
                if c.name == "get_weather" && arg_str(c, "city").is_some_and(|x| x.to_lowercase().contains("lyon")) =>
            {
                (CapabilityStatus::Pass, "called get_weather(city: Lyon)".into())
            }
            Some(c) => (
                CapabilityStatus::Limited,
                format!("called a tool with wrong arguments: {}({})", c.name, short(&c.arguments.to_string(), 80)),
            ),
        },
    }
}

pub const ORDER_ID: &str = "ORD-7731";
pub const ORDER_STATUS: &str = "shipped on 3 March";

/// `first`/`second`: the tool calls of the two steps; `answer`: the final text.
pub fn eval_multi_step(first: Option<&ToolCall>, second: Option<&ToolCall>, answer: Option<&str>) -> Verdict {
    let Some(f) = first else { return (CapabilityStatus::Fail, "no first tool call".into()) };
    if f.name != "find_order" {
        return (CapabilityStatus::Fail, format!("first call was {} instead of find_order", f.name));
    }
    let Some(s) = second else {
        return (CapabilityStatus::Limited, "made the first call but did not chain the second one".into());
    };
    if s.name != "order_status" || arg_str(s, "order_id").map(str::trim) != Some(ORDER_ID) {
        return (
            CapabilityStatus::Limited,
            format!("second call did not use the first result: {}({})", s.name, short(&s.arguments.to_string(), 80)),
        );
    }
    match answer {
        Some(a) if a.to_lowercase().contains("shipped") => {
            (CapabilityStatus::Pass, format!("find_order → order_status({ORDER_ID}) → correct answer"))
        }
        _ => (CapabilityStatus::Limited, "chained both calls but the final answer missed the result".into()),
    }
}

pub const VAULT_CODE: &str = "4817-KESTREL";

pub fn eval_context(r: &std::result::Result<ChatResponse, String>, prompt_words: usize) -> Verdict {
    match r {
        Err(e) => (CapabilityStatus::Fail, format!("request failed: {}", short(e, 120))),
        Ok(resp) => {
            let tokens =
                resp.prompt_tokens.map(|t| format!("{t} prompt tokens")).unwrap_or(format!("~{prompt_words} words"));
            if resp.content.to_uppercase().contains(VAULT_CODE) {
                (CapabilityStatus::Pass, format!("found the fact in a {tokens} prompt"))
            } else if resp.content.contains("4817") {
                (CapabilityStatus::Limited, format!("partially recalled the fact ({tokens})"))
            } else {
                (
                    CapabilityStatus::Fail,
                    format!("lost the fact in a {tokens} prompt (context window too small or truncated)"),
                )
            }
        }
    }
}

/// After `read_file(config.yml)` failed, the model either retried with the
/// file the error named (pass), reported the failure (limited) or pretended.
pub fn eval_recovery(first: Option<&ToolCall>, after_error: &std::result::Result<ChatResponse, String>) -> Verdict {
    if first.is_none() {
        return (CapabilityStatus::Fail, "no tool call to recover from".into());
    }
    match after_error {
        Err(e) => (CapabilityStatus::Fail, format!("request failed after the tool error: {}", short(e, 120))),
        Ok(r) => {
            if let Some(c) = r.tool_calls.first() {
                if arg_str(c, "path").is_some_and(|p| p.contains("settings.yml")) {
                    return (CapabilityStatus::Pass, "retried with the file named in the error".into());
                }
                return (
                    CapabilityStatus::Limited,
                    format!("retried without using the error: {}({})", c.name, short(&c.arguments.to_string(), 80)),
                );
            }
            let t = r.content.to_lowercase();
            if ["not found", "no such", "error", "doesn't exist", "does not exist", "failed", "settings.yml"]
                .iter()
                .any(|k| t.contains(k))
            {
                (CapabilityStatus::Limited, "reported the error instead of retrying".into())
            } else {
                (CapabilityStatus::Fail, format!("ignored the tool error: \"{}\"", short(&r.content, 80)))
            }
        }
    }
}

pub fn central_mode(results: &[CapabilityResult]) -> CentralMode {
    let status = |t: CapabilityTest| results.iter().find(|r| r.test == t).map(|r| r.status);
    if status(CapabilityTest::Chat) != Some(CapabilityStatus::Pass)
        && status(CapabilityTest::Chat) != Some(CapabilityStatus::Limited)
    {
        return CentralMode::Unavailable;
    }
    let tool = status(CapabilityTest::ToolCall);
    let multi = status(CapabilityTest::MultiStep);
    if tool == Some(CapabilityStatus::Pass) && matches!(multi, Some(CapabilityStatus::Pass | CapabilityStatus::Limited))
    {
        CentralMode::Full
    } else {
        CentralMode::LimitedTools
    }
}

pub fn summary(model: &str, results: &[CapabilityResult], mode: CentralMode) -> String {
    let passed = results.iter().filter(|r| r.status == CapabilityStatus::Pass).count();
    let what = match mode {
        CentralMode::Full => "Central Agent: full tool mode",
        CentralMode::LimitedTools => "Central Agent: Limited Tool Mode (the model does not control tools)",
        CentralMode::Unavailable => "Central Agent: unavailable on this model",
    };
    format!("{model}: {passed}/{} tests passed · {what}", results.len())
}

fn short(s: &str, max: usize) -> String {
    let s = s.trim().replace('\n', " ");
    if s.chars().count() <= max {
        s
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

// ---------------------------------------------------------------- the real run

fn tool(name: &str, description: &str, params: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: description.into(),
        parameters: json!({"type": "object", "properties": params, "required": required}),
    }
}

fn request(model: &str, messages: Vec<ChatMessage>, tools: Vec<ToolSpec>, max_tokens: u32) -> ChatRequest {
    ChatRequest {
        model: model.into(),
        messages,
        tools,
        temperature: Some(0.0),
        max_tokens: Some(max_tokens),
        think: crate::catalog::find(model).filter(|m| m.thinking).map(|_| false),
    }
}

const TOOL_SYSTEM: &str =
    "You are an agent that acts through tools. When a tool can answer, call it instead of answering in text.";

/// The long prompt of the context test (~3,000 words, the fact in the middle).
pub fn context_prompt() -> (String, usize) {
    let filler = "The quarterly maintenance log lists routine inspections of pumps, valves, cables and filters; \
nothing unusual was recorded and every item was signed off by the duty engineer. ";
    let mut s = String::from("Read the following log carefully.\n\n");
    for i in 0..110 {
        if i == 55 {
            s.push_str(&format!("IMPORTANT: the vault code is {VAULT_CODE}. "));
        }
        s.push_str(filler);
    }
    s.push_str("\n\nQuestion: what is the vault code? Answer with the code only.");
    let words = s.split_whitespace().count();
    (s, words)
}

fn timed<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let t = Instant::now();
    let v = f();
    (v, t.elapsed().as_millis() as u64)
}

/// Runs the six tests against the runtime (blocking, from seconds to a few
/// minutes on a CPU). `on_result` receives each result as it completes.
pub fn run(
    p: &dyn LocalAiProvider,
    runtime: &str,
    model: &str,
    on_result: &mut dyn FnMut(&CapabilityResult),
) -> CapabilityReport {
    let kind = p.kind();
    let chat = |req: &ChatRequest| p.chat(req).map_err(|e| e.to_string());
    let mut results: Vec<CapabilityResult> = Vec::new();
    let mut push = |test: CapabilityTest, (status, detail): Verdict, ms: u64, results: &mut Vec<CapabilityResult>| {
        let r = CapabilityResult { test, status, detail, ms };
        on_result(&r);
        results.push(r);
    };

    // 1. Chat.
    let (r, ms) = timed(|| {
        chat(&request(
            model,
            vec![ChatMessage::user(format!("Reply with exactly this text and nothing else: {CHAT_TOKEN}"))],
            vec![],
            24,
        ))
    });
    let v = match &r {
        Ok(resp) => eval_chat(&resp.content),
        Err(e) => (CapabilityStatus::Fail, format!("request failed: {}", short(e, 120))),
    };
    let chat_failed = v.0 == CapabilityStatus::Fail;
    push(CapabilityTest::Chat, v, ms, &mut results);

    // 2. Structured output.
    let (r, ms) = timed(|| {
        chat(&request(
            model,
            vec![
                ChatMessage::system("You output JSON only, no prose, no code fence."),
                ChatMessage::user(
                    "Give a JSON object with the keys \"city\" (string), \"country\" (string) and \"population_millions\" (number) for the capital of France.",
                ),
            ],
            vec![],
            96,
        ))
    });
    let v = match &r {
        Ok(resp) => eval_structured(&resp.content),
        Err(e) => (CapabilityStatus::Fail, format!("request failed: {}", short(e, 120))),
    };
    push(CapabilityTest::StructuredOutput, v, ms, &mut results);

    // 3. Tool call.
    let weather = tool(
        "get_weather",
        "Current weather of a city.",
        json!({"city": {"type": "string", "description": "City name"}}),
        &["city"],
    );
    let (r, ms) = timed(|| {
        chat(&request(
            model,
            vec![ChatMessage::system(TOOL_SYSTEM), ChatMessage::user("What is the weather in Lyon right now?")],
            vec![weather],
            128,
        ))
    });
    let v = eval_tool_call(&r);
    let tools_refused = v.0 == CapabilityStatus::Fail;
    push(CapabilityTest::ToolCall, v, ms, &mut results);

    // 4. Multi-step: find_order → order_status(order id from the first result).
    if tools_refused {
        push(
            CapabilityTest::MultiStep,
            (CapabilityStatus::Skipped, "skipped: the tool call test failed".into()),
            0,
            &mut results,
        );
    } else {
        let tools = vec![
            tool(
                "find_order",
                "Find the order id of a customer.",
                json!({"customer": {"type": "string"}}),
                &["customer"],
            ),
            tool(
                "order_status",
                "Delivery status of an order, by order id.",
                json!({"order_id": {"type": "string"}}),
                &["order_id"],
            ),
        ];
        let (v, ms) = timed(|| {
            let mut msgs = vec![
                ChatMessage::system(TOOL_SYSTEM),
                ChatMessage::user(
                    "Has Alice Martin's order been delivered? Use the tools: first find her order, then its status.",
                ),
            ];
            let first = match chat(&request(model, msgs.clone(), tools.clone(), 160)) {
                Ok(r) => r,
                Err(e) => return (CapabilityStatus::Fail, format!("request failed: {}", short(&e, 120))),
            };
            let Some(c1) = first.tool_calls.first().cloned() else { return eval_multi_step(None, None, None) };
            msgs.push(ChatMessage::assistant_calls(kind, &first.content, &first.tool_calls[..1]));
            msgs.push(ChatMessage::tool_result(kind, &c1, 0, json!({"order_id": ORDER_ID}).to_string()));
            let second = match chat(&request(model, msgs.clone(), tools.clone(), 160)) {
                Ok(r) => r,
                Err(e) => return (CapabilityStatus::Limited, format!("second step failed: {}", short(&e, 120))),
            };
            let Some(c2) = second.tool_calls.first().cloned() else {
                return eval_multi_step(Some(&c1), None, None);
            };
            if c2.name != "order_status" {
                return eval_multi_step(Some(&c1), Some(&c2), None);
            }
            msgs.push(ChatMessage::assistant_calls(kind, &second.content, &second.tool_calls[..1]));
            msgs.push(ChatMessage::tool_result(kind, &c2, 0, json!({"status": ORDER_STATUS}).to_string()));
            let fin = chat(&request(model, msgs, tools.clone(), 160)).ok();
            eval_multi_step(Some(&c1), Some(&c2), fin.as_ref().map(|f| f.content.as_str()))
        });
        push(CapabilityTest::MultiStep, v, ms, &mut results);
    }

    // 5. Long context.
    let (prompt, words) = context_prompt();
    let (r, ms) = timed(|| chat(&request(model, vec![ChatMessage::user(prompt)], vec![], 24)));
    push(CapabilityTest::Context, eval_context(&r, words), ms, &mut results);

    // 6. Recovery from a tool error.
    if tools_refused {
        push(
            CapabilityTest::Recovery,
            (CapabilityStatus::Skipped, "skipped: the tool call test failed".into()),
            0,
            &mut results,
        );
    } else {
        let read = vec![tool("read_file", "Read a project file.", json!({"path": {"type": "string"}}), &["path"])];
        let (v, ms) = timed(|| {
            let mut msgs = vec![
                ChatMessage::system(TOOL_SYSTEM),
                ChatMessage::user("Read config.yml and tell me the value of `port`."),
            ];
            let first = match chat(&request(model, msgs.clone(), read.clone(), 128)) {
                Ok(r) => r,
                Err(e) => return (CapabilityStatus::Fail, format!("request failed: {}", short(&e, 120))),
            };
            let Some(c1) = first.tool_calls.first().cloned() else { return eval_recovery(None, &Err(String::new())) };
            msgs.push(ChatMessage::assistant_calls(kind, &first.content, &first.tool_calls[..1]));
            msgs.push(ChatMessage::tool_result(
                kind,
                &c1,
                0,
                "ERROR: ENOENT: no such file 'config.yml'. The configuration is in settings.yml.",
            ));
            let after = chat(&request(model, msgs, read.clone(), 128));
            eval_recovery(Some(&c1), &after)
        });
        push(CapabilityTest::Recovery, v, ms, &mut results);
    }

    let mode = if chat_failed { CentralMode::Unavailable } else { central_mode(&results) };
    CapabilityReport {
        runtime: runtime.into(),
        base_url: p.base_url().into(),
        model: model.into(),
        at: pcc_core::now(),
        summary: summary(model, &results, mode),
        results,
        central_mode: mode,
    }
}

// ---------------------------------------------------------------- stored results

static STORE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where results are kept (the app's local data folder); set once at start-up.
pub fn set_store_dir(dir: PathBuf) {
    let _ = STORE_DIR.set(dir);
}

fn store_file(dir: &Path) -> PathBuf {
    dir.join("ai").join("capabilities.json")
}

fn key(runtime: &str, model: &str) -> String {
    format!("{runtime}/{}", model.strip_suffix(":latest").unwrap_or(model))
}

pub fn load_all_in(dir: &Path) -> Vec<CapabilityReport> {
    std::fs::read_to_string(store_file(dir)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Keeps the latest report per runtime + model.
pub fn save_in(dir: &Path, report: &CapabilityReport) -> Result<()> {
    let mut all = load_all_in(dir);
    all.retain(|r| key(&r.runtime, &r.model) != key(&report.runtime, &report.model));
    all.push(report.clone());
    let f = store_file(dir);
    if let Some(parent) = f.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&f, serde_json::to_string_pretty(&all)?)?;
    Ok(())
}

pub fn load_all() -> Vec<CapabilityReport> {
    STORE_DIR.get().map(|d| load_all_in(d)).unwrap_or_default()
}

pub fn save(report: &CapabilityReport) -> Result<()> {
    match STORE_DIR.get() {
        Some(d) => save_in(d, report),
        None => Ok(()),
    }
}

/// The last report for this runtime + model, if it was tested.
pub fn latest(runtime: &str, model: &str) -> Option<CapabilityReport> {
    load_all().into_iter().find(|r| key(&r.runtime, &r.model) == key(runtime, model))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall { name: name.into(), arguments: args, id: None }
    }

    fn resp(content: &str, calls: Vec<ToolCall>) -> ChatResponse {
        ChatResponse { content: content.into(), tool_calls: calls, ..Default::default() }
    }

    #[test]
    fn chat_and_structured_output() {
        assert_eq!(eval_chat("NEXUS-OK").0, CapabilityStatus::Pass);
        assert_eq!(eval_chat("Sure! Here you go").0, CapabilityStatus::Limited);
        assert_eq!(eval_chat("  ").0, CapabilityStatus::Fail);
        let good = r#"{"city": "Paris", "country": "France", "population_millions": 2.1}"#;
        assert_eq!(eval_structured(good).0, CapabilityStatus::Pass);
        let fenced = format!("Here is the JSON:\n```json\n{good}\n```");
        assert_eq!(eval_structured(&fenced).0, CapabilityStatus::Limited);
        assert_eq!(eval_structured(r#"{"city": "Paris"}"#).0, CapabilityStatus::Limited);
        assert_eq!(eval_structured("Paris, France, 2.1 million").0, CapabilityStatus::Fail);
    }

    #[test]
    fn tool_call_results() {
        let ok = Ok(resp("", vec![call("get_weather", json!({"city": "Lyon"}))]));
        assert_eq!(eval_tool_call(&ok).0, CapabilityStatus::Pass);
        let wrong = Ok(resp("", vec![call("get_weather", json!({"town": "Lyon"}))]));
        assert_eq!(eval_tool_call(&wrong).0, CapabilityStatus::Limited);
        let text = Ok(resp("It is sunny in Lyon.", vec![]));
        assert_eq!(eval_tool_call(&text).0, CapabilityStatus::Fail);
        // What Ollama answers for llama3.
        let refused: std::result::Result<ChatResponse, String> =
            Err("registry.ollama.ai/library/llama3:latest does not support tools".into());
        let v = eval_tool_call(&refused);
        assert_eq!(v.0, CapabilityStatus::Fail);
        assert!(v.1.contains("refused tools"));
    }

    #[test]
    fn multi_step_context_and_recovery() {
        let f = call("find_order", json!({"customer": "Alice Martin"}));
        let s = call("order_status", json!({"order_id": ORDER_ID}));
        assert_eq!(eval_multi_step(Some(&f), Some(&s), Some("Yes, it shipped on 3 March.")).0, CapabilityStatus::Pass);
        assert_eq!(eval_multi_step(Some(&f), None, None).0, CapabilityStatus::Limited);
        let guess = call("order_status", json!({"order_id": "12345"}));
        assert_eq!(eval_multi_step(Some(&f), Some(&guess), None).0, CapabilityStatus::Limited);
        assert_eq!(eval_multi_step(None, None, None).0, CapabilityStatus::Fail);

        let (prompt, words) = context_prompt();
        assert!(prompt.contains(VAULT_CODE) && words > 2_500);
        assert_eq!(eval_context(&Ok(resp("4817-KESTREL", vec![])), words).0, CapabilityStatus::Pass);
        assert_eq!(eval_context(&Ok(resp("I don't know", vec![])), words).0, CapabilityStatus::Fail);

        let first = call("read_file", json!({"path": "config.yml"}));
        let retry = Ok(resp("", vec![call("read_file", json!({"path": "settings.yml"}))]));
        assert_eq!(eval_recovery(Some(&first), &retry).0, CapabilityStatus::Pass);
        let report = Ok(resp("config.yml does not exist.", vec![]));
        assert_eq!(eval_recovery(Some(&first), &report).0, CapabilityStatus::Limited);
        let pretend = Ok(resp("The port is 8080.", vec![]));
        assert_eq!(eval_recovery(Some(&first), &pretend).0, CapabilityStatus::Fail);
    }

    fn result(test: CapabilityTest, status: CapabilityStatus) -> CapabilityResult {
        CapabilityResult { test, status, detail: String::new(), ms: 0 }
    }

    #[test]
    fn central_mode_follows_tool_calling() {
        use CapabilityStatus::*;
        use CapabilityTest::*;
        let no_tools =
            [result(Chat, Pass), result(StructuredOutput, Pass), result(ToolCall, Fail), result(MultiStep, Skipped)];
        assert_eq!(central_mode(&no_tools), CentralMode::LimitedTools);
        assert!(summary("llama3", &no_tools, CentralMode::LimitedTools).contains("Limited Tool Mode"));
        let full = [result(Chat, Pass), result(ToolCall, Pass), result(MultiStep, Limited)];
        assert_eq!(central_mode(&full), CentralMode::Full);
        let broken = [result(Chat, Fail), result(ToolCall, Fail)];
        assert_eq!(central_mode(&broken), CentralMode::Unavailable);
    }

    #[test]
    fn stores_the_latest_report_per_model() {
        let d = tempfile::tempdir().unwrap();
        let mut r = CapabilityReport {
            runtime: "ollama".into(),
            base_url: "http://127.0.0.1:11434".into(),
            model: "llama3:latest".into(),
            at: "2026-10-07T10:00:00Z".into(),
            results: vec![],
            central_mode: CentralMode::LimitedTools,
            summary: String::new(),
        };
        save_in(d.path(), &r).unwrap();
        r.model = "llama3".into();
        r.central_mode = CentralMode::Full;
        save_in(d.path(), &r).unwrap();
        let all = load_all_in(d.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].central_mode, CentralMode::Full);
    }

    /// Live: needs Ollama on 127.0.0.1:11434 with llama3 installed (no tool support).
    #[test]
    #[ignore]
    fn live_llama3_is_limited() {
        let o = crate::provider::Ollama::new("http://127.0.0.1:11434");
        let mut seen = 0;
        let report = run(&o, "ollama", "llama3:latest", &mut |r| {
            seen += 1;
            eprintln!("{:?} {:?} {} ({} ms)", r.test, r.status, r.detail, r.ms);
        });
        eprintln!("{}", report.summary);
        assert_eq!(seen, 6);
        assert_eq!(
            report.results.iter().find(|r| r.test == CapabilityTest::Chat).unwrap().status,
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.results.iter().find(|r| r.test == CapabilityTest::ToolCall).unwrap().status,
            CapabilityStatus::Fail
        );
        assert_eq!(report.central_mode, CentralMode::LimitedTools);
    }

    /// Live: needs Ollama with qwen3:8b installed (tool support).
    #[test]
    #[ignore]
    fn live_qwen3_controls_tools() {
        let o = crate::provider::Ollama::new("http://127.0.0.1:11434");
        let report = run(&o, "ollama", "qwen3:8b", &mut |r| {
            eprintln!("{:?} {:?} {} ({} ms)", r.test, r.status, r.detail, r.ms);
        });
        eprintln!("{}", report.summary);
        assert_eq!(
            report.results.iter().find(|r| r.test == CapabilityTest::ToolCall).unwrap().status,
            CapabilityStatus::Pass
        );
        assert_eq!(report.central_mode, CentralMode::Full);
    }
}
