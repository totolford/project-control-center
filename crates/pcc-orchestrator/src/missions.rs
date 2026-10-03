//! Missions beyond create/finish: the queue (one mission runs at a time,
//! the others wait by priority), archiving, the brief handed to Central with
//! the user's skill / MCP / connection selection, the pre-mission analysis
//! (one short Claude Code call) and the activity observed in the logs.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use pcc_core::{
    Connection, Error, EventKind, Mission, MissionAnalysis, MissionStatus, Priority, RequiredAgent, Requirement,
    Result, CENTRAL_ID,
};
use pcc_store::{ProjectStore, TaskFilter};

use crate::dto::MissionSpec;
use crate::engine::{first_line, Engine};

// ---------------------------------------------------------------- queue

impl Engine {
    /// Creates a mission. It goes to Central right away when nothing else is
    /// running (or `start_now`), otherwise it is queued and started when the
    /// running mission finishes.
    pub fn create_mission_from(&mut self, spec: MissionSpec) -> Result<Mission> {
        self.ensure_not_emergency()?;
        let prompt = spec.prompt.trim();
        if prompt.is_empty() {
            return Err(Error::invalid("describe the mission"));
        }
        let known: Vec<String> = self.store.list_connections()?.into_iter().map(|c| c.id).collect();
        if let Some(bad) = spec.connections.iter().find(|c| !known.contains(c)) {
            return Err(Error::invalid(format!("unknown connection `{bad}`")));
        }
        let now = pcc_core::now();
        let mut m = Mission {
            id: self.store.next_mission_id()?,
            title: spec.title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| first_line(prompt, 80)),
            prompt: prompt.into(),
            status: MissionStatus::Queued,
            summary: None,
            created_at: now.clone(),
            updated_at: now,
            completed_at: None,
            priority: spec.priority.unwrap_or(Priority::Normal),
            model: spec.model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            skills: clean(spec.skills),
            mcp: clean(spec.mcp),
            connections: clean(spec.connections),
            analysis: spec.analysis,
            started_at: None,
            archived_at: None,
        };
        self.store.upsert_mission(&m)?;
        let running = !self.store.active_mission_ids()?.is_empty();
        if running && !spec.start_now {
            let position = self.store.queued_missions()?.iter().position(|q| q.id == m.id).unwrap_or(0) + 1;
            self.emit_mission(
                EventKind::MissionCreated,
                &m.id,
                format!("Mission {} queued (position {position}): {}", m.id, m.title),
            );
            return Ok(m);
        }
        self.emit_mission(EventKind::MissionCreated, &m.id, format!("Mission {} created: {}", m.id, m.title));
        self.dispatch_mission(&mut m)?;
        Ok(m)
    }

    /// Hands a queued mission to Central.
    fn dispatch_mission(&mut self, m: &mut Mission) -> Result<()> {
        let connections = self.store.list_connections()?;
        m.status = MissionStatus::Planning;
        m.started_at = Some(pcc_core::now());
        m.updated_at = m.started_at.clone().unwrap_or_default();
        self.store.upsert_mission(m)?;
        self.emit_mission(EventKind::MissionUpdated, &m.id, format!("Mission {} sent to Central", m.id));
        self.autopilot = true;
        let body = mission_brief(m, &connections);
        self.wake(CENTRAL_ID)?;
        self.post_message(pcc_core::USER_ID, CENTRAL_ID, pcc_core::MessageKind::User, &body, None, Some(m.id.clone()))?;
        Ok(())
    }

    /// Starts the first queued mission when nothing is running. Returns its id.
    pub fn start_next_queued(&mut self) -> Result<Option<String>> {
        if self.emergency || self.store.read_only() || !self.store.active_mission_ids()?.is_empty() {
            return Ok(None);
        }
        let Some(mut next) = self.store.queued_missions()?.into_iter().next() else { return Ok(None) };
        self.dispatch_mission(&mut next)?;
        Ok(Some(next.id))
    }

    /// "Start now": hands a queued mission to Central even if another one runs.
    pub fn start_mission(&mut self, id: &str) -> Result<Mission> {
        self.ensure_not_emergency()?;
        let mut m = self.store.get_mission(id)?.ok_or_else(|| Error::not_found(format!("mission {id}")))?;
        if m.status != MissionStatus::Queued {
            return Err(Error::invalid(format!("{id} is not queued")));
        }
        self.dispatch_mission(&mut m)?;
        Ok(m)
    }

    /// Reprioritises a mission that has not finished (reorders the queue).
    pub fn set_mission_priority(&mut self, id: &str, priority: Priority) -> Result<Mission> {
        let mut m = self.store.get_mission(id)?.ok_or_else(|| Error::not_found(format!("mission {id}")))?;
        if m.status.is_closed() {
            return Err(Error::invalid(format!("{id} is already closed")));
        }
        m.priority = priority;
        m.updated_at = pcc_core::now();
        self.store.upsert_mission(&m)?;
        self.emit_mission(EventKind::MissionUpdated, id, format!("{id} priority {priority:?}").to_lowercase());
        Ok(m)
    }

    /// Hides a finished mission from the main lists (or brings it back).
    pub fn archive_mission(&mut self, id: &str, archived: bool) -> Result<Mission> {
        let mut m = self.store.get_mission(id)?.ok_or_else(|| Error::not_found(format!("mission {id}")))?;
        if !m.status.is_closed() {
            return Err(Error::invalid(format!("{id} is not finished: only finished missions can be archived")));
        }
        m.archived_at = archived.then(pcc_core::now);
        m.updated_at = pcc_core::now();
        self.store.upsert_mission(&m)?;
        let what = if archived { "archived" } else { "restored" };
        self.emit_mission(EventKind::MissionUpdated, id, format!("{id} {what}"));
        Ok(m)
    }
}

fn clean(v: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

// ---------------------------------------------------------------- brief for Central

/// The message Central receives for a mission: the objective, then what the
/// user selected with explicit instructions on how to use it.
pub fn mission_brief(m: &Mission, connections: &[Connection]) -> String {
    let mut s = format!("NEW MISSION {} · priority {:?}\n\n{}\n", m.id, m.priority, m.prompt.trim());
    let mut selected = Vec::new();
    if !m.skills.is_empty() {
        let list = m.skills.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ");
        selected.push(format!(
            "- Skills: {list}. Use them for real: invoke each one with the Skill tool (e.g. Skill with skill \"{}\") when you work on the part it covers, and pass the relevant ones in `create_task` `skills` so the worker is told to invoke them too.",
            m.skills[0]
        ));
    }
    if !m.mcp.is_empty() {
        let list = m.mcp.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ");
        selected.push(format!(
            "- MCP servers: {list}. Their tools are named `mcp__<server>__<tool>`; use them where they apply and give the workers that need them the `mcp` permission (create_agent `permissions` with `mcp` set to allow or ask)."
        ));
    }
    if !m.connections.is_empty() {
        let list = m
            .connections
            .iter()
            .map(|id| match connections.iter().find(|c| &c.id == id) {
                Some(c) => format!("{} (`{}`, {:?})", c.name, c.id, c.kind),
                None => format!("`{id}`"),
            })
            .collect::<Vec<_>>()
            .join(", ");
        selected
            .push(format!("- Connections: {list}. Grant them with `grant_connection` to the workers that need them."));
    }
    if let Some(model) = &m.model {
        selected
            .push(format!("- Model: create the workers of this mission with model `{model}` (create_agent `model`)."));
    }
    if !selected.is_empty() {
        s.push_str("\n## Selected by the user for this mission\n\n");
        s.push_str(&selected.join("\n"));
        s.push('\n');
    }
    if let Some(a) = &m.analysis {
        let mut lines = Vec::new();
        if !a.agents.is_empty() {
            lines
                .push(format!("- Agents: {}", a.agents.iter().map(|r| r.role.as_str()).collect::<Vec<_>>().join(", ")));
        }
        if !a.steps.is_empty() {
            lines.push(format!("- Steps: {}", a.steps.join(" → ")));
        }
        if !lines.is_empty() {
            s.push_str(&format!(
                "\n## Pre-analysis by {} (an estimate, not a plan: verify it)\n\n{}\n",
                a.analyzed_with,
                lines.join("\n")
            ));
        }
    }
    s.push_str(&format!(
        "\nPlan it: inspect what you need, create or reuse agents, then create tasks (mission_id \"{}\") with dependencies. Finish with complete_mission when everything is done and verified.",
        m.id
    ));
    s
}

// ---------------------------------------------------------------- analysis

/// Real context the analysis is given (and checked against).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AnalysisContext {
    pub project_name: String,
    pub project_types: Vec<String>,
    pub agents: Vec<ContextAgent>,
    pub skills: Vec<ContextSkill>,
    pub mcp_servers: Vec<ContextMcp>,
    /// False when the MCP server list could not be read (requirements are then "unknown").
    pub mcp_known: bool,
    pub connections: Vec<ContextConnection>,
    pub models: Vec<String>,
}

impl Engine {
    /// Project part of the analysis context (agents, connections); skills,
    /// MCP servers and models come from Claude Code and are added by the caller.
    pub fn analysis_base(&self) -> Result<AnalysisContext> {
        Ok(AnalysisContext {
            project_name: self.store.info().name.clone(),
            project_types: self.project_types.clone(),
            agents: self
                .store
                .list_agents()?
                .into_iter()
                .filter(|a| a.status != pcc_core::AgentStatus::Retired)
                .map(|a| ContextAgent { id: a.id, name: a.name, role: a.role })
                .collect(),
            connections: self
                .store
                .list_connections()?
                .into_iter()
                .map(|c| ContextConnection {
                    kind: serde_json::to_value(c.kind)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default(),
                    status: serde_json::to_value(c.status)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default(),
                    id: c.id,
                    name: c.name,
                    enabled: c.enabled,
                })
                .collect(),
            ..Default::default()
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextAgent {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextSkill {
    /// Name to give the Skill tool (`plugin:skill` for plugin skills).
    pub name: String,
    pub description: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextMcp {
    pub name: String,
    /// As reported by Claude Code (`connected`, `failed`, `needs-auth`...), when known.
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextConnection {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub status: String,
}

/// Name the Skill tool expects: plugin skills are namespaced by plugin
/// (`ui-ux-pro-max@marketplace` + `design` → `ui-ux-pro-max:design`).
pub fn skill_invocation_name(name: &str, plugin_id: Option<&str>) -> String {
    match plugin_id.map(|p| p.split('@').next().unwrap_or(p)).filter(|p| !p.is_empty()) {
        Some(plugin) if !name.contains(':') => format!("{plugin}:{name}"),
        _ => name.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max {
        s
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// Prompt of the analysis call. Everything listed is real; Claude is told to
/// prefer it and to flag anything else as missing.
pub fn analysis_prompt(objective: &str, ctx: &AnalysisContext) -> String {
    let mut s = String::from(
        "You estimate what a software mission needs before a team of Claude Code agents starts it. \
         Do not plan in detail and do not do the work. Answer ONLY with one JSON object, no prose, with keys:\n\
         title (string, max 60 chars), summary (one sentence),\n\
         agents (array of {role, reason, existing}: specialised workers needed; existing = id of a listed agent whose role fits, else null),\n\
         skills (array of {name, reason}: skills worth invoking; use exact names from the installed list, add others only if clearly needed),\n\
         mcp (array of {name, reason}: MCP servers needed; exact names from the list when they exist),\n\
         connections (array of {name, reason}: project connections needed, by id when listed, else a kind like github, ssh, roblox_studio),\n\
         model (one of the listed models or null), model_reason (string),\n\
         steps (array of 2-8 short strings), estimated_steps (integer).\n\
         Prefer few requirements: only what the objective really needs.\n\n",
    );
    s.push_str(&format!("Project: {}", ctx.project_name));
    if !ctx.project_types.is_empty() {
        s.push_str(&format!(" ({})", ctx.project_types.join(", ")));
    }
    s.push_str("\n\nExisting agents:\n");
    for a in &ctx.agents {
        s.push_str(&format!("- {} ({}): {}\n", a.id, a.name, truncate(&a.role, 160)));
    }
    s.push_str("\nInstalled skills:\n");
    if ctx.skills.is_empty() {
        s.push_str("(none)\n");
    }
    for k in &ctx.skills {
        s.push_str(&format!(
            "- {}{}: {}\n",
            k.name,
            if k.enabled { "" } else { " [disabled]" },
            truncate(&k.description, 220)
        ));
    }
    s.push_str("\nMCP servers configured in Claude Code:\n");
    if ctx.mcp_servers.is_empty() {
        s.push_str(if ctx.mcp_known { "(none)\n" } else { "(unknown)\n" });
    }
    for m in &ctx.mcp_servers {
        s.push_str(&format!("- {}{}\n", m.name, m.status.as_deref().map(|x| format!(" [{x}]")).unwrap_or_default()));
    }
    s.push_str("\nProject connections:\n");
    if ctx.connections.is_empty() {
        s.push_str("(none)\n");
    }
    for c in &ctx.connections {
        s.push_str(&format!("- {} ({}, kind {}{})\n", c.id, c.name, c.kind, if c.enabled { "" } else { ", disabled" }));
    }
    if !ctx.models.is_empty() {
        s.push_str(&format!("\nModels: {}\n", ctx.models.join(", ")));
    }
    s.push_str(&format!("\nMission objective:\n{}\n", objective.trim()));
    s
}

/// Extracts the outermost JSON object of a model answer (tolerates code fences and prose).
pub fn json_object(text: &str) -> Result<Value> {
    let start = text.find('{').ok_or_else(|| Error::invalid("no JSON object in the answer"))?;
    let end = text.rfind('}').ok_or_else(|| Error::invalid("no JSON object in the answer"))?;
    if end < start {
        return Err(Error::invalid("no JSON object in the answer"));
    }
    serde_json::from_str(&text[start..=end]).map_err(|e| Error::invalid(format!("invalid JSON from Claude: {e}")))
}

fn text(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn items(v: &Value, k: &str) -> Vec<Value> {
    match v.get(k) {
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                // Tolerate a bare list of names.
                Value::String(s) => serde_json::json!({ "name": s }),
                other => other.clone(),
            })
            .collect(),
        _ => vec![],
    }
}

fn norm(s: &str) -> String {
    s.trim().trim_start_matches('/').to_lowercase().replace(['_', ' '], "-")
}

/// Same skill when the full names match, or the part after `plugin:` does.
fn skill_matches(candidate: &str, real: &str) -> bool {
    let (c, r) = (norm(candidate), norm(real));
    if c == r {
        return true;
    }
    let tail = |s: &str| s.rsplit(':').next().unwrap_or(s).to_string();
    (!c.contains(':') || !r.contains(':')) && tail(&c) == tail(&r)
}

/// Turns the model answer into an analysis whose availability flags come
/// from the real context, never from the model.
pub fn parse_analysis(answer: &str, ctx: &AnalysisContext, model: &str) -> Result<MissionAnalysis> {
    let v = json_object(answer)?;
    let mut a = MissionAnalysis {
        title: truncate(&text(&v, "title"), 80),
        summary: text(&v, "summary"),
        analyzed_with: model.to_string(),
        analyzed_at: pcc_core::now(),
        ..Default::default()
    };
    for r in items(&v, "agents") {
        let role = text(&r, "role");
        if role.is_empty() {
            continue;
        }
        let named = text(&r, "existing");
        let existing = ctx
            .agents
            .iter()
            .find(|x| !named.is_empty() && (norm(&x.id) == norm(&named) || norm(&x.name) == norm(&named)))
            .map(|x| x.id.clone());
        a.agents.push(RequiredAgent { role, reason: text(&r, "reason"), existing });
    }
    for r in items(&v, "skills") {
        let name = text(&r, "name");
        if name.is_empty() {
            continue;
        }
        // Prefer an exact match, then a namespace-insensitive one.
        let found = ctx
            .skills
            .iter()
            .find(|k| norm(&k.name) == norm(&name))
            .or_else(|| ctx.skills.iter().find(|k| skill_matches(&name, &k.name)));
        let req = match found {
            Some(k) => Requirement {
                name: k.name.clone(),
                reason: text(&r, "reason"),
                available: k.enabled,
                detail: (!k.enabled).then(|| "installed but disabled".into()),
            },
            None => {
                Requirement { name, reason: text(&r, "reason"), available: false, detail: Some("not installed".into()) }
            }
        };
        if !a.skills.iter().any(|x| x.name == req.name) {
            a.skills.push(req);
        }
    }
    for r in items(&v, "mcp") {
        let name = text(&r, "name");
        if name.is_empty() {
            continue;
        }
        let found = ctx.mcp_servers.iter().find(|m| norm(&m.name) == norm(&name));
        let req = match found {
            Some(m) => {
                let bad = m.status.as_deref().filter(|s| !matches!(*s, "connected" | "ok"));
                Requirement {
                    name: m.name.clone(),
                    reason: text(&r, "reason"),
                    available: bad.is_none(),
                    detail: bad.map(|s| format!("configured, status {s}")),
                }
            }
            None => Requirement {
                name,
                reason: text(&r, "reason"),
                available: false,
                detail: Some(if ctx.mcp_known {
                    "not configured in Claude Code".into()
                } else {
                    "unknown: the MCP server list was not available".into()
                }),
            },
        };
        if !a.mcp.iter().any(|x| x.name == req.name) {
            a.mcp.push(req);
        }
    }
    for r in items(&v, "connections") {
        let name = text(&r, "name");
        if name.is_empty() {
            continue;
        }
        let n = norm(&name);
        let found = ctx
            .connections
            .iter()
            .find(|c| norm(&c.id) == n || norm(&c.name) == n)
            .or_else(|| ctx.connections.iter().find(|c| norm(&c.kind) == n));
        let req = match found {
            Some(c) => {
                let detail = if !c.enabled {
                    Some("disabled".to_string())
                } else if c.status == "error" || c.status == "disconnected" {
                    Some(format!("status {}", c.status))
                } else {
                    None
                };
                Requirement { name: c.id.clone(), reason: text(&r, "reason"), available: detail.is_none(), detail }
            }
            None => Requirement {
                name,
                reason: text(&r, "reason"),
                available: false,
                detail: Some("no such project connection".into()),
            },
        };
        if !a.connections.iter().any(|x| x.name == req.name) {
            a.connections.push(req);
        }
    }
    let model = text(&v, "model");
    if !model.is_empty() && model != "null" {
        a.model = Some(model);
        a.model_reason = Some(text(&v, "model_reason")).filter(|s| !s.is_empty());
    }
    a.steps =
        items(&v, "steps").iter().filter_map(|s| s.get("name").and_then(Value::as_str).map(str::to_string)).collect();
    a.estimated_steps =
        v.get("estimated_steps").and_then(Value::as_u64).map(|n| n.min(1000) as u32).unwrap_or(a.steps.len() as u32);
    Ok(a)
}

/// One answer of the analysis model: text and cost when reported.
pub struct ModelAnswer {
    pub text: String,
    pub cost_usd: Option<f64>,
}

/// Runs the analysis with any model caller (the real one is [`ask_claude`]).
pub async fn analyze_with<F, Fut>(
    objective: &str,
    ctx: &AnalysisContext,
    model: &str,
    ask: F,
) -> Result<MissionAnalysis>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<ModelAnswer>>,
{
    if objective.trim().is_empty() {
        return Err(Error::invalid("describe the mission"));
    }
    let answer = ask(analysis_prompt(objective, ctx)).await?;
    let mut a = parse_analysis(&answer.text, ctx, model)?;
    a.cost_usd = answer.cost_usd;
    Ok(a)
}

/// One-shot Claude Code call with tools, MCP and skills disabled; the prompt
/// goes through stdin (no command-line length limit).
pub async fn ask_claude(claude: &Path, model: &str, prompt: String, timeout: Duration) -> Result<ModelAnswer> {
    use tokio::io::AsyncWriteExt;
    let mut cmd = pcc_claude::process::command(claude);
    cmd.args([
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--max-budget-usd",
        "0.25",
    ])
    .current_dir(std::env::temp_dir())
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| Error::Process(format!("cannot run Claude Code: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        drop(stdin);
    }
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| Error::Process(format!("Claude Code did not answer within {}s", timeout.as_secs())))??;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| {
        let err = String::from_utf8_lossy(&out.stderr);
        Error::Process(format!(
            "unexpected Claude Code output: {}",
            if err.trim().is_empty() { "no output".into() } else { truncate(&err, 300) }
        ))
    })?;
    if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        return Err(Error::Process(v.get("result").and_then(Value::as_str).unwrap_or("Claude Code error").into()));
    }
    Ok(ModelAnswer {
        text: v.get("result").and_then(Value::as_str).unwrap_or("").to_string(),
        cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
    })
}

// ---------------------------------------------------------------- observed activity

/// What the mission's agents really did with skills and MCP, from their logs.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionActivity {
    pub mission_id: String,
    /// Central plus every agent assigned to one of the mission's tasks.
    pub agents: Vec<String>,
    pub skills_used: Vec<ToolUsage>,
    pub mcp_used: Vec<ToolUsage>,
    /// Time window the logs were read for.
    pub from: String,
    pub to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    /// Skill name or MCP server name.
    pub name: String,
    pub agents: Vec<String>,
    pub count: u32,
    pub last: String,
}

/// `("skill", name)` or `("mcp", server)` from a logged tool use line
/// (`Skill {"skill":"x"}`, `mcp__server__tool {...}`, optionally prefixed by `↳ `).
pub fn parse_tool_use(line: &str) -> Option<(&'static str, String)> {
    let line = line.trim_start_matches("↳ ").trim_start();
    let (name, rest) = line.split_once(' ').unwrap_or((line, ""));
    if name == "Skill" {
        let v: Value = serde_json::from_str(rest.trim()).ok()?;
        let skill = v.get("skill").or_else(|| v.get("command")).and_then(Value::as_str)?;
        return Some(("skill", skill.trim_start_matches('/').to_string()));
    }
    let server = name.strip_prefix("mcp__")?.split("__").next()?;
    (!server.is_empty()).then(|| ("mcp", server.to_string()))
}

pub fn mission_activity(store: &ProjectStore, m: &Mission) -> Result<MissionActivity> {
    let mut agents = vec![CENTRAL_ID.to_string()];
    for t in store.list_tasks(&TaskFilter { mission_id: Some(m.id.clone()), ..Default::default() })? {
        if let Some(a) = t.agent {
            if !agents.contains(&a) {
                agents.push(a);
            }
        }
    }
    let from = m.started_at.clone().unwrap_or_else(|| m.created_at.clone());
    let mut act = MissionActivity {
        mission_id: m.id.clone(),
        agents: agents.clone(),
        from: from.clone(),
        to: m.completed_at.clone(),
        ..Default::default()
    };
    if m.status == MissionStatus::Queued {
        return Ok(act);
    }
    let mut skills: BTreeMap<String, ToolUsage> = BTreeMap::new();
    let mut mcp: BTreeMap<String, ToolUsage> = BTreeMap::new();
    for agent in &agents {
        for l in store.tool_uses(agent, &from, m.completed_at.as_deref(), 5000)? {
            let Some((kind, name)) = parse_tool_use(&l.text) else { continue };
            let map = if kind == "skill" { &mut skills } else { &mut mcp };
            let u = map.entry(name.clone()).or_insert_with(|| ToolUsage { name, ..Default::default() });
            u.count += 1;
            if !u.agents.contains(agent) {
                u.agents.push(agent.clone());
            }
            if l.ts > u.last {
                u.last = l.ts.clone();
            }
        }
    }
    act.skills_used = skills.into_values().collect();
    act.mcp_used = mcp.into_values().collect();
    Ok(act)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> AnalysisContext {
        AnalysisContext {
            project_name: "AERIS".into(),
            project_types: vec!["roblox".into()],
            agents: vec![ContextAgent { id: "ui".into(), name: "UI Agent".into(), role: "Interfaces".into() }],
            skills: vec![
                ContextSkill { name: "ui-ux-pro-max:ui-ux-pro-max".into(), description: "UI".into(), enabled: true },
                ContextSkill {
                    name: "ui-ux-pro-max:design-system".into(),
                    description: "tokens".into(),
                    enabled: true,
                },
                ContextSkill { name: "old-skill".into(), description: "x".into(), enabled: false },
            ],
            mcp_servers: vec![
                ContextMcp { name: "roblox-studio".into(), status: Some("connected".into()) },
                ContextMcp { name: "figma".into(), status: Some("failed".into()) },
            ],
            mcp_known: true,
            connections: vec![ContextConnection {
                id: "github".into(),
                name: "GitHub".into(),
                kind: "github".into(),
                enabled: true,
                status: "connected".into(),
            }],
            models: vec!["haiku".into(), "sonnet".into(), "opus".into()],
        }
    }

    #[test]
    fn prompt_lists_the_real_context() {
        let p = analysis_prompt("Improve the Works panel", &ctx());
        assert!(p.contains("ui-ux-pro-max:design-system"));
        assert!(p.contains("old-skill [disabled]"));
        assert!(p.contains("roblox-studio [connected]"));
        assert!(p.contains("- github (GitHub, kind github)"));
        assert!(p.contains("- ui (UI Agent): Interfaces"));
        assert!(p.ends_with("Improve the Works panel\n"));
    }

    #[test]
    fn availability_comes_from_the_context_not_the_model() {
        let answer = r#"Here you go:
```json
{"title": "Improve Works panel", "summary": "Polish the UI.",
 "agents": [{"role": "UI specialist", "reason": "panel", "existing": "UI Agent"}, {"role": "Reviewer", "existing": null}],
 "skills": [{"name": "ui-ux-pro-max", "reason": "design"}, {"name": "design-system"}, {"name": "old-skill"}, {"name": "magic", "reason": "?"}],
 "mcp": [{"name": "Roblox-Studio"}, {"name": "figma"}, "playwright"],
 "connections": [{"name": "GitHub"}, {"name": "ssh"}],
 "model": "sonnet", "model_reason": "UI work", "steps": ["Analyse", "Implement", "Test"], "estimated_steps": 5}
```"#;
        let a = parse_analysis(answer, &ctx(), "haiku").unwrap();
        assert_eq!(a.title, "Improve Works panel");
        assert_eq!(a.agents[0].existing.as_deref(), Some("ui"));
        assert_eq!(a.agents[1].existing, None);
        let s: Vec<(&str, bool)> = a.skills.iter().map(|r| (r.name.as_str(), r.available)).collect();
        assert_eq!(
            s,
            [
                ("ui-ux-pro-max:ui-ux-pro-max", true),
                ("ui-ux-pro-max:design-system", true),
                ("old-skill", false),
                ("magic", false)
            ]
        );
        assert_eq!(a.skills[2].detail.as_deref(), Some("installed but disabled"));
        assert_eq!(a.skills[3].detail.as_deref(), Some("not installed"));
        let m: Vec<(&str, bool)> = a.mcp.iter().map(|r| (r.name.as_str(), r.available)).collect();
        assert_eq!(m, [("roblox-studio", true), ("figma", false), ("playwright", false)]);
        assert_eq!(a.mcp[1].detail.as_deref(), Some("configured, status failed"));
        assert_eq!(a.connections[0].name, "github");
        assert!(a.connections[0].available);
        assert!(!a.connections[1].available);
        assert_eq!(a.model.as_deref(), Some("sonnet"));
        assert_eq!(a.steps.len(), 3);
        assert_eq!(a.estimated_steps, 5);
        assert_eq!(a.analyzed_with, "haiku");
    }

    #[test]
    fn rejects_answers_without_json() {
        assert!(parse_analysis("I cannot help with that.", &ctx(), "haiku").is_err());
        assert!(parse_analysis("} nothing {", &ctx(), "haiku").is_err());
    }

    #[tokio::test]
    async fn analyze_with_a_fake_model() {
        let a = analyze_with("Add tests", &ctx(), "haiku", |prompt| async move {
            assert!(prompt.contains("Add tests"));
            Ok(ModelAnswer {
                text: r#"{"title":"Tests","steps":["Write","Run"],"skills":[]}"#.into(),
                cost_usd: Some(0.002),
            })
        })
        .await
        .unwrap();
        assert_eq!((a.title.as_str(), a.estimated_steps, a.cost_usd), ("Tests", 2, Some(0.002)));
        let err = analyze_with("x", &ctx(), "haiku", |_| async { Err(Error::Process("not logged in".into())) }).await;
        assert!(err.unwrap_err().to_string().contains("not logged in"));
    }

    #[test]
    fn invocation_names() {
        assert_eq!(skill_invocation_name("design", Some("ui-ux-pro-max@ui-ux-pro-max-skill")), "ui-ux-pro-max:design");
        assert_eq!(skill_invocation_name("mine", None), "mine");
        assert_eq!(skill_invocation_name("a:b", Some("p@m")), "a:b");
    }

    #[test]
    fn tool_use_lines() {
        assert_eq!(
            parse_tool_use(r#"Skill {"skill":"ui-ux-pro-max:ui-ux-pro-max","args":"x"}"#),
            Some(("skill", "ui-ux-pro-max:ui-ux-pro-max".into()))
        );
        assert_eq!(parse_tool_use(r#"↳ mcp__roblox-studio__run_code {"a":1}"#), Some(("mcp", "roblox-studio".into())));
        assert_eq!(parse_tool_use(r#"mcp__pcc__create_task {"a":1}"#), Some(("mcp", "pcc".into())));
        assert_eq!(parse_tool_use(r#"Read {"file_path":"x"}"#), None);
        assert_eq!(parse_tool_use("Skill not-json"), None);
    }

    #[test]
    fn brief_carries_the_selection() {
        let m = Mission {
            id: "M-0042".into(),
            title: "Works panel".into(),
            prompt: "Improve the AERIS Works panel".into(),
            status: MissionStatus::Queued,
            summary: None,
            created_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
            priority: Priority::High,
            model: Some("sonnet".into()),
            skills: vec!["ui-ux-pro-max:ui-ux-pro-max".into(), "ui-ux-pro-max:design-system".into()],
            mcp: vec!["roblox-studio".into()],
            connections: vec!["github".into()],
            analysis: Some(MissionAnalysis {
                agents: vec![RequiredAgent { role: "UI Agent".into(), ..Default::default() }],
                steps: vec!["Analyse".into(), "Implement".into()],
                analyzed_with: "haiku".into(),
                ..Default::default()
            }),
            started_at: None,
            archived_at: None,
        };
        let b = mission_brief(&m, &[]);
        assert!(b.starts_with("NEW MISSION M-0042 · priority High"));
        assert!(
            b.contains("invoke each one with the Skill tool (e.g. Skill with skill \"ui-ux-pro-max:ui-ux-pro-max\")")
        );
        assert!(b.contains("`ui-ux-pro-max:design-system`"));
        assert!(b.contains("`create_task` `skills`"));
        assert!(b.contains("`roblox-studio`"));
        assert!(b.contains("grant_connection"));
        assert!(b.contains("model `sonnet`"));
        assert!(b.contains("Pre-analysis by haiku (an estimate"));
        assert!(b.contains("mission_id \"M-0042\""));
        let plain = Mission { skills: vec![], mcp: vec![], connections: vec![], model: None, analysis: None, ..m };
        assert!(!mission_brief(&plain, &[]).contains("Selected by the user"));
    }
}
