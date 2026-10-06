//! Registry of the processes NEXUS depends on: Claude Code sessions, the AI
//! Town backend, MCP servers it starts or probes, local AI runtimes, SSH
//! sessions and terminals. Each record carries the facts the watchdog and the
//! recovery need (PID and its OS start time, heartbeat, last event, state,
//! owner, mission/agent, restart history). The registry is persisted, so a
//! restarted NEXUS knows what was running before.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProcessKind {
    ClaudeSession,
    AiTown,
    AiTownBackend,
    McpServer,
    LocalAi,
    Ssh,
    Pty,
    Other,
}

impl ProcessKind {
    pub fn label(self) -> &'static str {
        match self {
            ProcessKind::ClaudeSession => "Claude Code session",
            ProcessKind::AiTown => "AI Town (convex dev)",
            ProcessKind::AiTownBackend => "AI Town backend",
            ProcessKind::McpServer => "MCP server",
            ProcessKind::LocalAi => "Local AI runtime",
            ProcessKind::Ssh => "SSH session",
            ProcessKind::Pty => "Terminal",
            ProcessKind::Other => "Process",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Starting,
    Running,
    /// Working (a Claude turn, a request being served).
    Busy,
    Idle,
    /// No sign of life within its heartbeat timeout; being diagnosed.
    Unresponsive,
    /// A soft recovery or a restart is in progress.
    Recovering,
    /// Ended normally (stopped on purpose).
    Exited,
    /// Ended unexpectedly.
    Crashed,
}

impl ProcessState {
    pub fn is_ended(self) -> bool {
        matches!(self, ProcessState::Exited | ProcessState::Crashed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestartRecord {
    pub at: String,
    pub reason: String,
    /// `restarted`, `reconnected`, `interrupted`, `failed: ...`, `skipped: ...`
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRecord {
    /// Stable key (`claude:<project>:<agent>`, `aitown:convex`, `localai:<id>`...).
    pub key: String,
    pub kind: ProcessKind,
    pub label: String,
    pub pid: Option<u32>,
    pub parent_pid: Option<u32>,
    /// OS creation time of `pid` (ms since epoch), to detect PID reuse.
    pub os_start_ms: Option<u64>,
    /// Image name expected for `pid` (`claude.exe`, `node.exe`...), when known.
    pub image: Option<String>,
    /// NEXUS process that registered it.
    pub owner_pid: u32,
    pub started_at: String,
    /// Last sign of life (stdout line, ping, health check).
    pub heartbeat_at: Option<String>,
    pub heartbeat_source: Option<String>,
    pub last_event: Option<String>,
    pub state: ProcessState,
    pub state_detail: Option<String>,
    pub project: Option<String>,
    pub mission_id: Option<String>,
    pub agent_id: Option<String>,
    pub restart_count: u32,
    #[serde(default)]
    pub restarts: Vec<RestartRecord>,
    /// Short description of what was started (never contains secrets).
    pub command: Option<String>,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
}

/// What a component tells the registry when it starts a process.
#[derive(Debug, Clone, Default)]
pub struct Registration {
    pub kind: Option<ProcessKind>,
    pub label: String,
    pub pid: Option<u32>,
    pub parent_pid: Option<u32>,
    pub image: Option<String>,
    pub project: Option<String>,
    pub mission_id: Option<String>,
    pub agent_id: Option<String>,
    pub command: Option<String>,
}

impl Registration {
    pub fn new(kind: ProcessKind, label: impl Into<String>) -> Self {
        Registration { kind: Some(kind), label: label.into(), ..Default::default() }
    }
    pub fn pid(mut self, pid: Option<u32>) -> Self {
        self.pid = pid.filter(|p| *p != 0);
        self
    }
    pub fn parent(mut self, pid: u32) -> Self {
        self.parent_pid = Some(pid);
        self
    }
    pub fn image(mut self, image: impl Into<String>) -> Self {
        self.image = Some(image.into());
        self
    }
    pub fn project(mut self, root: &Path) -> Self {
        self.project = Some(root.to_string_lossy().into_owned());
        self
    }
    pub fn agent(mut self, id: impl Into<String>) -> Self {
        self.agent_id = Some(id.into());
        self
    }
    pub fn mission(mut self, id: Option<String>) -> Self {
        self.mission_id = id;
        self
    }
    pub fn command(mut self, c: impl Into<String>) -> Self {
        self.command = Some(c.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySnapshot {
    pub written_at: String,
    pub owner_pid: u32,
    pub processes: Vec<ProcessRecord>,
}

/// Ended records kept for history.
const KEEP_ENDED: usize = 60;
/// Heartbeats are persisted at most this often (structural changes immediately).
const HEARTBEAT_FLUSH: Duration = Duration::from_secs(10);
const MAX_RESTART_HISTORY: usize = 20;

struct Inner {
    records: BTreeMap<String, ProcessRecord>,
    path: Option<PathBuf>,
    last_flush: Option<Instant>,
    dirty: bool,
}

/// Thread-safe registry; cloning shares it.
#[derive(Clone)]
pub struct ProcessRegistry {
    inner: Arc<Mutex<Inner>>,
}

impl Default for ProcessRegistry {
    fn default() -> Self {
        Self::in_memory()
    }
}

impl ProcessRegistry {
    pub fn in_memory() -> Self {
        ProcessRegistry {
            inner: Arc::new(Mutex::new(Inner { records: BTreeMap::new(), path: None, last_flush: None, dirty: false })),
        }
    }

    /// A registry persisted to `path` (`processes.json`).
    pub fn persisted(path: PathBuf) -> Self {
        let r = Self::in_memory();
        r.set_path(path);
        r
    }

    pub fn set_path(&self, path: PathBuf) {
        let mut g = self.lock();
        g.path = Some(path);
        g.dirty = true;
        flush(&mut g);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Adds or replaces a running process. A key registered again (a restart)
    /// keeps its restart history.
    pub fn register(&self, key: &str, reg: Registration) -> ProcessRecord {
        let now = pcc_core::now();
        let os_start_ms = reg.pid.and_then(crate::sys::process_info).and_then(|i| i.created_ms);
        let mut g = self.lock();
        let previous = g.records.remove(key);
        let rec = ProcessRecord {
            key: key.to_string(),
            kind: reg.kind.unwrap_or(ProcessKind::Other),
            label: reg.label,
            pid: reg.pid,
            parent_pid: reg.parent_pid.or(Some(crate::sys::current_pid())),
            os_start_ms,
            image: reg.image,
            owner_pid: crate::sys::current_pid(),
            started_at: now.clone(),
            heartbeat_at: Some(now),
            heartbeat_source: Some("started".into()),
            last_event: Some("started".into()),
            state: ProcessState::Starting,
            state_detail: None,
            project: reg.project,
            mission_id: reg.mission_id,
            agent_id: reg.agent_id,
            restart_count: previous.as_ref().map(|p| p.restart_count).unwrap_or(0),
            restarts: previous.map(|p| p.restarts).unwrap_or_default(),
            command: reg.command,
            ended_at: None,
            exit_code: None,
        };
        g.records.insert(key.to_string(), rec.clone());
        g.dirty = true;
        flush(&mut g);
        rec
    }

    /// Records a sign of life.
    pub fn heartbeat(&self, key: &str, source: &str, event: Option<&str>) {
        let mut g = self.lock();
        let Some(r) = g.records.get_mut(key) else { return };
        r.heartbeat_at = Some(pcc_core::now());
        if r.heartbeat_source.as_deref() != Some(source) {
            r.heartbeat_source = Some(source.to_string());
        }
        if let Some(e) = event {
            r.last_event = Some(e.chars().take(200).collect());
        }
        if r.state == ProcessState::Starting || r.state == ProcessState::Unresponsive {
            r.state = ProcessState::Running;
            r.state_detail = None;
        }
        g.dirty = true;
        if g.last_flush.is_none_or(|t| t.elapsed() >= HEARTBEAT_FLUSH) {
            flush(&mut g);
        }
    }

    pub fn set_state(&self, key: &str, state: ProcessState, detail: Option<String>) {
        let mut g = self.lock();
        let Some(r) = g.records.get_mut(key) else { return };
        if r.state == state && r.state_detail == detail {
            return;
        }
        r.state = state;
        r.state_detail = detail;
        g.dirty = true;
        flush(&mut g);
    }

    pub fn set_mission(&self, key: &str, mission: Option<String>) {
        let mut g = self.lock();
        if let Some(r) = g.records.get_mut(key) {
            if r.mission_id != mission {
                r.mission_id = mission;
                g.dirty = true;
            }
        }
    }

    pub fn record_restart(&self, key: &str, reason: &str, outcome: &str) {
        let mut g = self.lock();
        let Some(r) = g.records.get_mut(key) else { return };
        r.restart_count += 1;
        r.restarts.push(RestartRecord { at: pcc_core::now(), reason: reason.into(), outcome: outcome.into() });
        let excess = r.restarts.len().saturating_sub(MAX_RESTART_HISTORY);
        r.restarts.drain(..excess);
        g.dirty = true;
        flush(&mut g);
    }

    /// Marks the process ended; the record stays for history.
    pub fn ended(&self, key: &str, crashed: bool, exit_code: Option<i32>, detail: Option<String>) {
        let mut g = self.lock();
        let Some(r) = g.records.get_mut(key) else { return };
        r.state = if crashed { ProcessState::Crashed } else { ProcessState::Exited };
        r.state_detail = detail;
        r.exit_code = exit_code;
        r.ended_at = Some(pcc_core::now());
        prune(&mut g.records);
        g.dirty = true;
        flush(&mut g);
    }

    /// Forgets a record entirely.
    pub fn unregister(&self, key: &str) {
        let mut g = self.lock();
        if g.records.remove(key).is_some() {
            g.dirty = true;
            flush(&mut g);
        }
    }

    pub fn get(&self, key: &str) -> Option<ProcessRecord> {
        self.lock().records.get(key).cloned()
    }

    pub fn list(&self) -> Vec<ProcessRecord> {
        self.lock().records.values().cloned().collect()
    }

    pub fn flush(&self) {
        let mut g = self.lock();
        g.dirty = true;
        flush(&mut g);
    }

    /// The snapshot a previous NEXUS run left in `path`.
    pub fn load_previous(path: &Path) -> Option<RegistrySnapshot> {
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }
}

fn prune(records: &mut BTreeMap<String, ProcessRecord>) {
    let mut ended: Vec<(String, String)> = records
        .values()
        .filter(|r| r.state.is_ended())
        .map(|r| (r.ended_at.clone().unwrap_or_default(), r.key.clone()))
        .collect();
    if ended.len() <= KEEP_ENDED {
        return;
    }
    ended.sort();
    for (_, k) in ended.iter().take(ended.len() - KEEP_ENDED) {
        records.remove(k);
    }
}

fn flush(g: &mut Inner) {
    if !g.dirty {
        return;
    }
    let Some(path) = g.path.clone() else {
        g.dirty = false;
        return;
    };
    let snap = RegistrySnapshot {
        written_at: pcc_core::now(),
        owner_pid: crate::sys::current_pid(),
        processes: g.records.values().cloned().collect(),
    };
    match serde_json::to_vec_pretty(&snap) {
        Ok(bytes) => {
            if let Err(e) = crate::write_atomic(&path, &bytes) {
                tracing::warn!("cannot persist process registry {}: {e}", path.display());
            }
        }
        Err(e) => tracing::warn!("cannot serialise process registry: {e}"),
    }
    g.dirty = false;
    g.last_flush = Some(Instant::now());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_heartbeat_restart_and_persist() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runtime").join("processes.json");
        let r = ProcessRegistry::persisted(path.clone());
        let rec = r.register(
            "claude:central",
            Registration::new(ProcessKind::ClaudeSession, "Central").pid(Some(std::process::id())).agent("central"),
        );
        assert_eq!(rec.state, ProcessState::Starting);
        assert_eq!(rec.owner_pid, std::process::id());
        r.heartbeat("claude:central", "stdout", Some("Reading main.rs"));
        let got = r.get("claude:central").unwrap();
        assert_eq!(got.state, ProcessState::Running);
        assert_eq!(got.last_event.as_deref(), Some("Reading main.rs"));

        r.record_restart("claude:central", "crashed", "restarted");
        // Registering the same key again (the restart) keeps the history.
        r.register("claude:central", Registration::new(ProcessKind::ClaudeSession, "Central").pid(Some(1)));
        let got = r.get("claude:central").unwrap();
        assert_eq!(got.restart_count, 1);
        assert_eq!(got.restarts[0].reason, "crashed");

        r.ended("claude:central", true, Some(3), Some("exit 3".into()));
        let snap = ProcessRegistry::load_previous(&path).unwrap();
        assert_eq!(snap.processes.len(), 1);
        assert_eq!(snap.processes[0].state, ProcessState::Crashed);
        assert_eq!(snap.processes[0].exit_code, Some(3));
    }

    #[test]
    fn ended_records_are_pruned() {
        let r = ProcessRegistry::in_memory();
        for i in 0..(KEEP_ENDED + 5) {
            let k = format!("p{i:03}");
            r.register(&k, Registration::new(ProcessKind::Pty, "t"));
            r.ended(&k, false, Some(0), None);
        }
        r.register("live", Registration::new(ProcessKind::Pty, "t"));
        assert_eq!(r.list().len(), KEEP_ENDED + 1);
        assert!(r.get("live").is_some());
    }
}
