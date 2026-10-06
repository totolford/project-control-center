//! Builds the Claude Code launch specification for an agent.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use pcc_claude::LaunchSpec;
use pcc_core::{Agent, AgentKind, Connection, Error, Isolation, Result};
use pcc_git::Repo;
use pcc_store::ProjectStore;

use crate::policy::builtin_tools;
use crate::prompts::{system_prompt, PromptContext};

/// Name of the in-process MCP server that exposes orchestrator tools.
pub const PCC_SERVER: &str = "pcc";

pub struct Prepared {
    pub spec: LaunchSpec,
    /// Claude session id (new or resumed).
    pub claude_session_id: String,
    /// Local model the session runs on (Claude Code against the local runtime), `None` = Claude.
    pub local_model: Option<String>,
    /// Engine choice explanation, logged with the session.
    pub notes: Vec<String>,
}

/// Local runtime + model for an agent, following its engine setting, the
/// router and the fallback policy. `Ok(None)` = Claude. Blocking (HTTP to the
/// local runtime) only when the agent is not on Claude.
pub fn local_engine(store: &ProjectStore, agent: &Agent, notes: &mut Vec<String>) -> Result<Option<(String, String)>> {
    use pcc_ai::router::{self, Journal, Route, RouteRequest, TaskKind};
    use pcc_core::EngineProvider;
    let ai = store.settings().ai;
    let chosen = agent.profile.engine.unwrap_or(match agent.kind {
        AgentKind::Central => ai.central,
        AgentKind::Worker => ai.workers,
    });
    if chosen == EngineProvider::Claude {
        return Ok(None);
    }
    let journal = Journal::new(store.layout().logs_dir().join("ai-routing.jsonl"));
    let source = format!("agent:{}", agent.id);
    let req = RouteRequest { task: TaskKind::AgentSession, required_tools: true, ..Default::default() };
    let cap = match chosen {
        EngineProvider::Local => match pcc_ai::check_local_for_agent(&ai)? {
            pcc_ai::LocalCheck::Ready(cap) => cap,
            pcc_ai::LocalCheck::UseClaude(why) => {
                let d = router::RouteDecision {
                    provider: Route::Claude,
                    model: None,
                    reason: format!("fallback to Claude: {why}"),
                    rule: "fallback-switch-to-claude".into(),
                };
                journal.record(&source, ai.mode, &req, &d);
                notes.push(format!("Local AI unavailable ({why}): running on Claude (fallback policy)."));
                return Ok(None);
            }
        },
        _ => pcc_ai::capacity(&ai),
    };
    let d = router::agent_engine(&ai, agent.kind, &agent.role, agent.profile.engine, &cap);
    journal.record(&source, ai.mode, &req, &d);
    match d.provider {
        Route::Local => {
            let model = d.model.clone().unwrap_or_default();
            notes.push(format!(
                "Engine: {} · model {model} (Claude Code on the local runtime) · {}",
                pcc_ai::runtime_name(&ai.local.runtime),
                d.reason
            ));
            Ok(Some((ai.local.base_url.clone(), model)))
        }
        Route::Claude => {
            notes.push(format!("Engine: Claude · {}", d.reason));
            Ok(None)
        }
        Route::Unavailable => Err(Error::invalid(format!("Local AI unavailable: {}", d.reason))),
    }
}

/// Makes sure the agent's working directory exists. For worktree agents this
/// creates the git worktree; if that is impossible the agent falls back to the
/// shared folder and a note explains why.
pub fn ensure_workdir(store: &ProjectStore, repo: Option<&Repo>, agent: &mut Agent) -> Vec<String> {
    let mut notes = Vec::new();
    if agent.isolation == Isolation::Worktree {
        match repo {
            Some(r) => {
                let path = store.layout().worktrees_dir().join(&agent.id);
                let branch = agent.branch.clone().unwrap_or_else(|| format!("agent/{}", agent.id));
                let base = r.current_branch().unwrap_or_else(|| "HEAD".into());
                match r.ensure_worktree(&path, &branch, &base) {
                    Ok(()) => {
                        agent.workdir = path.to_string_lossy().into_owned();
                        agent.branch = Some(branch);
                        return notes;
                    }
                    Err(e) => notes.push(format!("Worktree unavailable ({e}); working in the shared project folder.")),
                }
            }
            None => notes.push("Project is not a git repository; working in the shared project folder.".into()),
        }
        agent.isolation = Isolation::Shared;
        agent.branch = None;
    }
    agent.workdir = store.root().to_string_lossy().into_owned();
    notes
}

pub fn prepare(
    store: &ProjectStore,
    claude: &Path,
    agent: &Agent,
    connections: &[Connection],
    project_types: &[String],
    git_branch: Option<String>,
    resume: bool,
) -> Result<Prepared> {
    let settings = store.settings();
    let sessions_dir = store.layout().sessions_dir();
    std::fs::create_dir_all(&sessions_dir)?;

    let prompt = system_prompt(&PromptContext { store, agent, connections, project_types, git_branch });
    let prompt_file = sessions_dir.join(format!("{}.prompt.md", agent.id));
    std::fs::write(&prompt_file, prompt)?;

    let mut servers = Map::new();
    servers.insert(PCC_SERVER.into(), json!({"type": "sdk", "name": PCC_SERVER}));
    let mut env: Vec<(String, String)> = settings.session_env.clone().into_iter().collect();
    env.extend(agent.profile.env.clone());
    let master = &settings.master_control;
    let mastered = crate::policy::mastered(agent, master);
    // MASTER CONTROL gives Central every enabled connection of the opened scopes.
    let usable = |c: &Connection| {
        c.enabled
            && (agent.connections.contains(&c.id)
                || (mastered && crate::policy::master_covers_connection(master, c.kind)))
    };
    for c in connections.iter().filter(|c| usable(c)) {
        if let Some(entry) = pcc_connections::mcp_server_entry(c)? {
            servers.insert(entry.name, entry.config);
            env.extend(entry.env);
        }
        env.extend(pcc_connections::kinds::session_env(c)?);
    }
    let mcp_file = sessions_dir.join(format!("{}.mcp.json", agent.id));
    std::fs::write(&mcp_file, serde_json::to_string_pretty(&json!({"mcpServers": Value::Object(servers)}))?)?;

    let (session_id, resume_id) = match (&agent.claude_session_id, resume) {
        (Some(id), true) => (id.clone(), Some(id.clone())),
        _ => {
            let id = uuid::Uuid::new_v4().to_string();
            (id.clone(), None)
        }
    };
    let mut notes = Vec::new();
    let local = local_engine(store, agent, &mut notes)?;
    let model = match &local {
        Some((base, model)) => {
            env.extend(pcc_ai::claude_code_env(base, model));
            Some(model.clone())
        }
        None => agent.model.clone().or(match agent.kind {
            AgentKind::Central => settings.central_model.clone(),
            AgentKind::Worker => settings.worker_model.clone(),
        }),
    };
    let workdir = PathBuf::from(&agent.workdir);
    if !workdir.is_dir() {
        return Err(Error::not_found(format!("working directory {}", workdir.display())));
    }

    Ok(Prepared {
        spec: LaunchSpec {
            program: claude.to_path_buf(),
            cwd: workdir,
            model,
            system_prompt_file: Some(prompt_file),
            tools: builtin_tools(&crate::policy::effective_permissions(agent, &settings.autonomy, master)),
            effort: agent.profile.effort.clone(),
            disable_skills: !agent.profile.skills_enabled || (mastered && !master.skills),
            mcp_config_file: Some(mcp_file),
            sdk_mcp_servers: vec![PCC_SERVER.into()],
            session_id: Some(session_id.clone()),
            resume: resume_id,
            setting_sources: (!settings.inherit_user_settings).then(|| "project,local".to_string()),
            add_dirs: vec![],
            env,
            // Claude Code prices local tokens as if they were Claude's: no budget there.
            max_budget_usd: if local.is_some() { None } else { settings.max_budget_usd_per_session },
            name: Some(format!("PCC · {}", agent.name)),
        },
        claude_session_id: session_id,
        local_model: local.map(|(_, m)| m),
        notes,
    })
}
