//! The `pcc` MCP server, answered in-process through Claude Code's control
//! protocol. These tools are how agents act on the orchestrator: every call
//! mutates real state (tasks, agents, messages, memory).

use std::collections::BTreeMap;

use serde_json::{json, Value};

use pcc_core::{
    Access, AgentKind, Capability, Error, MessageKind, MissionStatus, Priority, Result, TaskResult, TaskStatus,
    CENTRAL_ID,
};
use pcc_store::TaskFilter;

use crate::dto::{AgentSpec, TaskPatch, TaskSpec};
use crate::engine::Engine;
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
                "model": {"type": "string", "description": "Optional model alias (e.g. sonnet, opus, haiku)."}
            }),
            &["name", "role"],
        ),
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
                "mission_id": {"type": "string", "description": "Defaults to the single active mission"}
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
    ]
}

fn worker_tools() -> Vec<Value> {
    vec![
        tool(
            "send_message",
            "Send a message to the Central agent (it routes requests to other agents).",
            json!({"to": {"type": "string", "description": "Defaults to central"}, "body": {"type": "string"}, "kind": {"type": "string", "enum": ["request", "response", "info"]}, "task_id": {"type": "string"}}),
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

/// Handles one JSON-RPC message. Returns `None` for notifications.
pub fn handle_rpc(engine: &mut Engine, agent: &str, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let is_central = engine.store.get_agent(agent).ok().flatten().is_some_and(|a| a.kind == AgentKind::Central);
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": msg.pointer("/params/protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "project-control-center", "version": env!("CARGO_PKG_VERSION")}
        })),
        "tools/list" => Ok(json!({"tools": if is_central { central_tools() } else { worker_tools() }})),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            let out = if is_central {
                call_central(engine, agent, name, &args)
            } else {
                call_worker(engine, agent, name, &args)
            };
            Ok(match out {
                Ok(text) => json!({"content": [{"type": "text", "text": text}]}),
                Err(e) => json!({"content": [{"type": "text", "text": format!("Error: {e}")}], "isError": true}),
            })
        }
        "ping" => Ok(json!({})),
        m if m.starts_with("notifications/") => return None,
        _ => Err(json!({"code": -32601, "message": format!("method not found: {method}")})),
    };
    id.map(|id| match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": e}),
    })
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
                    let perms: BTreeMap<&str, &str> = Capability::ALL.iter().map(|c| (c.as_str(), access_str(a.permissions.get(*c)))).filter(|(_, v)| *v != access_str(Access::Deny)).collect();
                    json!({"id": a.id, "name": a.name, "kind": a.kind, "role": a.role, "status": a.status, "currentTask": a.current_task,
                           "isolation": a.isolation, "branch": a.branch, "connections": a.connections, "permissions": perms})
                })
                .collect();
            Ok(serde_json::to_string_pretty(&rows)?)
        }
        "create_agent" => {
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
            let a = e.create_agent(
                AgentSpec {
                    id: s(args, "id").map(str::to_string),
                    provider: None,
                    name: req(args, "name")?.to_string(),
                    role: req(args, "role")?.to_string(),
                    instructions: s(args, "instructions").map(str::to_string),
                    permissions,
                    connections: args.get("connections").map(|_| strings(args, "connections")),
                    isolation: s(args, "isolation").map(str::to_string),
                    model: s(args, "model").map(str::to_string),
                },
                me,
            )?;
            Ok(format!(
                "Agent `{}` created ({}, isolation {:?}{}). It starts when it receives a task or message.",
                a.id,
                a.role,
                a.isolation,
                a.branch.map(|b| format!(", branch {b}")).unwrap_or_default()
            ))
        }
        "retire_agent" => {
            let id = req(args, "id")?;
            e.retire_agent(id, s(args, "reason"))?;
            Ok(format!("{id} retired."))
        }
        "create_task" => {
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
                },
                me,
            )?;
            Ok(format!(
                "{} created for {} (status {}{}).",
                t.id,
                t.agent.unwrap_or_default(),
                t.status.as_str(),
                t.mission_id.map(|m| format!(", mission {m}")).unwrap_or_default()
            ))
        }
        "update_task" => {
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
        "send_message" => {
            let to = req(args, "to")?;
            let m = e.post_message(
                me,
                to,
                kind_of(args),
                req(args, "body")?,
                s(args, "task_id").map(str::to_string),
                None,
            )?;
            Ok(format!("Message {} queued for {to}; it is delivered to its session as soon as it is idle.", m.id))
        }
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
        other => Err(Error::invalid(format!("unknown tool `{other}`"))),
    }
}

fn call_worker(e: &mut Engine, me: &str, name: &str, args: &Value) -> Result<String> {
    match name {
        "send_message" => {
            let to = s(args, "to").unwrap_or(CENTRAL_ID);
            if to != CENTRAL_ID && !e.store.settings().allow_direct_worker_messages {
                return Err(Error::Denied("workers message Central only; Central forwards to other agents".into()));
            }
            let m = e.post_message(
                me,
                to,
                kind_of(args),
                req(args, "body")?,
                s(args, "task_id").map(str::to_string),
                None,
            )?;
            Ok(format!("Message {} sent to {to}.", m.id))
        }
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
                "{} recorded as {}{}. Central has been notified. End your turn unless you have other work.",
                t.id,
                t.status.as_str(),
                t.result.and_then(|r| r.commit).map(|c| format!(", committed as {c}")).unwrap_or_default()
            ))
        }
        "block_task" => {
            let t = e.block_task(me, req(args, "task_id")?, req(args, "reason")?)?;
            Ok(format!("{} is blocked; Central has been notified. End your turn: you will receive a message when it is resolved.", t.id))
        }
        "fail_task" => {
            let t = e.fail_task(me, req(args, "task_id")?, req(args, "reason")?)?;
            Ok(format!("{} marked as failed; Central has been notified.", t.id))
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
    let rows: Vec<Value> = tasks
        .iter()
        .map(|t| {
            json!({"id": t.id, "title": t.title, "status": t.status, "agent": t.agent, "priority": t.priority,
                   "dependencies": t.dependencies, "mission": t.mission_id, "reason": t.status_reason,
                   "summary": t.result.as_ref().map(|r| r.summary.clone())})
        })
        .collect();
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
