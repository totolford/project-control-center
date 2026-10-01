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
    for c in connections.iter().filter(|c| c.enabled && agent.connections.contains(&c.id)) {
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
    let model = agent.model.clone().or(match agent.kind {
        AgentKind::Central => settings.central_model.clone(),
        AgentKind::Worker => settings.worker_model.clone(),
    });
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
            tools: builtin_tools(crate::policy::effective_permissions(agent, &settings.autonomy)),
            effort: agent.profile.effort.clone(),
            disable_skills: !agent.profile.skills_enabled,
            mcp_config_file: Some(mcp_file),
            sdk_mcp_servers: vec![PCC_SERVER.into()],
            session_id: Some(session_id.clone()),
            resume: resume_id,
            setting_sources: (!settings.inherit_user_settings).then(|| "project,local".to_string()),
            add_dirs: vec![],
            env,
            max_budget_usd: settings.max_budget_usd_per_session,
            name: Some(format!("PCC · {}", agent.name)),
        },
        claude_session_id: session_id,
    })
}
