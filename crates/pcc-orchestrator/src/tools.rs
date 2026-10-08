//! The `pcc` MCP server, answered in-process through Claude Code's control
//! protocol. These tools are how agents act on the orchestrator: every call
//! mutates real state (tasks, agents, messages, memory).

use std::collections::BTreeMap;

use serde_json::{json, Value};

use pcc_core::{
    Access, Agent, AgentKind, AgentRank, Capability, Error, MessageKind, MissionStatus, Priority, Result, TaskResult,
    TaskStatus,
};
use pcc_store::TaskFilter;

use crate::dto::{AgentSpec, TaskPatch, TaskSpec};
use crate::engine::Engine;
use crate::hierarchy::Tree;
use crate::work::access_str;

const MEMORY_FILES: &str = "project, architecture, decisions, conventions, discoveries, or agent:<id>";

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": props, "required": required, "additionalProperties": false}
    })
}

fn central_tools() -> Vec<Value> {
    let caps: Vec<&str> = Capability::ALL.iter().map(|c| c.as_str()).collect();
    vec![
        tool("list_agents", "List all agents with role, status, current task, isolation and permissions.", json!({}), &[]),
        tool(
            "create_agent",
            "Create a specialised worker agent (a new Claude Code session started when it gets work). Roles are free-form.",
            json!({
                "name": {"type": "string", "description": "Display name, e.g. \"Movement Agent\""},
                "id": {"type": "string", "description": "Optional slug (lowercase, digits, dashes). Derived from name if omitted."},
                "role": {"type": "string", "description": "One-line specialty, e.g. \"Movement systems specialist\""},
                "instructions": {"type": "string", "description": "Standing instructions: scope, files it owns, conventions, how to test."},
                "isolation": {"type": "string", "enum": ["auto", "shared", "worktree"], "description": "auto = own git worktree when available"},
                "permissions": {"type": "object", "description": format!("Optional overrides, capability -> deny|ask|allow. Capabilities: {}. Capped by the project's limits.", caps.join(", ")), "additionalProperties": {"type": "string", "enum": ["deny", "ask", "allow"]}},
                "connections": {"type": "array", "items": {"type": "string"}, "description": "Project connection ids to grant (see project_status)."},
                "model": {"type": "string", "description": "Optional model alias (e.g. sonnet, opus, haiku)."},
                "rank": {"type": "string", "enum": ["specialist", "lieutenant"], "description": "specialist (default) does the work; lieutenant may create and supervise specialists for a whole domain."},
                "parent": {"type": "string", "description": "Supervisor of the new agent: central (default) or one of your lieutenants."},
                "decision_reason": {"type": "string", "description": "Why a sub-agent is needed, when you did not call record_delegation_decision first."}
            }),
            &["name", "role"],
        ),
        decision_tool(),
        tool("retire_agent", "Stop and retire a worker that is no longer needed (it keeps its history).", json!({"id": {"type": "string"}, "reason": {"type": "string"}}), &["id"]),
        tool(
            "create_task",
            "Create a task for a worker. It starts automatically when its dependencies are completed and the agent is free.",
            json!({
                "title": {"type": "string"},
                "description": {"type": "string", "description": "Everything the worker needs: goal, files, constraints, acceptance criteria."},
                "agent": {"type": "string", "description": "Worker id"},
                "dependencies": {"type": "array", "items": {"type": "string"}, "description": "Task ids that must be completed first"},
                "priority": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
                "requires_review": {"type": "boolean", "description": "Completion goes to `review` until you approve it"},
                "mission_id": {"type": "string", "description": "Defaults to the single active mission"},
                "skills": {"type": "array", "items": {"type": "string"}, "description": "Skills the worker must invoke with the Skill tool for this task (exact names, e.g. the ones selected for the mission)."}
            }),
            &["title", "description", "agent"],
        ),
        tool(
            "update_task",
            "Change a task: approve (status completed), cancel, reassign (agent), reprioritise, or re-queue.",
            json!({
                "id": {"type": "string"},
                "status": {"type": "string", "enum": ["pending", "queued", "completed", "cancelled", "failed"]},
                "agent": {"type": "string"},
                "priority": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
                "description": {"type": "string", "description": "Replaces the description"}
            }),
            &["id"],
        ),
        tool("request_changes", "Send a task in review (or failed/blocked) back to its agent with feedback.", json!({"task_id": {"type": "string"}, "feedback": {"type": "string"}}), &["task_id", "feedback"]),
        tool("list_tasks", "List tasks, optionally filtered.", json!({"mission_id": {"type": "string"}, "agent": {"type": "string"}, "status": {"type": "string"}}), &[]),
        tool("get_task", "Full details of a task including its result.", json!({"id": {"type": "string"}}), &["id"]),
        tool(
            "send_message",
            "Send a message to an agent's session.",
            json!({"to": {"type": "string"}, "body": {"type": "string"}, "kind": {"type": "string", "enum": ["request", "response", "info"]}, "task_id": {"type": "string"}}),
            &["to", "body"],
        ),
        tool("read_memory", &format!("Read a memory file: {MEMORY_FILES}."), json!({"file": {"type": "string"}}), &["file"]),
        tool(
            "write_memory",
            &format!("Write a memory file ({MEMORY_FILES}). mode=replace rewrites it (use for consolidation), append adds a dated entry."),
            json!({"file": {"type": "string"}, "content": {"type": "string"}, "mode": {"type": "string", "enum": ["replace", "append"]}}),
            &["file", "content"],
        ),
        tool("project_status", "Project overview: missions, task counts, connections, git state.", json!({}), &[]),
        tool("review_agent_changes", "Diff of a worktree agent's branch against the current branch (files, commits, conflicts).", json!({"agent": {"type": "string"}}), &["agent"]),
        tool("merge_agent_work", "Ask the user to approve merging an agent's branch into the current branch.", json!({"agent": {"type": "string"}}), &["agent"]),
        tool(
            "complete_mission",
            "Close a mission once all its tasks are completed or cancelled. Update memory first.",
            json!({"mission_id": {"type": "string"}, "summary": {"type": "string", "description": "What changed, files, tests, remaining risks."}}),
            &["mission_id", "summary"],
        ),
        tool("fail_mission", "Close a mission that cannot be achieved.", json!({"mission_id": {"type": "string"}, "reason": {"type": "string"}}), &["mission_id", "reason"]),
        tool(
            "resume_report",
            "Verified state of the mission to continue (the interrupted or running one, or mission_id): tasks done vs remaining, files of completed tasks checked on disk, repository, Claude sessions, MCP servers, agents, last action and the next action. Read-only. Use it when the user asks to continue/resume and no NEXUS RESUME REPORT was given.",
            json!({"mission_id": {"type": "string"}}),
            &[],
        ),
        tool(
            "report_mission_blocked",
            "Declare that the running mission cannot continue without the user (a decision, a permission, a sign-in, an external action) or hit a fatal error. NEXUS then stops reminding you to continue until the user answers. Say in your text what you need.",
            json!({
                "mission_id": {"type": "string", "description": "Defaults to the running mission"},
                "reason": {"type": "string", "description": "What is missing, precisely"},
                "needs": {"type": "string", "enum": ["user_decision", "permission", "external", "fatal"]}
            }),
            &["reason"],
        ),
    ]
}

/// Structured "do I need sub-agents?" decision, required before creating agents.
fn decision_tool() -> Value {
    tool(
        "record_delegation_decision",
        "Record, before creating sub-agents, whether you need them and which. Only delegate when it really helps (independent domains, parallel work); for small requests do it yourself or use one agent. The decision is shown to the user.",
        json!({
            "needs_sub_agents": {"type": "boolean"},
            "reason": {"type": "string", "description": "Why (not): scope, independence, parallelism"},
            "children": {"type": "array", "description": "Sub-agents you plan to create", "items": {"type": "object", "properties": {
                "name": {"type": "string"}, "role": {"type": "string"},
                "rank": {"type": "string", "enum": ["specialist", "lieutenant"]}, "reason": {"type": "string"}}}}
        }),
        &["needs_sub_agents", "reason"],
    )
}

/// Agent-management tools of a lieutenant, scoped to its own subtree.
fn lieutenant_tools() -> Vec<Value> {
    vec![
        decision_tool(),
        tool(
            "create_agent",
            "Create a sub-agent under you (a real Claude Code session started when it gets work). Record your delegation decision first.",
            json!({
                "name": {"type": "string"},
                "id": {"type": "string", "description": "Optional slug (lowercase, digits, dashes)."},
                "role": {"type": "string"},
                "instructions": {"type": "string", "description": "Scope, files it owns, conventions, how to test."},
                "isolation": {"type": "string", "enum": ["auto", "shared", "worktree"]},
                "model": {"type": "string"},
                "rank": {"type": "string", "enum": ["specialist", "lieutenant"], "description": "specialist (default); lieutenant only for a large sub-domain, within the depth limit."},
                "decision_reason": {"type": "string", "description": "Why it is needed, when you did not call record_delegation_decision first."}
            }),
            &["name", "role"],
        ),
        tool("list_agents", "Your sub-agents (whole subtree) with role, rank, status and current task.", json!({}), &[]),
        tool(
            "create_task",
            "Create a task for one of your sub-agents. It starts when its dependencies are completed and the agent is free; its result comes back to you.",
            json!({
                "title": {"type": "string"},
                "description": {"type": "string", "description": "Everything the sub-agent needs: goal, files, constraints, acceptance criteria."},
                "agent": {"type": "string", "description": "Sub-agent id"},
                "dependencies": {"type": "array", "items": {"type": "string"}},
                "priority": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
                "requires_review": {"type": "boolean"},
                "skills": {"type": "array", "items": {"type": "string"}}
            }),
            &["title", "description", "agent"],
        ),
        tool(
            "update_task",
            "Approve (status completed), cancel, reassign or reprioritise a task of your subtree.",
            json!({
                "id": {"type": "string"},
                "status": {"type": "string", "enum": ["pending", "queued", "completed", "cancelled", "failed"]},
                "agent": {"type": "string"},
                "priority": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
                "description": {"type": "string"}
            }),
            &["id"],
        ),
        tool("request_changes", "Send a task of your subtree back with feedback.", json!({"task_id": {"type": "string"}, "feedback": {"type": "string"}}), &["task_id", "feedback"]),
        tool("list_tasks", "Tasks of your subtree (their status and result summaries).", json!({"agent": {"type": "string"}, "status": {"type": "string"}}), &[]),
        tool("retire_agent", "Retire one of your sub-agents that is no longer needed.", json!({"id": {"type": "string"}, "reason": {"type": "string"}}), &["id"]),
    ]
}

fn worker_tools() -> Vec<Value> {
    vec![
        tool(
            "send_message",
            "Send a message to your parent, or to one of your sub-agents. Other agents are reached through your parent: NEXUS routes the message there.",
            json!({"to": {"type": "string", "description": "Agent id; defaults to your parent"}, "body": {"type": "string"}, "kind": {"type": "string", "enum": ["request", "response", "info"]}, "task_id": {"type": "string"}}),
            &["body"],
        ),
        tool(
            "report_progress",
            "Report progress on your current task.",
            json!({"task_id": {"type": "string"}, "percent": {"type": "integer", "minimum": 0, "maximum": 100}, "action": {"type": "string", "description": "What you are doing now"}}),
            &["task_id", "percent"],
        ),
        tool(
            "complete_task",
            "Report that your task is done (after verifying it).",
            json!({
                "task_id": {"type": "string"},
                "summary": {"type": "string", "description": "What you changed and why, concisely"},
                "files_changed": {"type": "array", "items": {"type": "string"}},
                "tests": {"type": "string", "description": "Test/build results, e.g. \"18 passed\""},
                "issues": {"type": "string", "description": "Potential problems or follow-ups"}
            }),
            &["task_id", "summary"],
        ),
        tool(
            "block_task",
            "You cannot continue without something (information, another agent's work, a decision).",
            json!({"task_id": {"type": "string"}, "reason": {"type": "string", "description": "Exactly what you need and why"}}),
            &["task_id", "reason"],
        ),
        tool(
            "fail_task",
            "The task cannot be done.",
            json!({"task_id": {"type": "string"}, "reason": {"type": "string"}}),
            &["task_id", "reason"],
        ),
        tool("get_task", "Details of a task (yours or a dependency).", json!({"id": {"type": "string"}}), &["id"]),
        tool(
            "read_memory",
            &format!("Read a memory file: {MEMORY_FILES}."),
            json!({"file": {"type": "string"}}),
            &["file"],
        ),
        tool(
            "remember",
            "Record durable knowledge. scope=agent (your own memory) or discovery (shared project discoveries).",
            json!({"note": {"type": "string"}, "scope": {"type": "string", "enum": ["agent", "discovery"]}}),
            &["note"],
        ),
    ]
}

/// Answer to an `mcp_message`: now (`None` for notifications) or later, when a
/// background task finishes (the task writes the response itself).
pub enum Reply {
    Now(Option<Value>),
    Later,
}

impl Reply {
    /// JSON-RPC result carrying a text (or an error text) as tool output.
    pub fn text(rpc_id: Value, out: Result<String>) -> Reply {
        let result = match out {
            Ok(text) => json!({"content": [{"type": "text", "text": text}]}),
            Err(e) => json!({"content": [{"type": "text", "text": format!("Error: {e}")}], "isError": true}),
        };
        Reply::Now(Some(json!({"jsonrpc": "2.0", "id": rpc_id, "result": result})))
    }

    pub fn into_value(self) -> Option<Value> {
        match self {
            Reply::Now(v) => v,
            Reply::Later => None,
        }
    }
}

/// Handles one JSON-RPC message from an agent's session.
pub fn handle_rpc(engine: &mut Engine, agent: &str, request_id: &str, msg: &Value) -> Reply {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let me = engine.store.get_agent(agent).ok().flatten();
    let is_central = me.as_ref().is_some_and(|a| a.kind == AgentKind::Central);
    let is_lieutenant = !is_central && me.as_ref().is_some_and(|a| a.rank == AgentRank::Lieutenant);
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": msg.pointer("/params/protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "project-control-center", "version": env!("CARGO_PKG_VERSION")}
        })),
        "tools/list" => Ok(json!({"tools": if is_central {
            let mut t = central_tools();
            t.extend(crate::env_tools::definitions());
            t.push(crate::world_tools::definition());
            t
        } else if is_lieutenant {
            let mut t = worker_tools();
            t.extend(lieutenant_tools());
            t
        } else {
            worker_tools()
        }})),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            if is_central {
                let rpc_id = id.clone().unwrap_or(Value::Null);
                if let Some(reply) = crate::env_tools::call(engine, agent, request_id, rpc_id, name, &args) {
                    return reply;
                }
            }
            let out = if is_central && name == crate::world_tools::TOOL {
                crate::world_tools::call(engine, agent, &args)
            } else if is_central {
                call_central(engine, agent, name, &args)
            } else if is_lieutenant {
                call_lieutenant(engine, agent, name, &args).unwrap_or_else(|| call_worker(engine, agent, name, &args))
            } else {
                call_worker(engine, agent, name, &args)
            };
            Ok(match out {
                Ok(text) => json!({"content": [{"type": "text", "text": text}]}),
                Err(e) => json!({"content": [{"type": "text", "text": format!("Error: {e}")}], "isError": true}),
            })
        }
        "ping" => Ok(json!({})),
        m if m.starts_with("notifications/") => return Reply::Now(None),
        _ => Err(json!({"code": -32601, "message": format!("method not found: {method}")})),
    };
    Reply::Now(id.map(|id| match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": e}),
    }))
}

fn s<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn req<'a>(args: &'a Value, k: &str) -> Result<&'a str> {
    s(args, k).ok_or_else(|| Error::invalid(format!("missing `{k}`")))
}

fn strings(args: &Value, k: &str) -> Vec<String> {
    args.get(k)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn kind_of(args: &Value) -> MessageKind {
    match s(args, "kind") {
        Some("response") => MessageKind::Response,
        Some("info") => MessageKind::Info,
        _ => MessageKind::Request,
    }
}

fn call_central(e: &mut Engine, me: &str, name: &str, args: &Value) -> Result<String> {
    match name {
        "list_agents" => {
            let rows: Vec<Value> = e
                .store
                .list_agents()?
                .into_iter()
                .map(|a| {
                    let perms: BTreeMap<&str, &str> = Capability::ALL
                        .iter()
                        .map(|c| (c.as_str(), access_str(a.permissions.get(*c))))
                        .filter(|(_, v)| *v != access_str(Access::Deny))
                        .collect();
                    agent_row(&a, perms)
                })
                .collect();
            Ok(serde_json::to_string_pretty(&rows)?)
        }
        "create_agent" => create_agent(e, me, args),
        "record_delegation_decision" => record_decision(e, me, args),
        "retire_agent" => {
            let id = req(args, "id")?;
            e.retire_agent(id, s(args, "reason"))?;
            Ok(format!("{id} retired."))
        }
        "create_task" => create_task(e, me, args),
        "update_task" => update_task(e, me, args),
        "request_changes" => {
            let t = e.request_changes(req(args, "task_id")?, req(args, "feedback")?)?;
            Ok(format!(
                "{} sent back to {} with your feedback (status {}).",
                t.id,
                t.agent.unwrap_or_default(),
                t.status.as_str()
            ))
        }
        "list_tasks" => list_tasks(e, args),
        "get_task" => Ok(serde_json::to_string_pretty(&e.store.task(req(args, "id")?)?)?),
        "send_message" => send_message(e, me, args),
        "read_memory" => read_memory(e, args),
        "write_memory" => {
            let file = req(args, "file")?;
            let content = args.get("content").and_then(Value::as_str).unwrap_or("");
            if s(args, "mode") == Some("append") {
                e.append_memory(file, content, me)?;
            } else {
                e.save_memory(file, content, me)?;
            }
            Ok(format!("Memory `{file}` updated."))
        }
        "project_status" => project_status(e),
        "review_agent_changes" => {
            let agent = req(args, "agent")?;
            let a = e.store.agent(agent)?;
            let branch = a.branch.clone().ok_or_else(|| {
                Error::invalid(format!("{agent} works in the shared folder (no branch); inspect with git diff"))
            })?;
            let repo = e.repo()?;
            let base = repo.current_branch().unwrap_or_else(|| "HEAD".into());
            let d = repo.diff(&base, &branch, Some(std::path::Path::new(&a.workdir)))?;
            Ok(serde_json::to_string_pretty(&d)?)
        }
        "merge_agent_work" => e.request_merge(me, req(args, "agent")?),
        "complete_mission" => {
            let m = e.finish_mission(req(args, "mission_id")?, MissionStatus::Completed, req(args, "summary")?)?;
            Ok(format!("Mission {} completed. The summary is saved in .agent-project/plans/{}.md.", m.id, m.id))
        }
        "fail_mission" => {
            let m = e.finish_mission(req(args, "mission_id")?, MissionStatus::Failed, req(args, "reason")?)?;
            Ok(format!("Mission {} marked as failed.", m.id))
        }
        "resume_report" => {
            let mid = match s(args, "mission_id") {
                Some(m) => m.to_string(),
                None => e.resume_candidate()?.ok_or_else(|| Error::invalid("no running or interrupted mission"))?,
            };
            Ok(e.resume_report(&mid, "central")?.render())
        }
        "report_mission_blocked" => {
            let b =
                e.report_mission_blocked(s(args, "mission_id"), req(args, "reason")?, s(args, "needs").unwrap_or(""))?;
            Ok(format!(
                "Mission {} marked as waiting for the user ({}). NEXUS will not push you to continue until the user answers; end your turn with a clear question or request.",
                b.mission_id, b.needs
            ))
        }
        other => Err(Error::invalid(format!("unknown tool `{other}`"))),
    }
}

fn call_worker(e: &mut Engine, me: &str, name: &str, args: &Value) -> Result<String> {
    match name {
        "send_message" => send_message(e, me, args),
        "create_agent" | "record_delegation_decision" => Err(Error::Denied(
            "specialists cannot create agents. Do the work yourself, or ask your parent (send_message) for more help."
                .into(),
        )),
        "report_progress" => {
            let pct = args.get("percent").and_then(Value::as_u64).unwrap_or(0).min(100) as u8;
            e.report_progress(me, req(args, "task_id")?, pct, s(args, "action").map(str::to_string))?;
            Ok("Progress recorded.".into())
        }
        "complete_task" => {
            let t = e.complete_task(
                me,
                req(args, "task_id")?,
                TaskResult {
                    summary: req(args, "summary")?.into(),
                    files_changed: strings(args, "files_changed"),
                    tests: s(args, "tests").map(str::to_string),
                    issues: s(args, "issues").map(str::to_string),
                    commit: None,
                },
            )?;
            Ok(format!(
                "{} recorded as {}{}. Your supervisor has been notified. End your turn unless you have other work.",
                t.id,
                t.status.as_str(),
                t.result.and_then(|r| r.commit).map(|c| format!(", committed as {c}")).unwrap_or_default()
            ))
        }
        "block_task" => {
            let t = e.block_task(me, req(args, "task_id")?, req(args, "reason")?)?;
            Ok(format!("{} is blocked; Your supervisor has been notified. End your turn: you will receive a message when it is resolved.", t.id))
        }
        "fail_task" => {
            let t = e.fail_task(me, req(args, "task_id")?, req(args, "reason")?)?;
            Ok(format!("{} marked as failed; Your supervisor has been notified.", t.id))
        }
        "get_task" => Ok(serde_json::to_string_pretty(&e.store.task(req(args, "id")?)?)?),
        "read_memory" => read_memory(e, args),
        "remember" => {
            let note = req(args, "note")?;
            let key =
                if s(args, "scope") == Some("discovery") { "discoveries".to_string() } else { format!("agent:{me}") };
            e.append_memory(&key, note, me)?;
            Ok(format!("Saved to {key}."))
        }
        other => Err(Error::invalid(format!("unknown tool `{other}`"))),
    }
}

/// Agent-management tools of a lieutenant; `None` for tools it shares with specialists.
fn call_lieutenant(e: &mut Engine, me: &str, name: &str, args: &Value) -> Option<Result<String>> {
    Some(match name {
        "record_delegation_decision" => record_decision(e, me, args),
        "create_agent" => create_agent(e, me, args),
        "list_agents" => (|| {
            let agents = e.store.list_agents()?;
            let tree = Tree::new(&agents);
            let rows: Vec<Value> = tree.descendants(me).into_iter().map(|a| agent_row(a, BTreeMap::new())).collect();
            if rows.is_empty() {
                return Ok("You have no sub-agents yet.".to_string());
            }
            Ok(serde_json::to_string_pretty(&rows)?)
        })(),
        "create_task" => in_subtree(e, me, req(args, "agent").unwrap_or("")).and_then(|_| create_task(e, me, args)),
        "update_task" => (|| {
            let t = e.store.task(req(args, "id")?)?;
            in_subtree(e, me, t.agent.as_deref().unwrap_or(""))?;
            if let Some(to) = s(args, "agent") {
                in_subtree(e, me, to)?;
            }
            update_task(e, me, args)
        })(),
        "request_changes" => (|| {
            let t = e.store.task(req(args, "task_id")?)?;
            in_subtree(e, me, t.agent.as_deref().unwrap_or(""))?;
            let t = e.request_changes(&t.id, req(args, "feedback")?)?;
            Ok(format!("{} sent back to {} with your feedback.", t.id, t.agent.unwrap_or_default()))
        })(),
        "list_tasks" => (|| {
            let agents = e.store.list_agents()?;
            let tree = Tree::new(&agents);
            let mine: Vec<String> = tree.descendants(me).iter().map(|a| a.id.clone()).collect();
            if let Some(a) = s(args, "agent") {
                in_subtree(e, me, a)?;
            }
            let status = s(args, "status").and_then(TaskStatus::parse);
            let rows: Vec<Value> = e
                .store
                .list_tasks(&TaskFilter { agent: s(args, "agent").map(str::to_string), status, ..Default::default() })?
                .iter()
                .filter(|t| t.agent.as_ref().is_some_and(|a| mine.contains(a)))
                .map(task_row)
                .collect();
            if rows.is_empty() {
                return Ok("No tasks match.".to_string());
            }
            Ok(serde_json::to_string_pretty(&rows)?)
        })(),
        "retire_agent" => (|| {
            let id = req(args, "id")?;
            in_subtree(e, me, id)?;
            e.retire_agent(id, s(args, "reason"))?;
            Ok(format!("{id} retired."))
        })(),
        _ => return None,
    })
}

fn in_subtree(e: &Engine, me: &str, id: &str) -> Result<()> {
    let agents = e.store.list_agents()?;
    if Tree::new(&agents).is_ancestor(me, id) {
        Ok(())
    } else {
        Err(Error::Denied(format!(
            "`{id}` is not one of your sub-agents; you manage only your own subtree (ask your parent for anything else)"
        )))
    }
}

fn agent_row(a: &Agent, perms: BTreeMap<&str, &str>) -> Value {
    let mut v = json!({"id": a.id, "name": a.name, "kind": a.kind, "role": a.role, "rank": a.rank, "parent": a.parent_agent,
        "status": a.status, "currentTask": a.current_task, "paused": a.paused_at.is_some(),
        "isolation": a.isolation, "branch": a.branch, "connections": a.connections});
    if !perms.is_empty() {
        v["permissions"] = json!(perms);
    }
    v
}

fn task_row(t: &pcc_core::Task) -> Value {
    json!({"id": t.id, "title": t.title, "status": t.status, "agent": t.agent, "priority": t.priority,
           "dependencies": t.dependencies, "mission": t.mission_id, "reason": t.status_reason,
           "summary": t.result.as_ref().map(|r| r.summary.clone())})
}

fn rank_of(args: &Value) -> Result<Option<AgentRank>> {
    match s(args, "rank") {
        None => Ok(None),
        Some("specialist") => Ok(Some(AgentRank::Specialist)),
        Some("lieutenant") => Ok(Some(AgentRank::Lieutenant)),
        Some(other) => Err(Error::invalid(format!("unknown rank `{other}` (specialist or lieutenant)"))),
    }
}

fn record_decision(e: &mut Engine, me: &str, args: &Value) -> Result<String> {
    let d = crate::hierarchy::decision_from_args(args);
    let needs = d.needs_sub_agents;
    e.record_delegation(me, d)?;
    Ok(if needs {
        "Decision recorded. Create the sub-agents you listed with create_agent, then give them tasks.".into()
    } else {
        "Decision recorded: no sub-agents. Do the work yourself (or with existing agents).".into()
    })
}

fn create_agent(e: &mut Engine, me: &str, args: &Value) -> Result<String> {
    let permissions = match args.get("permissions").and_then(Value::as_object) {
        Some(obj) => {
            let mut m = BTreeMap::new();
            for (k, v) in obj {
                let cap: Capability = serde_json::from_value(json!(k))
                    .map_err(|_| Error::invalid(format!("unknown capability `{k}`")))?;
                let acc: Access = serde_json::from_value(v.clone())
                    .map_err(|_| Error::invalid(format!("invalid access for `{k}`")))?;
                m.insert(cap, acc);
            }
            Some(m)
        }
        None => None,
    };
    let rank = rank_of(args)?;
    let name = req(args, "name")?.to_string();
    let role = req(args, "role")?.to_string();
    // An inline reason counts as the decision for this one sub-agent.
    if let Some(reason) = s(args, "decision_reason") {
        e.record_delegation(
            me,
            crate::hierarchy::DelegationDecision {
                needs_sub_agents: true,
                reason: reason.to_string(),
                children: vec![crate::hierarchy::PlannedChild {
                    name: name.clone(),
                    role: role.clone(),
                    rank,
                    reason: reason.to_string(),
                }],
            },
        )?;
    }
    let a = e.create_agent(
        AgentSpec {
            id: s(args, "id").map(str::to_string),
            provider: None,
            name,
            role,
            instructions: s(args, "instructions").map(str::to_string),
            permissions,
            connections: args.get("connections").map(|_| strings(args, "connections")),
            isolation: s(args, "isolation").map(str::to_string),
            model: s(args, "model").map(str::to_string),
            parent: s(args, "parent").map(str::to_string),
            rank,
        },
        me,
    )?;
    Ok(format!(
        "Agent `{}` created ({:?} under {}, {}, isolation {:?}{}). It starts when it receives a task or message.",
        a.id,
        a.rank,
        a.parent_agent.as_deref().unwrap_or("-"),
        a.role,
        a.isolation,
        a.branch.map(|b| format!(", branch {b}")).unwrap_or_default()
    ))
}

fn create_task(e: &mut Engine, me: &str, args: &Value) -> Result<String> {
    let priority = s(args, "priority")
        .map(|p| Priority::parse(p).ok_or_else(|| Error::invalid(format!("invalid priority `{p}`"))))
        .transpose()?;
    let t = e.create_task(
        TaskSpec {
            title: req(args, "title")?.into(),
            description: s(args, "description").map(str::to_string),
            agent: Some(req(args, "agent")?.into()),
            dependencies: Some(strings(args, "dependencies")),
            priority,
            requires_review: args.get("requires_review").and_then(Value::as_bool),
            mission_id: s(args, "mission_id").map(str::to_string),
            skills: Some(strings(args, "skills")),
        },
        me,
    )?;
    // Skills are all-or-nothing per session: say so when the worker cannot use them.
    let agent = t.agent.clone().unwrap_or_default();
    let skills_note = match e.store.get_agent(&agent)? {
        Some(a) if !t.skills.is_empty() && !a.profile.skills_enabled => format!(
            " Warning: {agent} runs with skills disabled, it cannot invoke {}; enable skills on the agent or pick another one.",
            t.skills.join(", ")
        ),
        _ => String::new(),
    };
    Ok(format!(
        "{} created for {} (status {}{}).{skills_note}",
        t.id,
        agent,
        t.status.as_str(),
        t.mission_id.map(|m| format!(", mission {m}")).unwrap_or_default()
    ))
}

fn update_task(e: &mut Engine, me: &str, args: &Value) -> Result<String> {
    let id = req(args, "id")?;
    let status = s(args, "status")
        .map(|x| TaskStatus::parse(x).ok_or_else(|| Error::invalid(format!("invalid status `{x}`"))))
        .transpose()?;
    let priority = s(args, "priority")
        .map(|p| Priority::parse(p).ok_or_else(|| Error::invalid(format!("invalid priority `{p}`"))))
        .transpose()?;
    let t = e.update_task(
        id,
        TaskPatch {
            status,
            priority,
            agent: s(args, "agent").map(|a| Some(a.to_string())),
            description: s(args, "description").map(str::to_string),
            ..Default::default()
        },
        me,
    )?;
    Ok(format!("{} is now {} (agent {}).", t.id, t.status.as_str(), t.agent.unwrap_or("-".into())))
}

/// Messages follow the hierarchy (see `hierarchy::delivery`).
fn send_message(e: &mut Engine, me: &str, args: &Value) -> Result<String> {
    let parent = e.store.agent(me)?.parent_agent;
    let to = match s(args, "to") {
        Some(t) => t.to_string(),
        None => parent.ok_or_else(|| Error::invalid("missing `to`"))?,
    };
    let (m, route) =
        e.route_message(me, &to, kind_of(args), req(args, "body")?, s(args, "task_id").map(str::to_string))?;
    Ok(match route {
        Some(path) if m.to != to => format!(
            "{to} is outside your branch: message {} was handed to {} to relay (route {}).",
            m.id,
            m.to,
            path.join(" → ")
        ),
        Some(path) => format!("Message {} sent to {to} across branches (route {}).", m.id, path.join(" → ")),
        None => format!("Message {} queued for {to}; it is delivered to its session as soon as it is idle.", m.id),
    })
}

fn read_memory(e: &Engine, args: &Value) -> Result<String> {
    let scope = pcc_store::MemoryScope::parse(req(args, "file")?)?;
    let f = e.store.read_memory(&scope)?;
    Ok(if f.content.trim().is_empty() { format!("`{}` is empty.", f.key) } else { f.content })
}

fn list_tasks(e: &Engine, args: &Value) -> Result<String> {
    let status = s(args, "status").and_then(TaskStatus::parse);
    let tasks = e.store.list_tasks(&TaskFilter {
        mission_id: s(args, "mission_id").map(str::to_string),
        agent: s(args, "agent").map(str::to_string),
        status,
    })?;
    if tasks.is_empty() {
        return Ok("No tasks match.".into());
    }
    let rows: Vec<Value> = tasks.iter().map(task_row).collect();
    Ok(serde_json::to_string_pretty(&rows)?)
}

fn project_status(e: &Engine) -> Result<String> {
    let missions: Vec<Value> = e
        .store
        .list_missions()?
        .into_iter()
        .take(10)
        .map(|m| json!({"id": m.mission.id, "title": m.mission.title, "status": m.mission.status, "tasks": m.task_total, "done": m.task_done, "failed": m.task_failed}))
        .collect();
    let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
    for t in e.store.list_tasks(&TaskFilter::default())? {
        *counts.entry(t.status.as_str()).or_default() += 1;
    }
    let connections: Vec<Value> = e.store.list_connections()?.iter().map(crate::connections::public_view).collect();
    let git = e.repo.as_ref().map(|r| r.status());
    Ok(serde_json::to_string_pretty(&json!({
        "project": e.store.info().name,
        "root": e.store.info().root,
        "types": e.project_types,
        "missions": missions,
        "taskCounts": counts,
        "connections": connections,
        "git": git,
        "maxParallelWorkers": e.store.settings().max_parallel_workers,
    }))?)
}
