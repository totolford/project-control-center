//! Renderer health: heartbeats from the UI, the renderer watchdog, renderer
//! incidents (crash history) and machine resources for the Diagnostics page.
//!
//! The UI is a client of the Control Center that lives in this process: when
//! the webview freezes or goes black, the watchdog reloads it (and, if that does
//! not help, recreates the main window). Missions, agents, MCP, Claude Code
//! sessions and AI Town are never touched by any of this.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use pcc_core::{AgentStatus, ConnectionKind, ConnectionStatus, Error, Event, EventKind, MissionStatus, Severity};

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

/// Watchdog notices for the UI (`{ kind: "ui.rendererRecovered", incident }`).
pub const HEALTH_CHANNEL: &str = "pcc://health";
/// Label of the window the watchdog looks after.
pub const MAIN_WINDOW: &str = "main";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

// ---------------------------------------------------------------- watchdog decision (pure)

/// No heartbeat yet: the first page load (and Vite in dev) may take a while.
pub const STARTUP_GRACE: Duration = Duration::from_secs(90);
/// A visible page that has not beaten for this long is considered frozen.
pub const STALE_VISIBLE: Duration = Duration::from_secs(25);
/// Hidden/occluded pages have their timers throttled (down to once a minute).
pub const STALE_HIDDEN: Duration = Duration::from_secs(300);
/// After an action, time given to the new page to beat before the next step.
pub const ACTION_COOLDOWN: Duration = Duration::from_secs(45);
/// Reloads tried before recreating the window.
pub const MAX_RELOADS: u32 = 2;
/// Window recreations tried before giving up (until the page beats again).
pub const MAX_RECREATES: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WatchInput {
    /// Time since the last heartbeat; `None` when the page never beat.
    pub since_beat: Option<Duration>,
    /// Time since the watchdog started.
    pub uptime: Duration,
    /// The last report said `document.visibilityState === "hidden"`.
    pub page_hidden: bool,
    /// The window is minimized or not shown (its webview is throttled).
    pub window_hidden: bool,
    /// Recovery actions taken since the last heartbeat.
    pub attempts: u32,
    /// Time since the last recovery action.
    pub since_action: Option<Duration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchAction {
    Wait,
    Reload,
    Recreate,
    /// Every step failed: record it once and wait for the page to come back.
    GiveUp,
}

pub fn decide(i: WatchInput) -> WatchAction {
    if i.window_hidden {
        return WatchAction::Wait;
    }
    let silent = match i.since_beat {
        Some(d) => d,
        None if i.uptime < STARTUP_GRACE => return WatchAction::Wait,
        None => i.uptime,
    };
    let limit = if i.page_hidden { STALE_HIDDEN } else { STALE_VISIBLE };
    if silent < limit || i.since_action.is_some_and(|d| d < ACTION_COOLDOWN) {
        return WatchAction::Wait;
    }
    match i.attempts {
        n if n < MAX_RELOADS => WatchAction::Reload,
        n if n < MAX_RELOADS + MAX_RECREATES => WatchAction::Recreate,
        n if n == MAX_RELOADS + MAX_RECREATES => WatchAction::GiveUp,
        _ => WatchAction::Wait,
    }
}

// ---------------------------------------------------------------- reports

/// What the renderer health monitor sends with each heartbeat.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RendererReport {
    /// `ok`, `degraded` or `recovering`.
    pub status: String,
    pub visible: bool,
    pub render_errors: u32,
    pub window_errors: u32,
    pub rejections: u32,
    pub stalls: u32,
    pub longest_stall_ms: u64,
    pub invoke_calls: u64,
    pub invoke_errors: u64,
    pub heartbeat_failures: u32,
    pub ai_world_errors: u32,
    pub js_heap_used: Option<u64>,
    pub js_heap_limit: Option<u64>,
    pub last_error: Option<String>,
    pub view: Option<String>,
}

/// What was running when the interface had to be recovered (and still is).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub project_open: bool,
    pub project_name: Option<String>,
    pub running_agents: usize,
    pub working_agents: usize,
    pub active_mission: Option<String>,
    pub active_missions: usize,
    pub mcp_connected: usize,
    pub mcp_total: usize,
    /// `None` when the AI Town runtime is busy (being started/stopped) or never used.
    pub ai_town_running: Option<bool>,
    pub terminals: usize,
}

/// One entry of the renderer crash history.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RendererIncident {
    pub id: String,
    pub ts: String,
    /// `frozen` (no heartbeat), `degraded` (UI asked), `manual`, `viewCrash`, `gaveUp`.
    pub kind: String,
    /// `reload`, `recreate` or `none`.
    pub action: String,
    pub reason: String,
    /// `pending`, `recovered`, `failed` or `recorded` (nothing to recover).
    pub outcome: String,
    pub recovered_at: Option<String>,
    pub downtime_ms: Option<u64>,
    pub report: Option<RendererReport>,
    pub preserved: Option<CoreStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatAck {
    pub watchdog: bool,
    /// Set once, on the first heartbeat after a recovery.
    pub recovered: Option<RendererIncident>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogStatus {
    pub enabled: bool,
    pub uptime_secs: u64,
    pub heartbeats: u64,
    pub last_beat_ms_ago: Option<u64>,
    pub attempts: u32,
    pub recoveries: u32,
    pub last_report: Option<RendererReport>,
    pub pending: Option<RendererIncident>,
}

// ---------------------------------------------------------------- monitor state

struct Pending {
    incident: RendererIncident,
    at: Instant,
}

#[derive(Default)]
struct Inner {
    last_beat: Option<Instant>,
    heartbeats: u64,
    last_report: Option<RendererReport>,
    attempts: u32,
    last_action: Option<Instant>,
    pending: Option<Pending>,
    recoveries: u32,
}

/// Managed by Tauri (`app.state::<HealthMonitor>()`).
pub struct HealthMonitor {
    inner: Mutex<Inner>,
    started: Instant,
    enabled: bool,
    file: PathBuf,
    /// The main window is being recreated: the run loop must not exit when it closes.
    pub recreating: std::sync::atomic::AtomicBool,
    sys: Mutex<Option<sysinfo::System>>,
}

const MAX_INCIDENTS: usize = 200;

impl HealthMonitor {
    pub fn new(data_dir: &std::path::Path) -> Self {
        let enabled = !matches!(
            std::env::var("NEXUS_RENDERER_WATCHDOG").as_deref().map(str::to_ascii_lowercase).as_deref(),
            Ok("off" | "0" | "false")
        );
        HealthMonitor {
            inner: Mutex::new(Inner::default()),
            started: Instant::now(),
            enabled,
            file: data_dir.join("diagnostics").join("renderer-incidents.jsonl"),
            recreating: Default::default(),
            sys: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn incidents(&self, limit: usize) -> Vec<RendererIncident> {
        let text = std::fs::read_to_string(&self.file).unwrap_or_default();
        let mut v: Vec<RendererIncident> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        // Later lines update earlier ones (same id): keep the last version of each.
        let mut seen = std::collections::HashSet::new();
        v.reverse();
        v.retain(|i| seen.insert(i.id.clone()));
        v.truncate(limit);
        v
    }

    fn append(&self, incident: &RendererIncident) {
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.file)?;
            writeln!(f, "{}", serde_json::to_string(incident).unwrap_or_default())?;
            Ok(())
        };
        if let Err(e) = write() {
            tracing::warn!("cannot record the renderer incident: {e}");
            return;
        }
        // Compact occasionally so the file stays small.
        if std::fs::metadata(&self.file).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
            let mut keep = self.incidents(MAX_INCIDENTS);
            keep.reverse();
            let text: String = keep.iter().filter_map(|i| serde_json::to_string(i).ok()).map(|l| l + "\n").collect();
            let _ = std::fs::write(&self.file, text);
        }
    }

    fn input(&self, window_hidden: bool) -> WatchInput {
        let now = Instant::now();
        let s = self.lock();
        WatchInput {
            since_beat: s.last_beat.map(|t| now - t),
            uptime: now - self.started,
            page_hidden: s.last_report.as_ref().is_some_and(|r| !r.visible),
            window_hidden,
            attempts: s.attempts,
            since_action: s.last_action.map(|t| now - t),
        }
    }

    /// Records a recovery action (the incident stays pending until the page beats again).
    fn begin(&self, kind: &str, action: &str, reason: String, preserved: Option<CoreStatus>) -> RendererIncident {
        let mut s = self.lock();
        s.attempts += 1;
        s.last_action = Some(Instant::now());
        let report = s.last_report.take();
        let incident = match s.pending.as_mut() {
            // Further steps of the same incident (reload, then recreate).
            Some(p) => {
                p.incident.action = action.to_string();
                p.incident.reason = format!("{}; then: {reason}", p.incident.reason);
                p.incident.clone()
            }
            None => {
                let ts = pcc_core::now();
                let incident = RendererIncident {
                    id: format!("renderer-{}", chrono::Utc::now().timestamp_millis()),
                    ts,
                    kind: kind.to_string(),
                    action: action.to_string(),
                    reason,
                    outcome: "pending".into(),
                    report,
                    preserved,
                    ..Default::default()
                };
                s.pending = Some(Pending { incident: incident.clone(), at: Instant::now() });
                incident
            }
        };
        drop(s);
        self.append(&incident);
        incident
    }

    /// A heartbeat: resets the watchdog, closes a pending incident as recovered.
    fn beat(&self, report: RendererReport) -> Option<RendererIncident> {
        let mut s = self.lock();
        s.last_beat = Some(Instant::now());
        s.heartbeats += 1;
        s.last_report = Some(report);
        s.attempts = 0;
        let p = s.pending.take()?;
        s.recoveries += 1;
        drop(s);
        let mut incident = p.incident;
        incident.outcome = "recovered".into();
        incident.recovered_at = Some(pcc_core::now());
        incident.downtime_ms = Some(p.at.elapsed().as_millis() as u64);
        self.append(&incident);
        Some(incident)
    }

    fn status(&self) -> WatchdogStatus {
        let s = self.lock();
        WatchdogStatus {
            enabled: self.enabled,
            uptime_secs: self.started.elapsed().as_secs(),
            heartbeats: s.heartbeats,
            last_beat_ms_ago: s.last_beat.map(|t| t.elapsed().as_millis() as u64),
            attempts: s.attempts,
            recoveries: s.recoveries,
            last_report: s.last_report.clone(),
            pending: s.pending.as_ref().map(|p| p.incident.clone()),
        }
    }
}

// ---------------------------------------------------------------- core status

pub async fn core_status_of(state: &AppState) -> CoreStatus {
    let mut status = CoreStatus { terminals: state.pty.list().len(), ..Default::default() };
    if let Ok(mut guard) = state.ai_town.try_lock() {
        status.ai_town_running = guard.as_mut().map(|rt| rt.is_running());
    }
    let Ok(orch) = state.orch().await else { return status };
    status.project_open = true;
    status.project_name = Some(orch.store.info().name.clone());
    if let Ok(agents) = orch.store.list_agents() {
        status.running_agents = agents.iter().filter(|a| a.status.is_live()).count();
        status.working_agents = agents.iter().filter(|a| a.status == AgentStatus::Working).count();
    }
    if let Ok(missions) = orch.store.list_missions() {
        let active: Vec<_> = missions
            .iter()
            .filter(|m| matches!(m.mission.status, MissionStatus::Active | MissionStatus::Planning))
            .collect();
        status.active_missions = active.len();
        status.active_mission = active.first().map(|m| m.mission.title.clone());
    }
    if let Ok(conns) = orch.store.list_connections() {
        let mcp: Vec<_> =
            conns.iter().filter(|c| matches!(c.kind, ConnectionKind::Mcp | ConnectionKind::RobloxStudio)).collect();
        status.mcp_total = mcp.len();
        status.mcp_connected = mcp.iter().filter(|c| c.status == ConnectionStatus::Connected).count();
    }
    status
}

/// Writes an application notice to the open project's journal (Activity), if any.
fn journal(app: &AppHandle, name: &'static str, severity: Severity, summary: String, incident: &RendererIncident) {
    let app = app.clone();
    let payload = serde_json::to_value(incident).unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let Ok(orch) = app.state::<AppState>().orch().await else { return };
        let e =
            Event::new(EventKind::SystemNotice, summary, payload).named(name).with_severity(severity).with_source("ui");
        orch.lock().await.emit(e);
    });
}

// ---------------------------------------------------------------- watchdog loop

fn main_window_hidden(app: &AppHandle) -> Option<bool> {
    let w = app.get_webview_window(MAIN_WINDOW)?;
    Some(w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true))
}

fn reload_main(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window(MAIN_WINDOW) else { return false };
    match w.reload() {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("renderer reload failed ({e}); trying location.reload()");
            w.eval("location.reload()").is_ok()
        }
    }
}

/// Destroys the main window and builds a new one from the configuration. The
/// run loop is told not to exit while the window is gone.
async fn recreate_main(app: &AppHandle) -> Result<(), String> {
    let health = app.state::<HealthMonitor>();
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
        .ok_or("no main window in the configuration")?;
    health.recreating.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        w.destroy().map_err(|e| e.to_string())?;
        for _ in 0..50 {
            if app.get_webview_window(MAIN_WINDOW).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    let built = tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build());
    // Exit requests during the gap are over once the new window exists.
    tokio::time::sleep(Duration::from_secs(2)).await;
    health.recreating.store(false, std::sync::atomic::Ordering::SeqCst);
    built.map(|_| ()).map_err(|e| e.to_string())
}

/// Checks the renderer every few seconds; never touches the engine.
pub fn spawn_watchdog(app: AppHandle) {
    if !app.state::<HealthMonitor>().enabled {
        tracing::info!("renderer watchdog disabled (NEXUS_RENDERER_WATCHDOG)");
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            let health = app.state::<HealthMonitor>();
            let hidden = main_window_hidden(&app);
            // No main window at all (destroyed by a failed recreation): treat as frozen.
            let input = health.input(hidden.unwrap_or(false));
            let action = decide(input);
            if action == WatchAction::Wait {
                continue;
            }
            let silent = input.since_beat.map(|d| d.as_secs()).unwrap_or(input.uptime.as_secs());
            let preserved = Some(core_status_of(&app.state::<AppState>()).await);
            let reason = format!("no heartbeat from the interface for {silent}s");
            match action {
                WatchAction::Reload => {
                    tracing::warn!("renderer frozen: {reason}; reloading the interface");
                    health.begin("frozen", "reload", reason, preserved);
                    if hidden.is_none() || !reload_main(&app) {
                        if let Err(e) = recreate_main(&app).await {
                            tracing::error!("cannot recreate the main window: {e}");
                        }
                    }
                }
                WatchAction::Recreate => {
                    tracing::warn!("renderer still frozen after reloads: {reason}; recreating the main window");
                    health.begin("frozen", "recreate", reason, preserved);
                    if let Err(e) = recreate_main(&app).await {
                        tracing::error!("cannot recreate the main window: {e}");
                    }
                }
                WatchAction::GiveUp => {
                    tracing::error!("renderer did not come back after reloads and a new window; waiting");
                    let mut incident =
                        health.begin("frozen", "none", format!("{reason}; automatic recovery exhausted"), preserved);
                    incident.outcome = "failed".into();
                    health.append(&incident);
                    let summary =
                        "Interface unresponsive: automatic recovery exhausted (the engine keeps running)".to_string();
                    journal(&app, "ui.rendererUnresponsive", Severity::Critical, summary, &incident);
                }
                WatchAction::Wait => {}
            }
        }
    });
}

// ---------------------------------------------------------------- resources

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub utilization_pct: Option<f32>,
    pub vram_used_mb: Option<u64>,
    pub vram_total_mb: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub memory_bytes: u64,
    pub cpu_pct: f32,
    pub depth: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub cpu_pct: f32,
    pub cpu_cores: usize,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
    /// NEXUS and every process it started (agents, MCP servers, terminals, AI Town...).
    pub processes: Vec<ProcInfo>,
    pub gpus: Vec<GpuInfo>,
    /// Why GPU load/VRAM is not shown, when it is not.
    pub gpu_unavailable: Option<String>,
}

/// Parses `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`.
pub fn parse_nvidia_smi(out: &str) -> Vec<GpuInfo> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            if f.len() < 4 || f[0].is_empty() {
                return None;
            }
            Some(GpuInfo {
                name: f[0].to_string(),
                utilization_pct: f[1].parse().ok(),
                vram_used_mb: f[2].parse().ok(),
                vram_total_mb: f[3].parse().ok(),
            })
        })
        .collect()
}

fn nvidia_gpus() -> Result<Vec<GpuInfo>, String> {
    let out = pcc_claude::process::std_command("nvidia-smi")
        .args(["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"])
        .output()
        .map_err(|_| {
            "nvidia-smi not found: GPU load and VRAM can only be read on NVIDIA GPUs with their driver tools"
                .to_string()
        })?;
    if !out.status.success() {
        return Err(format!("nvidia-smi failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let gpus = parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout));
    if gpus.is_empty() {
        return Err("nvidia-smi reported no GPU".into());
    }
    Ok(gpus)
}

/// Orders `procs` as a tree under `root` (depth-first), dropping unrelated processes.
pub fn descendants(root: u32, procs: &[ProcInfo]) -> Vec<ProcInfo> {
    let mut out = Vec::new();
    let mut stack: VecDeque<(u32, usize)> = VecDeque::from([(root, 0)]);
    let mut seen = std::collections::HashSet::new();
    while let Some((pid, depth)) = stack.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(p) = procs.iter().find(|p| p.pid == pid) {
            out.push(ProcInfo { depth, ..p.clone() });
        } else if depth == 0 {
            return out;
        }
        let mut children: Vec<&ProcInfo> = procs.iter().filter(|p| p.parent == Some(pid) && p.pid != pid).collect();
        children.sort_by_key(|p| std::cmp::Reverse(p.pid));
        for c in children {
            stack.push_front((c.pid, depth + 1));
        }
    }
    out
}

fn resources(health: &HealthMonitor) -> Resources {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut guard = health.sys.lock().unwrap_or_else(|e| e.into_inner());
    let first = guard.is_none();
    let sys = guard.get_or_insert_with(System::new);
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    if first {
        // CPU usage is a difference between two samples.
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        sys.refresh_cpu_usage();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu());
    }
    let all: Vec<ProcInfo> = sys
        .processes()
        .values()
        .map(|p| ProcInfo {
            pid: p.pid().as_u32(),
            parent: p.parent().map(|x| x.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            memory_bytes: p.memory(),
            cpu_pct: p.cpu_usage(),
            depth: 0,
        })
        .collect();
    let (gpus, gpu_unavailable) = match nvidia_gpus() {
        Ok(g) => (g, None),
        Err(e) => (vec![], Some(e)),
    };
    Resources {
        cpu_pct: sys.global_cpu_usage(),
        cpu_cores: sys.cpus().len(),
        memory_total_bytes: sys.total_memory(),
        memory_used_bytes: sys.used_memory(),
        processes: descendants(std::process::id(), &all),
        gpus,
        gpu_unavailable,
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn renderer_heartbeat(
    app: AppHandle,
    health: State<'_, HealthMonitor>,
    report: RendererReport,
) -> CmdResult<HeartbeatAck> {
    let recovered = health.beat(report);
    if let Some(incident) = &recovered {
        tracing::info!("interface recovered after {} ({})", incident.action, incident.reason);
        let _ = app.emit(HEALTH_CHANNEL, serde_json::json!({ "kind": "ui.rendererRecovered", "incident": incident }));
        let summary = format!("Interface recovered ({}): {}", incident.action, incident.reason);
        journal(&app, "ui.rendererRecovered", Severity::Warning, summary, incident);
    }
    Ok(HeartbeatAck { watchdog: health.enabled, recovered })
}

/// What keeps running regardless of the interface (for the Safe Recovery Overlay).
#[tauri::command]
pub async fn core_status(state: State<'_, AppState>) -> CmdResult<CoreStatus> {
    Ok(core_status_of(&state).await)
}

/// The interface asks to be reloaded (degraded, or "Reload interface"). The
/// incident is closed by the first heartbeat of the new page.
#[tauri::command]
pub async fn renderer_reload(
    app: AppHandle,
    state: State<'_, AppState>,
    health: State<'_, HealthMonitor>,
    kind: String,
    reason: String,
    report: Option<RendererReport>,
) -> CmdResult<()> {
    if let Some(r) = report {
        health.lock().last_report = Some(r);
    }
    let preserved = Some(core_status_of(&state).await);
    let kind = if kind == "manual" { "manual" } else { "degraded" };
    health.begin(kind, "reload", reason, preserved);
    if !reload_main(&app) {
        return Err(Error::Process("the main window cannot be reloaded".into()));
    }
    Ok(())
}

/// A view crashed and was contained by an error boundary: history only.
#[tauri::command]
pub async fn record_renderer_incident(
    app: AppHandle,
    health: State<'_, HealthMonitor>,
    kind: String,
    reason: String,
    report: Option<RendererReport>,
) -> CmdResult<RendererIncident> {
    let incident = RendererIncident {
        id: format!("renderer-{}", chrono::Utc::now().timestamp_millis()),
        ts: pcc_core::now(),
        kind,
        action: "none".into(),
        reason: reason.chars().take(2000).collect(),
        outcome: "recorded".into(),
        report,
        ..Default::default()
    };
    health.append(&incident);
    let summary = format!("Interface view crashed and was contained: {}", incident.reason.lines().next().unwrap_or(""));
    journal(&app, "ui.viewCrashed", Severity::Error, summary, &incident);
    Ok(incident)
}

#[tauri::command]
pub async fn renderer_incidents(
    health: State<'_, HealthMonitor>,
    limit: Option<usize>,
) -> CmdResult<Vec<RendererIncident>> {
    Ok(health.incidents(limit.unwrap_or(50).min(MAX_INCIDENTS)))
}

#[tauri::command]
pub async fn watchdog_status(health: State<'_, HealthMonitor>) -> CmdResult<WatchdogStatus> {
    Ok(health.status())
}

#[tauri::command]
pub async fn diagnostics_resources(app: AppHandle) -> CmdResult<Resources> {
    blocking(move || resources(&app.state::<HealthMonitor>())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn waits_during_startup_and_while_beating() {
        let i = WatchInput { since_beat: None, uptime: secs(30), ..Default::default() };
        assert_eq!(decide(i), WatchAction::Wait);
        let i = WatchInput { since_beat: Some(secs(5)), uptime: secs(600), ..Default::default() };
        assert_eq!(decide(i), WatchAction::Wait);
    }

    #[test]
    fn never_loaded_page_is_reloaded_after_grace() {
        let i = WatchInput { since_beat: None, uptime: secs(120), ..Default::default() };
        assert_eq!(decide(i), WatchAction::Reload);
    }

    #[test]
    fn frozen_visible_page_escalates_reload_recreate_give_up() {
        let base = WatchInput { since_beat: Some(secs(40)), uptime: secs(600), ..Default::default() };
        assert_eq!(decide(base), WatchAction::Reload);
        let after = |attempts| WatchInput { attempts, since_action: Some(secs(60)), ..base };
        assert_eq!(decide(after(1)), WatchAction::Reload);
        assert_eq!(decide(after(2)), WatchAction::Recreate);
        assert_eq!(decide(after(3)), WatchAction::GiveUp);
        assert_eq!(decide(after(4)), WatchAction::Wait);
    }

    #[test]
    fn gives_a_reloaded_page_time_to_come_back() {
        let i = WatchInput {
            since_beat: Some(secs(60)),
            uptime: secs(600),
            attempts: 1,
            since_action: Some(secs(10)),
            ..Default::default()
        };
        assert_eq!(decide(i), WatchAction::Wait);
    }

    #[test]
    fn hidden_pages_and_minimized_windows_are_throttled_not_frozen() {
        let hidden =
            WatchInput { since_beat: Some(secs(120)), uptime: secs(600), page_hidden: true, ..Default::default() };
        assert_eq!(decide(hidden), WatchAction::Wait);
        assert_eq!(decide(WatchInput { since_beat: Some(secs(400)), ..hidden }), WatchAction::Reload);
        let minimized =
            WatchInput { since_beat: Some(secs(4000)), uptime: secs(9000), window_hidden: true, ..Default::default() };
        assert_eq!(decide(minimized), WatchAction::Wait);
    }

    #[test]
    fn monitor_closes_pending_incident_on_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let m = HealthMonitor::new(dir.path());
        let first = m.begin("frozen", "reload", "no heartbeat for 30s".into(), None);
        let second = m.begin("frozen", "recreate", "still frozen".into(), None);
        assert_eq!(first.id, second.id);
        assert_eq!(m.status().attempts, 2);
        let recovered = m.beat(RendererReport { status: "ok".into(), visible: true, ..Default::default() }).unwrap();
        assert_eq!(recovered.outcome, "recovered");
        assert_eq!(recovered.action, "recreate");
        assert!(m.beat(RendererReport::default()).is_none());
        let history = m.incidents(10);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].outcome, "recovered");
        assert_eq!(m.status().attempts, 0);
        assert_eq!(m.status().recoveries, 1);
    }

    #[test]
    fn parses_nvidia_smi_csv() {
        let gpus = parse_nvidia_smi("NVIDIA GeForce RTX 4070, 12, 2048, 12282\n\n");
        assert_eq!(
            gpus,
            vec![GpuInfo {
                name: "NVIDIA GeForce RTX 4070".into(),
                utilization_pct: Some(12.0),
                vram_used_mb: Some(2048),
                vram_total_mb: Some(12282)
            }]
        );
        assert!(parse_nvidia_smi("garbage").is_empty());
        assert_eq!(parse_nvidia_smi("GPU, [N/A], 1, 2")[0].utilization_pct, None);
    }

    #[test]
    fn process_tree_keeps_only_descendants_in_order() {
        let p = |pid, parent: Option<u32>| ProcInfo { pid, parent, name: format!("p{pid}"), ..Default::default() };
        let all = vec![p(1, None), p(10, Some(1)), p(11, Some(10)), p(12, Some(1)), p(99, Some(5))];
        let tree = descendants(1, &all);
        let order: Vec<(u32, usize)> = tree.iter().map(|p| (p.pid, p.depth)).collect();
        assert_eq!(order, vec![(1, 0), (10, 1), (11, 2), (12, 1)]);
    }
}
