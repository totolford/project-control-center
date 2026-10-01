//! Commands of the Claude Control Center: environment inspection, command
//! center, MCP and skills management, models, autonomy, environment
//! inspector and Raw Terminal. One-to-one with `src/lib/api.ts`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use pcc_claude::cli_help::{self, CliCommand, CliRun};
use pcc_claude::inspect::ClaudeEnvironment;
use pcc_claude::skills::{self, NewSkill, Skill, SkillRoots, SkillScope};
use pcc_connections::kinds::{self, McpConfig};
use pcc_connections::mcp::{self, McpProbe};
use pcc_connections::system::{self, ProjectInsights, SystemReport};
use pcc_core::{Agent, ConnectionKind, DecisionRecord, Error, Event, EventKind, Mission, PowerLevel};
use pcc_orchestrator::dto::ConnectionInput;
use pcc_pty::{PtyEvent, PtyInfo, PtySpec};

use crate::state::{AppSettings, AppState};

type CmdResult<T> = Result<T, Error>;

pub const PTY_CHANNEL: &str = "pcc://pty";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

fn claude() -> CmdResult<PathBuf> {
    pcc_claude::find_claude().ok_or_else(|| Error::Process("Claude Code was not detected".into()))
}

/// Project root when a project is open, otherwise the user's home folder.
async fn workdir(state: &AppState) -> PathBuf {
    match state.orch().await {
        Ok(o) => o.store.root().to_path_buf(),
        Err(_) => std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(std::env::temp_dir),
    }
}

async fn emit(state: &AppState, kind: EventKind, summary: String, payload: Value) {
    if let Ok(o) = state.orch().await {
        o.lock().await.emit(Event::new(kind, summary, payload));
    }
}

// ---------------------------------------------------------------- app settings

#[tauri::command]
pub fn app_settings(state: State<'_, AppState>) -> AppSettings {
    state.load_app_settings()
}

#[tauri::command]
pub fn save_app_settings(state: State<'_, AppState>, settings: AppSettings) -> CmdResult<AppSettings> {
    if let Some(p) = settings.claude_path.as_deref().filter(|p| !p.trim().is_empty()) {
        if !Path::new(p).is_file() {
            return Err(Error::invalid(format!("{p} does not exist")));
        }
    }
    std::fs::write(state.app_settings_file(), serde_json::to_string_pretty(&settings)?)?;
    AppState::apply_app_settings(&settings);
    Ok(settings)
}

// ---------------------------------------------------------------- Claude environment

#[tauri::command]
pub async fn claude_environment(state: State<'_, AppState>) -> CmdResult<ClaudeEnvironment> {
    Ok(pcc_claude::inspect::inspect(&workdir(&state).await).await)
}

/// The CLI command tree of the installed version (cached per version).
#[tauri::command]
pub async fn claude_command_tree(state: State<'_, AppState>, refresh: bool) -> CmdResult<CliCommand> {
    let info = pcc_claude::detect().await;
    let version = info.version.clone().ok_or_else(|| Error::Process("Claude Code was not detected".into()))?;
    let cache = state.data_dir.join(format!("claude-commands-{version}.json"));
    if !refresh {
        if let Some(tree) = std::fs::read_to_string(&cache).ok().and_then(|s| serde_json::from_str(&s).ok()) {
            return Ok(tree);
        }
    }
    let exe = claude()?;
    let tree = blocking(move || cli_help::command_tree(&exe)).await??;
    std::fs::write(&cache, serde_json::to_string(&tree)?)?;
    Ok(tree)
}

/// Runs `claude <args>` without a terminal.
#[tauri::command]
pub async fn run_claude_cli(state: State<'_, AppState>, args: Vec<String>) -> CmdResult<CliRun> {
    let run = cli_help::run(&claude()?, &workdir(&state).await, args, Duration::from_secs(120)).await?;
    emit(
        &state,
        EventKind::ToolUsed,
        format!("user ran: claude {}", run.args.join(" ")),
        json!({"exitCode": run.exit_code}),
    )
    .await;
    Ok(run)
}

// ---------------------------------------------------------------- MCP (Claude Code configuration)

/// Adds a server to Claude Code's own configuration (`claude mcp add-json`).
/// Secret values are never written: env / header values must be `${VAR}`
/// references that Claude Code resolves from its environment.
#[tauri::command]
pub async fn claude_mcp_add(
    state: State<'_, AppState>,
    name: String,
    config: Value,
    scope: String,
) -> CmdResult<CliRun> {
    if !matches!(scope.as_str(), "local" | "user" | "project") {
        return Err(Error::invalid("scope must be local, user or project"));
    }
    for map in ["env", "headers"] {
        if let Some(o) = config.get(map).and_then(Value::as_object) {
            if let Some((k, _)) =
                o.iter().find(|(_, v)| !v.as_str().is_some_and(|s| s.starts_with("${") && s.ends_with('}')))
            {
                return Err(Error::invalid(format!(
                    "`{k}` must be a ${{VAR}} reference: secrets are not written to Claude Code's config files. Add the server to NEXUS instead to keep the value in Windows Credential Manager."
                )));
            }
        }
    }
    let args = vec!["mcp".into(), "add-json".into(), name.clone(), config.to_string(), "-s".into(), scope.clone()];
    let run = cli_help::run(&claude()?, &workdir(&state).await, args, Duration::from_secs(60)).await?;
    emit(&state, EventKind::McpChanged, format!("MCP {name} added to Claude Code ({scope})"), json!({"name": name}))
        .await;
    Ok(run)
}

#[tauri::command]
pub async fn claude_mcp_remove(state: State<'_, AppState>, name: String, scope: String) -> CmdResult<CliRun> {
    let args = vec!["mcp".into(), "remove".into(), name.clone(), "-s".into(), scope.clone()];
    let run = cli_help::run(&claude()?, &workdir(&state).await, args, Duration::from_secs(60)).await?;
    emit(
        &state,
        EventKind::McpChanged,
        format!("MCP {name} removed from Claude Code ({scope})"),
        json!({"name": name}),
    )
    .await;
    Ok(run)
}

/// Enables or disables a server for this project in Claude Code (persisted by Claude Code).
#[tauri::command]
pub async fn claude_mcp_set_enabled(state: State<'_, AppState>, name: String, enabled: bool) -> CmdResult<()> {
    let cwd = workdir(&state).await;
    pcc_claude::control::one_shot(&claude()?, &cwd, "mcp_toggle", json!({"serverName": name, "enabled": enabled}))
        .await?;
    emit(
        &state,
        EventKind::McpChanged,
        format!("MCP {name} {}", if enabled { "enabled" } else { "disabled" }),
        json!({"name": name, "enabled": enabled}),
    )
    .await;
    Ok(())
}

/// Tests a server given in Claude Code's config format (`type`, `command`, `url`, ...).
#[tauri::command]
pub async fn test_mcp_config(state: State<'_, AppState>, config: Value) -> CmdResult<McpProbe> {
    let cwd = workdir(&state).await;
    let strings = |k: &str| -> BTreeMap<String, String> {
        config
            .get(k)
            .and_then(Value::as_object)
            .map(|o| o.iter().filter_map(|(a, b)| Some((a.clone(), b.as_str()?.to_string()))).collect())
            .unwrap_or_default()
    };
    let kind = config.get("type").and_then(Value::as_str).unwrap_or("stdio");
    let probe = if matches!(kind, "http" | "sse") {
        let url = config.get("url").and_then(Value::as_str).ok_or_else(|| Error::invalid("missing url"))?;
        mcp::probe(mcp::Target::Http { url, headers: &strings("headers") }, Duration::from_secs(25)).await
    } else if kind == "stdio" {
        let program = config.get("command").and_then(Value::as_str).ok_or_else(|| Error::invalid("missing command"))?;
        let args: Vec<String> = config
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let env: Vec<(String, String)> = strings("env").into_iter().collect();
        mcp::probe(mcp::Target::Stdio { program, args: &args, env: &env, cwd: &cwd }, Duration::from_secs(25)).await
    } else {
        return Err(Error::invalid(format!("transport `{kind}` cannot be tested from NEXUS")));
    };
    probe.map_err(Error::Process)
}

/// Detailed test of a NEXUS MCP / Roblox connection: tools, resources, prompts, latency.
#[tauri::command]
pub async fn probe_connection(state: State<'_, AppState>, id: String) -> CmdResult<McpProbe> {
    let orch = state.orch().await?;
    let c = orch.store.get_connection(&id)?.ok_or_else(|| Error::not_found(format!("connection {id}")))?;
    if !matches!(c.kind, ConnectionKind::Mcp | ConnectionKind::RobloxStudio) {
        return Err(Error::invalid("only MCP connections expose tools"));
    }
    let kinds::McpRuntime { config: cfg, env, headers } = kinds::mcp_runtime(&c)?;
    let root = orch.store.root().to_path_buf();
    let target = if cfg.is_remote() {
        mcp::Target::Http { url: &cfg.url, headers: &headers }
    } else {
        mcp::Target::Stdio { program: &cfg.command, args: &cfg.args, env: &env, cwd: &root }
    };
    mcp::probe(target, Duration::from_secs(25)).await.map_err(Error::Process)
}

/// Copies a Claude Code MCP server into NEXUS. Env / header values move to
/// Windows Credential Manager; the project only keeps their names.
#[tauri::command]
pub async fn import_claude_mcp(
    state: State<'_, AppState>,
    name: String,
    config: Value,
) -> CmdResult<pcc_core::Connection> {
    let cfg: McpConfig =
        kinds::mcp_config_from_claude(&config).ok_or_else(|| Error::invalid("unsupported MCP server type"))?;
    let mut secrets = BTreeMap::new();
    for map in ["env", "headers"] {
        if let Some(o) = config.get(map).and_then(Value::as_object) {
            for (k, v) in o {
                if let Some(v) = v.as_str() {
                    secrets.insert(k.clone(), v.to_string());
                }
            }
        }
    }
    let orch = state.orch().await?;
    let kind =
        if name.to_ascii_lowercase().contains("roblox") { ConnectionKind::RobloxStudio } else { ConnectionKind::Mcp };
    let mut e = orch.lock().await;
    e.add_connection(ConnectionInput { name, kind, config: serde_json::to_value(cfg)?, secrets: Some(secrets) })
}

#[tauri::command]
pub async fn reconnect_mcp(state: State<'_, AppState>, server: String) -> CmdResult<Vec<String>> {
    state.orch().await?.lock().await.reconnect_mcp_everywhere(&server)
}

#[tauri::command]
pub async fn reload_plugins(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    state.orch().await?.lock().await.reload_plugins_everywhere()
}

#[tauri::command]
pub async fn claude_plugin_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> CmdResult<CliRun> {
    let args = vec!["plugin".into(), if enabled { "enable" } else { "disable" }.into(), id.clone()];
    let run = cli_help::run(&claude()?, &workdir(&state).await, args, Duration::from_secs(60)).await?;
    emit(
        &state,
        EventKind::SkillChanged,
        format!("Plugin {id} {}", if enabled { "enabled" } else { "disabled" }),
        json!({"plugin": id}),
    )
    .await;
    Ok(run)
}

// ---------------------------------------------------------------- skills

async fn skill_roots(state: &AppState) -> CmdResult<SkillRoots> {
    let project = state.orch().await.ok().map(|o| o.store.root().to_path_buf());
    let exe = claude().ok();
    let plugins: Vec<Value> = match exe {
        Some(exe) => {
            blocking(move || {
                pcc_claude::process::std_command(&exe)
                    .args(["plugin", "list", "--json"])
                    .output()
                    .ok()
                    .and_then(|o| serde_json::from_slice(&o.stdout).ok())
                    .unwrap_or_default()
            })
            .await?
        }
        None => vec![],
    };
    Ok(SkillRoots::new(project.as_deref(), &plugins))
}

async fn skills_changed(state: &AppState, summary: String) {
    if let Ok(o) = state.orch().await {
        let mut e = o.lock().await;
        let _ = e.reload_plugins_everywhere();
        e.emit(Event::new(EventKind::SkillChanged, summary, Value::Null));
    }
}

#[tauri::command]
pub async fn list_skills(state: State<'_, AppState>) -> CmdResult<Vec<Skill>> {
    let roots = skill_roots(&state).await?;
    blocking(move || skills::list(&roots)).await
}

#[tauri::command]
pub async fn skill_create(state: State<'_, AppState>, scope: SkillScope, spec: NewSkill) -> CmdResult<String> {
    let roots = skill_roots(&state).await?;
    let dir = skills::create(&roots, scope, &spec)?;
    skills_changed(&state, format!("Skill {} created", spec.name)).await;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn skill_preview(spec: NewSkill) -> String {
    skills::render(&spec)
}

#[tauri::command]
pub async fn skill_read_file(state: State<'_, AppState>, dir: String, file: String) -> CmdResult<String> {
    let roots = skill_roots(&state).await?;
    skills::read_file(&roots, &dir, &file)
}

/// Unified diff between the current SKILL.md and `content` (shown before saving).
#[tauri::command]
pub async fn skill_diff(dir: String, content: String) -> CmdResult<String> {
    let current = std::fs::read_to_string(Path::new(&dir).join("SKILL.md"))?;
    Ok(skills::diff(&current, &content))
}

#[tauri::command]
pub async fn skill_save(state: State<'_, AppState>, dir: String, content: String) -> CmdResult<()> {
    let roots = skill_roots(&state).await?;
    skills::write_skill_md(&roots, &dir, &content)?;
    skills_changed(&state, "Skill updated".into()).await;
    Ok(())
}

#[tauri::command]
pub async fn skill_set_enabled(state: State<'_, AppState>, dir: String, enabled: bool) -> CmdResult<String> {
    let roots = skill_roots(&state).await?;
    let d = skills::set_enabled(&roots, &dir, enabled)?;
    skills_changed(&state, format!("Skill {}", if enabled { "enabled" } else { "disabled" })).await;
    Ok(d.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn skill_duplicate(state: State<'_, AppState>, dir: String, name: String) -> CmdResult<String> {
    let roots = skill_roots(&state).await?;
    let d = skills::duplicate(&roots, &dir, &name)?;
    skills_changed(&state, format!("Skill duplicated as {name}")).await;
    Ok(d.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn skill_delete(state: State<'_, AppState>, dir: String) -> CmdResult<String> {
    let roots = skill_roots(&state).await?;
    let d = skills::delete(&roots, &dir)?;
    skills_changed(&state, "Skill moved to skills-trash".into()).await;
    Ok(d.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn skill_export(dir: String, destination: String) -> CmdResult<String> {
    Ok(skills::export(&dir, Path::new(&destination))?.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTest {
    /// Claude Code lists the skill among its commands.
    pub discovered: bool,
    pub problems: Vec<String>,
    pub command_name: Option<String>,
}

/// Checks SKILL.md and whether Claude Code actually discovers the skill (no model call).
#[tauri::command]
pub async fn skill_test(state: State<'_, AppState>, dir: String) -> CmdResult<SkillTest> {
    let roots = skill_roots(&state).await?;
    let all = blocking(move || skills::list(&roots)).await?;
    let s = all.into_iter().find(|s| s.dir == dir).ok_or_else(|| Error::not_found(format!("skill {dir}")))?;
    let env = pcc_claude::inspect::inspect(&workdir(&state).await).await;
    let found = env
        .commands
        .iter()
        .filter_map(|c| c.get("name").and_then(Value::as_str))
        .find(|n| *n == s.name || n.ends_with(&format!(":{}", s.name)))
        .map(str::to_string);
    let mut problems = s.problems.clone();
    if !s.enabled {
        problems.push("the skill is disabled".into());
    }
    if found.is_none() && s.enabled {
        problems.push("Claude Code does not list this skill (check its location and frontmatter)".into());
    }
    Ok(SkillTest { discovered: found.is_some(), problems, command_name: found })
}

// ---------------------------------------------------------------- models / power / autonomy

/// Changes an agent's model; returns true when its running session switched immediately.
#[tauri::command]
pub async fn set_agent_model(state: State<'_, AppState>, agent_id: String, model: Option<String>) -> CmdResult<bool> {
    state.orch().await?.lock().await.set_agent_model(&agent_id, model)
}

#[tauri::command]
pub async fn apply_power(state: State<'_, AppState>, agent_id: String, level: PowerLevel) -> CmdResult<Agent> {
    state.orch().await?.lock().await.apply_power(&agent_id, level)
}

#[tauri::command]
pub async fn emergency_stop(state: State<'_, AppState>) -> CmdResult<()> {
    state.pty.kill_all();
    state.orch().await?.lock().await.emergency_stop()
}

#[tauri::command]
pub async fn release_emergency(state: State<'_, AppState>) -> CmdResult<()> {
    state.orch().await?.lock().await.release_emergency()
}

#[tauri::command]
pub async fn revoke_all_permissions(state: State<'_, AppState>) -> CmdResult<()> {
    state.orch().await?.lock().await.revoke_all_permissions()
}

#[tauri::command]
pub async fn list_decisions(
    state: State<'_, AppState>,
    agent_id: Option<String>,
    before: Option<i64>,
    limit: u32,
) -> CmdResult<Vec<DecisionRecord>> {
    state.orch().await?.store.list_decisions(agent_id.as_deref(), before, limit)
}

#[tauri::command]
pub async fn start_improvement_cycle(state: State<'_, AppState>) -> CmdResult<Mission> {
    state.orch().await?.lock().await.start_improvement_cycle("user")
}

// ---------------------------------------------------------------- environment inspector

#[tauri::command]
pub async fn system_report() -> CmdResult<SystemReport> {
    blocking(system::system_report).await
}

#[tauri::command]
pub async fn project_insights(state: State<'_, AppState>) -> CmdResult<ProjectInsights> {
    let root = state.orch().await?.store.root().to_path_buf();
    blocking(move || system::project_insights(&root)).await
}

// ---------------------------------------------------------------- Raw Terminal

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRequest {
    /// `claude`, `claude-resume`, `powershell`, `pwsh`, `cmd`, `wsl`.
    pub profile: String,
    /// For `claude-resume`: the agent whose Claude session to open.
    pub agent_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub async fn pty_spawn(app: AppHandle, state: State<'_, AppState>, request: TerminalRequest) -> CmdResult<PtyInfo> {
    let cwd = workdir(&state).await;
    let claude_exe = || claude().map(|p| p.to_string_lossy().into_owned());
    let (title, program, args, cwd) = match request.profile.as_str() {
        "claude" => ("Claude Code".to_string(), claude_exe()?, vec![], cwd),
        "claude-resume" => {
            let orch = state.orch().await?;
            let id = request.agent_id.clone().ok_or_else(|| Error::invalid("agent required"))?;
            let a = orch.store.agent(&id)?;
            if a.status.is_live() {
                return Err(Error::Conflict(format!(
                    "{} is running in NEXUS; stop it before opening its session in a terminal",
                    a.name
                )));
            }
            let session = a
                .claude_session_id
                .clone()
                .ok_or_else(|| Error::invalid(format!("{} has no Claude session yet", a.name)))?;
            (
                format!("Claude Code · {}", a.name),
                claude_exe()?,
                vec!["--resume".into(), session],
                PathBuf::from(a.workdir),
            )
        }
        "powershell" => ("PowerShell".into(), "powershell.exe".into(), vec!["-NoLogo".into()], cwd),
        "pwsh" => ("PowerShell 7".into(), "pwsh.exe".into(), vec!["-NoLogo".into()], cwd),
        "cmd" => ("Command Prompt".into(), "cmd.exe".into(), vec![], cwd),
        "wsl" => ("WSL".into(), "wsl.exe".into(), vec![], cwd),
        other => return Err(Error::invalid(format!("unknown terminal profile `{other}`"))),
    };
    let app2 = app.clone();
    let info = state.pty.spawn(
        PtySpec {
            title,
            program,
            args,
            cwd: cwd.to_string_lossy().into_owned(),
            env: vec![],
            cols: request.cols,
            rows: request.rows,
        },
        move |e: PtyEvent| {
            let _ = app2.emit(PTY_CHANNEL, e);
        },
    )?;
    emit(&state, EventKind::ToolUsed, format!("Raw Terminal opened: {}", info.title), json!({"terminal": info.id}))
        .await;
    Ok(info)
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    state.pty.write(&id, &data)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    state.pty.resize(&id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.pty.kill(&id)
}

#[tauri::command]
pub fn pty_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.pty.close(&id)
}

#[tauri::command]
pub fn pty_list(state: State<'_, AppState>) -> Vec<PtyInfo> {
    state.pty.list()
}

#[tauri::command]
pub fn pty_scrollback(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    state.pty.scrollback(&id)
}
