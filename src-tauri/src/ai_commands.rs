//! AI Engines: hardware detection, local runtimes (Ollama, LM Studio,
//! llama.cpp), local models, the ModelRouter settings and journal, the AI
//! Setup wizard and AI Town's local townspeople.
//!
//! Nothing is installed or downloaded here without a command the UI only
//! sends after the user confirmed the exact action (winget command, model and
//! download size).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use pcc_ai::catalog::{self, Recommendation};
use pcc_ai::hardware::{self, HardwareInfo};
use pcc_ai::provider::{self, LocalModel, Ollama, PullProgress};
use pcc_ai::router::{self, Journal, JournalEntry, LocalCapacity, RouteDecision, RouteRequest, TaskKind};
use pcc_ai::runtime::{self, Benchmark, RuntimeKind, RuntimeStatus};
use pcc_ai::TownspeopleReadiness;
use pcc_core::{AiEngineSettings, AiMode, EngineProvider, Error, Event, EventKind, FallbackPolicy, Severity};

use crate::state::{AppState, EVENT_CHANNEL};

type CmdResult<T> = Result<T, Error>;

/// Model download progress (`AiPullEvent`).
pub const PULL_CHANNEL: &str = "pcc://ai-pull";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

// ---------------------------------------------------------------- settings

/// Application-level AI settings (`<app data>/ai-settings.json`): the engines
/// used when no project is open, and the AI Setup wizard state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiAppSettings {
    pub ai: AiEngineSettings,
    /// When the AI Setup wizard was finished or skipped (`None` = never: offer it).
    pub setup_at: Option<String>,
    pub setup_skipped: bool,
}

fn app_file(state: &AppState) -> PathBuf {
    state.data_dir.join("ai-settings.json")
}

fn load_app(state: &AppState) -> AiAppSettings {
    std::fs::read_to_string(app_file(state)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_app(state: &AppState, s: &AiAppSettings) -> CmdResult<()> {
    std::fs::write(app_file(state), serde_json::to_string_pretty(s)?)?;
    Ok(())
}

/// Settings in force: the open project's, else the application default.
async fn current(state: &AppState) -> AiEngineSettings {
    match state.orch().await {
        Ok(o) => o.store.settings().ai,
        Err(_) => load_app(state).ai,
    }
}

/// Journal of routing decisions (the project's, else the application's).
async fn journal(state: &AppState) -> Journal {
    match state.orch().await {
        Ok(o) => Journal::new(o.store.layout().logs_dir().join("ai-routing.jsonl")),
        Err(_) => Journal::new(state.log_dir.join("ai-routing.jsonl")),
    }
}

/// Journals in the open project (Activity) or, without a project, sends the
/// event to the window only.
async fn emit(app: &AppHandle, e: Event) {
    let state = app.state::<AppState>();
    match state.orch().await {
        Ok(o) => o.lock().await.emit(e),
        Err(_) => {
            let _ = app.emit(EVENT_CHANNEL, e);
        }
    }
}

fn runtime_event(name: &str, kind: RuntimeKind, summary: String, pid: Option<u32>, severity: Severity) -> Event {
    Event::new(EventKind::RuntimeChanged, summary, json!({ "runtime": kind.id(), "name": kind.name() }))
        .named(name)
        .with_source("runtime")
        .with_pid(pid)
        .with_severity(severity)
}

fn validate_settings(s: &AiEngineSettings) -> CmdResult<()> {
    if !["ollama", "lmstudio", "llamacpp", "openai"].contains(&s.local.runtime.as_str()) {
        return Err(Error::invalid(format!("unknown local runtime `{}`", s.local.runtime)));
    }
    let url = s.local.base_url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(Error::invalid("the runtime address must start with http:// or https://"));
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_settings(state: State<'_, AppState>) -> CmdResult<AiEngineSettings> {
    Ok(current(&state).await)
}

/// Saves the engines for the open project (if any) and as the application default.
#[tauri::command]
pub async fn ai_save_settings(state: State<'_, AppState>, settings: AiEngineSettings) -> CmdResult<AiEngineSettings> {
    validate_settings(&settings)?;
    let mut settings = settings;
    settings.local.base_url = settings.local.base_url.trim().trim_end_matches('/').to_string();
    settings.local.model = settings.local.model.filter(|m| !m.trim().is_empty());
    let mut app = load_app(&state);
    app.ai = settings.clone();
    save_app(&state, &app)?;
    if let Ok(orch) = state.orch().await {
        let e = orch.lock().await;
        let mut s = orch.store.settings();
        s.ai = settings.clone();
        orch.store.save_settings(s.clone())?;
        e.emit(Event::new(EventKind::ProjectChanged, "AI engines updated", json!({ "settings": s })));
    }
    Ok(settings)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub setup_at: Option<String>,
    pub skipped: bool,
}

#[tauri::command]
pub fn ai_setup_state(state: State<'_, AppState>) -> SetupState {
    let a = load_app(&state);
    SetupState { setup_at: a.setup_at, skipped: a.setup_skipped }
}

#[tauri::command]
pub fn ai_complete_setup(state: State<'_, AppState>, skipped: bool) -> CmdResult<SetupState> {
    let mut a = load_app(&state);
    a.setup_at = Some(pcc_core::now());
    a.setup_skipped = skipped;
    save_app(&state, &a)?;
    Ok(SetupState { setup_at: a.setup_at, skipped })
}

// ---------------------------------------------------------------- hardware & catalog

fn hw_cache() -> &'static StdMutex<Option<HardwareInfo>> {
    static HW: OnceLock<StdMutex<Option<HardwareInfo>>> = OnceLock::new();
    HW.get_or_init(Default::default)
}

/// Blocking. Detected once, then cached until `refresh`.
fn hardware_info(refresh: bool) -> HardwareInfo {
    let mut g = hw_cache().lock().unwrap_or_else(|e| e.into_inner());
    if refresh || g.is_none() {
        *g = Some(hardware::detect());
    }
    g.clone().unwrap_or_default()
}

#[tauri::command]
pub async fn ai_hardware(refresh: Option<bool>) -> CmdResult<HardwareInfo> {
    blocking(move || hardware_info(refresh.unwrap_or(false))).await
}

/// Installed model names on the configured runtime (empty when it is down).
fn installed_names(settings: &AiEngineSettings) -> Vec<String> {
    pcc_ai::provider_for(settings).list_models().map(|m| m.into_iter().map(|m| m.name).collect()).unwrap_or_default()
}

#[tauri::command]
pub async fn ai_recommend(state: State<'_, AppState>, refresh: Option<bool>) -> CmdResult<Recommendation> {
    let settings = current(&state).await;
    blocking(move || {
        let hw = hardware_info(refresh.unwrap_or(false));
        catalog::recommend(&hw, &installed_names(&settings))
    })
    .await
}

// ---------------------------------------------------------------- overview

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiOverview {
    pub settings: AiEngineSettings,
    pub project_open: bool,
    pub setup_at: Option<String>,
    pub setup_skipped: bool,
    pub winget: bool,
    pub runtimes: Vec<RuntimeStatus>,
    /// Models of the configured runtime.
    pub models: Vec<LocalModel>,
    pub models_error: Option<String>,
    pub capacity: LocalCapacity,
    pub models_dir: String,
    /// Models being downloaded now.
    pub pulling: Vec<String>,
}

#[tauri::command]
pub async fn ai_overview(state: State<'_, AppState>) -> CmdResult<AiOverview> {
    let settings = current(&state).await;
    let project_open = state.orch().await.is_ok();
    let app = load_app(&state);
    blocking(move || {
        let configured = RuntimeKind::parse(&settings.local.runtime).ok();
        let runtimes = RuntimeKind::ALL
            .iter()
            .map(|k| {
                let base = (Some(*k) == configured).then_some(settings.local.base_url.as_str());
                pcc_ai::manager().status(*k, base)
            })
            .collect();
        let (models, models_error) = match pcc_ai::provider_for(&settings).list_models() {
            Ok(m) => (m, None),
            Err(e) => (vec![], Some(e.to_string())),
        };
        AiOverview {
            capacity: pcc_ai::capacity(&settings),
            settings,
            project_open,
            setup_at: app.setup_at,
            setup_skipped: app.setup_skipped,
            winget: runtime::winget_available(),
            runtimes,
            models,
            models_error,
            models_dir: hardware::models_dir().display().to_string(),
            pulling: pulls().lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect(),
        }
    })
    .await
}

// ---------------------------------------------------------------- runtimes

/// The exact command NEXUS would run (shown before the user confirms).
#[tauri::command]
pub fn ai_runtime_command(runtime: String, action: String) -> CmdResult<String> {
    let kind = RuntimeKind::parse(&runtime)?;
    Ok(format!("winget {}", runtime::winget_args(kind, &action)?.join(" ")))
}

/// Install / update / uninstall through winget. Called only after the user
/// confirmed the command shown by `ai_runtime_command`.
#[tauri::command]
pub async fn ai_runtime_winget(app: AppHandle, runtime: String, action: String) -> CmdResult<String> {
    let kind = RuntimeKind::parse(&runtime)?;
    runtime::winget_args(kind, &action)?;
    if action != "install" {
        // Never pull the files from under a server NEXUS started.
        let _ = pcc_ai::manager().stop(kind);
    }
    let a = action.clone();
    let result = blocking(move || runtime::RuntimeManager::winget(kind, &a)).await?;
    let (name, verb) = match action.as_str() {
        "install" => ("runtime.installed", "installed"),
        "update" => ("runtime.updated", "updated"),
        _ => ("runtime.uninstalled", "uninstalled"),
    };
    match &result {
        Ok(_) => {
            emit(&app, runtime_event(name, kind, format!("{} {verb} (winget)", kind.name()), None, Severity::Info))
                .await
        }
        Err(e) => {
            let e = runtime_event(
                &format!("{name}_failed"),
                kind,
                format!("{} could not be {verb}: {e}", kind.name()),
                None,
                Severity::Error,
            );
            emit(&app, e).await
        }
    }
    result
}

/// Version winget would install (network).
#[tauri::command]
pub async fn ai_runtime_latest(runtime: String) -> CmdResult<Option<String>> {
    let kind = RuntimeKind::parse(&runtime)?;
    blocking(move || runtime::RuntimeManager::latest_version(kind)).await
}

fn base_for(settings: &AiEngineSettings, kind: RuntimeKind, base_url: Option<String>) -> Option<String> {
    base_url.or_else(|| (settings.local.runtime == kind.id()).then(|| settings.local.base_url.clone()))
}

#[tauri::command]
pub async fn ai_runtime_start(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: String,
    base_url: Option<String>,
    model_path: Option<String>,
) -> CmdResult<provider::Health> {
    let kind = RuntimeKind::parse(&runtime)?;
    let base = base_for(&current(&state).await, kind, base_url);
    let h = blocking(move || pcc_ai::manager().start(kind, base.as_deref(), model_path.as_deref())).await??;
    let pid = pcc_ai::manager().managed_pids().into_iter().find(|(k, _)| *k == kind).map(|(_, p)| p);
    let who = if pid.is_some() { "started by NEXUS" } else { "already running" };
    emit(&app, runtime_event("runtime.started", kind, format!("{} {who}", kind.name()), pid, Severity::Info)).await;
    Ok(h)
}

#[tauri::command]
pub async fn ai_runtime_stop(app: AppHandle, runtime: String) -> CmdResult<String> {
    let kind = RuntimeKind::parse(&runtime)?;
    let pid = pcc_ai::manager().managed_pids().into_iter().find(|(k, _)| *k == kind).map(|(_, p)| p);
    let msg = blocking(move || pcc_ai::manager().stop(kind)).await??;
    emit(&app, runtime_event("runtime.stopped", kind, msg.clone(), pid, Severity::Info)).await;
    Ok(msg)
}

#[tauri::command]
pub async fn ai_runtime_restart(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: String,
    base_url: Option<String>,
    model_path: Option<String>,
) -> CmdResult<provider::Health> {
    let kind = RuntimeKind::parse(&runtime)?;
    let base = base_for(&current(&state).await, kind, base_url);
    let h = blocking(move || pcc_ai::manager().restart(kind, base.as_deref(), model_path.as_deref())).await??;
    let pid = pcc_ai::manager().managed_pids().into_iter().find(|(k, _)| *k == kind).map(|(_, p)| p);
    emit(&app, runtime_event("runtime.started", kind, format!("{} restarted", kind.name()), pid, Severity::Info)).await;
    Ok(h)
}

// ---------------------------------------------------------------- models

#[tauri::command]
pub async fn ai_models(state: State<'_, AppState>) -> CmdResult<Vec<LocalModel>> {
    let settings = current(&state).await;
    blocking(move || pcc_ai::provider_for(&settings).list_models()).await?
}

fn pulls() -> &'static StdMutex<HashMap<String, Arc<AtomicBool>>> {
    static P: OnceLock<StdMutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PullEvent {
    model: String,
    status: String,
    completed: Option<u64>,
    total: Option<u64>,
    percent: Option<f64>,
    done: bool,
    error: Option<String>,
}

/// Disk check before a download: the catalog's verified size plus a 2 GB margin
/// must fit on the models' drive. Unknown free space refuses the download.
pub fn check_disk(model: &str, disk_free_mb: Option<u64>) -> CmdResult<u64> {
    let m = catalog::find(model).ok_or_else(|| {
        Error::invalid(format!(
            "{model} is not in the NEXUS catalog: only models with verified sizes are downloaded from here"
        ))
    })?;
    let free = disk_free_mb.ok_or_else(|| Error::invalid("free disk space unknown: download refused"))?;
    if free * 1024 * 1024 < m.size_bytes + catalog::DISK_MARGIN_BYTES {
        return Err(Error::invalid(format!(
            "not enough disk space for {model}: {:.1} GB download, {:.1} GB free (2 GB kept free)",
            m.size_bytes as f64 / 1e9,
            free as f64 / 1024.0
        )));
    }
    Ok(m.size_bytes)
}

/// Downloads a catalog model into Ollama, streaming progress on `pcc://ai-pull`.
/// Called only after the user confirmed the model and its size.
#[tauri::command]
pub async fn ai_pull_model(app: AppHandle, state: State<'_, AppState>, model: String) -> CmdResult<()> {
    let settings = current(&state).await;
    if settings.local.runtime != "ollama" {
        return Err(Error::invalid("models are downloaded through Ollama; use LM Studio's own window for LM Studio"));
    }
    // Fresh disk figure: it changes with every download.
    let hw = blocking(|| hardware_info(true)).await?;
    check_disk(&model, hw.disk_free_mb)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut p = pulls().lock().unwrap_or_else(|e| e.into_inner());
        if p.contains_key(&model) {
            return Err(Error::invalid(format!("{model} is already downloading")));
        }
        p.insert(model.clone(), cancel.clone());
    }
    let (a, m, base) = (app.clone(), model.clone(), settings.local.base_url.clone());
    let result = blocking(move || {
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut last_status = String::new();
        Ollama::new(base).pull(&m, |p: &PullProgress| {
            if p.status != last_status || last.elapsed() >= Duration::from_millis(250) || p.done {
                last = Instant::now();
                last_status = p.status.clone();
                let _ = a.emit(
                    PULL_CHANNEL,
                    PullEvent {
                        model: m.clone(),
                        status: p.status.clone(),
                        completed: p.completed,
                        total: p.total,
                        percent: p.percent(),
                        done: false,
                        error: None,
                    },
                );
            }
            !cancel.load(Ordering::SeqCst)
        })
    })
    .await?;
    pulls().lock().unwrap_or_else(|e| e.into_inner()).remove(&model);
    let kind = RuntimeKind::Ollama;
    let done = PullEvent {
        model: model.clone(),
        status: if result.is_ok() { "success".into() } else { "failed".into() },
        completed: None,
        total: None,
        percent: result.is_ok().then_some(100.0),
        done: true,
        error: result.as_ref().err().map(|e| e.to_string()),
    };
    let _ = app.emit(PULL_CHANNEL, done);
    match &result {
        Ok(()) => {
            emit(
                &app,
                runtime_event(
                    "runtime.model_installed",
                    kind,
                    format!("Model {model} installed"),
                    None,
                    Severity::Info,
                ),
            )
            .await
        }
        Err(e) => {
            let e = runtime_event(
                "runtime.model_failed",
                kind,
                format!("Model {model} not installed: {e}"),
                None,
                Severity::Warning,
            );
            emit(&app, e).await
        }
    }
    result
}

#[tauri::command]
pub fn ai_cancel_pull(model: String) -> bool {
    match pulls().lock().unwrap_or_else(|e| e.into_inner()).get(&model) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Deletes an installed Ollama model (after the user confirmed).
#[tauri::command]
pub async fn ai_delete_model(app: AppHandle, state: State<'_, AppState>, model: String) -> CmdResult<()> {
    let settings = current(&state).await;
    if settings.local.runtime != "ollama" {
        return Err(Error::invalid("only Ollama models can be deleted from NEXUS"));
    }
    let (m, base) = (model.clone(), settings.local.base_url.clone());
    blocking(move || Ollama::new(base).delete(&m)).await??;
    let e = runtime_event(
        "runtime.model_deleted",
        RuntimeKind::Ollama,
        format!("Model {model} deleted"),
        None,
        Severity::Info,
    );
    emit(&app, e).await;
    Ok(())
}

#[tauri::command]
pub async fn ai_load_model(state: State<'_, AppState>, model: String, load: bool) -> CmdResult<()> {
    let settings = current(&state).await;
    blocking(move || {
        let p = pcc_ai::provider_for(&settings);
        if load {
            p.load_model(&model)
        } else {
            p.unload_model(&model)
        }
    })
    .await?
}

#[tauri::command]
pub async fn ai_benchmark(state: State<'_, AppState>, model: String) -> CmdResult<Benchmark> {
    let settings = current(&state).await;
    blocking(move || runtime::benchmark(pcc_ai::provider_for(&settings).as_ref(), &model)).await?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub model: String,
    pub benchmark: Benchmark,
    pub capabilities: Option<Vec<String>>,
    /// Tool calling: NEXUS agents can run on it.
    pub tools: bool,
    /// The runtime serves the Anthropic Messages API (Claude Code can use it).
    pub anthropic_api: bool,
    pub notes: Vec<String>,
}

/// Real check of a model: one tiny generation (also the benchmark), its
/// capabilities and whether Claude Code agents can use it.
#[tauri::command]
pub async fn ai_validate(state: State<'_, AppState>, model: String) -> CmdResult<Validation> {
    let settings = current(&state).await;
    blocking(move || {
        let p = pcc_ai::provider_for(&settings);
        let benchmark = runtime::benchmark(p.as_ref(), &model)?;
        let capabilities =
            p.list_models().ok().and_then(|ms| ms.into_iter().find(|m| m.name == model).and_then(|m| m.capabilities));
        let tools = match &capabilities {
            Some(c) => c.iter().any(|c| c == "tools"),
            None => catalog::find(&model).is_some_and(|m| m.tools),
        };
        let anthropic_api = settings.local.runtime == "ollama" && provider::supports_anthropic_messages(p.base_url());
        let mut notes = Vec::new();
        if !tools {
            notes.push(format!("{model} has no tool calling: fine for AI Town dialogue, not for NEXUS agents."));
        }
        if !anthropic_api {
            notes.push(
                "This runtime does not serve the Anthropic API: agents cannot run on it through Claude Code.".into(),
            );
        }
        Ok(Validation { model, benchmark, capabilities, tools, anthropic_api, notes })
    })
    .await?
}

// ---------------------------------------------------------------- router

#[tauri::command]
pub async fn ai_route_preview(state: State<'_, AppState>, request: RouteRequest) -> CmdResult<RouteDecision> {
    let settings = current(&state).await;
    blocking(move || router::route(settings.mode, &request, &pcc_ai::capacity(&settings))).await
}

#[tauri::command]
pub async fn ai_routing_journal(state: State<'_, AppState>, limit: Option<usize>) -> CmdResult<Vec<JournalEntry>> {
    let j = journal(&state).await;
    blocking(move || j.recent(limit.unwrap_or(100).min(1000))).await
}

/// The "Local AI unavailable" actions: `retry`, `restart` (the runtime) or
/// `switch_to_claude` (Central, workers and AI work back on Claude).
#[tauri::command]
pub async fn ai_fallback(app: AppHandle, state: State<'_, AppState>, action: String) -> CmdResult<LocalCapacity> {
    let mut settings = current(&state).await;
    match action.as_str() {
        "retry" => {}
        "restart" => {
            let kind = RuntimeKind::parse(&settings.local.runtime)?;
            let base = settings.local.base_url.clone();
            blocking(move || pcc_ai::manager().restart(kind, Some(&base), None)).await??;
            let pid = pcc_ai::manager().managed_pids().into_iter().find(|(k, _)| *k == kind).map(|(_, p)| p);
            emit(
                &app,
                runtime_event("runtime.started", kind, format!("{} restarted", kind.name()), pid, Severity::Info),
            )
            .await;
        }
        "switch_to_claude" => {
            settings.mode = AiMode::Claude;
            settings.central = EngineProvider::Claude;
            settings.workers = EngineProvider::Claude;
            let saved = ai_save_settings(app.state::<AppState>(), settings.clone()).await?;
            let d = RouteDecision {
                provider: router::Route::Claude,
                model: None,
                reason: "switched to Claude by the user (Local AI unavailable)".into(),
                rule: "user-switch-to-claude".into(),
            };
            let j = journal(&state).await;
            j.record("user", saved.mode, &RouteRequest::default(), &d);
            let e = Event::new(EventKind::RuntimeChanged, "Switched to Claude: local AI unavailable", json!(saved))
                .named("runtime.fallback")
                .with_source("runtime")
                .with_severity(Severity::Warning);
            emit(&app, e).await;
            settings = saved;
        }
        other => return Err(Error::invalid(format!("unknown action `{other}`"))),
    }
    blocking(move || pcc_ai::capacity(&settings)).await
}

// ---------------------------------------------------------------- AI Town townspeople

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TownLocalStatus {
    pub readiness: TownspeopleReadiness,
    /// AI Town runs for the open project.
    pub ai_town_running: bool,
    /// `{count, max, names}` from the world, when AI Town runs.
    pub townspeople: Option<Value>,
    pub error: Option<String>,
}

async fn town_target(state: &AppState) -> Option<(pcc_world::aitown::ConvexClient, String)> {
    let guard = state.project.read().await;
    let p = guard.as_ref()?;
    let t = p.ai_town_target.lock().await.clone();
    t
}

#[tauri::command]
pub async fn ai_town_local_status(state: State<'_, AppState>) -> CmdResult<TownLocalStatus> {
    let settings = current(&state).await;
    let target = town_target(&state).await;
    blocking(move || {
        let readiness = pcc_ai::townspeople_readiness(&settings, &pcc_ai::capacity(&settings));
        let (townspeople, error) = match &target {
            Some((c, w)) => match c.query("nexusTownspeople:status", json!({ "worldId": w })) {
                Ok(v) => (Some(v), None),
                Err(e) => (None, Some(e.to_string())),
            },
            None => (None, None),
        };
        TownLocalStatus { readiness, ai_town_running: target.is_some(), townspeople, error }
    })
    .await
}

/// Points AI Town's LLM at the local runtime and adds `count` townspeople.
/// Refused unless the chat and embedding models are installed and answering.
#[tauri::command]
pub async fn ai_town_add_townspeople(app: AppHandle, state: State<'_, AppState>, count: u32) -> CmdResult<Value> {
    let settings = current(&state).await;
    let (client, world) =
        town_target(&state).await.ok_or_else(|| Error::invalid("start AI Town for this project first (AI World)"))?;
    let s = settings.clone();
    let readiness = blocking(move || pcc_ai::townspeople_readiness(&s, &pcc_ai::capacity(&s))).await?;
    if !readiness.ready {
        return Err(Error::invalid(format!("Local AI unavailable for townspeople: {}", readiness.reasons.join("; "))));
    }
    let shared = crate::aitown_commands::runtime_of(&app, &state).await;
    let env = readiness.env.clone();
    crate::aitown_commands::with_runtime(shared, move |r| r.set_env(&env)).await??;
    let req = RouteRequest { task: TaskKind::NpcDialogue, ..Default::default() };
    let cap = blocking(move || pcc_ai::capacity(&settings)).await?;
    let d = router::route(AiMode::Local, &req, &cap);
    journal(&state).await.record("ai-town-townspeople", AiMode::Local, &req, &d);
    let created =
        blocking(move || client.mutation("nexusTownspeople:add", json!({ "worldId": world, "count": count.min(17) })))
            .await??;
    let e = Event::new(
        EventKind::RuntimeChanged,
        format!(
            "AI Town townspeople on local AI ({}): {} added",
            readiness.chat_model.as_deref().unwrap_or("?"),
            created["created"].as_u64().unwrap_or(0)
        ),
        created.clone(),
    )
    .named("runtime.townspeople_added")
    .with_source("runtime");
    emit(&app, e).await;
    Ok(created)
}

#[tauri::command]
pub async fn ai_town_remove_townspeople(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let (client, world) = town_target(&state).await.ok_or_else(|| Error::invalid("AI Town is not running"))?;
    blocking(move || client.mutation("nexusTownspeople:remove", json!({ "worldId": world }))).await??;
    let e = Event::new(EventKind::RuntimeChanged, "AI Town townspeople removed", Value::Null)
        .named("runtime.townspeople_removed")
        .with_source("runtime");
    emit(&app, e).await;
    Ok(())
}

// ---------------------------------------------------------------- monitor

/// Watches the runtimes NEXUS started: a crash is journaled
/// (`runtime.crashed`) and, with the `restart` fallback policy, the runtime is
/// restarted once per crash. Healthy runtimes heartbeat the process registry.
pub fn spawn_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let exits = blocking(|| pcc_ai::manager().take_exits()).await.unwrap_or_default();
            for x in exits {
                let summary = format!(
                    "{} crashed (pid {}, exit code {})",
                    x.kind.name(),
                    x.pid,
                    x.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
                );
                tracing::warn!("{summary}");
                emit(&app, runtime_event("runtime.crashed", x.kind, summary, Some(x.pid), Severity::Error)).await;
                let settings = current(&app.state::<AppState>()).await;
                if settings.fallback != FallbackPolicy::Restart || settings.local.runtime != x.kind.id() {
                    continue;
                }
                let (kind, base) = (x.kind, settings.local.base_url.clone());
                let r = blocking(move || pcc_ai::manager().restart(kind, Some(&base), None)).await;
                let e = match r {
                    Ok(Ok(_)) => {
                        let pid =
                            pcc_ai::manager().managed_pids().into_iter().find(|(k, _)| *k == kind).map(|(_, p)| p);
                        runtime_event(
                            "runtime.started",
                            kind,
                            format!("{} restarted after a crash", kind.name()),
                            pid,
                            Severity::Warning,
                        )
                    }
                    Ok(Err(err)) => runtime_event(
                        "runtime.restart_failed",
                        kind,
                        format!("{} could not be restarted: {err}", kind.name()),
                        None,
                        Severity::Error,
                    ),
                    Err(_) => continue,
                };
                emit(&app, e).await;
            }
            let settings = current(&app.state::<AppState>()).await;
            let _ = blocking(move || {
                for (kind, _) in pcc_ai::manager().managed_pids() {
                    let key = runtime::registry_key(kind);
                    let h =
                        runtime::RuntimeManager::provider(kind, base_for(&settings, kind, None).as_deref()).health();
                    if h.ok {
                        pcc_recovery::app().heartbeat(&key, "health check", None);
                    } else {
                        pcc_recovery::app().set_state(&key, pcc_recovery::ProcessState::Unresponsive, h.error);
                    }
                }
            })
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_need_disk_space_and_a_catalog_model() {
        // qwen3:8b is 5.2 GB: 15 GB free is enough, 6 GB is not (2 GB margin).
        assert!(check_disk("qwen3:8b", Some(15 * 1024)).is_ok());
        let err = check_disk("qwen3:8b", Some(6 * 1024)).unwrap_err().to_string();
        assert!(err.contains("not enough disk space"), "{err}");
        assert!(check_disk("qwen3:8b", None).is_err());
        assert!(check_disk("some/unknown:70b", Some(1_000_000)).unwrap_err().to_string().contains("catalog"));
    }
}
