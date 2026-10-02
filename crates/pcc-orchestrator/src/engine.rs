//! The orchestration engine.
//!
//! One `Engine` per open project, always accessed under a single async mutex:
//! session outputs and UI commands are processed one at a time, so state
//! transitions never race. Nothing here is simulated — an agent is `working`
//! only between writing a turn to its Claude Code process and receiving that
//! turn's `result`.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use pcc_claude::protocol::{self, Block, ControlRequest, Inbound};
use pcc_claude::session::describe_tool_use;
use pcc_claude::{SessionHandle, SessionOutput};
use pcc_core::{
    ids, Agent, AgentKind, AgentStatus, Error, Event, EventBus, EventKind, Isolation, LogKind, Message, MessageKind,
    PermissionDecision, PermissionRequest, Result, TaskStatus, CENTRAL_ID, SYSTEM_ID, USER_ID,
};
use pcc_git::Repo;
use pcc_store::{ProjectStore, TaskFilter};

use crate::dto::{ProjectSnapshot, RecoveryAgent, RecoveryInfo};
use crate::launch;
use crate::policy::{self, Decision, PolicyInput};
use crate::prompts;

/// `(agent id, session epoch)`: outputs of a replaced session are ignored.
pub type Tag = (String, u64);

/// How many times a worker is reminded to report before its task is parked.
const MAX_NUDGES: u8 = 2;

pub(crate) struct Live {
    pub handle: SessionHandle,
    pub epoch: u64,
    pub session_row: i64,
    /// A turn is in progress.
    pub busy: bool,
    pub stopping: bool,
    /// Stopped by the scheduler to free a worker slot (not by the user).
    pub reclaimed: bool,
    pub restart_after_exit: bool,
    pub resumed: bool,
    pub got_init: bool,
    /// Cost of the agent's previous sessions.
    pub base_cost: f64,
    pub tool_names: HashMap<String, String>,
    pub stderr_tail: Vec<String>,
}

pub(crate) enum PendingKind {
    Tool { request_id: String, input: Value, epoch: u64 },
    Merge { agent: String },
    Admin(Box<crate::admin::AdminAction>),
}

/// Work queued for the engine from background tasks (e.g. a finished
/// connection test answering a deferred tool call).
pub type Job = Box<dyn FnOnce(&mut Engine) -> Result<()> + Send>;

pub(crate) struct PendingPermission {
    pub request: PermissionRequest,
    pub kind: PendingKind,
}

pub struct Engine {
    pub(crate) store: Arc<ProjectStore>,
    pub(crate) bus: EventBus,
    pub(crate) repo: Option<Repo>,
    pub(crate) claude: Option<PathBuf>,
    pub(crate) project_types: Vec<String>,
    pub(crate) sessions: HashMap<String, Live>,
    pub(crate) permissions: BTreeMap<String, PendingPermission>,
    out_tx: mpsc::UnboundedSender<(Tag, SessionOutput)>,
    next_epoch: u64,
    pub(crate) nudges: HashMap<String, u8>,
    pub(crate) recovery: Option<RecoveryInfo>,
    /// Agents may be started automatically only after the user acted in this
    /// session (mission, message, start, recovery). Prevents spending tokens
    /// just because a project was opened.
    pub(crate) autopilot: bool,
    /// Emergency stop: no auto-start, no auto-approval, no new work until released.
    pub(crate) emergency: bool,
    pub(crate) connection_touches: HashMap<String, std::time::Instant>,
    pub(crate) user_requests: BTreeMap<String, crate::admin::UserRequest>,
    /// Stored secret values, used only to redact logs and command outputs.
    pub(crate) secret_values: Vec<String>,
    pub(crate) jobs_tx: mpsc::UnboundedSender<Job>,
    jobs_rx: Option<mpsc::UnboundedReceiver<Job>>,
    pub(crate) compatibility: Option<pcc_store::compat::CompatibilityReport>,
}

impl Engine {
    pub fn new(
        store: Arc<ProjectStore>,
        bus: EventBus,
        claude: Option<PathBuf>,
        project_types: Vec<String>,
        out_tx: mpsc::UnboundedSender<(Tag, SessionOutput)>,
    ) -> Result<Engine> {
        let repo = Repo::discover(store.root());
        let (jobs_tx, jobs_rx) = mpsc::unbounded_channel();
        let mut e = Engine {
            store,
            bus,
            repo,
            claude,
            project_types,
            sessions: HashMap::new(),
            permissions: BTreeMap::new(),
            out_tx,
            next_epoch: 1,
            nudges: HashMap::new(),
            recovery: None,
            autopilot: false,
            emergency: false,
            connection_touches: HashMap::new(),
            user_requests: BTreeMap::new(),
            secret_values: Vec::new(),
            jobs_tx,
            jobs_rx: Some(jobs_rx),
            compatibility: None,
        };
        e.compatibility = pcc_store::compat::analyze(e.store.root()).ok();
        if e.store.read_only() {
            // Compatibility mode: show the project, write nothing.
            return Ok(e);
        }
        e.refresh_secret_values();
        e.emergency = e.store.meta_get("emergency_stop")?.is_some_and(|v| !v.is_empty());
        e.ensure_central()?;
        e.detect_recovery()?;
        Ok(e)
    }

    // ------------------------------------------------------------ helpers

    pub fn emit(&self, mut e: Event) {
        if let Err(err) = self.store.insert_event(&mut e) {
            tracing::error!("cannot persist event: {err}");
        }
        self.bus.publish(e);
    }

    pub(crate) fn emit_agent(&self, kind: EventKind, a: &Agent, summary: impl Into<String>) {
        self.emit(Event::new(kind, summary, json!(a)).agent(&a.id));
    }

    pub(crate) fn emit_task(&self, kind: EventKind, t: &pcc_core::Task, summary: impl Into<String>) {
        let mut e = Event::new(kind, summary, json!(t)).task(&t.id).mission(t.mission_id.clone());
        e.agent_id = t.agent.clone();
        self.emit(e);
    }

    pub(crate) fn emit_mission(&self, kind: EventKind, id: &str, summary: impl Into<String>) {
        match self.store.list_missions() {
            Ok(list) => {
                if let Some(m) = list.into_iter().find(|m| m.mission.id == id) {
                    self.emit(Event::new(kind, summary, json!(m)).mission(Some(id.to_string())));
                }
            }
            Err(e) => tracing::error!("cannot load missions: {e}"),
        }
    }

    /// Receiver of queued jobs; taken once by the orchestrator.
    pub fn take_jobs(&mut self) -> Option<mpsc::UnboundedReceiver<Job>> {
        self.jobs_rx.take()
    }

    pub(crate) fn log(&self, agent: &str, session: i64, kind: LogKind, text: &str) {
        let text = self.redact(text);
        match self.store.append_log(agent, session, kind, &text) {
            Ok(entry) => self.bus.publish_log(entry),
            Err(e) => tracing::error!("cannot write log: {e}"),
        }
    }

    fn session_row(&self, agent: &str) -> i64 {
        self.sessions.get(agent).map(|l| l.session_row).unwrap_or(0)
    }

    /// Persists an agent and streams the change to the UI.
    pub(crate) fn save_agent(&self, a: &mut Agent) -> Result<()> {
        a.updated_at = pcc_core::now();
        self.store.upsert_agent(a)?;
        self.emit_agent(EventKind::AgentUpdated, a, format!("{} updated", a.name));
        Ok(())
    }

    pub(crate) fn set_status(&self, id: &str, status: AgentStatus) -> Result<Agent> {
        let mut a = self.store.agent(id)?;
        if a.status != status {
            a.status = status;
            if !matches!(status, AgentStatus::Working | AgentStatus::AwaitingPermission) {
                a.current_action = None;
            }
            self.save_agent(&mut a)?;
        }
        Ok(a)
    }

    pub fn snapshot(&self) -> Result<ProjectSnapshot> {
        Ok(ProjectSnapshot {
            info: self.store.info().clone(),
            settings: self.store.settings(),
            agents: self.store.list_agents()?,
            tasks: self.store.list_tasks(&TaskFilter::default())?,
            missions: self.store.list_missions()?,
            connections: self.store.list_connections()?,
            pending_permissions: self.permissions.values().map(|p| p.request.clone()).collect(),
            repo: self.repo.as_ref().map(Repo::status),
            recovery: self.recovery.clone(),
            emergency: self.emergency,
            user_requests: self.pending_user_requests(),
            compatibility: self.compatibility.clone(),
            read_only: self.store.read_only(),
            migration: None,
        })
    }

    pub fn refresh_repo(&mut self) {
        self.repo = Repo::discover(self.store.root());
    }

    // ------------------------------------------------------------ recovery

    fn ensure_central(&mut self) -> Result<()> {
        if self.store.get_agent(CENTRAL_ID)?.is_some() {
            return Ok(());
        }
        let now = pcc_core::now();
        let a = Agent {
            id: CENTRAL_ID.into(),
            name: "Central".into(),
            kind: AgentKind::Central,
            provider: pcc_core::CLAUDE_CODE_PROVIDER.into(),
            role: "Orchestrator: plans missions, creates agents and tasks, coordinates and reviews".into(),
            instructions: String::new(),
            status: AgentStatus::Offline,
            model: None,
            permissions: pcc_core::PermissionSet::central(),
            connections: vec![],
            isolation: Isolation::Shared,
            workdir: self.store.root().to_string_lossy().into_owned(),
            branch: None,
            current_task: None,
            current_action: None,
            progress: None,
            claude_session_id: None,
            total_cost_usd: 0.0,
            profile: Default::default(),
            created_by: SYSTEM_ID.into(),
            created_at: now.clone(),
            updated_at: now,
        };
        self.store.upsert_agent(&a)?;
        self.emit_agent(EventKind::AgentCreated, &a, "Central agent created");
        Ok(())
    }

    /// Sessions still marked running belong to processes that died with the
    /// previous app instance (crash, kill, reboot). Agents that were live are
    /// marked `disconnected` and offered for recovery.
    fn detect_recovery(&mut self) -> Result<()> {
        for s in self.store.running_sessions()? {
            self.store.end_session(s.id, "abandoned", None)?;
        }
        let mut list = Vec::new();
        for mut a in self.store.list_agents()? {
            if a.status.is_live() || a.status == AgentStatus::Disconnected {
                a.status = AgentStatus::Disconnected;
                a.current_action = None;
                self.store.upsert_agent(&a)?;
                list.push(RecoveryAgent {
                    agent_id: a.id.clone(),
                    name: a.name.clone(),
                    claude_session_id: a.claude_session_id.clone(),
                    task_id: a.current_task.clone(),
                });
            }
        }
        self.recovery = (!list.is_empty()).then_some(RecoveryInfo { agents: list });
        Ok(())
    }

    pub fn recover(&mut self) -> Result<()> {
        let Some(info) = self.recovery.take() else { return Ok(()) };
        self.autopilot = true;
        for ra in info.agents {
            let note = match &ra.task_id {
                Some(t) => format!("The control center was restarted. Continue your work on {t} where you left off, then report with complete_task / block_task / fail_task."),
                None if ra.agent_id == CENTRAL_ID => "The control center was restarted. Review the current state with list_tasks and list_agents and continue coordinating.".into(),
                None => "The control center was restarted. Continue where you left off.".into(),
            };
            if let Err(e) = self.start_agent(&ra.agent_id, true) {
                self.set_status(&ra.agent_id, AgentStatus::Crashed)?;
                self.emit(
                    Event::new(
                        EventKind::Error,
                        format!("Could not recover {}: {e}", ra.name),
                        json!({"error": e.to_string()}),
                    )
                    .agent(&ra.agent_id),
                );
                continue;
            }
            self.post_message(SYSTEM_ID, &ra.agent_id, MessageKind::System, &note, ra.task_id.clone(), None)?;
        }
        self.schedule()
    }

    /// Drops the previous sessions. Tasks they were running are parked in
    /// `waiting` so nothing restarts without a decision.
    pub fn discard_recovery(&mut self) -> Result<()> {
        let Some(info) = self.recovery.take() else { return Ok(()) };
        for ra in info.agents {
            let mut a = self.store.agent(&ra.agent_id)?;
            a.status = AgentStatus::Offline;
            a.current_task = None;
            a.progress = None;
            self.save_agent(&mut a)?;
            for mut t in self.store.list_tasks(&TaskFilter {
                agent: Some(a.id.clone()),
                status: Some(TaskStatus::InProgress),
                ..Default::default()
            })? {
                self.transition(
                    &mut t,
                    TaskStatus::Waiting,
                    Some("session discarded after restart; retry the task to run it again".into()),
                )?;
            }
        }
        Ok(())
    }

    /// Stops every session on application exit. Agents that were running are
    /// marked `disconnected` so the next start offers to resume them.
    pub fn shutdown(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            if let Some(mut live) = self.sessions.remove(&id) {
                live.handle.kill();
                let _ = self.store.end_session(live.session_row, "app_closed", None);
                if let Ok(mut a) = self.store.agent(&id) {
                    a.status = AgentStatus::Disconnected;
                    a.current_action = None;
                    let _ = self.store.upsert_agent(&a);
                }
            }
        }
    }

    // ------------------------------------------------------------ sessions

    fn claude_path(&self) -> Result<PathBuf> {
        self.claude.clone().ok_or_else(|| {
            Error::Process("Claude Code was not detected. Install it and sign in with `claude auth login`.".into())
        })
    }

    /// Stops one idle worker (no turn running, no active task, nothing queued for it).
    fn reclaim_idle_worker(&mut self) -> Result<()> {
        if self.sessions.values().any(|l| l.reclaimed) {
            return Ok(());
        }
        let candidates: Vec<String> = self
            .sessions
            .iter()
            .filter(|(id, l)| id.as_str() != CENTRAL_ID && !l.busy && !l.stopping)
            .map(|(id, _)| id.clone())
            .collect();
        for id in candidates {
            let queued = self.store.list_tasks(&TaskFilter {
                agent: Some(id.clone()),
                status: Some(TaskStatus::Queued),
                ..Default::default()
            })?;
            if self.has_active_task(&id)? || !queued.is_empty() || !self.store.undelivered_for(&id)?.is_empty() {
                continue;
            }
            if let Some(l) = self.sessions.get_mut(&id) {
                l.stopping = true;
                l.reclaimed = true;
                l.handle.kill();
                let row = l.session_row;
                self.log(&id, row, LogKind::System, "Idle session stopped to free a worker slot");
            }
            return Ok(());
        }
        Ok(())
    }

    /// Starts an agent the user explicitly addressed, unless it is running,
    /// retired or waiting for the recovery decision.
    pub(crate) fn wake(&mut self, id: &str) -> Result<()> {
        let a = self.store.agent(id)?;
        if self.sessions.contains_key(id)
            || !matches!(
                a.status,
                AgentStatus::Offline | AgentStatus::Stopped | AgentStatus::Crashed | AgentStatus::Waiting
            )
        {
            return Ok(());
        }
        self.start_agent(id, a.claude_session_id.is_some())
    }

    fn live_workers(&self) -> usize {
        self.sessions.keys().filter(|id| id.as_str() != CENTRAL_ID).count()
    }

    pub fn start_agent(&mut self, id: &str, resume: bool) -> Result<()> {
        if self.sessions.contains_key(id) {
            return Ok(());
        }
        self.ensure_not_emergency()?;
        let claude = self.claude_path()?;
        let mut agent = self.store.agent(id)?;
        if agent.status == AgentStatus::Retired {
            return Err(Error::invalid(format!("{} is retired", agent.name)));
        }
        crate::providers::ensure_supported(&agent.provider)?;
        let notes = launch::ensure_workdir(&self.store, self.repo.as_ref(), &mut agent);
        let connections = self.store.list_connections()?;
        let branch = self.repo.as_ref().and_then(Repo::current_branch);
        let prepared =
            launch::prepare(&self.store, &claude, &agent, &connections, &self.project_types, branch, resume)?;

        let epoch = self.next_epoch;
        self.next_epoch += 1;
        let handle = pcc_claude::spawn(&prepared.spec, (id.to_string(), epoch), self.out_tx.clone())?;
        let row = self.store.start_session(id, Some(&prepared.claude_session_id), Some(handle.pid))?;
        let base_cost = agent.total_cost_usd;
        self.sessions.insert(
            id.to_string(),
            Live {
                handle,
                epoch,
                session_row: row,
                busy: false,
                stopping: false,
                reclaimed: false,
                restart_after_exit: false,
                resumed: prepared.spec.resume.is_some(),
                got_init: false,
                base_cost,
                tool_names: HashMap::new(),
                stderr_tail: Vec::new(),
            },
        );
        agent.claude_session_id = Some(prepared.claude_session_id.clone());
        agent.status = AgentStatus::Waiting;
        agent.current_action = None;
        self.store.upsert_agent(&agent)?;
        let pid = self.sessions[id].handle.pid;
        self.log(
            id,
            row,
            LogKind::System,
            &format!(
                "Session {} ({}) · pid {pid} · {}",
                if prepared.spec.resume.is_some() { "resumed" } else { "started" },
                prepared.claude_session_id,
                agent.workdir
            ),
        );
        for n in notes {
            self.log(id, row, LogKind::System, &n);
        }
        self.emit_agent(EventKind::AgentStarted, &agent, format!("{} session started", agent.name));
        Ok(())
    }

    pub fn stop_agent(&mut self, id: &str) -> Result<()> {
        let Some(live) = self.sessions.get_mut(id) else {
            let a = self.store.agent(id)?;
            if a.status != AgentStatus::Retired && a.status != AgentStatus::Stopped {
                self.set_status(id, AgentStatus::Stopped)?;
            }
            return Ok(());
        };
        live.stopping = true;
        live.handle.kill();
        Ok(())
    }

    pub fn restart_agent(&mut self, id: &str) -> Result<()> {
        self.autopilot = true;
        match self.sessions.get_mut(id) {
            Some(live) => {
                live.stopping = true;
                live.restart_after_exit = true;
                live.handle.kill();
                Ok(())
            }
            None => {
                self.start_agent(id, true)?;
                self.pump(id)
            }
        }
    }

    pub fn interrupt_agent(&mut self, id: &str) -> Result<()> {
        let live = self.sessions.get(id).ok_or_else(|| Error::invalid(format!("{id} has no running session")))?;
        live.handle.interrupt()?;
        self.log(id, live.session_row, LogKind::System, "Interrupt requested by the user");
        Ok(())
    }

    pub fn stop_all(&mut self) -> Result<()> {
        self.autopilot = false;
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.stop_agent(&id)?;
        }
        Ok(())
    }

    /// User-initiated start.
    pub fn start_agent_by_user(&mut self, id: &str) -> Result<()> {
        self.autopilot = true;
        let resume = self.store.agent(id)?.claude_session_id.is_some();
        self.start_agent(id, resume)?;
        self.pump(id)
    }

    // ------------------------------------------------------------ delivery

    /// Writes pending input (messages and/or the next task) to the agent's
    /// session if it is idle, starting the session when allowed.
    pub(crate) fn pump(&mut self, id: &str) -> Result<()> {
        let agent = self.store.agent(id)?;
        if agent.status == AgentStatus::Retired {
            return Ok(());
        }
        let messages = self.store.undelivered_for(id)?;
        let task = if agent.kind == AgentKind::Worker && !self.has_active_task(id)? {
            let tasks = self.store.list_tasks(&TaskFilter {
                agent: Some(id.into()),
                status: Some(TaskStatus::Queued),
                ..Default::default()
            })?;
            pcc_core::tasks::next_for_agent(&tasks, id).cloned()
        } else {
            None
        };
        if messages.is_empty() && task.is_none() {
            return Ok(());
        }
        match self.sessions.get(id) {
            Some(l) if l.busy || l.stopping => return Ok(()),
            Some(_) => {}
            None => {
                if !self.autopilot
                    || self.emergency
                    || !matches!(agent.status, AgentStatus::Offline | AgentStatus::Waiting)
                {
                    return Ok(());
                }
                let limit = self.store.settings().max_parallel_workers as usize;
                if agent.kind == AgentKind::Worker && self.live_workers() >= limit {
                    // Free a slot held by an idle worker; this agent starts when it exits.
                    self.reclaim_idle_worker()?;
                    return Ok(());
                }
                let resume = agent.claude_session_id.is_some() && agent.kind == AgentKind::Central;
                if let Err(e) = self.start_agent(id, resume) {
                    self.emit(
                        Event::new(
                            EventKind::Error,
                            format!("Cannot start {}: {e}", agent.name),
                            json!({"error": e.to_string()}),
                        )
                        .agent(id),
                    );
                    self.set_status(id, AgentStatus::Crashed)?;
                    return Ok(());
                }
            }
        }

        let mut parts: Vec<String> = Vec::new();
        let now = pcc_core::now();
        for m in &messages {
            parts.push(prompts::message_envelope(m));
            if let Some(dm) = self.store.mark_delivered(&m.id, &now)? {
                self.emit(
                    Event::new(EventKind::AgentMessage, format!("{} → {} delivered", dm.from, dm.to), json!(dm))
                        .agent(id),
                );
            }
        }
        // A message may unblock the agent's parked task.
        if agent.kind == AgentKind::Worker && !messages.is_empty() {
            if let Some(tid) = &agent.current_task {
                let mut t = self.store.task(tid)?;
                if matches!(t.status, TaskStatus::Waiting | TaskStatus::Blocked) && t.agent.as_deref() == Some(id) {
                    self.transition(&mut t, TaskStatus::InProgress, Some("resumed after a message".into()))?;
                }
            }
        }
        if let Some(mut t) = task {
            let deps: Vec<pcc_core::Task> =
                t.dependencies.iter().filter_map(|d| self.store.get_task(d).ok().flatten()).collect();
            let sync_note = self.sync_dependency_branches(id, &deps);
            let resumed = t.started_at.is_some();
            parts.push(prompts::task_dispatch(&t, &deps, resumed, sync_note.as_deref()));
            t.started_at.get_or_insert_with(pcc_core::now);
            self.transition(&mut t, TaskStatus::InProgress, None)?;
            self.nudges.remove(&t.id);
            let mut a = self.store.agent(id)?;
            a.current_task = Some(t.id.clone());
            a.progress = Some(0);
            self.store.upsert_agent(&a)?;
        }
        self.send_turn(id, &parts.join("\n\n---\n\n"))
    }

    fn send_turn(&mut self, id: &str, text: &str) -> Result<()> {
        let live = self.sessions.get_mut(id).ok_or_else(|| Error::invalid(format!("{id} has no session")))?;
        live.handle.send_user(text)?;
        live.busy = true;
        let row = live.session_row;
        self.log(id, row, LogKind::Input, text);
        let mut a = self.store.agent(id)?;
        a.status = AgentStatus::Working;
        a.current_action = Some("Thinking".into());
        self.save_agent(&mut a)
    }

    pub(crate) fn has_active_task(&self, agent: &str) -> Result<bool> {
        Ok(self
            .store
            .list_tasks(&TaskFilter { agent: Some(agent.into()), ..Default::default() })?
            .iter()
            .any(|t| matches!(t.status, TaskStatus::InProgress | TaskStatus::Waiting | TaskStatus::Blocked)))
    }

    /// Recomputes task readiness and feeds idle agents.
    pub fn schedule(&mut self) -> Result<()> {
        let tasks = self.store.list_tasks(&TaskFilter::default())?;
        let statuses: HashMap<String, TaskStatus> = tasks.iter().map(|t| (t.id.clone(), t.status)).collect();
        for t in &tasks {
            let dep_blocked = t.status == TaskStatus::Blocked
                && t.status_reason.as_deref().is_some_and(|r| r.starts_with("dependency"));
            if !(matches!(t.status, TaskStatus::Pending | TaskStatus::Queued) || dep_blocked) {
                continue;
            }
            let mut t = t.clone();
            match pcc_core::tasks::readiness(&t, &statuses) {
                pcc_core::tasks::Readiness::Ready => {
                    if t.status != TaskStatus::Queued && t.agent.is_some() {
                        self.transition(&mut t, TaskStatus::Queued, None)?;
                    }
                }
                pcc_core::tasks::Readiness::Waiting => {
                    if t.status != TaskStatus::Pending {
                        self.transition(&mut t, TaskStatus::Pending, None)?;
                    }
                }
                pcc_core::tasks::Readiness::DependencyFailed(d) => {
                    if t.status != TaskStatus::Blocked {
                        let reason = format!("dependency {d} failed or was cancelled");
                        self.transition(&mut t, TaskStatus::Blocked, Some(reason.clone()))?;
                        self.notify_central(
                            &format!("{} \"{}\" is blocked: {reason}. Retry, re-plan or cancel it.", t.id, t.title),
                            Some(t.id.clone()),
                            t.mission_id.clone(),
                        )?;
                    }
                }
            }
        }
        let ids: Vec<String> = self.store.list_agents()?.into_iter().map(|a| a.id).collect();
        // Central first so it can react before workers take new work.
        for id in ids {
            self.pump(&id)?;
        }
        Ok(())
    }

    // ------------------------------------------------------------ messages

    pub fn post_message(
        &mut self,
        from: &str,
        to: &str,
        kind: MessageKind,
        body: &str,
        task_id: Option<String>,
        mission_id: Option<String>,
    ) -> Result<Message> {
        if body.trim().is_empty() {
            return Err(Error::invalid("message body is empty"));
        }
        let recipient = self.store.agent(to)?;
        if recipient.status == AgentStatus::Retired {
            return Err(Error::invalid(format!("{} is retired", recipient.name)));
        }
        let m = Message {
            id: format!("msg-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            from: from.into(),
            to: to.into(),
            kind,
            subject: None,
            body: body.trim().to_string(),
            task_id,
            mission_id,
            created_at: pcc_core::now(),
            delivered_at: None,
        };
        self.store.insert_message(&m)?;
        self.emit(
            Event::new(EventKind::AgentMessage, format!("{from} → {to}: {}", first_line(&m.body, 90)), json!(m))
                .agent(from)
                .mission(m.mission_id.clone()),
        );
        self.pump(to)?;
        Ok(m)
    }

    pub fn send_user_message(&mut self, to: &str, body: &str) -> Result<Message> {
        self.ensure_not_emergency()?;
        self.autopilot = true;
        self.wake(to)?;
        self.post_message(USER_ID, to, MessageKind::User, body, None, None)
    }

    pub(crate) fn notify_central(&mut self, body: &str, task: Option<String>, mission: Option<String>) -> Result<()> {
        self.post_message(SYSTEM_ID, CENTRAL_ID, MessageKind::System, body, task, mission)?;
        Ok(())
    }

    // ------------------------------------------------------------ session output

    pub fn handle_output(&mut self, tag: Tag, out: SessionOutput) -> Result<()> {
        let (agent, epoch) = tag;
        let Some(live) = self.sessions.get(&agent) else { return Ok(()) };
        if live.epoch != epoch {
            return Ok(());
        }
        let row = live.session_row;
        match out {
            SessionOutput::Message { msg, raw } => {
                if let Err(e) = self.store.append_raw(&agent, row, &raw) {
                    tracing::warn!("raw log write failed: {e}");
                }
                self.handle_message(&agent, row, msg)?;
            }
            SessionOutput::Garbage(line) => self.log(&agent, row, LogKind::System, &line),
            SessionOutput::Stderr(line) => {
                if let Some(l) = self.sessions.get_mut(&agent) {
                    l.stderr_tail.push(line.clone());
                    if l.stderr_tail.len() > 20 {
                        l.stderr_tail.remove(0);
                    }
                }
                self.log(&agent, row, LogKind::Stderr, &line);
            }
            SessionOutput::Exited(code) => self.on_exit(&agent, code)?,
        }
        Ok(())
    }

    fn handle_message(&mut self, agent: &str, row: i64, msg: Inbound) -> Result<()> {
        match msg {
            Inbound::Init { session_id, model, tools } => {
                if let Some(l) = self.sessions.get_mut(agent) {
                    l.got_init = true;
                }
                let mut a = self.store.agent(agent)?;
                if a.claude_session_id.as_deref() != Some(session_id.as_str()) {
                    a.claude_session_id = Some(session_id.clone());
                    self.store.upsert_agent(&a)?;
                }
                self.log(
                    agent,
                    row,
                    LogKind::System,
                    &format!("Claude Code ready · model {} · {} tools", model.unwrap_or_default(), tools.len()),
                );
            }
            Inbound::Assistant { blocks, parent_tool_use_id } => {
                let prefix = if parent_tool_use_id.is_some() { "↳ " } else { "" };
                for b in blocks {
                    match b {
                        Block::Text(t) => self.log(agent, row, LogKind::AssistantText, &format!("{prefix}{t}")),
                        Block::Thinking(t) => self.log(agent, row, LogKind::Thinking, &t),
                        Block::ToolUse { id, name, input } => {
                            let action = describe_tool_use(&name, &input);
                            self.log(
                                agent,
                                row,
                                LogKind::ToolUse,
                                &format!("{prefix}{name} {}", compact_json(&input, 1200)),
                            );
                            if matches!(name.as_str(), "Bash" | "PowerShell") {
                                if let Some(cmd) = input.get("command").and_then(Value::as_str) {
                                    self.record_agent_command(agent, &id, cmd);
                                }
                            }
                            if is_notable_tool(&name) {
                                self.emit(
                                    Event::new(
                                        EventKind::ToolUsed,
                                        format!("{agent}: {action}"),
                                        json!({"tool": name, "input": truncate_value(&input)}),
                                    )
                                    .agent(agent),
                                );
                            }
                            if let Some(l) = self.sessions.get_mut(agent) {
                                l.tool_names.insert(id, name);
                            }
                            let mut a = self.store.agent(agent)?;
                            a.current_action = Some(action);
                            self.save_agent(&mut a)?;
                        }
                    }
                }
            }
            Inbound::ToolResults { results, parent_tool_use_id } => {
                let prefix = if parent_tool_use_id.is_some() { "↳ " } else { "" };
                for r in results {
                    if self
                        .sessions
                        .get(agent)
                        .and_then(|l| l.tool_names.get(&r.tool_use_id))
                        .is_some_and(|n| n == "Bash" || n == "PowerShell")
                    {
                        self.finish_agent_command(&r.tool_use_id, r.is_error, &r.text);
                    }
                    let name = self
                        .sessions
                        .get(agent)
                        .and_then(|l| l.tool_names.get(&r.tool_use_id).cloned())
                        .unwrap_or_default();
                    let marker = if r.is_error { "✗" } else { "✓" };
                    self.log(
                        agent,
                        row,
                        if r.is_error { LogKind::Error } else { LogKind::ToolResult },
                        &format!("{prefix}{marker} {name}\n{}", r.text),
                    );
                }
            }
            Inbound::Result { subtype, is_error, text, total_cost_usd, num_turns, duration_ms } => {
                if let Some(cost) = total_cost_usd {
                    let base = self.sessions.get(agent).map(|l| l.base_cost).unwrap_or(0.0);
                    let mut a = self.store.agent(agent)?;
                    a.total_cost_usd = base + cost;
                    self.store.upsert_agent(&a)?;
                    self.store.set_session_cost(row, cost)?;
                }
                let summary = format!(
                    "Turn finished ({subtype}) · {} turn(s) · {:.1}s · session cost ${:.4}",
                    num_turns.unwrap_or(0),
                    duration_ms.unwrap_or(0) as f64 / 1000.0,
                    total_cost_usd.unwrap_or(0.0)
                );
                self.log(agent, row, if is_error { LogKind::Error } else { LogKind::Result }, &summary);
                if is_error {
                    if let Some(t) = text.filter(|t| !t.is_empty()) {
                        self.log(agent, row, LogKind::Error, &t);
                    }
                }
                if let Some(l) = self.sessions.get_mut(agent) {
                    l.busy = false;
                }
                let waiting_perm = self.permissions.values().any(|p| p.request.agent_id == agent);
                self.set_status(
                    agent,
                    if waiting_perm { AgentStatus::AwaitingPermission } else { AgentStatus::Waiting },
                )?;
                self.on_turn_end(agent)?;
            }
            Inbound::ControlRequest { request_id, request } => self.handle_control(agent, request_id, request)?,
            Inbound::ControlResponse { success, error, .. } => {
                if !success {
                    self.log(
                        agent,
                        row,
                        LogKind::Error,
                        &format!("Control request failed: {}", error.unwrap_or_default()),
                    );
                }
            }
            Inbound::Other { .. } => {}
        }
        Ok(())
    }

    /// A worker ended its turn: make sure its task is not silently abandoned.
    fn on_turn_end(&mut self, agent: &str) -> Result<()> {
        let a = self.store.agent(agent)?;
        if a.kind == AgentKind::Worker && self.store.undelivered_for(agent)?.is_empty() {
            let open = self.store.list_tasks(&TaskFilter {
                agent: Some(agent.into()),
                status: Some(TaskStatus::InProgress),
                ..Default::default()
            })?;
            if let Some(mut t) = open.into_iter().next() {
                let n = self.nudges.entry(t.id.clone()).or_insert(0);
                *n += 1;
                if *n <= MAX_NUDGES {
                    let text = format!(
                        "[MESSAGE from system · notification]\nYour turn ended but {} is still in progress. If it is done, call complete_task. If you need something, call block_task. If it cannot be done, call fail_task. Otherwise continue working.",
                        t.id
                    );
                    return self.send_turn(agent, &text);
                }
                self.transition(&mut t, TaskStatus::Waiting, Some("agent stopped without reporting a result".into()))?;
                self.notify_central(
                    &format!("{} \"{}\" ({}): the agent ended its turns without reporting. Check its terminal, then message it, reassign or retry the task.", t.id, t.title, agent),
                    Some(t.id.clone()),
                    t.mission_id.clone(),
                )?;
            }
        }
        self.schedule()
    }

    fn on_exit(&mut self, agent: &str, code: Option<i32>) -> Result<()> {
        let Some(live) = self.sessions.remove(agent) else { return Ok(()) };
        // Pending permission prompts of this session can no longer be answered.
        let stale: Vec<String> = self
            .permissions
            .iter()
            .filter(|(_, p)| p.request.agent_id == agent && matches!(p.kind, PendingKind::Tool { .. }))
            .map(|(k, _)| k.clone())
            .collect();
        for id in stale {
            self.permissions.remove(&id);
            self.emit(
                Event::new(
                    EventKind::PermissionResolved,
                    "Permission request dropped (session ended)",
                    json!({"id": id, "decision": "reject"}),
                )
                .agent(agent),
            );
        }
        let intentional = live.stopping;
        let state = if intentional { "stopped" } else { "crashed" };
        self.store.end_session(live.session_row, state, code)?;
        let detail =
            if live.stderr_tail.is_empty() { String::new() } else { format!("\n{}", live.stderr_tail.join("\n")) };
        self.log(
            agent,
            live.session_row,
            if intentional { LogKind::System } else { LogKind::Error },
            &format!(
                "Session ended (exit code {}){}",
                code.map(|c| c.to_string()).unwrap_or("-".into()),
                if intentional { String::new() } else { detail.clone() }
            ),
        );

        // A resume that fails before the session initialises: start fresh once.
        if !intentional && live.resumed && !live.got_init {
            self.log(
                agent,
                live.session_row,
                LogKind::System,
                "Could not resume the previous Claude session; starting a fresh one.",
            );
            let mut a = self.store.agent(agent)?;
            a.claude_session_id = None;
            self.store.upsert_agent(&a)?;
            self.start_agent(agent, false)?;
            return self.redispatch_current(agent);
        }
        if live.restart_after_exit {
            self.start_agent(agent, true)?;
            return self.redispatch_current(agent);
        }
        if live.reclaimed {
            self.set_status(agent, AgentStatus::Offline)?;
            return self.schedule();
        }
        let a = self.set_status(agent, if intentional { AgentStatus::Stopped } else { AgentStatus::Crashed })?;
        if intentional {
            self.emit_agent(EventKind::AgentStopped, &a, format!("{} stopped", a.name));
        } else {
            self.emit_agent(EventKind::AgentCrashed, &a, format!("{} crashed (exit code {:?})", a.name, code));
            if a.kind == AgentKind::Worker {
                self.notify_central(
                    &format!(
                        "Agent {} crashed (exit code {:?}). Its task {} is interrupted; the user can restart it.{}",
                        a.id,
                        code,
                        a.current_task.clone().unwrap_or("-".into()),
                        first_line(&detail, 300)
                    ),
                    a.current_task.clone(),
                    None,
                )?;
            }
        }
        Ok(())
    }

    /// After a restart, tell the agent to continue its in-progress task.
    fn redispatch_current(&mut self, agent: &str) -> Result<()> {
        let a = self.store.agent(agent)?;
        if let Some(tid) = a.current_task.clone() {
            let t = self.store.task(&tid)?;
            if t.status == TaskStatus::InProgress {
                let text = format!("[MESSAGE from system · notification]\nYour session was restarted. Continue {} (\"{}\") where you left off.", t.id, t.title);
                return self.send_turn(agent, &text);
            }
        }
        self.pump(agent)
    }

    // ------------------------------------------------------------ control requests

    fn handle_control(&mut self, agent: &str, request_id: String, req: ControlRequest) -> Result<()> {
        let Some(live) = self.sessions.get(agent) else { return Ok(()) };
        let epoch = live.epoch;
        match req {
            ControlRequest::McpMessage { server_name, message } => {
                let reply = if server_name == launch::PCC_SERVER {
                    crate::tools::handle_rpc(self, agent, &request_id, &message)
                } else {
                    crate::tools::Reply::Now(Some(
                        json!({"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32601, "message": "unknown server"}}),
                    ))
                };
                if let crate::tools::Reply::Now(r) = reply {
                    self.write(agent, protocol::mcp_reply(&request_id, r))?;
                }
            }
            ControlRequest::CanUseTool { tool_name, input, tool_use_id } => {
                let a = self.store.agent(agent)?;
                let connections = self.store.list_connections()?;
                let store = self.store.clone();
                let agent_id = a.id.clone();
                let has_rule = move |k: &str| store.has_permission_rule(&agent_id, k).unwrap_or(false);
                let settings = self.store.settings();
                let mut autonomy = settings.autonomy;
                let mut master = settings.master_control;
                if self.emergency {
                    autonomy.auto_approve = false;
                    master.active = false;
                }
                let decision = policy::evaluate(
                    &PolicyInput {
                        agent: &a,
                        project_root: self.store.root().to_path_buf(),
                        connections: &connections,
                        has_rule: &has_rule,
                        autonomy: &autonomy,
                        master: &master,
                    },
                    &tool_name,
                    &input,
                );
                let class = pcc_core::permissions::classify_tool(&tool_name, &input, &[]);
                if let Some(id) = &tool_use_id {
                    let label = match &decision {
                        Decision::Allow => "allowed",
                        Decision::AutoApprove { .. } => "auto_approved",
                        Decision::Deny(_) => "denied",
                        Decision::Ask { .. } => "asked",
                    };
                    let _ = self.store.set_command_decision(id, label);
                }
                match decision {
                    Decision::Allow => {
                        if class.capability.is_some() {
                            self.record_decision(agent, &tool_name, Some(&class), "allowed", "policy", None);
                        }
                        self.touch_connection(&class);
                        self.write(agent, protocol::permission_allow(&request_id, &input))?
                    }
                    Decision::AutoApprove { reason, class } => {
                        self.record_decision(
                            agent,
                            &tool_name,
                            Some(&class),
                            "auto_approved",
                            "autonomy",
                            Some(reason),
                        );
                        self.touch_connection(&class);
                        let row = self.session_row(agent);
                        self.log(agent, row, LogKind::System, &format!("AUTO-APPROVED {}", class.summary));
                        self.write(agent, protocol::permission_allow(&request_id, &input))?
                    }
                    Decision::Deny(msg) => {
                        self.record_decision(agent, &tool_name, Some(&class), "denied", "policy", Some(msg.clone()));
                        let row = self.session_row(agent);
                        self.log(agent, row, LogKind::System, &format!("Denied {tool_name}: {msg}"));
                        self.write(agent, protocol::permission_deny(&request_id, &msg))?;
                    }
                    Decision::Ask { reason, class } => {
                        self.record_decision(agent, &tool_name, Some(&class), "asked", "policy", Some(reason.clone()));
                        let req = PermissionRequest {
                            id: format!("perm-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
                            agent_id: agent.into(),
                            tool_name: tool_name.clone(),
                            capability: class.capability.map(|c| c.as_str().to_string()).unwrap_or_default(),
                            summary: class.summary.clone(),
                            input: input.clone(),
                            reason,
                            rule_key: class.rule_key.clone(),
                            created_at: pcc_core::now(),
                        };
                        self.ask_user(req, PendingKind::Tool { request_id, input, epoch })?;
                    }
                }
            }
            ControlRequest::Other { subtype, .. } => {
                self.write(
                    agent,
                    protocol::control_error(&request_id, &format!("unsupported control request `{subtype}`")),
                )?;
            }
        }
        Ok(())
    }

    pub(crate) fn write(&self, agent: &str, line: String) -> Result<()> {
        match self.sessions.get(agent) {
            Some(l) => l.handle.send_line(line),
            None => Ok(()),
        }
    }

    pub(crate) fn ask_user(&mut self, req: PermissionRequest, kind: PendingKind) -> Result<()> {
        let agent = req.agent_id.clone();
        self.emit(
            Event::new(
                EventKind::PermissionRequested,
                format!("{} wants: {}", agent, first_line(&req.summary, 120)),
                json!(req),
            )
            .agent(&agent),
        );
        self.permissions.insert(req.id.clone(), PendingPermission { request: req, kind });
        if self.sessions.get(&agent).is_some_and(|l| l.busy) {
            self.set_status(&agent, AgentStatus::AwaitingPermission)?;
        }
        Ok(())
    }

    pub fn resolve_permission(&mut self, id: &str, decision: PermissionDecision) -> Result<()> {
        let p = self.permissions.remove(id).ok_or_else(|| Error::not_found(format!("permission request {id}")))?;
        let agent = p.request.agent_id.clone();
        let allow = decision != PermissionDecision::Reject;
        self.store
            .insert_decision(pcc_core::DecisionRecord {
                id: 0,
                ts: pcc_core::now(),
                agent_id: agent.clone(),
                tool_name: p.request.tool_name.clone(),
                capability: Some(p.request.capability.clone()).filter(|c| !c.is_empty()),
                summary: p.request.summary.clone(),
                decision: if allow { "user_allowed" } else { "user_rejected" }.into(),
                actor: "user".into(),
                reason: Some(format!("{decision:?}")),
            })
            .map(|_| ())
            .unwrap_or_else(|e| tracing::error!("cannot journal decision: {e}"));
        if decision == PermissionDecision::AllowAlways {
            self.store.add_permission_rule(&agent, &p.request.rule_key)?;
        }
        self.emit(
            Event::new(
                EventKind::PermissionResolved,
                format!("{:?}: {}", decision, first_line(&p.request.summary, 100)),
                json!({"id": id, "decision": decision}),
            )
            .agent(&agent),
        );
        match p.kind {
            PendingKind::Tool { request_id, input, epoch } => {
                if self.sessions.get(&agent).is_some_and(|l| l.epoch == epoch) {
                    let line = if allow {
                        protocol::permission_allow(&request_id, &input)
                    } else {
                        protocol::permission_deny(&request_id, "The user rejected this action. Do not retry it; continue without it or report the blocker.")
                    };
                    self.write(&agent, line)?;
                    let still_waiting = self.permissions.values().any(|q| q.request.agent_id == agent);
                    let busy = self.sessions.get(&agent).is_some_and(|l| l.busy);
                    if !still_waiting {
                        self.set_status(&agent, if busy { AgentStatus::Working } else { AgentStatus::Waiting })?;
                    }
                }
            }
            PendingKind::Admin(action) => {
                let note = if allow {
                    match self.apply_admin(*action) {
                        Ok(n) => format!("The user approved: {n}"),
                        Err(e) => format!("The approved change failed: {e}"),
                    }
                } else {
                    format!("The user rejected: {}", p.request.summary)
                };
                self.post_message(SYSTEM_ID, &agent, MessageKind::System, &note, None, None)?;
            }
            PendingKind::Merge { agent: worker } => {
                let text = if allow {
                    match self.merge_agent_branch(&worker) {
                        Ok(o) if o.merged => format!(
                            "The user approved the merge: {} (commit {}).",
                            o.message,
                            o.commit.unwrap_or_default()
                        ),
                        Ok(o) => format!(
                            "Merge of {worker} not performed: {}. Conflicting files: {}",
                            o.message,
                            o.conflicts.join(", ")
                        ),
                        Err(e) => format!("Merge of {worker} failed: {e}"),
                    }
                } else {
                    format!("The user rejected merging {worker}'s branch.")
                };
                self.notify_central(&text, None, None)?;
            }
        }
        Ok(())
    }
}

/// Tools worth a timeline entry (reads and searches would flood it).
fn is_notable_tool(name: &str) -> bool {
    !matches!(name, "Read" | "Glob" | "Grep" | "TodoWrite" | "LSP" | "ToolSearch" | "NotebookRead")
        && !name.starts_with("mcp__pcc__")
}

/// Keeps event payloads small: long strings are cut.
fn truncate_value(v: &Value) -> Value {
    match v {
        Value::String(s) if s.chars().count() > 600 => {
            Value::String(format!("{}…", s.chars().take(600).collect::<String>()))
        }
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), truncate_value(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().take(50).map(truncate_value).collect()),
        other => other.clone(),
    }
}

pub(crate) fn first_line(s: &str, max: usize) -> String {
    let l = s.trim().lines().next().unwrap_or("");
    if l.chars().count() > max {
        format!("{}…", l.chars().take(max).collect::<String>())
    } else {
        l.to_string()
    }
}

fn compact_json(v: &Value, max: usize) -> String {
    let s = v.to_string();
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max).collect::<String>())
    } else {
        s
    }
}

pub(crate) fn valid_agent_id(id: &str) -> Result<()> {
    ids::validate_agent_id(id)?;
    if matches!(id, CENTRAL_ID | USER_ID | SYSTEM_ID) {
        return Err(Error::invalid(format!("`{id}` is reserved")));
    }
    Ok(())
}
