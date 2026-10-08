//! System prompts and the text written into agent sessions.
//!
//! Context retrieval: instead of replaying raw history, each session starts
//! with curated memory (budgeted per file) and each task carries only the
//! results of the tasks it depends on.

use pcc_core::{Agent, AgentKind, Connection, ConnectionKind, Isolation, Message, MessageKind, Task};
use pcc_store::{MemoryScope, ProjectStore};

const CENTRAL: &str = include_str!("prompts/central.md");
const WORKER: &str = include_str!("prompts/worker.md");

/// Characters of each memory file injected into a system prompt.
const MEMORY_BUDGET: usize = 6_000;
const AGENT_MEMORY_BUDGET: usize = 4_000;

pub struct PromptContext<'a> {
    pub store: &'a ProjectStore,
    pub agent: &'a Agent,
    pub connections: &'a [Connection],
    pub project_types: &'a [String],
    pub git_branch: Option<String>,
}

fn fill(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}

fn memory_section(ctx: &PromptContext<'_>, files: &[&str]) -> String {
    let mut s = String::from("## Project memory (curated; read the full files with `read_memory`)\n");
    for f in files {
        let scope = MemoryScope::Project((*f).to_string());
        match ctx.store.memory_budgeted(&scope, MEMORY_BUDGET) {
            Ok(c) if !c.trim().is_empty() => s.push_str(&format!("\n<memory file=\"{f}\">\n{}\n</memory>\n", c.trim())),
            _ => {}
        }
    }
    let own = MemoryScope::Agent(ctx.agent.id.clone());
    if let Ok(c) = ctx.store.memory_budgeted(&own, AGENT_MEMORY_BUDGET) {
        if !c.trim().is_empty() {
            s.push_str(&format!("\n<memory file=\"agent:{}\">\n{}\n</memory>\n", ctx.agent.id, c.trim()));
        }
    }
    s
}

fn connections_section(ctx: &PromptContext<'_>) -> String {
    let granted: Vec<&Connection> = ctx
        .connections
        .iter()
        .filter(|c| c.enabled && (ctx.agent.kind == AgentKind::Central || ctx.agent.connections.contains(&c.id)))
        .collect();
    if granted.is_empty() {
        return "## Connections\n\nNo external connection is granted to you.".into();
    }
    let mut s = String::from("## Connections available to you\n\n");
    for c in granted {
        let how = match c.kind {
            ConnectionKind::Mcp | ConnectionKind::RobloxStudio => format!("MCP tools `mcp__{}__*`", c.id),
            ConnectionKind::Ssh | ConnectionKind::Sftp => {
                let host = c.config.get("host").and_then(|v| v.as_str()).unwrap_or("?");
                let user = c.config.get("user").and_then(|v| v.as_str()).unwrap_or("?");
                let program = if c.kind == ConnectionKind::Sftp { "sftp" } else { "ssh" };
                format!("`{program} {user}@{host}` (key/agent auth; commands may require user approval)")
            }
            ConnectionKind::Gitlab => {
                "`glab` CLI or the GitLab API; `GITLAB_HOST` and `GITLAB_TOKEN` are set in your environment".into()
            }
            ConnectionKind::Http => {
                let url = c.config.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("?");
                let header = c.config.get("authHeader").and_then(|v| v.as_str()).unwrap_or("");
                let token = if c.credential_ref.is_some() {
                    format!(
                        "; token in env `{}`{}",
                        pcc_connections::kinds::token_env_var(c),
                        if header.is_empty() { String::new() } else { format!(" (send it in the `{header}` header)") }
                    )
                } else {
                    String::new()
                };
                format!("HTTP API at {url} (curl / scripts){token}. Never print the token.")
            }
            ConnectionKind::Terminal => {
                let shell = c.config.get("shell").and_then(|v| v.as_str()).unwrap_or("shell");
                format!("local `{shell}` shell available for commands")
            }
            ConnectionKind::Github => "`gh` CLI and `git push` (writes may require approval)".into(),
            ConnectionKind::Docker => "`docker` CLI".into(),
            ConnectionKind::Git => "`git` in your working directory".into(),
            ConnectionKind::Local => "local filesystem".into(),
        };
        let status = format!("{:?}", c.status).to_lowercase();
        s.push_str(&format!("- **{}** ({:?}, {status}): {how}\n", c.name, c.kind));
    }
    s
}

fn isolation_line(agent: &Agent) -> String {
    match (agent.isolation, &agent.branch) {
        (Isolation::Worktree, Some(b)) => format!(
            "You work in your own git worktree on branch `{b}`. Your changes are committed to that branch automatically when you complete a task; the user merges branches. Do not switch branches."
        ),
        _ => "You work directly in the project folder, shared with other agents: only touch files your task needs.".into(),
    }
}

/// Central's autonomy level (its power preset) in one line.
fn autonomy_line(a: &Agent) -> String {
    let level = crate::central::autonomy_level(a);
    let what = match level {
        Some(pcc_core::PowerLevel::Low) => "read-only tools without asking; NEXUS does not push missions forward on its own — ask before changing anything",
        Some(pcc_core::PowerLevel::Normal) | None => "act within your permissions; risky operations ask the user",
        Some(pcc_core::PowerLevel::High) => "act autonomously within your permissions; drive missions to completion",
        Some(pcc_core::PowerLevel::Maximum) => "maximum autonomy within the permissions the user granted; protections (destructive commands, paths outside the project, manual capabilities) still ask",
    };
    format!("Autonomy level: **{}** — {what}.", crate::central::autonomy_label(level))
}

fn hierarchy_section(ctx: &PromptContext<'_>) -> String {
    let agents = ctx.store.list_agents().unwrap_or_default();
    crate::hierarchy::prompt_section(&agents, ctx.agent, ctx.store.settings().max_hierarchy_depth)
}

pub fn system_prompt(ctx: &PromptContext<'_>) -> String {
    let info = ctx.store.info();
    let a = ctx.agent;
    match a.kind {
        AgentKind::Central => {
            let settings = ctx.store.settings();
            let isolation = if ctx.git_branch.is_some() && settings.use_worktrees {
                "The project is a git repository and worktrees are enabled: workers created with `isolation: \"auto\"` get their own worktree and branch `agent/<id>`, so they cannot overwrite each other. A task that depends on another agent's task automatically receives that agent's branch merged into its worktree. Changes reach the main branch only through `merge_agent_work` (user approved)."
            } else {
                "Workers share the project folder. Avoid assigning parallel tasks that edit the same files; sequence them with dependencies instead."
            };
            fill(
                CENTRAL,
                &[
                    ("project_name", info.name.clone()),
                    ("project_root", info.root.clone()),
                    ("project_types", ctx.project_types.join(", ")),
                    (
                        "git_line",
                        match &ctx.git_branch {
                            Some(b) => format!("Git repository detected, current branch `{b}`."),
                            None => "The project is not a git repository.".into(),
                        },
                    ),
                    ("isolation_line", isolation.into()),
                    ("autonomy_line", autonomy_line(a)),
                    ("hierarchy_section", hierarchy_section(ctx)),
                    ("connections_section", connections_section(ctx)),
                    (
                        "memory_section",
                        memory_section(ctx, &["project", "architecture", "conventions", "decisions", "discoveries"]),
                    ),
                ],
            )
        }
        AgentKind::Worker => fill(
            WORKER,
            &[
                ("agent_name", a.name.clone()),
                ("agent_role", a.role.clone()),
                (
                    "agent_instructions",
                    if a.instructions.trim().is_empty() {
                        String::new()
                    } else {
                        format!("## Instructions\n\n{}\n", a.instructions.trim())
                    },
                ),
                ("project_name", info.name.clone()),
                ("workdir", a.workdir.clone()),
                ("isolation_line", isolation_line(a)),
                ("hierarchy_section", hierarchy_section(ctx)),
                ("connections_section", connections_section(ctx)),
                ("memory_section", memory_section(ctx, &["project", "conventions", "architecture", "discoveries"])),
            ],
        ),
    }
}

/// Envelope for a message written into a session.
pub fn message_envelope(m: &Message) -> String {
    let kind = match m.kind {
        MessageKind::Request => "request",
        MessageKind::Response => "response",
        MessageKind::Info => "info",
        MessageKind::System => "notification",
        MessageKind::User => "from the human user",
    };
    let mut head = format!("[MESSAGE {} · from {} · {kind}", m.id, m.from);
    if let Some(t) = &m.task_id {
        head.push_str(&format!(" · re {t}"));
    }
    if let Some(mi) = &m.mission_id {
        head.push_str(&format!(" · mission {mi}"));
    }
    head.push(']');
    if let Some(s) = &m.subject {
        head.push_str(&format!("\nSubject: {s}"));
    }
    format!("{head}\n{}", m.body.trim())
}

/// Text handed to a worker when a task is dispatched.
pub fn task_dispatch(task: &Task, deps: &[Task], resumed: bool, sync_note: Option<&str>) -> String {
    let mut s = format!(
        "[TASK {}]{} {}\nPriority: {:?}{}{}\n\n{}\n",
        task.id,
        if resumed { " (resumed)" } else { "" },
        task.title,
        task.priority,
        task.mission_id.as_ref().map(|m| format!(" · Mission {m}")).unwrap_or_default(),
        if task.requires_review { " · Will be reviewed" } else { "" },
        task.description.trim()
    );
    if !task.skills.is_empty() {
        s.push_str("\n## Skills to use\n");
        for k in &task.skills {
            s.push_str(&format!(
                "- Invoke the skill `{k}` with the Skill tool before working on the part it covers.\n"
            ));
        }
    }
    if !deps.is_empty() {
        s.push_str("\n## Results of the tasks this one depends on\n");
        for d in deps {
            s.push_str(&format!("\n### {} — {} (by {})\n", d.id, d.title, d.agent.as_deref().unwrap_or("?")));
            if let Some(r) = &d.result {
                s.push_str(&format!("{}\n", r.summary.trim()));
                if !r.files_changed.is_empty() {
                    s.push_str(&format!("Files: {}\n", r.files_changed.join(", ")));
                }
                if let Some(i) = &r.issues {
                    s.push_str(&format!("Known issues: {i}\n"));
                }
            }
        }
    }
    if let Some(n) = sync_note {
        s.push_str(&format!("\n{n}\n"));
    }
    s.push_str(&format!(
        "\nWhen finished call `complete_task` with task_id \"{}\" (or `block_task` / `fail_task`).",
        task.id
    ));
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcc_core::{Priority, TaskResult, TaskStatus};

    #[test]
    fn fill_replaces_all() {
        assert_eq!(fill("{{a}} and {{a}} {{b}}", &[("a", "x".into()), ("b", "y".into())]), "x and x y");
    }

    #[test]
    fn dispatch_includes_dependency_results() {
        let mk = |id: &str| Task {
            id: id.into(),
            mission_id: Some("M-0001".into()),
            title: format!("t{id}"),
            description: "Do it".into(),
            status: TaskStatus::Completed,
            priority: Priority::High,
            agent: Some("backend".into()),
            dependencies: vec![],
            requires_review: false,
            progress: None,
            status_reason: None,
            result: Some(TaskResult {
                summary: "API ready".into(),
                files_changed: vec!["src/api/assets.ts".into()],
                ..Default::default()
            }),
            created_by: "central".into(),
            created_at: String::new(),
            updated_at: String::new(),
            started_at: None,
            completed_at: None,
            skills: vec![],
        };
        let mut task = mk("TASK-0002");
        task.skills = vec!["ui-ux-pro-max:ui-ux-pro-max".into()];
        let text = task_dispatch(&task, &[mk("TASK-0001")], false, None);
        assert!(text.contains("Invoke the skill `ui-ux-pro-max:ui-ux-pro-max` with the Skill tool"));
        assert!(text.starts_with("[TASK TASK-0002] tTASK-0002"));
        assert!(text.contains("API ready"));
        assert!(text.contains("src/api/assets.ts"));
        assert!(text.contains("complete_task"));
    }
}
