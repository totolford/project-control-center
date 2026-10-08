//! Local AI providers: one trait, two implementations — Ollama's native API and
//! any OpenAI-compatible server (LM Studio, llama.cpp `llama-server`, others).
//! Claude is not a provider here: it is reached through Claude Code.
//!
//! Request bodies and response parsing are pure functions so they can be
//! tested without a server.

use std::io::{BufRead, BufReader};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pcc_core::{Error, Result};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Assistant turn that called tools, in the runtime's wire format.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Value>,
    /// Tool result (OpenAI-compatible servers): the call it answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Tool result (Ollama): the tool that produced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

impl ChatMessage {
    pub fn system(c: impl Into<String>) -> Self {
        Self { role: "system".into(), content: c.into(), ..Default::default() }
    }
    pub fn user(c: impl Into<String>) -> Self {
        Self { role: "user".into(), content: c.into(), ..Default::default() }
    }

    /// The assistant turn that made `calls`, to send back with their results
    /// (`kind` is the provider's `kind()`).
    pub fn assistant_calls(kind: &str, content: &str, calls: &[ToolCall]) -> Self {
        let wire: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(i, c)| {
                if kind == "ollama" {
                    json!({"function": {"name": c.name, "arguments": c.arguments}})
                } else {
                    json!({"id": call_id(c, i), "type": "function",
                        "function": {"name": c.name, "arguments": c.arguments.to_string()}})
                }
            })
            .collect();
        Self {
            role: "assistant".into(),
            content: content.into(),
            tool_calls: Some(Value::Array(wire)),
            ..Default::default()
        }
    }

    /// Result of the `index`-th call of the previous assistant turn.
    pub fn tool_result(kind: &str, call: &ToolCall, index: usize, content: impl Into<String>) -> Self {
        let mut m = Self { role: "tool".into(), content: content.into(), ..Default::default() };
        if kind == "ollama" {
            m.tool_name = Some(call.name.clone());
        } else {
            m.tool_call_id = Some(call_id(call, index));
        }
        m
    }
}

fn call_id(c: &ToolCall, index: usize) -> String {
    c.id.clone().unwrap_or_else(|| format!("call_{index}"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON schema of the arguments.
    pub parameters: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// Thinking models (qwen3): `Some(false)` asks for a direct answer.
    pub think: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
    /// Call id given by OpenAI-compatible servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    /// Generation time reported by the runtime (ms), when it reports one.
    pub eval_ms: Option<u64>,
    /// Wall-clock time of the request (ms).
    pub total_ms: u64,
}

impl ChatResponse {
    /// Tokens per second of the generation phase.
    pub fn tokens_per_second(&self) -> Option<f64> {
        let n = self.completion_tokens? as f64;
        let ms = self.eval_ms.unwrap_or(self.total_ms) as f64;
        (ms > 0.0 && n > 0.0).then(|| n * 1000.0 / ms)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub name: String,
    pub size_bytes: Option<u64>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    pub family: Option<String>,
    /// Loaded in memory right now (Ollama `/api/ps`).
    pub loaded: bool,
    /// Capabilities reported by the runtime (`completion`, `tools`, `vision`, `embedding`, `thinking`).
    pub capabilities: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub version: Option<String>,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// A local model server.
pub trait LocalAiProvider: Send + Sync {
    fn kind(&self) -> &'static str;
    fn base_url(&self) -> &str;
    fn health(&self) -> Health;
    fn list_models(&self) -> Result<Vec<LocalModel>>;
    fn chat(&self, req: &ChatRequest) -> Result<ChatResponse>;
    /// Streams the answer; `on_token` receives each text fragment.
    fn stream(&self, req: &ChatRequest, on_token: &mut dyn FnMut(&str)) -> Result<ChatResponse>;
    fn embed(&self, model: &str, input: &[String]) -> Result<Vec<Vec<f32>>>;
    fn load_model(&self, model: &str) -> Result<()>;
    fn unload_model(&self, model: &str) -> Result<()>;

    /// Single-prompt completion.
    fn generate(&self, model: &str, prompt: &str) -> Result<String> {
        let req = ChatRequest { model: model.into(), messages: vec![ChatMessage::user(prompt)], ..Default::default() };
        Ok(self.chat(&req)?.content)
    }

    /// Chat with tools offered; the model's tool calls are returned, not executed.
    fn tool_call(&self, req: &ChatRequest) -> Result<ChatResponse> {
        if req.tools.is_empty() {
            return Err(Error::invalid("tool_call needs at least one tool"));
        }
        self.chat(req)
    }
}

pub(crate) fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout(timeout).build()
}

/// Turns a ureq error into a readable message (server error bodies included).
pub(crate) fn http_error(e: ureq::Error) -> Error {
    match e {
        ureq::Error::Status(code, r) => {
            let body = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("error").and_then(|e| {
                        e.as_str().map(str::to_string).or_else(|| e["message"].as_str().map(str::to_string))
                    })
                })
                .unwrap_or(body);
            Error::Process(format!("HTTP {code}: {}", msg.trim()))
        }
        ureq::Error::Transport(t) => Error::Process(format!("cannot reach the local runtime: {t}")),
    }
}

fn post(url: &str, body: &Value, timeout: Duration) -> Result<ureq::Response> {
    agent(timeout).post(url).send_json(body.clone()).map_err(http_error)
}

fn get_json(url: &str, timeout: Duration) -> Result<Value> {
    let r = agent(timeout).get(url).call().map_err(http_error)?;
    r.into_json().map_err(|e| Error::Process(format!("invalid JSON from {url}: {e}")))
}

const CHAT_TIMEOUT: Duration = Duration::from_secs(300);

// ---------------------------------------------------------------- Ollama

pub struct Ollama {
    pub base: String,
}

impl Ollama {
    pub fn new(base: impl Into<String>) -> Self {
        Self { base: base.into().trim_end_matches('/').to_string() }
    }
}

pub fn ollama_chat_body(req: &ChatRequest, stream: bool) -> Value {
    let mut body = json!({ "model": req.model, "messages": req.messages, "stream": stream });
    let mut options = serde_json::Map::new();
    if let Some(t) = req.temperature {
        options.insert("temperature".into(), json!(t));
    }
    if let Some(n) = req.max_tokens {
        options.insert("num_predict".into(), json!(n));
    }
    if !options.is_empty() {
        body["options"] = Value::Object(options);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}})
                })
                .collect(),
        );
    }
    if let Some(think) = req.think {
        body["think"] = json!(think);
    }
    body
}

fn ns_to_ms(v: &Value) -> Option<u64> {
    v.as_u64().map(|ns| ns / 1_000_000)
}

pub fn parse_ollama_chat(v: &Value) -> Result<ChatResponse> {
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        return Err(Error::Process(e.to_string()));
    }
    let msg = &v["message"];
    let tool_calls = msg["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .filter_map(|c| {
                    let f = &c["function"];
                    Some(ToolCall {
                        name: f["name"].as_str()?.to_string(),
                        arguments: f["arguments"].clone(),
                        id: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ChatResponse {
        content: msg["content"].as_str().unwrap_or("").to_string(),
        tool_calls,
        prompt_tokens: v["prompt_eval_count"].as_u64(),
        completion_tokens: v["eval_count"].as_u64(),
        eval_ms: ns_to_ms(&v["eval_duration"]),
        total_ms: ns_to_ms(&v["total_duration"]).unwrap_or(0),
    })
}

/// One line of `POST /api/pull` (NDJSON).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub status: String,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
    pub error: Option<String>,
    pub done: bool,
}

impl PullProgress {
    pub fn percent(&self) -> Option<f64> {
        let (t, c) = (self.total?, self.completed?);
        (t > 0).then(|| c as f64 * 100.0 / t as f64)
    }
}

pub fn parse_pull_line(line: &str) -> Option<PullProgress> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let status = v["status"].as_str().unwrap_or("").to_string();
    let error = v["error"].as_str().map(str::to_string);
    Some(PullProgress {
        done: status == "success",
        digest: v["digest"].as_str().map(str::to_string),
        total: v["total"].as_u64(),
        completed: v["completed"].as_u64(),
        status,
        error,
    })
}

impl Ollama {
    /// Downloads a model, reporting progress. Blocking; can take minutes.
    /// `on_progress` returns `false` to cancel: the connection is dropped and
    /// Ollama stops the download (completed layers stay cached for a later pull).
    pub fn pull(&self, model: &str, mut on_progress: impl FnMut(&PullProgress) -> bool) -> Result<()> {
        let resp = post(
            &format!("{}/api/pull", self.base),
            &json!({"model": model, "stream": true}),
            Duration::from_secs(6 * 3600),
        )?;
        let mut done = false;
        for line in BufReader::new(resp.into_reader()).lines() {
            let line = line?;
            let Some(p) = parse_pull_line(&line) else { continue };
            if let Some(e) = &p.error {
                return Err(Error::Process(format!("pull {model}: {e}")));
            }
            done |= p.done;
            if !on_progress(&p) {
                return Err(Error::Process(format!("pull {model}: cancelled")));
            }
        }
        if done {
            Ok(())
        } else {
            Err(Error::Process(format!("pull {model}: the download stopped before completion")))
        }
    }

    pub fn delete(&self, model: &str) -> Result<()> {
        agent(Duration::from_secs(60))
            .delete(&format!("{}/api/delete", self.base))
            .send_json(json!({ "model": model }))
            .map_err(http_error)?;
        Ok(())
    }

    /// Capabilities of an installed model (`/api/show`), e.g. `["completion","tools"]`.
    pub fn capabilities(&self, model: &str) -> Result<Vec<String>> {
        let v: Value = post(&format!("{}/api/show", self.base), &json!({ "model": model }), Duration::from_secs(20))?
            .into_json()
            .map_err(|e| Error::Process(e.to_string()))?;
        Ok(v["capabilities"]
            .as_array()
            .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
            .unwrap_or_default())
    }

    fn keep_alive(&self, model: &str, keep_alive: Value) -> Result<()> {
        post(
            &format!("{}/api/generate", self.base),
            &json!({ "model": model, "keep_alive": keep_alive, "stream": false }),
            CHAT_TIMEOUT,
        )?;
        Ok(())
    }
}

pub fn parse_ollama_tags(tags: &Value, ps: &Value) -> Vec<LocalModel> {
    let loaded: Vec<&str> =
        ps["models"].as_array().map(|a| a.iter().filter_map(|m| m["name"].as_str()).collect()).unwrap_or_default();
    tags["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    let name = m["name"].as_str()?.to_string();
                    let d = &m["details"];
                    Some(LocalModel {
                        loaded: loaded.contains(&name.as_str()),
                        size_bytes: m["size"].as_u64(),
                        parameter_size: d["parameter_size"].as_str().map(str::to_string),
                        quantization: d["quantization_level"].as_str().map(str::to_string),
                        family: d["family"].as_str().map(str::to_string),
                        capabilities: None,
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

impl LocalAiProvider for Ollama {
    fn kind(&self) -> &'static str {
        "ollama"
    }
    fn base_url(&self) -> &str {
        &self.base
    }
    fn health(&self) -> Health {
        let start = Instant::now();
        match get_json(&format!("{}/api/version", self.base), Duration::from_secs(3)) {
            Ok(v) => Health {
                ok: true,
                version: v["version"].as_str().map(str::to_string),
                latency_ms: start.elapsed().as_millis() as u64,
                error: None,
            },
            Err(e) => Health {
                ok: false,
                version: None,
                latency_ms: start.elapsed().as_millis() as u64,
                error: Some(e.to_string()),
            },
        }
    }
    fn list_models(&self) -> Result<Vec<LocalModel>> {
        let tags = get_json(&format!("{}/api/tags", self.base), Duration::from_secs(10))?;
        let ps = get_json(&format!("{}/api/ps", self.base), Duration::from_secs(10)).unwrap_or_default();
        let mut models = parse_ollama_tags(&tags, &ps);
        for m in &mut models {
            m.capabilities = self.capabilities(&m.name).ok();
        }
        Ok(models)
    }
    fn chat(&self, req: &ChatRequest) -> Result<ChatResponse> {
        let start = Instant::now();
        let v: Value = post(&format!("{}/api/chat", self.base), &ollama_chat_body(req, false), CHAT_TIMEOUT)?
            .into_json()
            .map_err(|e| Error::Process(e.to_string()))?;
        let mut r = parse_ollama_chat(&v)?;
        r.total_ms = start.elapsed().as_millis() as u64;
        Ok(r)
    }
    fn stream(&self, req: &ChatRequest, on_token: &mut dyn FnMut(&str)) -> Result<ChatResponse> {
        let start = Instant::now();
        let resp = post(&format!("{}/api/chat", self.base), &ollama_chat_body(req, true), CHAT_TIMEOUT)?;
        let mut out = ChatResponse::default();
        for line in BufReader::new(resp.into_reader()).lines() {
            let line = line?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let part = parse_ollama_chat(&v)?;
            if !part.content.is_empty() {
                on_token(&part.content);
                out.content.push_str(&part.content);
            }
            out.tool_calls.extend(part.tool_calls);
            if v["done"].as_bool() == Some(true) {
                out.prompt_tokens = part.prompt_tokens;
                out.completion_tokens = part.completion_tokens;
                out.eval_ms = part.eval_ms;
            }
        }
        out.total_ms = start.elapsed().as_millis() as u64;
        Ok(out)
    }
    fn embed(&self, model: &str, input: &[String]) -> Result<Vec<Vec<f32>>> {
        let v: Value = post(
            &format!("{}/api/embed", self.base),
            &json!({"model": model, "input": input}),
            Duration::from_secs(120),
        )?
        .into_json()
        .map_err(|e| Error::Process(e.to_string()))?;
        serde_json::from_value(v["embeddings"].clone()).map_err(|e| Error::Process(format!("invalid embeddings: {e}")))
    }
    fn load_model(&self, model: &str) -> Result<()> {
        self.keep_alive(model, json!("30m"))
    }
    fn unload_model(&self, model: &str) -> Result<()> {
        self.keep_alive(model, json!(0))
    }
}

// ---------------------------------------------------------------- OpenAI-compatible

/// LM Studio (`/v1` on port 1234), llama.cpp's `llama-server` (port 8080) or any
/// server speaking the OpenAI chat completions API.
pub struct OpenAiCompatible {
    pub kind: &'static str,
    pub base: String,
    pub api_key: Option<String>,
    /// LM Studio's `lms` CLI, used to load/unload models.
    pub lms: Option<std::path::PathBuf>,
}

impl OpenAiCompatible {
    pub fn new(kind: &'static str, base: impl Into<String>) -> Self {
        Self { kind, base: base.into().trim_end_matches('/').to_string(), api_key: None, lms: None }
    }

    fn post(&self, path: &str, body: &Value, timeout: Duration) -> Result<ureq::Response> {
        let mut r = agent(timeout).post(&format!("{}{path}", self.base));
        if let Some(k) = &self.api_key {
            r = r.set("Authorization", &format!("Bearer {k}"));
        }
        r.send_json(body.clone()).map_err(http_error)
    }

    fn lms(&self, args: &[&str]) -> Result<()> {
        let lms = self
            .lms
            .as_ref()
            .ok_or_else(|| Error::invalid(format!("{} cannot load or unload models from NEXUS", self.kind)))?;
        let out = pcc_claude::process::std_command(lms).args(args).output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(Error::Process(String::from_utf8_lossy(&out.stderr).trim().to_string()))
        }
    }
}

pub fn openai_chat_body(req: &ChatRequest, stream: bool) -> Value {
    let mut body = json!({ "model": req.model, "messages": req.messages, "stream": stream });
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(n) = req.max_tokens {
        body["max_tokens"] = json!(n);
    }
    if stream {
        body["stream_options"] = json!({"include_usage": true});
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}})
                })
                .collect(),
        );
    }
    body
}

fn openai_tool_calls(msg: &Value) -> Vec<ToolCall> {
    msg["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .filter_map(|c| {
                    let f = &c["function"];
                    let args = match &f["arguments"] {
                        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::String(s.clone())),
                        other => other.clone(),
                    };
                    Some(ToolCall {
                        name: f["name"].as_str()?.to_string(),
                        arguments: args,
                        id: c["id"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_openai_chat(v: &Value) -> Result<ChatResponse> {
    if let Some(e) = v.get("error") {
        return Err(Error::Process(e["message"].as_str().or(e.as_str()).unwrap_or("error").to_string()));
    }
    let msg = &v["choices"][0]["message"];
    Ok(ChatResponse {
        content: msg["content"].as_str().unwrap_or("").to_string(),
        tool_calls: openai_tool_calls(msg),
        prompt_tokens: v["usage"]["prompt_tokens"].as_u64(),
        completion_tokens: v["usage"]["completion_tokens"].as_u64(),
        // llama.cpp reports its own timings.
        eval_ms: v["timings"]["predicted_ms"].as_f64().map(|f| f as u64),
        total_ms: 0,
    })
}

/// One SSE line of a streamed chat completion: `Some(Ok(delta))`, `None` for
/// keep-alives and `[DONE]`.
pub fn parse_openai_sse(line: &str) -> Option<Value> {
    let data = line.trim().strip_prefix("data:")?.trim();
    if data == "[DONE]" {
        return None;
    }
    serde_json::from_str(data).ok()
}

impl LocalAiProvider for OpenAiCompatible {
    fn kind(&self) -> &'static str {
        self.kind
    }
    fn base_url(&self) -> &str {
        &self.base
    }
    fn health(&self) -> Health {
        let start = Instant::now();
        let mut r = agent(Duration::from_secs(3)).get(&format!("{}/v1/models", self.base));
        if let Some(k) = &self.api_key {
            r = r.set("Authorization", &format!("Bearer {k}"));
        }
        let latency = || start.elapsed().as_millis() as u64;
        match r.call() {
            Ok(_) => Health { ok: true, version: None, latency_ms: latency(), error: None },
            Err(e) => {
                Health { ok: false, version: None, latency_ms: latency(), error: Some(http_error(e).to_string()) }
            }
        }
    }
    fn list_models(&self) -> Result<Vec<LocalModel>> {
        let v = get_json(&format!("{}/v1/models", self.base), Duration::from_secs(10))?;
        Ok(v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| Some(LocalModel { name: m["id"].as_str()?.to_string(), ..Default::default() }))
                    .collect()
            })
            .unwrap_or_default())
    }
    fn chat(&self, req: &ChatRequest) -> Result<ChatResponse> {
        let start = Instant::now();
        let v: Value = self
            .post("/v1/chat/completions", &openai_chat_body(req, false), CHAT_TIMEOUT)?
            .into_json()
            .map_err(|e| Error::Process(e.to_string()))?;
        let mut r = parse_openai_chat(&v)?;
        r.total_ms = start.elapsed().as_millis() as u64;
        Ok(r)
    }
    fn stream(&self, req: &ChatRequest, on_token: &mut dyn FnMut(&str)) -> Result<ChatResponse> {
        let start = Instant::now();
        let resp = self.post("/v1/chat/completions", &openai_chat_body(req, true), CHAT_TIMEOUT)?;
        let mut out = ChatResponse::default();
        for line in BufReader::new(resp.into_reader()).lines() {
            let Some(v) = parse_openai_sse(&line?) else { continue };
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                on_token(t);
                out.content.push_str(t);
            }
            out.tool_calls.extend(openai_tool_calls(&v["choices"][0]["delta"]));
            if let Some(u) = v["usage"].as_object() {
                out.prompt_tokens = u.get("prompt_tokens").and_then(Value::as_u64);
                out.completion_tokens = u.get("completion_tokens").and_then(Value::as_u64);
            }
        }
        out.total_ms = start.elapsed().as_millis() as u64;
        Ok(out)
    }
    fn embed(&self, model: &str, input: &[String]) -> Result<Vec<Vec<f32>>> {
        let v: Value = self
            .post("/v1/embeddings", &json!({"model": model, "input": input}), Duration::from_secs(120))?
            .into_json()
            .map_err(|e| Error::Process(e.to_string()))?;
        v["data"]
            .as_array()
            .ok_or_else(|| Error::Process("invalid embeddings response".into()))?
            .iter()
            .map(|d| serde_json::from_value(d["embedding"].clone()).map_err(|e| Error::Process(e.to_string())))
            .collect()
    }
    fn load_model(&self, model: &str) -> Result<()> {
        self.lms(&["load", model, "--yes"])
    }
    fn unload_model(&self, model: &str) -> Result<()> {
        self.lms(&["unload", model])
    }
}

/// Does the server answer the Anthropic Messages API (`POST /v1/messages`)?
/// That is what Claude Code needs to run on a local model. An empty request is
/// sent: an Anthropic-shaped error (`{"type":"error",...}`) proves the route
/// exists without generating anything.
pub fn supports_anthropic_messages(base: &str) -> bool {
    let r = agent(Duration::from_secs(5))
        .post(&format!("{}/v1/messages", base.trim_end_matches('/')))
        .set("anthropic-version", "2023-06-01")
        .send_json(json!({}));
    let body = match r {
        Ok(r) => r.into_string().unwrap_or_default(),
        Err(ureq::Error::Status(404, _)) | Err(ureq::Error::Transport(_)) => return false,
        Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(),
    };
    is_anthropic_shaped(&body)
}

pub fn is_anthropic_shaped(body: &str) -> bool {
    serde_json::from_str::<Value>(body).ok().is_some_and(|v| v["type"] == "error" || v["type"] == "message")
}

/// The provider for a configured endpoint.
pub fn for_endpoint(runtime: &str, base: &str) -> Box<dyn LocalAiProvider> {
    match runtime {
        "ollama" => Box::new(Ollama::new(base)),
        "lmstudio" => {
            let mut p = OpenAiCompatible::new("lmstudio", base);
            p.lms = crate::runtime::find_lms();
            Box::new(p)
        }
        "llamacpp" => Box::new(OpenAiCompatible::new("llamacpp", base)),
        _ => Box::new(OpenAiCompatible::new("openai", base)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> ChatRequest {
        ChatRequest {
            model: "qwen3:8b".into(),
            messages: vec![ChatMessage::system("be brief"), ChatMessage::user("hi")],
            tools: vec![ToolSpec {
                name: "get_time".into(),
                description: "current time".into(),
                parameters: json!({"type": "object", "properties": {}}),
            }],
            temperature: Some(0.2),
            max_tokens: Some(64),
            think: Some(false),
        }
    }

    #[test]
    fn builds_ollama_requests() {
        let b = ollama_chat_body(&req(), false);
        assert_eq!(b["model"], "qwen3:8b");
        assert_eq!(b["stream"], false);
        assert_eq!(b["messages"][1]["role"], "user");
        assert_eq!(b["options"]["num_predict"], 64);
        assert_eq!(b["tools"][0]["function"]["name"], "get_time");
        assert_eq!(b["think"], false);
        let plain = ollama_chat_body(&ChatRequest { model: "m".into(), ..Default::default() }, true);
        assert!(plain.get("options").is_none() && plain.get("tools").is_none() && plain.get("think").is_none());
    }

    #[test]
    fn builds_openai_requests() {
        let b = openai_chat_body(&req(), true);
        assert_eq!(b["max_tokens"], 64);
        assert_eq!(b["stream_options"]["include_usage"], true);
        assert_eq!(b["tools"][0]["type"], "function");
        assert!(b.get("think").is_none());
    }

    #[test]
    fn parses_ollama_answers_with_tool_calls() {
        let v = json!({
            "message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "get_time", "arguments": {"tz": "UTC"}}}]},
            "done": true, "prompt_eval_count": 20, "eval_count": 10, "eval_duration": 500_000_000u64, "total_duration": 900_000_000u64
        });
        let r = parse_ollama_chat(&v).unwrap();
        assert_eq!(r.tool_calls[0].name, "get_time");
        assert_eq!(r.tool_calls[0].arguments["tz"], "UTC");
        assert_eq!(r.eval_ms, Some(500));
        assert_eq!(r.tokens_per_second().map(|t| t.round()), Some(20.0));
        assert!(parse_ollama_chat(&json!({"error": "model not found"})).is_err());
    }

    #[test]
    fn parses_openai_answers() {
        let v = json!({"choices": [{"message": {"content": "hello", "tool_calls": [{"function": {"name": "f", "arguments": "{\"a\":1}"}}]}}],
                       "usage": {"prompt_tokens": 5, "completion_tokens": 2}});
        let r = parse_openai_chat(&v).unwrap();
        assert_eq!(r.content, "hello");
        assert_eq!(r.tool_calls[0].arguments["a"], 1);
        assert_eq!(r.completion_tokens, Some(2));
        assert_eq!(parse_openai_sse("data: [DONE]"), None);
        assert_eq!(parse_openai_sse(": keep-alive"), None);
        assert_eq!(parse_openai_sse("data: {\"x\":1}").unwrap()["x"], 1);
    }

    #[test]
    fn sends_tool_results_back_in_each_wire_format() {
        let c = ToolCall { name: "find_order".into(), arguments: json!({"customer": "Alice"}), id: None };
        let o = ChatMessage::assistant_calls("ollama", "", std::slice::from_ref(&c));
        assert_eq!(o.tool_calls.as_ref().unwrap()[0]["function"]["arguments"]["customer"], "Alice");
        let r = ChatMessage::tool_result("ollama", &c, 0, "ORD-1");
        assert_eq!(
            (r.role.as_str(), r.tool_name.as_deref(), r.tool_call_id.as_deref()),
            ("tool", Some("find_order"), None)
        );
        let oc = ToolCall { id: Some("call_abc".into()), ..c.clone() };
        let a = ChatMessage::assistant_calls("lmstudio", "", std::slice::from_ref(&oc));
        let wire = &a.tool_calls.as_ref().unwrap()[0];
        assert_eq!(
            (wire["id"].as_str(), wire["function"]["arguments"].as_str()),
            (Some("call_abc"), Some(r#"{"customer":"Alice"}"#))
        );
        assert_eq!(ChatMessage::tool_result("lmstudio", &oc, 0, "x").tool_call_id.as_deref(), Some("call_abc"));
        // Plain messages serialise as before.
        assert_eq!(serde_json::to_value(ChatMessage::user("hi")).unwrap(), json!({"role": "user", "content": "hi"}));
    }

    #[test]
    fn parses_the_pull_stream() {
        let lines = [
            r#"{"status":"pulling manifest"}"#,
            r#"{"status":"pulling 6e4c38e1172f","digest":"sha256:6e4c","total":4661211424,"completed":2330605712}"#,
            r#"{"status":"verifying sha256 digest"}"#,
            r#"{"status":"success"}"#,
        ];
        let parsed: Vec<PullProgress> = lines.iter().filter_map(|l| parse_pull_line(l)).collect();
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[1].percent().map(|p| p.round()), Some(50.0));
        assert!(parsed[3].done);
        let err = parse_pull_line(r#"{"error":"pull model manifest: file does not exist"}"#).unwrap();
        assert!(err.error.unwrap().contains("does not exist"));
        assert!(parse_pull_line("garbage").is_none());
    }

    #[test]
    fn parses_tags_and_loaded_models() {
        let tags = json!({"models": [{"name": "llama3:latest", "size": 4661224676u64,
            "details": {"family": "llama", "parameter_size": "8.0B", "quantization_level": "Q4_0"}}]});
        let ps = json!({"models": [{"name": "llama3:latest"}]});
        let m = parse_ollama_tags(&tags, &ps);
        assert_eq!(m[0].parameter_size.as_deref(), Some("8.0B"));
        assert!(m[0].loaded);
        assert!(!parse_ollama_tags(&tags, &json!({}))[0].loaded);
    }

    #[test]
    fn recognises_anthropic_error_bodies() {
        assert!(is_anthropic_shaped(
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"model is required"}}"#
        ));
        assert!(!is_anthropic_shaped("404 page not found"));
        assert!(!is_anthropic_shaped(r#"{"error":"not found"}"#));
    }

    /// Live: needs Ollama on 127.0.0.1:11434 with llama3 installed.
    #[test]
    #[ignore]
    fn live_ollama_llama3() {
        let o = Ollama::new("http://127.0.0.1:11434");
        let h = o.health();
        assert!(h.ok, "{h:?}");
        let models = o.list_models().unwrap();
        assert!(models.iter().any(|m| m.name.starts_with("llama3")));
        let r = o
            .chat(&ChatRequest {
                model: "llama3:latest".into(),
                messages: vec![ChatMessage::user("Reply with the single word: pong")],
                max_tokens: Some(8),
                ..Default::default()
            })
            .unwrap();
        assert!(!r.content.trim().is_empty());
        assert!(r.completion_tokens.unwrap_or(0) > 0);
        assert!(supports_anthropic_messages("http://127.0.0.1:11434"));
        let mut streamed = String::new();
        o.stream(
            &ChatRequest {
                model: "llama3:latest".into(),
                messages: vec![ChatMessage::user("Count: 1 2 3")],
                max_tokens: Some(8),
                ..Default::default()
            },
            &mut |t| streamed.push_str(t),
        )
        .unwrap();
        assert!(!streamed.is_empty());
        o.unload_model("llama3:latest").unwrap();
    }
}
