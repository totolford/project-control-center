//! Tauri commands. One-to-one with `src/lib/api.ts`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use pcc_connections::{environment, github, kinds};
use pcc_core::{
    Agent, ClaudeInfo, Connection, EnvironmentReport, Error, Event, EventBus, EventKind, LogEntry, Message, Mission,
    PermissionDecision, ProjectSettings, SessionRecord, Task, USER_ID,
};
use pcc_git::{MergeOutcome, Repo, RepoStatus, Snapshot};
use pcc_orchestrator::dto::{
    AgentPatch, AgentSpec, ConnectionInput, GitOverview, ProjectSnapshot, TaskPatch, TaskSpec,
};
use pcc_orchestrator::Orchestrator;
use pcc_store::{recent, EventFilter, Layout, MemoryFile, ProjectStore};

use crate::state::{AppState, OpenProject};

type CmdResult<T> = Result<T, Error>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

// ---------------------------------------------------------------- app

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
    log_dir: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        log_dir: state.log_dir.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub async fn detect_claude() -> ClaudeInfo {
    pcc_claude::detect().await
}

#[tauri::command]
pub fn recent_projects(state: State<'_, AppState>) -> Vec<recent::RecentProject> {
    recent::load(&state.recent_file())
}

#[tauri::command]
pub fn forget_recent(state: State<'_, AppState>, root: String) -> CmdResult<Vec<recent::RecentProject>> {
    recent::remove(&state.recent_file(), &root)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInspection {
    path: String,
    is_project: bool,
    suggested_name: String,
    environment: EnvironmentReport,
}

#[tauri::command]
pub async fn inspect_folder(path: String) -> CmdResult<FolderInspection> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(Error::not_found(format!("folder {path}")));
    }
    let suggested_name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Project".into());
    let is_project = Layout::exists(&root);
    let environment = blocking(move || environment::detect_environment(&root)).await?;
    Ok(FolderInspection { path, is_project, suggested_name, environment })
}

// ---------------------------------------------------------------- project

async fn activate(app: &AppHandle, state: &AppState, store: ProjectStore) -> CmdResult<ProjectSnapshot> {
    let root = store.root().to_path_buf();
    let name = store.info().name.clone();
    let scan_root = root.clone();
    let (_, project_types) = blocking(move || environment::detect_project(&scan_root)).await?;
    let claude = pcc_claude::find_claude();
    let orch = Orchestrator::open(store, EventBus::new(), claude, project_types)?;
    let snapshot = {
        let mut e = orch.lock().await;
        e.ensure_default_connections()?;
        e.emit(Event::new(EventKind::ProjectOpened, format!("Project {name} opened"), json!({"root": root})));
        e.snapshot()?
    };
    *state.project.write().await = Some(OpenProject::new(app, orch));
    recent::touch(&state.recent_file(), &name, &root.to_string_lossy())?;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&format!("{name} — Project Control Center"));
    }
    tracing::info!("project opened: {}", root.display());
    Ok(snapshot)
}

#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
    init_git: bool,
) -> CmdResult<ProjectSnapshot> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(Error::not_found(format!("folder {path}")));
    }
    let name = if name.trim().is_empty() {
        root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Project".into())
    } else {
        name.trim().to_string()
    };
    state.close_project().await;
    if init_git && Repo::discover(&root).is_none() {
        Repo::init(&root)?;
    }
    let store = blocking(move || ProjectStore::create(&root, &name)).await??;
    activate(&app, &state, store).await
}

#[tauri::command]
pub async fn open_project(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<ProjectSnapshot> {
    let root = PathBuf::from(&path);
    state.close_project().await;
    let store = blocking(move || ProjectStore::open(&root)).await??;
    activate(&app, &state, store).await
}

#[tauri::command]
pub async fn close_project(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    state.close_project().await;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title("Project Control Center");
    }
    Ok(())
}

#[tauri::command]
pub async fn project_snapshot(state: State<'_, AppState>) -> CmdResult<ProjectSnapshot> {
    state.orch().await?.lock().await.snapshot()
}

#[tauri::command]
pub async fn project_environment(state: State<'_, AppState>) -> CmdResult<EnvironmentReport> {
    let root = state.orch().await?.store.root().to_path_buf();
    blocking(move || environment::detect_environment(&root)).await
}

#[tauri::command]
pub async fn save_settings(state: State<'_, AppState>, settings: ProjectSettings) -> CmdResult<ProjectSettings> {
    if settings.max_parallel_workers == 0 || settings.max_parallel_workers > 32 {
        return Err(Error::invalid("parallel workers must be between 1 and 32"));
    }
    let orch = state.orch().await?;
    let e = orch.lock().await;
    orch.store.save_settings(settings.clone())?;
    e.emit(Event::new(EventKind::ProjectChanged, "Project settings updated", json!({"settings": settings})));
    Ok(settings)
}

#[tauri::command]
pub async fn recover_sessions(state: State<'_, AppState>) -> CmdResult<()> {
    state.orch().await?.lock().await.recover()
}

#[tauri::command]
pub async fn discard_recovery(state: State<'_, AppState>) -> CmdResult<()> {
    state.orch().await?.lock().await.discard_recovery()
}

// ---------------------------------------------------------------- missions

#[tauri::command]
pub async fn create_mission(state: State<'_, AppState>, prompt: String, title: Option<String>) -> CmdResult<Mission> {
    state.orch().await?.lock().await.create_mission(&prompt, title)
}

#[tauri::command]
pub async fn cancel_mission(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.cancel_mission(&id)
}

// ---------------------------------------------------------------- agents

#[tauri::command]
pub async fn create_agent(state: State<'_, AppState>, spec: AgentSpec) -> CmdResult<Agent> {
    state.orch().await?.lock().await.create_agent(spec, USER_ID)
}

#[tauri::command]
pub async fn update_agent(state: State<'_, AppState>, id: String, patch: AgentPatch) -> CmdResult<Agent> {
    state.orch().await?.lock().await.update_agent(&id, patch)
}

#[tauri::command]
pub async fn start_agent(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.start_agent_by_user(&id)
}

#[tauri::command]
pub async fn stop_agent(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.stop_agent(&id)
}

#[tauri::command]
pub async fn restart_agent(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.restart_agent(&id)
}

#[tauri::command]
pub async fn interrupt_agent(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.interrupt_agent(&id)
}

#[tauri::command]
pub async fn retire_agent(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.retire_agent(&id, Some("retired by the user"))
}

#[tauri::command]
pub async fn stop_all_agents(state: State<'_, AppState>) -> CmdResult<()> {
    state.orch().await?.lock().await.stop_all()
}

#[tauri::command]
pub async fn send_user_message(state: State<'_, AppState>, to: String, body: String) -> CmdResult<Message> {
    state.orch().await?.lock().await.send_user_message(&to, &body)
}

#[tauri::command]
pub async fn agent_logs(
    state: State<'_, AppState>,
    agent_id: String,
    before: Option<i64>,
    limit: u32,
) -> CmdResult<Vec<LogEntry>> {
    state.orch().await?.store.list_logs(&agent_id, before, limit.clamp(1, 2000))
}

#[tauri::command]
pub async fn agent_sessions(state: State<'_, AppState>, agent_id: String) -> CmdResult<Vec<SessionRecord>> {
    state.orch().await?.store.list_sessions(&agent_id)
}

#[tauri::command]
pub async fn permission_rules(state: State<'_, AppState>, agent_id: String) -> CmdResult<Vec<String>> {
    state.orch().await?.store.list_permission_rules(&agent_id)
}

#[tauri::command]
pub async fn remove_permission_rule(state: State<'_, AppState>, agent_id: String, rule_key: String) -> CmdResult<()> {
    state.orch().await?.store.remove_permission_rule(&agent_id, &rule_key)
}

// ---------------------------------------------------------------- tasks

#[tauri::command]
pub async fn create_task(state: State<'_, AppState>, spec: TaskSpec) -> CmdResult<Task> {
    state.orch().await?.lock().await.create_task(spec, USER_ID)
}

#[tauri::command]
pub async fn update_task(state: State<'_, AppState>, id: String, patch: TaskPatch) -> CmdResult<Task> {
    state.orch().await?.lock().await.update_task(&id, patch, USER_ID)
}

#[tauri::command]
pub async fn retry_task(state: State<'_, AppState>, id: String) -> CmdResult<Task> {
    state.orch().await?.lock().await.retry_task(&id)
}

// ---------------------------------------------------------------- messages / events / permissions

#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    agent_id: Option<String>,
    limit: u32,
) -> CmdResult<Vec<Message>> {
    state.orch().await?.store.list_messages(agent_id.as_deref(), limit.clamp(1, 2000))
}

#[tauri::command]
pub async fn list_events(state: State<'_, AppState>, filter: EventFilter) -> CmdResult<Vec<Event>> {
    state.orch().await?.store.list_events(&filter)
}

#[tauri::command]
pub async fn resolve_permission(state: State<'_, AppState>, id: String, decision: PermissionDecision) -> CmdResult<()> {
    state.orch().await?.lock().await.resolve_permission(&id, decision)
}

// ---------------------------------------------------------------- memory

#[tauri::command]
pub async fn memory_files(state: State<'_, AppState>) -> CmdResult<Vec<MemoryFile>> {
    state.orch().await?.store.list_memory()
}

#[tauri::command]
pub async fn save_memory(state: State<'_, AppState>, key: String, content: String) -> CmdResult<MemoryFile> {
    let orch = state.orch().await?;
    orch.lock().await.save_memory(&key, &content, USER_ID)?;
    orch.store.read_memory(&pcc_store::MemoryScope::parse(&key)?)
}

#[tauri::command]
pub async fn consolidate_memory(state: State<'_, AppState>) -> CmdResult<()> {
    state.orch().await?.lock().await.consolidate_memory()
}

// ---------------------------------------------------------------- connections

#[tauri::command]
pub async fn add_connection(state: State<'_, AppState>, input: ConnectionInput) -> CmdResult<Connection> {
    state.orch().await?.lock().await.add_connection(input)
}

#[tauri::command]
pub async fn update_connection(
    state: State<'_, AppState>,
    id: String,
    input: ConnectionInput,
) -> CmdResult<Connection> {
    state.orch().await?.lock().await.update_connection(&id, input)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.delete_connection(&id)
}

#[tauri::command]
pub async fn check_connection(state: State<'_, AppState>, id: String) -> CmdResult<Connection> {
    let orch = state.orch().await?;
    let c = orch.store.get_connection(&id)?.ok_or_else(|| Error::not_found(format!("connection {id}")))?;
    // The check can take seconds (SSH, MCP start-up): never hold the engine lock meanwhile.
    let result = kinds::check_connection(&c, orch.store.root()).await;
    let mut e = orch.lock().await;
    e.record_check(&id, result)
}

#[tauri::command]
pub async fn connection_secret_keys(state: State<'_, AppState>, id: String) -> CmdResult<Vec<String>> {
    state.orch().await?.lock().await.connection_secret_keys(&id)
}

#[tauri::command]
pub async fn roblox_detect() -> CmdResult<kinds::RobloxDetection> {
    blocking(kinds::roblox_detect).await
}

#[tauri::command]
pub async fn known_mcp_servers() -> CmdResult<Vec<kinds::McpCandidate>> {
    blocking(kinds::known_mcp_servers).await
}

// ---------------------------------------------------------------- git / github

#[tauri::command]
pub async fn git_overview(state: State<'_, AppState>) -> CmdResult<Option<GitOverview>> {
    let orch = state.orch().await?;
    let mut e = orch.lock().await;
    e.refresh_repo();
    e.git_overview()
}

#[tauri::command]
pub async fn git_init(state: State<'_, AppState>) -> CmdResult<RepoStatus> {
    let orch = state.orch().await?;
    let mut e = orch.lock().await;
    let s = e.git_init()?;
    e.ensure_default_connections()?;
    Ok(s)
}

#[tauri::command]
pub async fn merge_agent_branch(state: State<'_, AppState>, agent_id: String) -> CmdResult<MergeOutcome> {
    state.orch().await?.lock().await.merge_agent_branch(&agent_id)
}

#[tauri::command]
pub async fn commit_agent_work(
    state: State<'_, AppState>,
    agent_id: String,
    message: String,
) -> CmdResult<Option<String>> {
    if message.trim().is_empty() {
        return Err(Error::invalid("a commit message is required"));
    }
    state.orch().await?.lock().await.commit_agent_work(&agent_id, message.trim())
}

#[tauri::command]
pub async fn create_snapshot(state: State<'_, AppState>, label: String) -> CmdResult<Snapshot> {
    state.orch().await?.lock().await.create_snapshot(&label)
}

#[tauri::command]
pub async fn restore_snapshot(state: State<'_, AppState>, branch: String) -> CmdResult<Snapshot> {
    state.orch().await?.lock().await.restore_snapshot(&branch)
}

fn github_repo(orch: &Orchestrator) -> CmdResult<Option<String>> {
    let configured = orch
        .store
        .list_connections()?
        .into_iter()
        .find(|c| c.kind == pcc_core::ConnectionKind::Github)
        .and_then(|c| c.config.get("repo").and_then(|v| v.as_str()).map(str::to_string))
        .filter(|r| !r.is_empty());
    Ok(configured.or_else(|| {
        Repo::discover(orch.store.root()).and_then(|r| r.status().remote_url).and_then(|u| github::parse_repo(&u))
    }))
}

#[tauri::command]
pub async fn github_status(state: State<'_, AppState>) -> CmdResult<github::GithubStatus> {
    let orch = state.orch().await?;
    let root = orch.store.root().to_path_buf();
    let repo = github_repo(&orch)?;
    blocking(move || {
        let mut s = github::status(&root, None);
        s.repo = repo;
        s
    })
    .await
}

#[tauri::command]
pub async fn github_overview(state: State<'_, AppState>) -> CmdResult<github::GithubOverview> {
    let orch = state.orch().await?;
    let root = orch.store.root().to_path_buf();
    let repo = github_repo(&orch)?.ok_or_else(|| {
        Error::invalid(
            "no GitHub repository configured (add a remote named origin or set the repo on the GitHub connection)",
        )
    })?;
    blocking(move || github::overview(&root, &repo)).await?
}

#[tauri::command]
pub async fn create_pull_request(
    state: State<'_, AppState>,
    agent_id: String,
    title: String,
    body: String,
) -> CmdResult<String> {
    let orch = state.orch().await?;
    let agent = orch.store.agent(&agent_id)?;
    let branch = agent.branch.ok_or_else(|| Error::invalid(format!("{agent_id} has no branch")))?;
    let repo_slug = github_repo(&orch)?.ok_or_else(|| Error::invalid("no GitHub repository configured"))?;
    let root = orch.store.root().to_path_buf();
    let base = Repo::discover(&root).and_then(|r| r.current_branch()).unwrap_or_else(|| "main".into());
    let url =
        blocking(move || github::create_pull_request(&root, &repo_slug, &branch, &base, title.trim(), &body)).await??;
    orch.lock().await.emit(
        Event::new(
            EventKind::GitChanged,
            format!("Pull request opened: {url}"),
            json!({"url": url, "agent": agent_id}),
        )
        .agent(&agent_id),
    );
    Ok(url)
}

// ---------------------------------------------------------------- misc

#[tauri::command]
pub async fn open_path(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let p = Path::new(&path);
    // Only folders/files of the open project (including .agent-project) can be opened.
    let root = state.orch().await?.store.root().to_path_buf();
    let inside = pcc_core::permissions::normalize_path(p).starts_with(pcc_core::permissions::normalize_path(&root));
    if !inside {
        return Err(Error::Denied("only paths inside the project can be opened".into()));
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| Error::Process(e.to_string()))
}
