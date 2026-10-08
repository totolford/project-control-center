//! Recovery commands: process tree, recovery state, crash reports (project,
//! application and interface), interrupted missions, mission checkpoints, MCP
//! supervision and orphan cleanup. One-to-one with the recovery section of
//! `src/lib/api.ts`.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{Manager, State};

use pcc_core::{Error, Event, EventKind, Severity};
use pcc_orchestrator::recovery::{McpHealth, ProbeRecord, RecoveryState};
use pcc_recovery::{CheckpointSummary, CrashReport, PreviousRun, ProcessRecord, ReportStore};

use crate::health_commands::{HealthMonitor, RendererIncident};
use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

// ---------------------------------------------------------------- application level

struct AppRecovery {
    reports: ReportStore,
    instance: PathBuf,
    previous_run: PreviousRun,
}

static APP: OnceLock<AppRecovery> = OnceLock::new();

/// At startup: persists the application process registry, tells a clean exit
/// from a crash, and files a report when the previous run ended unexpectedly.
pub fn init(data_dir: &std::path::Path) {
    let previous = pcc_recovery::init_app(data_dir);
    let rt = pcc_recovery::runtime_dir(data_dir);
    let instance = rt.join("instance.json");
    let previous_run = pcc_recovery::reports::begin_instance(&instance);
    let reports = ReportStore::new(rt.join("crash-reports"));
    if let PreviousRun::Unexpected { pid, started_at } = &previous_run {
        let running: Vec<ProcessRecord> =
            previous.map(|s| s.processes.into_iter().filter(|p| !p.state.is_ended()).collect()).unwrap_or_default();
        let r = unexpected_exit_report(*pid, started_at, &running);
        if let Err(e) = reports.add(&r) {
            tracing::warn!("cannot write crash report: {e}");
        }
    }
    let _ = APP.set(AppRecovery { reports, instance, previous_run });
}

/// At a clean exit.
pub fn clean_exit() {
    if let Some(a) = APP.get() {
        for r in pcc_recovery::app().list().into_iter().filter(|r| !r.state.is_ended()) {
            pcc_recovery::app().ended(&r.key, false, None, Some("NEXUS closed".into()));
        }
        pcc_recovery::app().flush();
        pcc_recovery::reports::end_instance(&a.instance);
    }
}

/// Report for an application that ended without closing.
pub fn unexpected_exit_report(pid: u32, started_at: &str, running: &[ProcessRecord]) -> CrashReport {
    let mut r = CrashReport::new("nexus", "NEXUS recovered from an unexpected failure");
    r.severity = pcc_recovery::Severity::Error;
    r.what_happened = format!("The previous NEXUS instance (pid {pid}, started {started_at}) ended without closing.");
    r.possible_cause = format!(
        "The application crashed, was killed ({}) or {} or lost power. NEXUS does not know which; the application log of the previous run may say more.",
        pcc_platform::external_kill_examples(),
        pcc_platform::os_restart_phrase()
    );
    r.preserved.push("Projects, missions, tasks and agent conversations (stored on disk)".into());
    r.preserved.push("Uncommitted files on disk (nothing is reverted)".into());
    for p in running {
        r.details.push(format!(
            "{} \"{}\" was {}{}",
            p.kind.label(),
            p.label,
            serde_json::to_value(p.state).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
            p.pid.map(|x| format!(" (pid {x})")).unwrap_or_default()
        ));
    }
    if running.is_empty() {
        r.lost.push("Nothing application-wide was running".into());
    } else {
        r.lost.push(format!(
            "{} application process(es) that were running (AI Town, terminals, local AI) stopped with it; start them again where needed",
            running.len()
        ));
    }
    r
}

// ---------------------------------------------------------------- shapes

/// One node of the process tree (`children` nest).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub pid: Option<u32>,
    pub status: String,
    pub detail: Option<String>,
    pub heartbeat_at: Option<String>,
    pub last_event: Option<String>,
    pub agent_id: Option<String>,
    pub mission_id: Option<String>,
    pub restart_count: u32,
    /// `registry` (NEXUS registered it) or `os` (found in the OS process table under one).
    pub source: String,
    pub children: Vec<ProcessNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStateView {
    pub app_previous_run: PreviousRun,
    pub app_previous_run_text: String,
    /// `None` without an open project.
    pub project: Option<RecoveryState>,
}

/// A crash report from any source, newest first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportView {
    #[serde(flatten)]
    pub report: CrashReport,
    /// `project`, `app` or `interface`.
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSupervision {
    /// What Claude Code reports per session (`mcp_status`).
    pub sessions: Vec<McpHealth>,
    /// NEXUS's own probes of project connections.
    pub probes: Vec<ProbeRecord>,
    /// Running Claude Code sessions (MCP servers of a session are its child processes).
    pub session_pids: Vec<(String, u32)>,
    /// Child processes of each session, from the OS process table.
    pub session_children: Vec<SessionChild>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChild {
    pub agent_id: String,
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

// ---------------------------------------------------------------- pure helpers

fn state_str(s: pcc_recovery::ProcessState) -> String {
    serde_json::to_value(s).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn kind_str(k: pcc_recovery::ProcessKind) -> String {
    serde_json::to_value(k).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn record_node(r: &ProcessRecord) -> ProcessNode {
    let restarts = if r.restart_count > 0 { Some(format!("{} restart(s)", r.restart_count)) } else { None };
    ProcessNode {
        id: r.key.clone(),
        label: r.label.clone(),
        kind: kind_str(r.kind),
        pid: r.pid,
        status: state_str(r.state),
        detail: [Some(r.kind.label().to_string()), r.state_detail.clone(), restarts]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ")
            .into(),
        heartbeat_at: r.heartbeat_at.clone(),
        last_event: r.last_event.clone(),
        agent_id: r.agent_id.clone(),
        mission_id: r.mission_id.clone(),
        restart_count: r.restart_count,
        source: "registry".into(),
        children: Vec::new(),
    }
}

/// NEXUS → registered processes (live first, then ended ones) → their OS
/// children. Ended records stay as history but carry no OS children.
pub fn build_tree(me: u32, records: &[ProcessRecord], table: &[pcc_recovery::sys::ProcEntry]) -> ProcessNode {
    let mut live: Vec<&ProcessRecord> = records.iter().filter(|r| !r.state.is_ended()).collect();
    live.sort_by(|a, b| a.key.cmp(&b.key));
    let mut ended: Vec<&ProcessRecord> = records.iter().filter(|r| r.state.is_ended()).collect();
    ended.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
    let registered: std::collections::HashSet<u32> = live.iter().filter_map(|r| r.pid).collect();
    let mut children = Vec::new();
    for r in live.iter().chain(ended.iter().take(20)) {
        let mut n = record_node(r);
        if let (Some(pid), false) = (r.pid, r.state.is_ended()) {
            n.children = os_children(pid, table, &registered);
        }
        children.push(n);
    }
    ProcessNode {
        id: "nexus".into(),
        label: "NEXUS".into(),
        kind: "nexus".into(),
        pid: Some(me),
        status: "running".into(),
        detail: Some("this application".into()),
        heartbeat_at: None,
        last_event: None,
        agent_id: None,
        mission_id: None,
        restart_count: 0,
        source: "os".into(),
        children,
    }
}

fn os_children(
    pid: u32,
    table: &[pcc_recovery::sys::ProcEntry],
    skip: &std::collections::HashSet<u32>,
) -> Vec<ProcessNode> {
    table
        .iter()
        .filter(|e| e.ppid == pid && e.pid != pid && !skip.contains(&e.pid))
        .map(|e| ProcessNode {
            id: format!("os:{}", e.pid),
            label: e.name.clone(),
            kind: "child".into(),
            pid: Some(e.pid),
            status: "running".into(),
            detail: Some("child process".into()),
            heartbeat_at: None,
            last_event: None,
            agent_id: None,
            mission_id: None,
            restart_count: 0,
            source: "os".into(),
            children: os_children(e.pid, table, skip),
        })
        .collect()
}

/// A renderer incident as a crash report.
pub fn incident_report(i: &RendererIncident) -> CrashReport {
    let mut r = CrashReport {
        id: i.id.clone(),
        at: i.ts.clone(),
        component: "interface".into(),
        title: match i.outcome.as_str() {
            "recovered" => "The interface was recovered".into(),
            "failed" => "The interface could not be recovered automatically".into(),
            "pending" => "The interface is being recovered".into(),
            _ => "Interface incident".into(),
        },
        severity: if i.outcome == "failed" { pcc_recovery::Severity::Error } else { pcc_recovery::Severity::Warning },
        what_happened: format!("{} ({})", i.reason, i.kind),
        possible_cause: match i.kind.as_str() {
            "frozen" => "The web view stopped answering (long script, GPU driver problem or a renderer crash).".into(),
            "viewCrash" => "A view of the interface threw an error while rendering.".into(),
            "manual" => "Reloaded by the user.".into(),
            _ => String::new(),
        },
        // The interface is the only thing restarted; the engine keeps running.
        acknowledged: true,
        ..Default::default()
    };
    if i.action != "none" {
        r.restarted.push(format!("Interface ({})", i.action));
    }
    if let Some(p) = &i.preserved {
        r.preserved.push(format!(
            "Engine untouched: {} agent session(s), {} active mission(s), {} MCP connection(s)",
            p.running_agents, p.active_missions, p.mcp_connected
        ));
    }
    if let Some(ms) = i.downtime_ms {
        r.details.push(format!("Downtime: {:.1}s", ms as f64 / 1000.0));
    }
    r.lost.push("Unsaved text in the interface (drafts in open forms)".into());
    r
}

/// Newest first.
pub fn merge_reports(
    project: Vec<CrashReport>,
    app: Vec<CrashReport>,
    interface: Vec<CrashReport>,
) -> Vec<CrashReportView> {
    let mut v: Vec<CrashReportView> = project
        .into_iter()
        .map(|report| CrashReportView { report, source: "project".into() })
        .chain(app.into_iter().map(|report| CrashReportView { report, source: "app".into() }))
        .chain(interface.into_iter().map(|report| CrashReportView { report, source: "interface".into() }))
        .collect();
    v.sort_by(|a, b| b.report.at.cmp(&a.report.at).then(b.report.id.cmp(&a.report.id)));
    v
}

fn previous_run_text(p: &PreviousRun) -> String {
    match p {
        PreviousRun::Unknown => "No record of the previous run".into(),
        PreviousRun::Clean { at } => format!("NEXUS was closed normally ({at})"),
        PreviousRun::Unexpected { pid, .. } => format!("The previous NEXUS (pid {pid}) ended unexpectedly"),
        PreviousRun::StillRunning { pid } => format!("Another NEXUS process (pid {pid}) is running"),
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn process_tree(state: State<'_, AppState>) -> CmdResult<Vec<ProcessNode>> {
    let mut records = pcc_recovery::app().list();
    if let Ok(orch) = state.orch().await {
        records.extend(orch.lock().await.project_processes());
    }
    blocking(move || {
        let table = pcc_recovery::sys::list_processes();
        vec![build_tree(pcc_recovery::sys::current_pid(), &records, &table)]
    })
    .await
}

#[tauri::command]
pub async fn recovery_state(state: State<'_, AppState>) -> CmdResult<RecoveryStateView> {
    let project = match state.orch().await {
        Ok(orch) => Some(orch.lock().await.recovery_state()),
        Err(_) => None,
    };
    let previous = APP.get().map(|a| a.previous_run.clone()).unwrap_or(PreviousRun::Unknown);
    Ok(RecoveryStateView { app_previous_run_text: previous_run_text(&previous), app_previous_run: previous, project })
}

#[tauri::command]
pub async fn crash_reports(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<Vec<CrashReportView>> {
    let project = match state.orch().await {
        Ok(orch) => orch.lock().await.crash_reports(),
        Err(_) => Vec::new(),
    };
    blocking(move || {
        let app_reports = APP.get().map(|a| a.reports.list()).unwrap_or_default();
        let interface: Vec<CrashReport> =
            app.state::<HealthMonitor>().incidents(200).iter().map(incident_report).collect();
        merge_reports(project, app_reports, interface)
    })
    .await
}

#[tauri::command]
pub async fn acknowledge_crash_report(state: State<'_, AppState>, id: String) -> CmdResult<bool> {
    if let Ok(orch) = state.orch().await {
        if orch.lock().await.acknowledge_crash_report(&id)? {
            return Ok(true);
        }
    }
    match APP.get() {
        Some(a) => a.reports.acknowledge(&id),
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn resume_interrupted_mission(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.resume_mission(&id)
}

#[tauri::command]
pub async fn abandon_interrupted_mission(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.orch().await?.lock().await.abandon_mission(&id)
}

#[tauri::command]
pub async fn mission_checkpoints(state: State<'_, AppState>, id: String) -> CmdResult<Vec<CheckpointSummary>> {
    Ok(state.orch().await?.lock().await.mission_checkpoints(&id))
}

#[tauri::command]
pub async fn mission_checkpoint(
    state: State<'_, AppState>,
    id: String,
    seq: Option<u32>,
) -> CmdResult<Option<pcc_recovery::Checkpoint>> {
    Ok(state.orch().await?.lock().await.mission_checkpoint(&id, seq))
}

#[tauri::command]
pub async fn mcp_supervision(state: State<'_, AppState>) -> CmdResult<McpSupervision> {
    let orch = state.orch().await?;
    let (sessions, probes, session_pids) = {
        let e = orch.lock().await;
        (e.mcp_health(), e.mcp_probes(), e.session_pids())
    };
    let pids = session_pids.clone();
    let session_children = blocking(move || {
        let table = pcc_recovery::sys::list_processes();
        pids.iter()
            .flat_map(|(agent, pid)| {
                pcc_recovery::sys::descendants(&table, *pid).into_iter().map(|c| SessionChild {
                    agent_id: agent.clone(),
                    pid: c.pid,
                    parent_pid: c.ppid,
                    name: c.name,
                })
            })
            .collect()
    })
    .await?;
    Ok(McpSupervision { sessions, probes, session_pids, session_children })
}

/// Reconnects an MCP server in the sessions that have it (Claude Code owns those processes).
#[tauri::command]
pub async fn restart_mcp(
    state: State<'_, AppState>,
    agent_id: Option<String>,
    server: String,
) -> CmdResult<Vec<String>> {
    state.orch().await?.lock().await.restart_mcp(agent_id.as_deref(), &server)
}

/// Asks every running session for its MCP status now; returns how many were asked.
#[tauri::command]
pub async fn refresh_mcp_status(state: State<'_, AppState>) -> CmdResult<usize> {
    Ok(state.orch().await?.lock().await.refresh_mcp_status())
}

#[tauri::command]
pub async fn scan_orphans(state: State<'_, AppState>) -> CmdResult<Vec<pcc_recovery::Orphan>> {
    let orch = state.orch().await?;
    let Some(input) = orch.lock().await.orphan_scan_input() else { return Ok(Vec::new()) };
    let found = blocking(move || pcc_orchestrator::recovery::scan_orphans(&input, true)).await?;
    orch.lock().await.set_orphans(found.clone());
    Ok(found)
}

/// Cleans up one orphan: state check, recorded reason, saved context,
/// modified files, soft stop, then termination. Only on the user's request.
#[tauri::command]
pub async fn cleanup_orphan(
    state: State<'_, AppState>,
    pid: u32,
) -> CmdResult<pcc_orchestrator::recovery::OrphanCleanup> {
    let orch = state.orch().await?;
    let (orphan, workdir, session) = orch.lock().await.orphan_context(pid)?;
    let outcome =
        blocking(move || pcc_orchestrator::recovery::cleanup_orphan(&orphan, workdir.as_deref(), session)).await?;
    let mut e = orch.lock().await;
    e.record_orphan_cleanup(outcome.clone());
    e.emit(
        Event::new(
            EventKind::SystemNotice,
            format!("Orphan process {pid}: {}", if outcome.terminated { "terminated" } else { "not terminated" }),
            serde_json::json!(outcome),
        )
        .named("recovery.orphanCleanup")
        .with_severity(if outcome.terminated || outcome.already_gone { Severity::Info } else { Severity::Warning })
        .with_source("recovery")
        .with_pid(Some(pid)),
    );
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcc_recovery::sys::ProcEntry;
    use pcc_recovery::{ProcessKind, ProcessRegistry, Registration};

    #[test]
    fn tree_nests_os_children_under_live_records() {
        let reg = ProcessRegistry::in_memory();
        reg.register("claude:central", Registration::new(ProcessKind::ClaudeSession, "Central").pid(Some(100)));
        reg.register("pty:1", Registration::new(ProcessKind::Pty, "PowerShell").pid(Some(200)));
        reg.ended("pty:1", false, Some(0), None);
        let table = vec![
            ProcEntry { pid: 101, ppid: 100, name: "node.exe".into() },
            ProcEntry { pid: 102, ppid: 101, name: "cmd.exe".into() },
            ProcEntry { pid: 201, ppid: 200, name: "conhost.exe".into() },
        ];
        let root = build_tree(1, &reg.list(), &table);
        assert_eq!(root.children.len(), 2);
        let central = root.children.iter().find(|n| n.id == "claude:central").unwrap();
        assert_eq!(central.children[0].pid, Some(101));
        assert_eq!(central.children[0].children[0].label, "cmd.exe");
        let pty = root.children.iter().find(|n| n.id == "pty:1").unwrap();
        assert_eq!(pty.status, "exited");
        assert!(pty.children.is_empty(), "ended records carry no OS children (PIDs may be reused)");
    }

    #[test]
    fn reports_from_all_sources_newest_first() {
        let mut a = CrashReport::new("claude-session", "A");
        a.at = "2026-01-02T00:00:00.000Z".into();
        let mut b = CrashReport::new("nexus", "B");
        b.at = "2026-01-03T00:00:00.000Z".into();
        let inc = RendererIncident {
            id: "ui-1".into(),
            ts: "2026-01-01T00:00:00.000Z".into(),
            kind: "frozen".into(),
            action: "reload".into(),
            reason: "no heartbeat for 30s".into(),
            outcome: "recovered".into(),
            downtime_ms: Some(4200),
            ..Default::default()
        };
        let v = merge_reports(vec![a], vec![b], vec![incident_report(&inc)]);
        assert_eq!(v.iter().map(|r| r.source.as_str()).collect::<Vec<_>>(), vec!["app", "project", "interface"]);
        let ui = &v[2].report;
        assert_eq!(ui.title, "The interface was recovered");
        assert_eq!(ui.restarted, vec!["Interface (reload)"]);
        assert!(ui.details[0].contains("4.2s"));
    }

    #[test]
    fn unexpected_exit_lists_what_was_running() {
        let reg = ProcessRegistry::in_memory();
        reg.register("aitown:convex", Registration::new(ProcessKind::AiTown, "AI Town (convex dev)").pid(Some(9)));
        let r = unexpected_exit_report(42, "2026-01-01T00:00:00Z", &reg.list());
        assert_eq!(r.title, "NEXUS recovered from an unexpected failure");
        assert!(r.details[0].contains("AI Town"));
        assert!(r.lost[0].contains("1 application process"));
    }
}
