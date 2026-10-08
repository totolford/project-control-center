//! The RESUME service: "reprends", "continue", an automatic resume after a
//! crash or a restart. NEXUS finds the mission to continue, inspects the real
//! state (tasks, files on disk, repository, Claude sessions, MCP servers,
//! agents), brings the needed sessions back and hands Central a verified
//! recovery report so it continues from the verified point instead of
//! restarting the mission or asking what to resume.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use pcc_core::{
    AgentKind, AgentStatus, Event, EventKind, Message, MessageKind, MissionStatus, Result, Severity, Task, TaskStatus,
    CENTRAL_ID, SYSTEM_ID, USER_ID,
};
use pcc_recovery::{CheckpointSummary, LastAction};
use pcc_store::TaskFilter;

use crate::central::AutoResumeNotice;
use crate::dto::RecoveryAgent;
use crate::engine::{first_line, Engine};
use crate::recovery::{clock, file_list};

/// First line of the report as Central (and the chat) receive it.
pub const REPORT_MARKER: &str = "[NEXUS RESUME REPORT]";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResumeMcp {
    pub server: String,
    /// `ok`, `failed` or `unknown` (not verifiable right now).
    pub state: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResumeAgent {
    pub agent_id: String,
    pub name: String,
    pub rank: String,
    pub status: String,
    pub task: Option<String>,
    /// `alive (pid N)`, `resumable`, `none`.
    pub session: String,
    /// What NEXUS did: `restarted (--resume)`, `started fresh`, `could not start: …`.
    pub action: Option<String>,
}

/// What NEXUS verified before resuming a mission.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResumeReport {
    /// `user`, `auto` or `central`.
    pub trigger: String,
    /// NEXUS was interrupted (crash, kill, reboot, close) while the mission ran.
    pub recovered: bool,
    pub mission_id: String,
    pub title: String,
    pub status: String,
    pub previous_state: String,
    pub tasks_total: usize,
    pub tasks_completed: usize,
    /// Completed tasks whose reported files are all on disk.
    pub tasks_verified: usize,
    pub done: Vec<String>,
    pub remaining: Vec<String>,
    pub files_validated: bool,
    pub files_expected: usize,
    pub files_present: usize,
    /// `path (TASK-x)` reported by a completed task and not found on disk.
    pub files_missing: Vec<String>,
    /// Files written after the mission's last checkpoint (interrupted missions):
    /// work that may be half done.
    pub files_since_checkpoint: Vec<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub uncommitted: Vec<String>,
    pub diff_stat: Option<String>,
    pub mcp: Vec<ResumeMcp>,
    pub claude: String,
    pub agents: Vec<ResumeAgent>,
    pub last_action: Option<LastAction>,
    pub last_checkpoint: Option<CheckpointSummary>,
    pub next_action: String,
}

impl ResumeReport {
    /// One line for notices: "Verified progress 3/5 tasks · Next: …".
    pub fn summary_line(&self) -> String {
        format!(
            "{} \"{}\": verified progress {}/{} tasks · Next: {}",
            self.mission_id,
            self.title,
            self.tasks_verified,
            self.tasks_total,
            first_line(&self.next_action, 160)
        )
    }

    /// The text Central receives (format of spec §116). Each fact is one
    /// `Key: value` line so the chat can render it as a recovery card.
    pub fn render(&self) -> String {
        let mut s = String::from(REPORT_MARKER);
        s.push('\n');
        s.push_str(if self.recovered {
            "Control Center recovered."
        } else if self.trigger == "central" {
            "Resume report requested by Central."
        } else {
            "Resume requested: the mission was still running."
        });
        s.push('\n');
        s.push_str(&format!("Mission: {} \"{}\" ({})\n", self.mission_id, self.title, self.status));
        s.push_str(&format!("Previous state: {}\n", self.previous_state));
        let unverified = self.tasks_completed - self.tasks_verified;
        s.push_str(&format!(
            "Verified progress: {}/{} tasks completed and verified{}\n",
            self.tasks_verified,
            self.tasks_total,
            if unverified > 0 {
                format!(" ({unverified} completed task(s) with missing files)")
            } else {
                String::new()
            }
        ));
        if self.files_validated {
            s.push_str(&format!(
                "Files: {}/{} files reported by completed tasks are on disk{}\n",
                self.files_present,
                self.files_expected,
                if self.files_missing.is_empty() {
                    String::new()
                } else {
                    format!("; missing: {}", file_list(&self.files_missing, 12))
                }
            ));
        } else {
            s.push_str("Files: not validated (Settings → Missions → Recovery: validation off)\n");
        }
        if !self.files_since_checkpoint.is_empty() {
            s.push_str(&format!(
                "Written since the last checkpoint (may be partial): {}
",
                file_list(&self.files_since_checkpoint, 12)
            ));
        }
        match &self.branch {
            Some(b) => s.push_str(&format!(
                "Repository: branch {b}{} · {}{}\n",
                self.head.as_deref().map(|h| format!(" · HEAD {h}")).unwrap_or_default(),
                if self.uncommitted.is_empty() {
                    "no uncommitted file".to_string()
                } else {
                    format!("{} uncommitted file(s): {}", self.uncommitted.len(), file_list(&self.uncommitted, 10))
                },
                self.diff_stat.as_deref().map(|d| format!(" · {d}")).unwrap_or_default()
            )),
            None => s.push_str("Repository: not a git repository\n"),
        }
        if self.mcp.is_empty() {
            s.push_str("MCP: none used by this mission\n");
        } else {
            let parts: Vec<String> = self
                .mcp
                .iter()
                .map(|m| {
                    let mark = match m.state.as_str() {
                        "ok" => "✓",
                        "failed" => "✗",
                        _ => "?",
                    };
                    format!("{} {mark} {}", m.server, m.detail)
                })
                .collect();
            s.push_str(&format!("MCP: {}\n", parts.join(" · ")));
        }
        s.push_str(&format!("Claude: {}\n", self.claude));
        if !self.agents.is_empty() {
            let parts: Vec<String> = self
                .agents
                .iter()
                .map(|a| {
                    format!(
                        "{} ({}) {}{}{}",
                        a.name,
                        a.rank,
                        a.status,
                        a.task.as_deref().map(|t| format!(" · {t}")).unwrap_or_default(),
                        a.action.as_deref().map(|x| format!(" → {x}")).unwrap_or_default()
                    )
                })
                .collect();
            s.push_str(&format!("Agents: {}\n", parts.join("; ")));
        }
        match &self.last_action {
            Some(l) => s.push_str(&format!("Last action: {} — {} ({})\n", l.agent_id, l.description, clock(&l.at))),
            None => s.push_str("Last action: no tool call recorded for this mission\n"),
        }
        if let Some(c) = &self.last_checkpoint {
            s.push_str(&format!("Last checkpoint: {} · {} ({})\n", c.name, c.reason, clock(&c.at)));
        }
        s.push_str(&format!(
            "Done: {}\n",
            if self.done.is_empty() { "nothing yet".into() } else { self.done.join("; ") }
        ));
        s.push_str(&format!(
            "Remaining: {}\n",
            if self.remaining.is_empty() { "no open task".into() } else { self.remaining.join("; ") }
        ));
        s.push_str(&format!("Next action: {}\n", self.next_action));
        s.push_str(
            "\nContinue this mission from the verified point: do not restart it and do not redo completed work. \
Before redoing any step, inspect what already exists (files, git status, MCP state); progress NEXUS cannot measure \
(content inside files, objects in an external tool) must be verified by you first. Then act with your tools or your \
agents, verify each result, and report. Ask the user only for what only the user can give.",
        );
        s
    }
}

fn task_line(t: &Task) -> String {
    format!(
        "{} \"{}\"{}{}",
        t.id,
        t.title,
        if t.status == TaskStatus::Completed { String::new() } else { format!(" {}", t.status.as_str()) },
        t.agent.as_ref().map(|a| format!(" ({a})")).unwrap_or_default()
    )
}

fn file_exists(root: &Path, workdir: Option<&Path>, f: &str) -> bool {
    let p = Path::new(f);
    if p.is_absolute() {
        return p.exists();
    }
    root.join(p).exists() || workdir.is_some_and(|w| w.join(p).exists())
}

impl Engine {
    /// The mission "reprends" continues: an interrupted one first (most recent
    /// checkpoint), else the running mission updated last.
    pub fn resume_candidate(&self) -> Result<Option<String>> {
        let interrupted = self
            .rec
            .interrupted
            .iter()
            .max_by_key(|m| m.last_checkpoint.as_ref().map(|c| c.at.clone()).unwrap_or_default())
            .map(|m| m.mission_id.clone());
        if interrupted.is_some() {
            return Ok(interrupted);
        }
        Ok(self
            .store
            .list_missions()?
            .into_iter()
            .map(|v| v.mission)
            .filter(|m| m.status.is_running() && m.archived_at.is_none())
            .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
            .map(|m| m.id))
    }

    /// Inspects the real state of a mission (nothing is changed).
    pub fn resume_report(&self, mission_id: &str, trigger: &str) -> Result<ResumeReport> {
        let m = self
            .store
            .get_mission(mission_id)?
            .ok_or_else(|| pcc_core::Error::not_found(format!("mission {mission_id}")))?;
        let settings = self.store.settings();
        let record = self.mission_record(&m)?;
        let interrupted = self.rec.interrupted.iter().find(|i| i.mission_id == mission_id);
        let tasks = self.store.list_tasks(&TaskFilter { mission_id: Some(m.id.clone()), ..Default::default() })?;
        let root = self.store.root().to_path_buf();
        let mut r = ResumeReport {
            trigger: trigger.into(),
            recovered: interrupted.is_some() || self.recovery.as_ref().is_some_and(|i| !i.agents.is_empty()),
            mission_id: m.id.clone(),
            title: m.title.clone(),
            status: m.status.as_str().into(),
            previous_state: match interrupted {
                Some(i) => format!("{} — interrupted during {}", i.previous_run, i.interrupted_during),
                None => format!("running — {}", record.current_step),
            },
            tasks_total: tasks.len(),
            files_validated: settings.mission_recovery.validate_files_before_resume,
            last_action: interrupted.and_then(|i| i.last_action.clone()).or_else(|| record.last_action.clone()),
            files_since_checkpoint: interrupted.map(|i| i.files_since_checkpoint.clone()).unwrap_or_default(),
            last_checkpoint: self.mission_checkpoints(&m.id).into_iter().next(),
            ..Default::default()
        };

        // Tasks: done vs remaining, files of completed tasks checked on disk.
        let mut missing_tasks = Vec::new();
        for t in &tasks {
            if t.status == TaskStatus::Completed {
                r.tasks_completed += 1;
                let mut ok = true;
                if r.files_validated {
                    let workdir = t
                        .agent
                        .as_ref()
                        .and_then(|a| self.store.get_agent(a).ok().flatten())
                        .map(|a| std::path::PathBuf::from(a.workdir));
                    for f in t.result.as_ref().map(|x| x.files_changed.clone()).unwrap_or_default() {
                        r.files_expected += 1;
                        if file_exists(&root, workdir.as_deref(), &f) {
                            r.files_present += 1;
                        } else {
                            ok = false;
                            r.files_missing.push(format!("{f} ({})", t.id));
                        }
                    }
                }
                if ok {
                    r.tasks_verified += 1;
                } else {
                    missing_tasks.push(t.id.clone());
                }
                r.done.push(task_line(t));
            } else if t.status == TaskStatus::Cancelled {
                r.done.push(task_line(t));
            } else {
                r.remaining.push(format!(
                    "{}{}",
                    task_line(t),
                    t.status_reason.as_deref().map(|x| format!(" — {}", first_line(x, 100))).unwrap_or_default()
                ));
            }
        }

        // Repository.
        if let Some(repo) = &self.repo {
            r.branch = repo.current_branch().or_else(|| Some("(detached)".into()));
            r.head = repo.git(&["rev-parse", "--short", "HEAD"]).ok().map(|s| s.trim().to_string());
            r.uncommitted = repo.dirty_files(&root).unwrap_or_default();
            r.diff_stat =
                repo.git(&["diff", "--shortstat"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        }

        // MCP: what Claude Code reports per session, else NEXUS's last probe.
        let mut servers: Vec<String> = Vec::new();
        for (_, s) in self.rec.mcp.keys() {
            if !servers.contains(s) {
                servers.push(s.clone());
            }
        }
        let connections = self.store.list_connections()?;
        for c in connections.iter().filter(|c| {
            c.enabled && matches!(c.kind, pcc_core::ConnectionKind::Mcp | pcc_core::ConnectionKind::RobloxStudio)
        }) {
            if !servers.contains(&c.id) {
                servers.push(c.id.clone());
            }
        }
        for s in &m.mcp {
            if !servers.contains(s) {
                servers.push(s.clone());
            }
        }
        for server in servers {
            let health: Vec<&crate::recovery::McpHealth> =
                self.rec.mcp.values().filter(|h| h.server == server && h.status != "session ended").collect();
            let name = connections.iter().find(|c| c.id == server).map(|c| c.name.clone()).unwrap_or(server.clone());
            let entry = if let Some(h) = health.iter().find(|h| h.status == "connected") {
                ResumeMcp {
                    server: name,
                    state: "ok".into(),
                    detail: format!("connected{}", h.tools.map(|n| format!(" ({n} tools)")).unwrap_or_default()),
                }
            } else if let Some(h) = health.first() {
                ResumeMcp {
                    server: name,
                    state: if h.status == "failed" { "failed".into() } else { "unknown".into() },
                    detail: format!(
                        "{}{}{}",
                        h.status,
                        h.cause.as_deref().map(|c| format!(": {c}")).unwrap_or_default(),
                        if h.reconnecting { " (NEXUS is reconnecting it)" } else { "" }
                    ),
                }
            } else if let Some(p) = self.rec.probes.get(&server) {
                ResumeMcp {
                    server: name,
                    state: if p.ok { "ok".into() } else { "failed".into() },
                    detail: if p.ok {
                        format!(
                            "answered NEXUS's probe at {}{}",
                            clock(&p.at),
                            p.tools.map(|n| format!(" ({n} tools)")).unwrap_or_default()
                        )
                    } else {
                        format!("probe failed at {}: {}", clock(&p.at), p.error.clone().unwrap_or_default())
                    },
                }
            } else {
                ResumeMcp {
                    server: name,
                    state: "unknown".into(),
                    detail: "not verified yet: no live session uses it (NEXUS checks it once the session is up and reconnects it if it failed)".into(),
                }
            };
            r.mcp.push(entry);
        }

        // Agents of the mission and their Claude sessions.
        for id in &record.agents {
            let Some(a) = self.store.get_agent(id)? else { continue };
            let session = match self.sessions.get(id) {
                Some(l) if pcc_recovery::sys::pid_alive(l.handle.pid) => format!("alive (pid {})", l.handle.pid),
                Some(l) => format!("process {} not answering", l.handle.pid),
                None if a.claude_session_id.is_some() => "resumable".into(),
                None => "none".into(),
            };
            r.agents.push(ResumeAgent {
                agent_id: a.id.clone(),
                name: a.name.clone(),
                rank: crate::hierarchy::rank_label(a.rank).into(),
                status: serde_json::to_value(a.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default(),
                task: a.current_task.clone(),
                session,
                action: None,
            });
        }
        r.claude = r
            .agents
            .iter()
            .find(|a| a.agent_id == CENTRAL_ID)
            .map(|a| format!("Central session {}", a.session))
            .unwrap_or_else(|| "Central has no session".into());

        // Next action.
        let open = |s: &[TaskStatus]| tasks.iter().filter(|t| s.contains(&t.status)).collect::<Vec<_>>();
        r.next_action = if !missing_tasks.is_empty() {
            format!(
                "Check the files reported by {} that are missing on disk ({}) before continuing: they may have been reverted, deleted or never merged.",
                missing_tasks.join(", "),
                file_list(&r.files_missing, 6)
            )
        } else if let Some(t) = open(&[TaskStatus::InProgress]).first() {
            format!(
                "Continue {} \"{}\"{} from where it stopped (inspect its files before redoing anything).",
                t.id,
                t.title,
                t.agent.as_ref().map(|a| format!(" with {a}")).unwrap_or_default()
            )
        } else if let Some(t) = open(&[TaskStatus::Review]).first() {
            format!("Review {} \"{}\": approve it or request changes.", t.id, t.title)
        } else if let Some(t) = open(&[TaskStatus::Blocked, TaskStatus::Waiting]).first() {
            format!(
                "Unblock {} \"{}\"{}.",
                t.id,
                t.title,
                t.status_reason.as_deref().map(|x| format!(" ({})", first_line(x, 120))).unwrap_or_default()
            )
        } else if let Some(t) = open(&[TaskStatus::Queued, TaskStatus::Pending]).first() {
            format!(
                "{} \"{}\" is {}: make sure its agent{} is running and its dependencies are done.",
                t.id,
                t.title,
                t.status.as_str(),
                t.agent.as_ref().map(|a| format!(" {a}")).unwrap_or_default()
            )
        } else if let Some(t) = open(&[TaskStatus::Failed]).first() {
            format!("{} \"{}\" failed: retry it, re-plan, or fail the mission.", t.id, t.title)
        } else if tasks.is_empty() {
            "The mission has no task yet: inspect the project state, then execute it (directly with your tools or by delegating).".into()
        } else {
            "Every task is finished: verify the result (files, tests, git status), then call complete_mission.".into()
        };
        Ok(r)
    }

    /// Stores a message without delivering it yet (delivered with the next turn).
    fn queue_message(
        &mut self,
        from: &str,
        to: &str,
        kind: MessageKind,
        body: &str,
        mission: Option<String>,
    ) -> Result<Message> {
        let m = Message {
            id: format!("msg-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            from: from.into(),
            to: to.into(),
            kind,
            subject: None,
            body: body.trim().to_string(),
            task_id: None,
            mission_id: mission,
            created_at: pcc_core::now(),
            delivered_at: None,
        };
        self.store.insert_message(&m)?;
        self.emit(
            Event::new(EventKind::AgentMessage, format!("{from} → {to}: {}", first_line(&m.body, 90)), json!(m))
                .agent(from)
                .mission(m.mission_id.clone()),
        );
        Ok(m)
    }

    /// Starts an agent for a resume; returns what was done.
    fn bring_back(&mut self, id: &str) -> String {
        let resume = self.store.agent(id).ok().and_then(|a| a.claude_session_id).is_some();
        match self.start_agent(id, resume) {
            Ok(()) => {
                if resume {
                    "restarted (--resume)".into()
                } else {
                    "started fresh (no previous conversation)".into()
                }
            }
            Err(e) => {
                let _ = self.set_status(id, AgentStatus::Crashed);
                format!("could not start: {e}")
            }
        }
    }

    /// Runs the resume flow for a mission: verified report, sessions brought
    /// back, Central briefed. `user_body` is the user's own words ("reprends"),
    /// delivered in the same turn as the report.
    pub fn resume_mission_flow(
        &mut self,
        mission_id: &str,
        trigger: &str,
        user_body: Option<&str>,
    ) -> Result<(ResumeReport, Option<Message>)> {
        self.ensure_not_emergency()?;
        let mut report = self.resume_report(mission_id, trigger)?;
        // Taken before the sessions come back (recovering them consumes it).
        let report_id = self.rec.startup_report.clone();
        self.autopilot = true;
        let user_msg = match user_body {
            Some(b) => Some(self.queue_message(USER_ID, CENTRAL_ID, MessageKind::User, b, Some(mission_id.into()))?),
            None => None,
        };
        let auto_restart = self.store.settings().mission_recovery.auto_restart_agents || trigger == "user";
        let mut actions: Vec<(String, String)> = Vec::new();

        let info = self.recovery.take();
        let sessions_recovered = info.as_ref().is_some_and(|i| !i.agents.is_empty());
        if let Some(info) = info.as_ref().filter(|_| sessions_recovered) {
            // Sessions that were running when NEXUS stopped: back with --resume
            // (as "Recover" does; the interrupted missions are resumed with them).
            let mut restarted = Vec::new();
            for ra in &info.agents {
                let note = (ra.agent_id != CENTRAL_ID).then(|| self.resume_note(ra));
                let what = self.bring_back(&ra.agent_id);
                if !what.starts_with("could not") {
                    restarted.push(ra.name.clone());
                    if let Some(note) = note {
                        self.post_message(
                            SYSTEM_ID,
                            &ra.agent_id,
                            MessageKind::System,
                            &note,
                            ra.task_id.clone(),
                            None,
                        )?;
                    }
                }
                actions.push((ra.agent_id.clone(), what));
            }
            self.rec_after_recover(&restarted);
        } else {
            // Only interrupted missions (no live session to bring back) stay offered.
            self.recovery = info;
        }
        // Then Central and the workers whose task of this mission is interrupted,
        // if they are not running yet.
        {
            if !self.sessions.contains_key(CENTRAL_ID) && self.store.agent(CENTRAL_ID)?.paused_at.is_none() {
                let what = self.bring_back(CENTRAL_ID);
                actions.push((CENTRAL_ID.into(), what));
            }
            let tasks =
                self.store.list_tasks(&TaskFilter { mission_id: Some(mission_id.into()), ..Default::default() })?;
            for t in tasks.iter().filter(|t| t.status == TaskStatus::InProgress) {
                let Some(aid) = t.agent.clone() else { continue };
                if self.sessions.contains_key(&aid) || actions.iter().any(|(a, _)| a == &aid) {
                    continue;
                }
                let a = self.store.agent(&aid)?;
                if a.kind != AgentKind::Worker || a.paused_at.is_some() || !Engine::needs_restart(a.status) {
                    continue;
                }
                if !auto_restart {
                    actions.push((aid.clone(), "not restarted (automatic restart is off)".into()));
                    continue;
                }
                let ra = RecoveryAgent {
                    agent_id: aid.clone(),
                    name: a.name.clone(),
                    claude_session_id: a.claude_session_id.clone(),
                    task_id: Some(t.id.clone()),
                };
                let note = self.resume_note(&ra);
                let what = self.bring_back(&aid);
                if !what.starts_with("could not") {
                    self.post_message(SYSTEM_ID, &aid, MessageKind::System, &note, Some(t.id.clone()), None)?;
                }
                actions.push((aid, what));
            }
            if !sessions_recovered {
                self.rec.interrupted.retain(|m| m.mission_id != mission_id);
                let reason = if report.recovered {
                    format!("resumed after interruption ({trigger})")
                } else {
                    format!("resumed ({trigger})")
                };
                self.checkpoint_mission(mission_id, &reason, true);
            }
        }
        if let Some(info) = self.recovery.as_mut() {
            info.missions.retain(|m| m.mission_id != mission_id);
            if info.agents.is_empty() && info.missions.is_empty() {
                self.recovery = None;
            }
        }

        for (id, what) in &actions {
            if let Some(a) = report.agents.iter_mut().find(|a| &a.agent_id == id) {
                a.action = Some(what.clone());
            }
        }
        report.claude = match actions.iter().find(|(a, _)| a == CENTRAL_ID) {
            Some((_, w)) if w.starts_with("restarted") => "Central session recovered (--resume)".into(),
            Some((_, w)) if w.starts_with("started fresh") => {
                "Central session restarted fresh (the previous conversation could not be resumed)".into()
            }
            Some((_, w)) => format!("Central {w}"),
            None => match self.sessions.get(CENTRAL_ID) {
                Some(l) => format!("Central session already running (pid {})", l.handle.pid),
                None => "Central has no session".into(),
            },
        };
        let workers: Vec<String> =
            actions.iter().filter(|(a, _)| a != CENTRAL_ID).map(|(a, w)| format!("{a} {w}")).collect();
        if !workers.is_empty() {
            report.claude.push_str(&format!("; workers: {}", workers.join(", ")));
        }

        self.central.blocks.remove(mission_id);
        let text = report.render();
        self.post_message(SYSTEM_ID, CENTRAL_ID, MessageKind::System, &text, None, Some(mission_id.into()))?;
        let line = format!("{mission_id}: resumed ({trigger}), Central briefed with a verified report");
        self.amend_report(report_id.as_deref(), |r| r.restarted.push(line));
        self.emit(
            Event::new(
                EventKind::MissionUpdated,
                format!("Mission {mission_id} resumed ({trigger}): {}", report.summary_line()),
                json!({"report": report}),
            )
            .mission(Some(mission_id.into()))
            .agent(CENTRAL_ID)
            .named("mission.resumed")
            .with_source("resume"),
        );
        self.schedule()?;
        Ok((report, user_msg))
    }

    /// "reprends" when nothing is running: Central gets the facts with the
    /// user's words in the same turn, never a blind "what should I resume?".
    fn resume_nothing(&mut self, user_body: &str) -> Result<Message> {
        self.ensure_not_emergency()?;
        self.autopilot = true;
        let user = self.queue_message(USER_ID, CENTRAL_ID, MessageKind::User, user_body, None)?;
        let last = self
            .store
            .list_missions()?
            .into_iter()
            .map(|v| v.mission)
            .filter(|m| m.status != MissionStatus::Queued)
            .max_by(|a, b| a.updated_at.cmp(&b.updated_at));
        let queued = self.store.queued_missions()?;
        let mut s = format!("{REPORT_MARKER}\nNothing to resume: no running or interrupted mission was found.\n");
        match &last {
            Some(m) => s.push_str(&format!(
                "Last mission: {} \"{}\" ({}{})\n",
                m.id,
                m.title,
                m.status.as_str(),
                m.summary.as_deref().map(|x| format!(": {}", first_line(x, 200))).unwrap_or_default()
            )),
            None => s.push_str("Last mission: none in this project\n"),
        }
        if !queued.is_empty() {
            s.push_str(&format!(
                "Queued: {}\n",
                queued.iter().map(|m| format!("{} \"{}\"", m.id, m.title)).collect::<Vec<_>>().join("; ")
            ));
        }
        s.push_str("Next action: Tell the user plainly that nothing was interrupted; if the last mission left follow-up work (see its summary), offer to continue it.\n");
        self.wake(CENTRAL_ID)?;
        self.post_message(SYSTEM_ID, CENTRAL_ID, MessageKind::System, &s, None, None)?;
        Ok(user)
    }

    /// The user typed an unambiguous RESUME command to Central.
    pub(crate) fn resume_by_user(&mut self, body: &str) -> Result<Message> {
        match self.resume_candidate()? {
            Some(mid) => {
                let (_, msg) = self.resume_mission_flow(&mid, "user", Some(body))?;
                Ok(msg.expect("user message queued"))
            }
            None => self.resume_nothing(body),
        }
    }

    /// At open, with Settings → Missions → Recovery → auto-resume on: resumes
    /// the last interrupted mission. The outcome is shown as a notice.
    pub fn auto_resume_on_open(&mut self) {
        if self.store.read_only() || self.emergency || self.rec.interrupted.is_empty() {
            return;
        }
        if !self.store.settings().mission_recovery.auto_resume_missions {
            return;
        }
        let Ok(Some(mid)) = self.resume_candidate() else { return };
        let title = self.store.get_mission(&mid).ok().flatten().map(|m| m.title);
        let notice = match self.resume_mission_flow(&mid, "auto", None) {
            Ok((report, _)) => AutoResumeNotice {
                mission_id: Some(mid),
                title,
                summary: report.summary_line(),
                ok: true,
                at: pcc_core::now(),
            },
            Err(e) => {
                self.emit(
                    Event::new(
                        EventKind::Error,
                        format!("Automatic resume of {mid} failed: {e}"),
                        json!({"error": e.to_string()}),
                    )
                    .mission(Some(mid.clone()))
                    .named("mission.autoResumeFailed")
                    .with_severity(Severity::Error)
                    .with_source("resume"),
                );
                AutoResumeNotice {
                    mission_id: Some(mid),
                    title,
                    summary: format!("Automatic resume failed: {e}. Resume it from the dialog."),
                    ok: false,
                    at: pcc_core::now(),
                }
            }
        };
        self.central.auto_resume = Some(notice);
    }

    pub fn auto_resume_notice(&self) -> Option<AutoResumeNotice> {
        self.central.auto_resume.clone()
    }

    pub fn dismiss_auto_resume(&mut self) {
        self.central.auto_resume = None;
    }
}
