//! Recovery: process registry of the project's sessions, mission checkpoints,
//! interrupted-mission detection after a restart, precise resume briefs,
//! crash reports and orphan handling.
//!
//! The watchdog that acts on live sessions is in `watchdog.rs`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pcc_claude::session::describe_tool_use;
use pcc_core::{
    AgentStatus, Event, EventKind, Isolation, LogKind, Mission, MissionStatus, Result, Severity, TaskStatus, CENTRAL_ID,
};
use pcc_recovery::checkpoint::{file_state, written_since, AgentState, TaskState};
use pcc_recovery::{
    CheckpointSummary, CrashReport, FileState, LastAction, MissionFiles, MissionRecord, Orphan, PreviousRun,
    ProcessKind, ProcessRecord, ProcessRegistry, Registration, ReportStore,
};
use pcc_store::{ProjectStore, TaskFilter};

use crate::dto::RecoveryAgent;
use crate::engine::Engine;

/// Most files listed in a checkpoint or a brief.
const MAX_FILES: usize = 500;

/// A mission that was running when NEXUS stopped.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InterruptedMission {
    pub mission_id: String,
    pub title: String,
    pub status: String,
    /// Task(s) in progress or the mission step at the interruption.
    pub interrupted_during: String,
    pub last_action: Option<LastAction>,
    /// Files written since the last checkpoint (labels: `path` or `path (agent)`).
    pub files_since_checkpoint: Vec<String>,
    /// One sentence about those files (`No file was written since the last checkpoint.`).
    pub files_note: String,
    pub last_checkpoint: Option<CheckpointSummary>,
    pub tasks_in_progress: Vec<TaskState>,
    pub agents: Vec<AgentState>,
    /// How the previous NEXUS run ended.
    pub previous_run: String,
    /// What Central is told when the mission resumes.
    pub brief: String,
}

/// Unexpected end of a session, kept until the watchdog restarts it.
#[derive(Debug, Clone)]
pub(crate) struct CrashInfo {
    pub at: Instant,
    pub code: Option<i32>,
    pub busy: bool,
    pub last_action: Option<LastAction>,
    pub inflight: Option<String>,
    pub report_id: Option<String>,
    pub capped: bool,
}

/// Watchdog bookkeeping of one live session.
#[derive(Debug, Clone)]
pub(crate) struct SessionWatch {
    pub epoch: u64,
    pub pid: u32,
    pub last_output: Instant,
    /// tool_use id → (tool name, started).
    pub inflight: HashMap<String, (String, Instant)>,
    pub cpu_ms: Option<u64>,
    pub soft_at: Option<Instant>,
    pub dead_ticks: u8,
    pub last_action: Option<LastAction>,
    pub diagnosis: Option<pcc_recovery::Diagnosis>,
    pub checked_at: Option<String>,
}

impl SessionWatch {
    fn new(epoch: u64, pid: u32) -> Self {
        SessionWatch {
            epoch,
            pid,
            last_output: Instant::now(),
            inflight: HashMap::new(),
            cpu_ms: None,
            soft_at: None,
            dead_ticks: 0,
            last_action: None,
            diagnosis: None,
            checked_at: None,
        }
    }

    /// Oldest tool call still running.
    pub fn oldest_inflight(&self) -> Option<(&str, Instant)> {
        self.inflight.values().min_by_key(|(_, t)| *t).map(|(n, t)| (n.as_str(), *t))
    }
}

/// What a control request NEXUS sent on its own is for.
#[derive(Debug, Clone)]
pub(crate) enum ControlPurpose {
    McpStatus,
    McpReconnect { server: String, automatic: bool },
}

#[derive(Debug, Clone)]
pub(crate) struct PendingControl {
    pub agent: String,
    pub purpose: ControlPurpose,
    pub sent: Instant,
}

/// Result of the latest NEXUS probe of a connection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProbeRecord {
    pub connection_id: String,
    pub name: String,
    pub at: String,
    pub ok: bool,
    pub transport: String,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub tools: Option<usize>,
    pub resources: Option<usize>,
    pub prompts: Option<usize>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub stderr_tail: Vec<String>,
    /// Number of probes since NEXUS started (re-tests from the supervision panel).
    pub probes: u32,
}

/// One MCP server inside one agent's Claude Code session, as reported by
/// Claude Code's `mcp_status` control request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct McpHealth {
    pub agent_id: String,
    pub server: String,
    /// `connected`, `failed`, `pending`, `needs-auth`, `disabled` (Claude Code's words).
    pub status: String,
    pub transport: Option<String>,
    pub tools: Option<usize>,
    pub tool_names: Vec<String>,
    pub server_version: Option<String>,
    pub error: Option<String>,
    /// NEXUS's reading of the error.
    pub cause: Option<String>,
    /// Last time Claude Code reported it connected.
    pub last_response_at: Option<String>,
    pub last_checked_at: String,
    /// PID of the Claude Code session that owns the server process.
    pub session_pid: Option<u32>,
    pub restarts: Vec<pcc_recovery::RestartRecord>,
    pub reconnecting: bool,
}

/// Recovery runtime of one project (owned by the engine).
pub(crate) struct RecoveryRuntime {
    pub registry: ProcessRegistry,
    pub reports: Option<ReportStore>,
    pub missions: Option<MissionFiles>,
    pub previous_run: PreviousRun,
    pub previous_processes: Vec<ProcessRecord>,
    pub orphans: Vec<Orphan>,
    pub orphans_scanned_at: Option<String>,
    pub sessions: HashMap<String, SessionWatch>,
    pub crashed: HashMap<String, CrashInfo>,
    /// Automatic restarts per agent (for the backoff and the cap).
    pub restarts: HashMap<String, Vec<Instant>>,
    /// Briefs given to an agent when its restarted session comes up.
    pub briefs: HashMap<String, String>,
    pub interrupted: Vec<InterruptedMission>,
    pub startup_report: Option<String>,
    pub mcp: BTreeMap<(String, String), McpHealth>,
    pub mcp_restarts: HashMap<(String, String), Vec<Instant>>,
    pub probes: BTreeMap<String, ProbeRecord>,
    pub pending: HashMap<String, PendingControl>,
    pub last_periodic: Option<Instant>,
    pub last_mcp_poll: Option<Instant>,
    pub last_tick: Option<String>,
    instance_file: Option<PathBuf>,
    claude_image: Option<String>,
}

impl RecoveryRuntime {
    pub fn open(store: &ProjectStore, claude: Option<&Path>) -> Self {
        let claude_image = claude.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned());
        if store.read_only() {
            // Compatibility mode writes nothing: an in-memory registry only.
            return RecoveryRuntime::new(ProcessRegistry::in_memory(), None, None, PreviousRun::Unknown, vec![], None)
                .with_image(claude_image);
        }
        let rt = pcc_recovery::runtime_dir(&store.layout().dir);
        let file = rt.join("processes.json");
        let previous = ProcessRegistry::load_previous(&file).map(|s| s.processes).unwrap_or_default();
        let instance = rt.join("instance.json");
        let previous_run = pcc_recovery::reports::begin_instance(&instance);
        RecoveryRuntime::new(
            ProcessRegistry::persisted(file),
            Some(ReportStore::new(rt.join("crash-reports"))),
            Some(MissionFiles::new(&store.layout().dir)),
            previous_run,
            previous,
            Some(instance),
        )
        .with_image(claude_image)
    }

    fn new(
        registry: ProcessRegistry,
        reports: Option<ReportStore>,
        missions: Option<MissionFiles>,
        previous_run: PreviousRun,
        previous_processes: Vec<ProcessRecord>,
        instance_file: Option<PathBuf>,
    ) -> Self {
        RecoveryRuntime {
            registry,
            reports,
            missions,
            previous_run,
            previous_processes,
            orphans: Vec::new(),
            orphans_scanned_at: None,
            sessions: HashMap::new(),
            crashed: HashMap::new(),
            restarts: HashMap::new(),
            briefs: HashMap::new(),
            interrupted: Vec::new(),
            startup_report: None,
            mcp: BTreeMap::new(),
            mcp_restarts: HashMap::new(),
            probes: BTreeMap::new(),
            pending: HashMap::new(),
            last_periodic: None,
            last_mcp_poll: None,
            last_tick: None,
            instance_file,
            claude_image: None,
        }
    }

    fn with_image(mut self, image: Option<String>) -> Self {
        self.claude_image = image;
        self
    }

    pub fn previous_run_text(&self) -> String {
        match &self.previous_run {
            PreviousRun::Unknown => "NEXUS was restarted".into(),
            PreviousRun::Clean { .. } => "NEXUS was closed and reopened".into(),
            PreviousRun::Unexpected { .. } => {
                "NEXUS ended unexpectedly (crash, forced kill, power loss or reboot) and was reopened".into()
            }
            PreviousRun::StillRunning { pid } => {
                format!("Another NEXUS process (pid {pid}) still has this project open")
            }
        }
    }
}

pub(crate) fn session_key(agent: &str) -> String {
    format!("claude:{agent}")
}

/// `Name {json}` (optionally `↳ `) from the transcript → (tool, description).
pub fn describe_logged_tool(text: &str) -> Option<(String, String)> {
    let line = text.trim_start_matches("↳ ").trim_start();
    let (name, rest) = line.split_once(' ').unwrap_or((line, ""));
    if name.is_empty() || name.contains(['{', '"']) {
        return None;
    }
    let input: Value = serde_json::from_str(rest.trim()).unwrap_or_else(|_| partial_input(rest));
    Some((name.to_string(), describe_tool_use(name, &input)))
}

/// Inputs logged in full are JSON; long ones are cut (`…`). Recover the fields
/// descriptions use from a cut one.
fn partial_input(rest: &str) -> Value {
    let mut o = serde_json::Map::new();
    for key in ["file_path", "command", "description", "pattern", "url", "query"] {
        let pat = format!("\"{key}\":\"");
        if let Some(i) = rest.find(&pat) {
            let tail = &rest[i + pat.len()..];
            let mut out = String::new();
            let mut esc = false;
            for c in tail.chars() {
                if esc {
                    out.push(c);
                    esc = false;
                } else if c == '\\' {
                    esc = true;
                } else if c == '"' {
                    break;
                } else {
                    out.push(c);
                }
            }
            o.insert(key.into(), Value::String(out));
        }
    }
    Value::Object(o)
}

/// Uncommitted files of a git working tree with their fingerprint.
fn git_dirty(dir: &Path, location: &str) -> Vec<FileState> {
    let Ok(out) = pcc_git::Repo::discover(dir)
        .map(|r| r.git(&["status", "--porcelain", "--untracked-files=all"]))
        .unwrap_or_else(|| Err(pcc_core::Error::Git("not a repository".into())))
    else {
        return Vec::new();
    };
    out.lines()
        .filter(|l| l.len() > 3)
        .filter_map(|l| {
            let code = &l[..2];
            let mut path = l[3..].trim_matches('"').to_string();
            if let Some((_, to)) = path.split_once(" -> ") {
                path = to.trim_matches('"').to_string();
            }
            (!path.starts_with(".agent-project/")).then(|| file_state(dir, &path, location, code))
        })
        .take(MAX_FILES)
        .collect()
}

/// Files modified after `since_ms` (projects without git). Bounded walk.
fn walk_modified(root: &Path, since_ms: u64) -> Vec<FileState> {
    const SKIP: &[&str] = &[".agent-project", ".git", "node_modules", "target", "dist", ".venv", "__pycache__"];
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 20_000 || out.len() >= MAX_FILES {
                return out;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(e.path());
                }
                continue;
            }
            let rel = e.path().strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or(name);
            let fs = file_state(root, &rel, "main", "modified");
            if fs.modified_ms.is_some_and(|m| m > since_ms) {
                out.push(fs);
            }
        }
    }
    out
}

fn ts_ms(ts: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(ts).map(|d| d.timestamp_millis().max(0) as u64).unwrap_or(0)
}

pub(crate) fn clock(ts: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|d| d.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
        .unwrap_or_else(|_| ts.to_string())
}

fn status_str<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// Human list of files, shortened.
pub(crate) fn file_list(files: &[String], max: usize) -> String {
    let mut s = files.iter().take(max).cloned().collect::<Vec<_>>().join(", ");
    if files.len() > max {
        s.push_str(&format!(" and {} more", files.len() - max));
    }
    s
}

impl Engine {
    // ------------------------------------------------------------ session hooks

    /// A session process was spawned.
    pub(crate) fn rec_session_started(&mut self, agent: &str, epoch: u64, pid: u32, resumed: bool) {
        self.rec.sessions.insert(agent.to_string(), SessionWatch::new(epoch, pid));
        self.rec.crashed.remove(agent);
        let a = self.store.agent(agent).ok();
        let mission = self.mission_of_agent(agent);
        let mut reg = Registration::new(
            ProcessKind::ClaudeSession,
            a.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| agent.to_string()),
        )
        .pid(Some(pid))
        .project(self.store.root())
        .agent(agent)
        .mission(mission)
        .command(format!(
            "claude -p stream-json {} {}",
            if resumed { "--resume" } else { "--session-id" },
            a.and_then(|a| a.claude_session_id).unwrap_or_default()
        ));
        if let Some(img) = &self.rec.claude_image {
            reg = reg.image(img.clone());
        }
        self.rec.registry.register(&session_key(agent), reg);
    }

    /// Every output line of a session (sign of life, tool calls in flight).
    pub(crate) fn rec_observe(&mut self, agent: &str, epoch: u64, out: &pcc_claude::SessionOutput) {
        use pcc_claude::protocol::{Block, Inbound};
        use pcc_claude::SessionOutput;
        let Some(w) = self.rec.sessions.get_mut(agent) else { return };
        if w.epoch != epoch {
            return;
        }
        let now = Instant::now();
        w.last_output = now;
        w.dead_ticks = 0;
        let mut event = None;
        let mut state = None;
        match out {
            SessionOutput::Message { msg, .. } => {
                w.soft_at = None;
                match msg {
                    Inbound::Assistant { blocks, .. } => {
                        for b in blocks {
                            if let Block::ToolUse { id, name, input } = b {
                                w.inflight.insert(id.clone(), (name.clone(), now));
                                let description = describe_tool_use(name, input);
                                event = Some(description.clone());
                                state = Some((pcc_recovery::ProcessState::Busy, Some(description.clone())));
                                w.last_action = Some(LastAction {
                                    agent_id: agent.to_string(),
                                    tool: name.clone(),
                                    description,
                                    at: pcc_core::now(),
                                });
                            }
                        }
                    }
                    Inbound::ToolResults { results, .. } => {
                        for r in results {
                            w.inflight.remove(&r.tool_use_id);
                        }
                    }
                    Inbound::Result { subtype, .. } => {
                        w.inflight.clear();
                        event = Some(format!("turn finished ({subtype})"));
                        state = Some((pcc_recovery::ProcessState::Idle, None));
                    }
                    Inbound::Init { .. } => state = Some((pcc_recovery::ProcessState::Idle, None)),
                    _ => {}
                }
            }
            SessionOutput::Exited(_) => return,
            _ => {}
        }
        let key = session_key(agent);
        self.rec.registry.heartbeat(&key, "stdout", event.as_deref());
        if let Some((s, d)) = state {
            self.rec.registry.set_state(&key, s, d);
        }
    }

    /// A session process ended. Unexpected ends get a crash report; the
    /// watchdog decides about the restart.
    pub(crate) fn rec_session_ended(
        &mut self,
        agent: &str,
        code: Option<i32>,
        intentional: bool,
        busy: bool,
        stderr_tail: &[String],
    ) {
        let watch = self.rec.sessions.remove(agent);
        let key = session_key(agent);
        let detail = if intentional {
            None
        } else {
            Some(format!("exit code {}", code.map(|c| c.to_string()).unwrap_or("-".into())))
        };
        self.rec.registry.ended(&key, !intentional, code, detail);
        self.rec.pending.retain(|_, p| p.agent != agent);
        for h in self.rec.mcp.values_mut().filter(|h| h.agent_id == agent) {
            h.status = "session ended".into();
            h.reconnecting = false;
        }
        if intentional || self.store.read_only() {
            return;
        }
        let a = self.store.agent(agent).ok();
        let name = a.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| agent.to_string());
        let last_action = watch.as_ref().and_then(|w| w.last_action.clone());
        let inflight = watch.as_ref().and_then(|w| w.oldest_inflight().map(|(n, _)| n.to_string()));
        let pid = watch.as_ref().map(|w| w.pid);
        let mut r = CrashReport::new("claude-session", format!("{name}'s Claude Code session stopped unexpectedly"));
        r.severity = pcc_recovery::Severity::Error;
        r.agent_id = Some(agent.to_string());
        r.mission_id = self.mission_of_agent(agent);
        r.project = Some(self.store.root().to_string_lossy().into_owned());
        r.what_happened = format!(
            "The Claude Code process of {name}{} exited with code {} {}.",
            pid.map(|p| format!(" (pid {p})")).unwrap_or_default(),
            code.map(|c| c.to_string()).unwrap_or_else(|| "unknown (terminated)".into()),
            match (&busy, &last_action) {
                (true, Some(l)) => format!("while a turn was running (last action: {})", l.description),
                (true, None) => "while a turn was running".into(),
                (false, _) => "while it was idle".into(),
            }
        );
        r.possible_cause = crash_cause(code, stderr_tail);
        if let Some(sid) = a.as_ref().and_then(|a| a.claude_session_id.clone()) {
            r.preserved.push(format!("Claude conversation {sid} (resumable with --resume)"));
        }
        if let Some(t) = a.as_ref().and_then(|a| a.current_task.clone()) {
            r.preserved.push(format!("Task {t} and its state"));
        }
        let dirty = a.as_ref().map(|a| self.workdir_dirty(a)).unwrap_or_default();
        if !dirty.is_empty() {
            r.preserved.push(format!(
                "{} uncommitted file(s) on disk: {}",
                dirty.len(),
                file_list(&dirty.iter().map(FileState::label).collect::<Vec<_>>(), 6)
            ));
        }
        if busy {
            r.lost.push("The reply of the turn in progress (the agent is asked to continue after the restart)".into());
        }
        if let Some(t) = &inflight {
            r.lost.push(format!("The result of the running {t} call (unknown whether it finished)"));
        }
        if r.lost.is_empty() {
            r.lost.push("Nothing: the agent was idle".into());
        }
        r.details.extend(stderr_tail.iter().rev().take(10).rev().cloned());
        let report_id = self.file_report(r);
        self.rec.crashed.insert(
            agent.to_string(),
            CrashInfo { at: Instant::now(), code, busy, last_action, inflight, report_id, capped: false },
        );
    }

    /// Response to a control request NEXUS sent on its own. Returns `true` when handled.
    pub(crate) fn rec_control_response(
        &mut self,
        agent: &str,
        request_id: &str,
        success: bool,
        error: Option<&str>,
        response: &Value,
    ) -> bool {
        let Some(p) = self.rec.pending.remove(request_id) else { return false };
        match p.purpose {
            ControlPurpose::McpStatus => {
                if success {
                    self.update_mcp_health(agent, response);
                }
            }
            ControlPurpose::McpReconnect { server, automatic } => {
                let k = (agent.to_string(), server.clone());
                let outcome = if success { "reconnect requested" } else { "reconnect failed" };
                if let Some(h) = self.rec.mcp.get_mut(&k) {
                    if let Some(last) = h.restarts.last_mut() {
                        last.outcome = match error {
                            Some(e) if !success => format!("failed: {e}"),
                            _ => outcome.into(),
                        };
                    }
                    h.reconnecting = success;
                }
                let row = self.sessions.get(agent).map(|l| l.session_row).unwrap_or(0);
                self.log(
                    agent,
                    row,
                    if success { LogKind::System } else { LogKind::Error },
                    &format!(
                        "{} reconnect of MCP server {server}: {}",
                        if automatic { "Automatic" } else { "Requested" },
                        if success {
                            "accepted by Claude Code".to_string()
                        } else {
                            error.unwrap_or("failed").to_string()
                        }
                    ),
                );
                // Re-read the status soon to see the tools again.
                self.rec.last_mcp_poll = None;
            }
        }
        true
    }

    // ------------------------------------------------------------ reports

    /// Persists a report and tells the UI. Returns its id.
    pub(crate) fn file_report(&mut self, r: CrashReport) -> Option<String> {
        let store = self.rec.reports.clone()?;
        if let Err(e) = store.add(&r) {
            tracing::error!("cannot write crash report: {e}");
            return None;
        }
        let sev = match r.severity {
            pcc_recovery::Severity::Info => Severity::Info,
            pcc_recovery::Severity::Warning => Severity::Warning,
            pcc_recovery::Severity::Error => Severity::Error,
        };
        let mut e = Event::new(EventKind::SystemNotice, r.title.clone(), json!({"report": r}))
            .named("recovery.report")
            .with_severity(sev)
            .with_source("recovery");
        e.agent_id = r.agent_id.clone();
        e.mission_id = r.mission_id.clone();
        self.emit(e);
        Some(r.id)
    }

    /// Changes a report written earlier (e.g. adds what was restarted).
    pub(crate) fn amend_report(&mut self, id: Option<&str>, f: impl FnOnce(&mut CrashReport)) {
        let (Some(id), Some(store)) = (id, self.rec.reports.clone()) else { return };
        let Some(mut r) = store.list().into_iter().find(|r| r.id == id) else { return };
        f(&mut r);
        if let Err(e) = store.add(&r) {
            tracing::error!("cannot update crash report: {e}");
            return;
        }
        self.emit(
            Event::new(EventKind::SystemNotice, r.title.clone(), json!({"report": r, "updated": true}))
                .named("recovery.reportUpdated")
                .with_source("recovery"),
        );
    }

    pub fn crash_reports(&self) -> Vec<CrashReport> {
        self.rec.reports.as_ref().map(ReportStore::list).unwrap_or_default()
    }

    pub fn acknowledge_crash_report(&mut self, id: &str) -> Result<bool> {
        match &self.rec.reports {
            Some(s) => s.acknowledge(id),
            None => Ok(false),
        }
    }

    // ------------------------------------------------------------ checkpoints

    pub(crate) fn mission_of_agent(&self, agent: &str) -> Option<String> {
        if let Ok(Some(a)) = self.store.get_agent(agent) {
            if let Some(t) = a.current_task.and_then(|t| self.store.get_task(&t).ok().flatten()) {
                if t.mission_id.is_some() {
                    return t.mission_id;
                }
            }
        }
        if agent == CENTRAL_ID {
            return self.store.active_mission_ids().ok().and_then(|v| v.into_iter().next());
        }
        None
    }

    /// Most recent tool call of an agent at or after `since`.
    pub(crate) fn last_action_of(&self, agent: &str, since: &str) -> Option<LastAction> {
        if let Some(l) = self.rec.sessions.get(agent).and_then(|w| w.last_action.clone()) {
            if l.at.as_str() >= since {
                return Some(l);
            }
        }
        let logs = self.store.list_logs(agent, None, 400).ok()?;
        logs.iter().rev().filter(|l| l.kind == LogKind::ToolUse && l.ts.as_str() >= since).find_map(|l| {
            let (tool, description) = describe_logged_tool(&l.text)?;
            Some(LastAction { agent_id: agent.to_string(), tool, description, at: l.ts.clone() })
        })
    }

    /// Uncommitted files in an agent's own worktree (or the project folder).
    fn workdir_dirty(&self, a: &pcc_core::Agent) -> Vec<FileState> {
        if a.isolation == Isolation::Worktree && Path::new(&a.workdir).is_dir() {
            git_dirty(Path::new(&a.workdir), &a.id)
        } else if self.repo.is_some() {
            git_dirty(self.store.root(), "main")
        } else {
            Vec::new()
        }
    }

    /// Uncommitted files of the project and of the agents' worktrees.
    fn files_state(&self, agents: &[pcc_core::Agent], since: &str) -> Vec<FileState> {
        if self.repo.is_none() {
            return walk_modified(self.store.root(), ts_ms(since));
        }
        let mut files = git_dirty(self.store.root(), "main");
        for a in agents {
            if a.isolation == Isolation::Worktree && Path::new(&a.workdir).is_dir() {
                files.extend(git_dirty(Path::new(&a.workdir), &a.id));
            }
        }
        files.truncate(MAX_FILES);
        files
    }

    /// Where a mission stands right now.
    pub(crate) fn mission_record(&self, m: &Mission) -> Result<MissionRecord> {
        let tasks = self.store.list_tasks(&TaskFilter { mission_id: Some(m.id.clone()), ..Default::default() })?;
        let mut ids = vec![CENTRAL_ID.to_string()];
        for t in &tasks {
            if let Some(a) = &t.agent {
                if !ids.contains(a) {
                    ids.push(a.clone());
                }
            }
        }
        let since = m.started_at.clone().unwrap_or_else(|| m.created_at.clone());
        let agents: Vec<pcc_core::Agent> =
            ids.iter().filter_map(|id| self.store.get_agent(id).ok().flatten()).collect();
        let states: Vec<AgentState> = agents
            .iter()
            .map(|a| AgentState {
                agent_id: a.id.clone(),
                name: a.name.clone(),
                status: status_str(&a.status),
                current_task: a.current_task.clone(),
                current_action: a.current_action.clone(),
                claude_session_id: a.claude_session_id.clone(),
                workdir: Some(a.workdir.clone()),
                last_action: self.last_action_of(&a.id, &since),
            })
            .collect();
        let in_progress: Vec<String> = tasks
            .iter()
            .filter(|t| matches!(t.status, TaskStatus::InProgress | TaskStatus::Waiting | TaskStatus::Blocked))
            .map(|t| {
                format!(
                    "{} \"{}\"{}{}",
                    t.id,
                    t.title,
                    t.agent.as_ref().map(|a| format!(" ({a})")).unwrap_or_default(),
                    if t.status == TaskStatus::InProgress {
                        String::new()
                    } else {
                        format!(" [{}]", t.status.as_str())
                    }
                )
            })
            .collect();
        let current_step = if !in_progress.is_empty() {
            in_progress.join("; ")
        } else if m.status == MissionStatus::Planning {
            "Planning (Central)".into()
        } else if tasks.iter().any(|t| t.status == TaskStatus::Review) {
            "Waiting for review".into()
        } else if tasks.iter().any(|t| matches!(t.status, TaskStatus::Pending | TaskStatus::Queued)) {
            "Waiting for queued tasks to start".into()
        } else if m.status.is_closed() {
            format!("Mission {}", m.status.as_str())
        } else {
            "Coordinating (Central)".into()
        };
        let last_action = states.iter().filter_map(|s| s.last_action.clone()).max_by(|a, b| a.at.cmp(&b.at));
        Ok(MissionRecord {
            id: m.id.clone(),
            title: m.title.clone(),
            status: m.status.as_str().to_string(),
            current_step,
            agents: ids,
            dependencies: tasks
                .iter()
                .filter(|t| !t.dependencies.is_empty())
                .map(|t| (t.id.clone(), t.dependencies.clone()))
                .collect(),
            tasks: tasks
                .iter()
                .map(|t| TaskState {
                    id: t.id.clone(),
                    title: t.title.clone(),
                    status: t.status.as_str().to_string(),
                    agent: t.agent.clone(),
                    dependencies: t.dependencies.clone(),
                    progress: None,
                })
                .collect(),
            last_checkpoint: None,
            last_checkpoint_at: None,
            last_known_agent_states: states,
            files_changed: self.files_state(&agents, &since),
            last_action,
            git_head: self.repo.as_ref().and_then(|r| r.git(&["rev-parse", "HEAD"]).ok()).map(|s| s.trim().to_string()),
            created_at: m.created_at.clone(),
            updated_at: pcc_core::now(),
        })
    }

    /// Writes a checkpoint of a mission. Never fails the caller: errors are logged.
    pub fn checkpoint_mission(&mut self, id: &str, reason: &str, force: bool) -> Option<pcc_recovery::Checkpoint> {
        let files = self.rec.missions.clone()?;
        let m = self.store.get_mission(id).ok().flatten()?;
        if m.status == MissionStatus::Queued {
            return None;
        }
        let record = match self.mission_record(&m) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("checkpoint of {id} skipped: {e}");
                return None;
            }
        };
        match files.write(record, reason, force) {
            Ok(cp) => cp,
            Err(e) => {
                tracing::warn!("cannot write checkpoint of {id}: {e}");
                None
            }
        }
    }

    /// Checkpoints every running mission (before/after merges, periodically).
    pub(crate) fn checkpoint_active_missions(&mut self, reason: &str, force: bool) {
        for id in self.store.active_mission_ids().unwrap_or_default() {
            self.checkpoint_mission(&id, reason, force);
        }
    }

    pub fn mission_checkpoints(&self, id: &str) -> Vec<CheckpointSummary> {
        self.rec.missions.as_ref().map(|m| m.list(id)).unwrap_or_default()
    }

    pub fn mission_checkpoint(&self, id: &str, seq: Option<u32>) -> Option<pcc_recovery::Checkpoint> {
        let m = self.rec.missions.as_ref()?;
        match seq {
            Some(s) => m.checkpoint(id, s),
            None => m.current(id),
        }
    }

    // ------------------------------------------------------------ interrupted missions

    /// At open: missions that were running when the previous NEXUS stopped.
    pub(crate) fn detect_interrupted_missions(&mut self) -> Result<()> {
        if self.store.read_only() {
            return Ok(());
        }
        let previous = self.rec.previous_run_text();
        let mut found = Vec::new();
        for mv in self.store.list_missions()? {
            let m = mv.mission;
            if !matches!(m.status, MissionStatus::Planning | MissionStatus::Active) || m.archived_at.is_some() {
                continue;
            }
            let now = self.mission_record(&m)?;
            let checkpoint = self.rec.missions.as_ref().and_then(|f| f.current(&m.id));
            let written: Vec<String> = match &checkpoint {
                Some(cp) => written_since(&cp.mission.files_changed, &now.files_changed),
                None => now.files_changed.clone(),
            }
            .iter()
            .map(FileState::label)
            .collect();
            let files_note = match (&checkpoint, written.is_empty()) {
                (Some(_), true) => "No file was written since the last checkpoint.".to_string(),
                (Some(cp), false) => format!(
                    "{} file(s) written since the last checkpoint ({}, {}): {}",
                    written.len(),
                    cp.name,
                    clock(&cp.at),
                    file_list(&written, 12)
                ),
                (None, true) => "No checkpoint was recorded and no uncommitted file was found.".to_string(),
                (None, false) => format!(
                    "No checkpoint was recorded; {} uncommitted file(s): {}",
                    written.len(),
                    file_list(&written, 12)
                ),
            };
            let summary = self.rec.missions.as_ref().and_then(|f| f.list(&m.id).into_iter().next());
            let tasks_in_progress: Vec<TaskState> = now
                .tasks
                .iter()
                .filter(|t| matches!(t.status.as_str(), "in_progress" | "waiting" | "blocked"))
                .cloned()
                .collect();
            let mut im = InterruptedMission {
                mission_id: m.id.clone(),
                title: m.title.clone(),
                status: now.status.clone(),
                interrupted_during: now.current_step.clone(),
                last_action: now.last_action.clone(),
                files_since_checkpoint: written,
                files_note,
                last_checkpoint: summary,
                tasks_in_progress,
                agents: now.last_known_agent_states.clone(),
                previous_run: previous.clone(),
                brief: String::new(),
            };
            im.brief = mission_brief(&im, &now);
            found.push(im);
        }
        if found.is_empty() {
            return Ok(());
        }
        self.rec.interrupted = found.clone();
        let info = self.recovery.get_or_insert_with(Default::default);
        info.missions = found.clone();
        info.previous_run = Some(previous.clone());

        let unexpected = matches!(self.rec.previous_run, PreviousRun::Unexpected { .. });
        let mut r = CrashReport::new(
            "nexus",
            if unexpected { "NEXUS recovered from an unexpected failure" } else { "Missions interrupted by a restart" },
        );
        r.severity = if unexpected { pcc_recovery::Severity::Error } else { pcc_recovery::Severity::Warning };
        r.project = Some(self.store.root().to_string_lossy().into_owned());
        r.what_happened = match &self.rec.previous_run {
            PreviousRun::Unexpected { pid, started_at } => format!(
                "The NEXUS instance (pid {pid}, started {}) ended without closing while {} mission(s) were running.",
                clock(started_at),
                found.len()
            ),
            _ => format!("{previous} while {} mission(s) were running.", found.len()),
        };
        r.possible_cause = if unexpected {
            format!(
                "The application crashed, was killed ({}) or {} or lost power. The exact cause is not recorded by NEXUS; see the application log of the previous run.",
                pcc_platform::external_kill_examples(),
                pcc_platform::os_restart_phrase()
            )
        } else {
            "NEXUS was closed by the user while agents were working.".into()
        };
        for im in &found {
            r.details.push(format!("{} \"{}\": interrupted during {}", im.mission_id, im.title, im.interrupted_during));
            if let Some(l) = &im.last_action {
                r.details.push(format!("  last action: {} — {} ({})", l.agent_id, l.description, clock(&l.at)));
            }
            r.details.push(format!("  {}", im.files_note));
            r.preserved.push(format!(
                "{}: tasks, plan and {}",
                im.mission_id,
                im.last_checkpoint
                    .as_ref()
                    .map(|c| format!("checkpoint {} ({})", c.name, clock(&c.at)))
                    .unwrap_or_else(|| "agent states".into())
            ));
        }
        let sessions = self
            .recovery
            .as_ref()
            .map(|i| i.agents.iter().filter(|a| a.claude_session_id.is_some()).count())
            .unwrap_or(0);
        if sessions > 0 {
            r.preserved.push(format!("{sessions} Claude conversation(s), resumable with --resume"));
        }
        r.preserved.push("Uncommitted files on disk (nothing is reverted)".into());
        r.lost.push(
            "Turns that were in progress at the moment of the interruption (agents are told to check and continue)"
                .into(),
        );
        r.lost.push("Pending permission prompts of the previous sessions (agents ask again)".into());
        self.rec.startup_report = self.file_report(r);
        Ok(())
    }

    /// Brief for an agent resumed after a restart (replaces the generic note).
    pub(crate) fn resume_note(&self, ra: &RecoveryAgent) -> String {
        let previous = self.rec.previous_run_text();
        if ra.agent_id == CENTRAL_ID {
            let mut s = format!("[RECOVERY] {previous}. Your Claude Code session was resumed.\n");
            if self.rec.interrupted.is_empty() {
                s.push_str("No mission was running. Review the current state with list_tasks and list_agents and continue coordinating.");
            } else {
                for im in &self.rec.interrupted {
                    s.push('\n');
                    s.push_str(&im.brief);
                    s.push('\n');
                }
                s.push_str("\nReview the state with list_tasks and list_agents, verify the files listed above, then continue coordinating. Do not redo completed work.");
            }
            return s;
        }
        let since = self
            .rec
            .interrupted
            .iter()
            .filter_map(|m| m.last_checkpoint.as_ref().map(|c| c.at.clone()))
            .min()
            .unwrap_or_default();
        let mut s = format!("[RECOVERY] {previous}. Your Claude Code session was resumed.\n");
        match &ra.task_id {
            Some(t) => {
                let title = self.store.get_task(t).ok().flatten().map(|t| t.title).unwrap_or_default();
                s.push_str(&format!("You were working on {t} \"{title}\".\n"));
            }
            None => s.push_str("You had no task in progress.\n"),
        }
        if let Some(l) = self.last_action_of(&ra.agent_id, &since) {
            s.push_str(&format!("Your last recorded action: {} ({}, {}).\n", l.description, l.tool, clock(&l.at)));
        }
        if let Ok(a) = self.store.agent(&ra.agent_id) {
            let dirty: Vec<String> = self.workdir_dirty(&a).iter().map(FileState::label).collect();
            if dirty.is_empty() {
                s.push_str("Your workspace has no uncommitted file.\n");
            } else {
                s.push_str(&format!("Uncommitted files in your workspace: {}.\n", file_list(&dirty, 15)));
            }
        }
        s.push_str(match &ra.task_id {
            Some(_) => "Check those files, continue where you left off, then report with complete_task / block_task / fail_task.",
            None => "Continue where you left off.",
        });
        s
    }

    /// After `recover()` (or a mission resume): checkpoint and report.
    pub(crate) fn rec_after_recover(&mut self, restarted: &[String]) {
        let missions: Vec<String> = self.rec.interrupted.drain(..).map(|m| m.mission_id).collect();
        for id in &missions {
            self.checkpoint_mission(id, "resumed after interruption", true);
        }
        let id = self.rec.startup_report.take();
        let restarted = restarted.to_vec();
        self.amend_report(id.as_deref(), |r| {
            r.restarted.extend(
                restarted.iter().map(|a| format!("{a}: Claude session resumed (--resume) with a recovery brief")),
            );
            for m in &missions {
                r.restarted.push(format!("{m}: resumed"));
            }
        });
    }

    /// "Resume" on an interrupted mission.
    pub fn resume_mission(&mut self, id: &str) -> Result<()> {
        if !self.rec.interrupted.iter().any(|m| m.mission_id == id) {
            return Err(pcc_core::Error::invalid(format!("{id} is not waiting for a recovery decision")));
        }
        // The resume service: sessions brought back, Central briefed with a
        // verified report (same flow as "reprends" and the automatic resume).
        self.resume_mission_flow(id, "user", None).map(|_| ())
    }

    /// "Abandon" on an interrupted mission: the mission is cancelled.
    pub fn abandon_mission(&mut self, id: &str) -> Result<()> {
        if !self.rec.interrupted.iter().any(|m| m.mission_id == id) {
            return Err(pcc_core::Error::invalid(format!("{id} is not waiting for a recovery decision")));
        }
        self.checkpoint_mission(id, "abandoned after interruption", true);
        self.cancel_mission(id)?;
        self.rec.interrupted.retain(|m| m.mission_id != id);
        if let Some(info) = self.recovery.as_mut() {
            info.missions.retain(|m| m.mission_id != id);
        }
        if self.recovery.as_ref().is_some_and(|r| r.agents.is_empty() && r.missions.is_empty()) {
            self.recovery = None;
        }
        let report = self.rec.startup_report.clone();
        let mid = id.to_string();
        self.amend_report(report.as_deref(), |r| r.lost.push(format!("{mid}: abandoned by the user (cancelled)")));
        Ok(())
    }

    /// Marks this instance closed cleanly (called from `shutdown`).
    pub(crate) fn rec_clean_exit(&mut self) {
        for id in self.rec.sessions.keys().cloned().collect::<Vec<_>>() {
            self.rec.registry.ended(&session_key(&id), false, None, Some("NEXUS closed".into()));
        }
        self.rec.registry.flush();
        if let Some(f) = &self.rec.instance_file {
            pcc_recovery::reports::end_instance(f);
        }
    }

    // ------------------------------------------------------------ orphans

    /// Inputs of an orphan scan (the scan itself is slow and runs without the engine lock).
    /// `None` when scanning is off (read-only project, `NEXUS_ORPHAN_SCAN=off`).
    pub fn orphan_scan_input(&self) -> Option<OrphanScanInput> {
        let off = std::env::var("NEXUS_ORPHAN_SCAN")
            .is_ok_and(|v| matches!(v.to_ascii_lowercase().as_str(), "off" | "0" | "false"));
        if off || self.store.read_only() {
            return None;
        }
        Some(OrphanScanInput {
            agent_dir: self.store.layout().dir.to_string_lossy().into_owned(),
            live_pids: self.sessions.values().map(|l| l.handle.pid).collect(),
            previous: self.rec.previous_processes.clone(),
        })
    }

    pub fn set_orphans(&mut self, orphans: Vec<Orphan>) {
        if !orphans.is_empty() && orphans != self.rec.orphans {
            self.emit(
                Event::new(
                    EventKind::SystemNotice,
                    format!("{} process(es) left by a previous NEXUS run were found", orphans.len()),
                    json!({"orphans": orphans}),
                )
                .named("recovery.orphansFound")
                .with_severity(Severity::Warning)
                .with_source("recovery"),
            );
        }
        self.rec.orphans = orphans;
        self.rec.orphans_scanned_at = Some(pcc_core::now());
    }

    /// Context for cleaning up an orphan: its agent's workspace and session.
    pub fn orphan_context(&self, pid: u32) -> Result<(Orphan, Option<PathBuf>, Option<String>)> {
        let o = self
            .rec
            .orphans
            .iter()
            .find(|o| o.pid == pid)
            .cloned()
            .ok_or_else(|| pcc_core::Error::not_found(format!("orphan process {pid}")))?;
        let a = o.agent_id.as_ref().and_then(|id| self.store.get_agent(id).ok().flatten());
        Ok((o, a.as_ref().map(|a| PathBuf::from(&a.workdir)), a.and_then(|a| a.claude_session_id)))
    }

    /// Records the outcome of a cleanup (report, list update).
    pub fn record_orphan_cleanup(&mut self, outcome: OrphanCleanup) {
        if outcome.terminated || outcome.already_gone {
            self.rec.orphans.retain(|o| o.pid != outcome.orphan.pid);
        }
        let mut r = CrashReport::new("orphans", format!("Orphan process {} cleaned up", outcome.orphan.pid));
        r.severity = pcc_recovery::Severity::Info;
        r.agent_id = outcome.orphan.agent_id.clone();
        r.project = Some(self.store.root().to_string_lossy().into_owned());
        r.what_happened = format!(
            "{} (pid {}) was left running by a previous NEXUS run. {}",
            outcome.orphan.label, outcome.orphan.pid, outcome.orphan.reason
        );
        r.possible_cause = "The previous NEXUS instance ended without stopping it (crash or kill) and the process was outside the job object.".into();
        r.details = outcome.steps.iter().map(|s| format!("{}: {}", s.step, s.outcome)).collect();
        if let Some(sid) = &outcome.session_id {
            r.preserved.push(format!("Claude conversation {sid} (resumable with --resume)"));
        }
        if !outcome.modified_files.is_empty() {
            r.preserved.push(format!(
                "{} uncommitted file(s) left on disk: {}",
                outcome.modified_files.len(),
                file_list(&outcome.modified_files, 8)
            ));
        }
        if outcome.terminated {
            r.lost.push("Whatever that process was still doing (it had no NEXUS to report to)".into());
        }
        self.file_report(r);
    }

    // ------------------------------------------------------------ views

    pub fn recovery_state(&self) -> RecoveryState {
        let watch = self
            .rec
            .sessions
            .iter()
            .map(|(agent, w)| WatchStatus {
                agent_id: agent.clone(),
                pid: w.pid,
                verdict: w.diagnosis.as_ref().map(|d| d.verdict),
                reason: w.diagnosis.as_ref().map(|d| d.reason.clone()),
                since_output_secs: w.last_output.elapsed().as_secs(),
                inflight_tool: w.oldest_inflight().map(|(n, t)| format!("{n} ({}s)", t.elapsed().as_secs())),
                soft_recovery_sent: w.soft_at.is_some(),
                last_action: w.last_action.clone(),
                checked_at: w.checked_at.clone(),
                automatic_restarts: self.rec.restarts.get(agent).map(|v| v.len()).unwrap_or(0),
            })
            .collect();
        let crashed = self
            .rec
            .crashed
            .iter()
            .map(|(a, c)| CrashedAgent {
                agent_id: a.clone(),
                exit_code: c.code,
                busy: c.busy,
                since_secs: c.at.elapsed().as_secs(),
                restart_capped: c.capped,
                report_id: c.report_id.clone(),
            })
            .collect();
        RecoveryState {
            previous_run: self.rec.previous_run.clone(),
            previous_run_text: self.rec.previous_run_text(),
            interrupted_missions: self.rec.interrupted.clone(),
            orphans: self.rec.orphans.clone(),
            orphans_scanned_at: self.rec.orphans_scanned_at.clone(),
            watch,
            crashed,
            last_tick: self.rec.last_tick.clone(),
            unacknowledged_reports: self.crash_reports().iter().filter(|r| !r.acknowledged).count(),
        }
    }

    /// Project processes from the registry.
    pub fn project_processes(&self) -> Vec<ProcessRecord> {
        self.rec.registry.list()
    }

    /// Running sessions: (agent, pid).
    pub fn session_pids(&self) -> Vec<(String, u32)> {
        let mut v: Vec<(String, u32)> = self.sessions.iter().map(|(a, l)| (a.clone(), l.handle.pid)).collect();
        v.sort();
        v
    }

    pub fn mcp_health(&self) -> Vec<McpHealth> {
        self.rec.mcp.values().cloned().collect()
    }

    pub fn mcp_probes(&self) -> Vec<ProbeRecord> {
        self.rec.probes.values().cloned().collect()
    }

    pub fn record_probe(&mut self, mut p: ProbeRecord) {
        p.probes = self.rec.probes.get(&p.connection_id).map(|x| x.probes).unwrap_or(0) + 1;
        self.rec.probes.insert(p.connection_id.clone(), p);
    }

    /// Agents whose sessions have this MCP server, for the "Restart" action.
    pub fn mcp_sessions_with(&self, server: &str) -> Vec<String> {
        self.rec.mcp.keys().filter(|(_, s)| s == server).map(|(a, _)| a.clone()).collect()
    }

    pub(crate) fn has_active_mission(&self) -> bool {
        self.store.active_mission_ids().map(|v| !v.is_empty()).unwrap_or(false)
    }

    pub(crate) fn agent_status(&self, id: &str) -> Option<AgentStatus> {
        self.store.get_agent(id).ok().flatten().map(|a| a.status)
    }
}

/// Brief of an interrupted mission for Central and the dialog.
fn mission_brief(im: &InterruptedMission, now: &MissionRecord) -> String {
    let mut s = format!(
        "[RECOVERY] Mission {} \"{}\" was interrupted: {}.\nInterrupted during: {}\n",
        im.mission_id, im.title, im.previous_run, im.interrupted_during
    );
    match &im.last_action {
        Some(l) => s.push_str(&format!("Last action: {} — {} ({})\n", l.agent_id, l.description, clock(&l.at))),
        None => s.push_str("Last action: no tool call recorded for this mission\n"),
    }
    s.push_str(&im.files_note);
    s.push('\n');
    let tasks: Vec<String> = now
        .tasks
        .iter()
        .map(|t| format!("{} {}{}", t.id, t.status, t.agent.as_ref().map(|a| format!(" ({a})")).unwrap_or_default()))
        .collect();
    if !tasks.is_empty() {
        s.push_str(&format!("Tasks: {}\n", tasks.join(", ")));
    }
    s
}

/// Reading of an unexpected exit for the report.
fn crash_cause(code: Option<i32>, stderr: &[String]) -> String {
    let text = stderr.join("\n").to_ascii_lowercase();
    let hint = if text.contains("rate limit") || text.contains("429") {
        Some("Claude API rate limit or usage limit reached.")
    } else if text.contains("auth") || text.contains("401") || text.contains("login") {
        Some("Claude Code authentication problem (sign in again with `claude auth login`).")
    } else if text.contains("econn")
        || text.contains("network")
        || text.contains("enotfound")
        || text.contains("timed out")
    {
        Some("Network error while talking to the Claude API.")
    } else if text.contains("heap") || text.contains("out of memory") {
        Some("Claude Code ran out of memory.")
    } else {
        None
    };
    match (hint, code) {
        (Some(h), _) => h.to_string(),
        (None, None) => format!(
            "The process was terminated from outside ({}) or crashed without an exit code.",
            pcc_platform::external_kill_examples()
        ),
        (None, Some(c)) => format!("Claude Code exited with code {c} without an error message NEXUS recognises; see the last stderr lines below."),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub agent_id: String,
    pub pid: u32,
    pub verdict: Option<pcc_recovery::Verdict>,
    pub reason: Option<String>,
    pub since_output_secs: u64,
    pub inflight_tool: Option<String>,
    pub soft_recovery_sent: bool,
    pub last_action: Option<LastAction>,
    pub checked_at: Option<String>,
    pub automatic_restarts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrashedAgent {
    pub agent_id: String,
    pub exit_code: Option<i32>,
    pub busy: bool,
    pub since_secs: u64,
    pub restart_capped: bool,
    pub report_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryState {
    pub previous_run: PreviousRun,
    pub previous_run_text: String,
    pub interrupted_missions: Vec<InterruptedMission>,
    pub orphans: Vec<Orphan>,
    pub orphans_scanned_at: Option<String>,
    pub watch: Vec<WatchStatus>,
    pub crashed: Vec<CrashedAgent>,
    pub last_tick: Option<String>,
    pub unacknowledged_reports: usize,
}

#[derive(Debug, Clone)]
pub struct OrphanScanInput {
    pub agent_dir: String,
    pub live_pids: HashSet<u32>,
    pub previous: Vec<ProcessRecord>,
}

/// Finds orphans: registry records of the previous run still alive, and
/// Claude Code processes of this project without a NEXUS parent. Blocking
/// (queries command lines); run it off the async runtime.
pub fn scan_orphans(input: &OrphanScanInput, query_command_lines: bool) -> Vec<Orphan> {
    use pcc_recovery::sys;
    let me = sys::current_pid();
    let table = sys::list_processes();
    let name_of = |pid: u32| table.iter().find(|p| p.pid == pid).map(|p| p.name.clone());
    let is_nexus = |pid: u32| {
        name_of(pid).is_some_and(|n| {
            let n = n.to_ascii_lowercase();
            n.contains("projectcontrolcenter") || n.contains("project-control-center") || n.contains("nexus")
        })
    };
    let mut out = pcc_recovery::orphans::from_snapshot(&input.previous, me, &sys::process_info, &name_of, &|p| {
        sys::pid_alive(p) && is_nexus(p)
    });
    if query_command_lines {
        match sys::command_lines(&["claude.exe", "node.exe"], std::time::Duration::from_secs(20)) {
            Ok(procs) => {
                for o in pcc_recovery::orphans::unowned_sessions(&procs, &input.agent_dir, me, &input.live_pids, &|p| {
                    sys::pid_alive(p) && is_nexus(p)
                }) {
                    if !out.iter().any(|x| x.pid == o.pid) {
                        out.push(o);
                    }
                }
            }
            Err(e) => tracing::warn!("orphan scan: {e}"),
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanCleanup {
    pub orphan: Orphan,
    pub steps: Vec<pcc_recovery::orphans::CleanupStep>,
    pub terminated: bool,
    pub already_gone: bool,
    pub modified_files: Vec<String>,
    pub session_id: Option<String>,
}

/// Cleans up one orphan following the rules: state check, soft attempt,
/// recorded reason, saved context, modified-files check, then termination.
/// Blocking (waits a few seconds for the soft attempt).
pub fn cleanup_orphan(orphan: &Orphan, workdir: Option<&Path>, session_id: Option<String>) -> OrphanCleanup {
    use pcc_recovery::orphans::CleanupStep;
    use pcc_recovery::sys;
    let mut steps = Vec::new();
    let step =
        |steps: &mut Vec<CleanupStep>, s: &str, o: String| steps.push(CleanupStep { step: s.into(), outcome: o });
    let mut out = OrphanCleanup {
        orphan: orphan.clone(),
        steps: Vec::new(),
        terminated: false,
        already_gone: false,
        modified_files: Vec::new(),
        session_id: session_id.clone(),
    };
    // 1. State check: still the same process?
    let info = sys::process_info(orphan.pid);
    let same = match &info {
        None => false,
        Some(i) => sys::same_start(orphan.os_start_ms, i.created_ms).unwrap_or(true),
    };
    if !same {
        step(
            &mut steps,
            "State check",
            "the process is gone (or its PID now belongs to another process): nothing to do".into(),
        );
        out.already_gone = true;
        out.steps = steps;
        return out;
    }
    step(
        &mut steps,
        "State check",
        format!(
            "pid {} is still running{}",
            orphan.pid,
            info.and_then(|i| i.cpu_ms).map(|c| format!(", {:.1}s CPU used", c as f64 / 1000.0)).unwrap_or_default()
        ),
    );
    // 2. Reason recorded.
    step(&mut steps, "Reason", orphan.reason.clone());
    // 3. Context saved.
    step(
        &mut steps,
        "Context",
        match &session_id {
            Some(s) => format!("Claude conversation {s} is stored; the agent can resume it with --resume"),
            None => "no Claude conversation is associated with this process".into(),
        },
    );
    // 4. Modified files.
    if let Some(dir) = workdir.filter(|d| d.is_dir()) {
        out.modified_files = git_dirty(dir, "main").iter().map(FileState::label).collect();
        step(
            &mut steps,
            "Modified files",
            if out.modified_files.is_empty() {
                format!("no uncommitted file in {}", dir.display())
            } else {
                format!(
                    "{} uncommitted file(s) kept on disk: {}",
                    out.modified_files.len(),
                    file_list(&out.modified_files, 8)
                )
            },
        );
    } else {
        step(&mut steps, "Modified files", "no workspace associated with this process".into());
    }
    // 5. Soft attempt: ask the process tree to close.
    pcc_platform::process::kill_tree(orphan.pid, false);
    let deadline = Instant::now() + std::time::Duration::from_secs(4);
    while Instant::now() < deadline && sys::pid_alive(orphan.pid) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    if !sys::pid_alive(orphan.pid) {
        step(&mut steps, "Soft stop", "the process closed when asked".into());
        out.terminated = true;
        out.steps = steps;
        return out;
    }
    step(
        &mut steps,
        "Soft stop",
        if cfg!(windows) {
            "no reaction within 4 s (console processes without a window ignore close requests)".into()
        } else {
            "no reaction to SIGTERM within 4 s".into()
        },
    );
    // 6. Termination of the process tree.
    let r = pcc_platform::process::kill_tree(orphan.pid, true);
    std::thread::sleep(std::time::Duration::from_millis(300));
    out.terminated = !sys::pid_alive(orphan.pid);
    step(
        &mut steps,
        "Terminate",
        match (out.terminated, r) {
            (true, _) => "process tree terminated".into(),
            (false, true) => "could not terminate: the process is still running after the kill request".into(),
            (false, false) => "could not terminate: the kill request was refused (access denied?)".into(),
        },
    );
    out.steps = steps;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logged_tool_lines_are_described() {
        let (t, d) = describe_logged_tool(r#"Read {"file_path":"C:\\p\\src\\Formation.luau"}"#).unwrap();
        assert_eq!((t.as_str(), d.as_str()), ("Read", "Reading Formation.luau"));
        // Cut JSON (long input) still yields the description.
        let (_, d) =
            describe_logged_tool(r#"↳ Bash {"command":"npm test","description":"Run the tests","x":"aaaa…"#).unwrap();
        assert_eq!(d, "Running Run the tests");
        let (t, d) = describe_logged_tool(r#"mcp__Roblox_Studio__get_script {"path":"Workspace.X.Script"}"#).unwrap();
        assert_eq!(t, "mcp__Roblox_Studio__get_script");
        assert_eq!(d, "Using Roblox_Studio → get_script");
        assert!(describe_logged_tool("").is_none());
    }

    #[test]
    fn causes_are_read_from_stderr() {
        assert!(crash_cause(Some(1), &["Error: 429 rate limit".into()]).contains("rate limit"));
        assert!(crash_cause(None, &[]).contains("terminated from outside"));
        assert!(crash_cause(Some(3), &["boom".into()]).contains("code 3"));
    }

    #[test]
    fn walk_finds_recent_files_only() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("node_modules")).unwrap();
        std::fs::write(tmp.path().join("node_modules/x.js"), "x").unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/a.txt"), "x").unwrap();
        let found = walk_modified(tmp.path(), 0);
        assert_eq!(found.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["src/a.txt"]);
        assert!(walk_modified(tmp.path(), u64::MAX).is_empty());
    }
}
