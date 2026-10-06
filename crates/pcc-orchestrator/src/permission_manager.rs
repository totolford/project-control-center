//! PermissionManager: agent → PermissionManager → PermissionStore (SQLite)
//! → event bus → UI.
//!
//! Every request is a persistent [`PermissionRecord`]. Its state changes
//! (pending, approved, denied, expired, cancelled, consumed, lost, recovered)
//! are written to the store before they are emitted, so a UI refresh, a
//! renderer restart or a NEXUS restart never loses a request, and acting on
//! a request that already ended returns an explanation, never "not found".
//!
//! Only the delivery handle of an open request (the Claude Code control
//! request it answers, or the merge/admin action to run) lives in memory.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use pcc_claude::protocol;
use pcc_core::{
    explain, Error, Event, EventKind, LogKind, MessageKind, PermissionDecision, PermissionKind, PermissionOutcome,
    PermissionRecord, PermissionRequest, PermissionStatus, PermissionStatusReport, Result, Severity, SYSTEM_ID,
};

use crate::admin::AdminAction;
use crate::engine::{first_line, Engine, PendingKind};

/// A lost tool request is re-linked when the agent asks again within this window.
const RELINK_WINDOW_HOURS: i64 = 24;

pub(crate) struct OpenPermission {
    pub record: PermissionRecord,
    pub kind: PendingKind,
}

/// Open requests with their delivery handles. Records are persisted by the engine.
#[derive(Default)]
pub struct PermissionManager {
    open: BTreeMap<String, OpenPermission>,
}

impl PermissionManager {
    pub fn new() -> Self {
        Self::default()
    }
    /// Ids of the open requests, oldest id order.
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.open.keys()
    }
    pub fn is_empty(&self) -> bool {
        self.open.is_empty()
    }
    pub fn len(&self) -> usize {
        self.open.len()
    }
    /// Open requests, oldest first.
    pub fn records(&self) -> Vec<PermissionRecord> {
        let mut v: Vec<PermissionRecord> = self.open.values().map(|o| o.record.clone()).collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        v
    }
    /// The agent has at least one request waiting for the user.
    pub fn any_for(&self, agent: &str) -> bool {
        self.open.values().any(|o| o.record.agent_id == agent)
    }
    pub fn get(&self, id: &str) -> Option<&PermissionRecord> {
        self.open.get(id).map(|o| &o.record)
    }
    fn tool_ids_of(&self, agent: &str) -> Vec<String> {
        self.open
            .iter()
            .filter(|(_, o)| o.record.agent_id == agent && o.record.kind == PermissionKind::Tool)
            .map(|(k, _)| k.clone())
            .collect()
    }
    fn expired_ids(&self, now: &str) -> Vec<String> {
        self.open
            .iter()
            .filter(|(_, o)| o.record.expires_at.as_deref().is_some_and(|e| e <= now))
            .map(|(k, _)| k.clone())
            .collect()
    }
}

/// Serialized merge/admin action so the request survives a restart. Requests
/// carrying secret values are never written: they cannot be resumed.
fn resume_data(kind: &PendingKind) -> Option<Value> {
    match kind {
        PendingKind::Tool { .. } => None,
        PendingKind::Merge { agent } => Some(json!({"merge": agent})),
        PendingKind::Admin(action) => {
            if let AdminAction::CreateConnection(input) = action.as_ref() {
                if input.secrets.as_ref().is_some_and(|s| !s.is_empty()) {
                    return None;
                }
            }
            serde_json::to_value(action.as_ref()).ok().map(|a| json!({"admin": a}))
        }
    }
}

fn kind_from_resume(data: &Value) -> Option<PendingKind> {
    if let Some(agent) = data.get("merge").and_then(Value::as_str) {
        return Some(PendingKind::Merge { agent: agent.to_string() });
    }
    let action: AdminAction = serde_json::from_value(data.get("admin")?.clone()).ok()?;
    Some(PendingKind::Admin(Box::new(action)))
}

fn plus_minutes(minutes: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::minutes(minutes)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Engine {
    // ------------------------------------------------------------ creation

    /// Registers a request for the user: persisted, announced, and linked to a
    /// lost identical request of the same agent if there is one.
    pub(crate) fn ask_user(&mut self, req: PermissionRequest, kind: PendingKind) -> Result<()> {
        let agent = req.agent_id.clone();
        let live = self.sessions.get(&agent);
        let pid = live.map(|l| l.handle.pid);
        let row = live.map(|l| l.session_row).unwrap_or(0);
        let record_kind = match &kind {
            PendingKind::Tool { .. } => PermissionKind::Tool,
            PendingKind::Merge { .. } => PermissionKind::Merge,
            PendingKind::Admin(_) => PermissionKind::Admin,
        };
        let mut r = PermissionRecord::new(req, record_kind);
        if let PendingKind::Tool { request_id, epoch, tool_use_id, .. } = &kind {
            r.request_id = Some(request_id.clone());
            r.session_epoch = *epoch;
            r.tool_use_id = tool_use_id.clone();
            let class = pcc_core::permissions::classify_tool(&r.tool_name, &r.input, &[]);
            (r.risk, r.resource) = pcc_core::tool_risk(&r.tool_name, &r.input, &class);
        }
        r.process_id = pid;
        r.session_row = row;
        r.resume_data = resume_data(&kind);
        if let Some(task) = self.store.get_agent(&agent)?.and_then(|a| a.current_task) {
            r.task_id = Some(task.clone());
            r.mission_id = self.store.get_task(&task)?.and_then(|t| t.mission_id);
        }
        let timeout = self.store.settings().permission_timeout_minutes;
        r.expires_at = (timeout > 0).then(|| plus_minutes(timeout as i64));

        // The agent asks again for an action whose request was lost with its
        // previous session: keep the same card instead of a blind new one.
        let mut name = "permission.created";
        if record_kind == PermissionKind::Tool {
            let since = (chrono::Utc::now() - chrono::Duration::hours(RELINK_WINDOW_HOURS))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            if let Some(lost) = self.store.find_lost_permission(&agent, &r.tool_name, &r.input, &since)? {
                let new_request = r.id.clone();
                r.id = lost.id.clone();
                r.created_at = lost.created_at.clone();
                r.recoveries = lost.recoveries + 1;
                r.status = PermissionStatus::Recovered;
                r.resolution = Some(format!(
                    "re-linked: the agent asked again for the same action after its session was lost (new prompt {new_request})"
                ));
                name = "permission.recovered";
            }
        }
        r.updated_at = pcc_core::now();
        self.store.upsert_permission(&r)?;
        let summary = if name == "permission.recovered" {
            format!("{agent} asks again (recovered): {}", first_line(&r.summary, 110))
        } else {
            format!("{agent} wants: {}", first_line(&r.summary, 120))
        };
        self.emit(
            Event::new(EventKind::PermissionRequested, summary, json!(r))
                .agent(&agent)
                .mission(r.mission_id.clone())
                .named(name)
                .with_pid(pid),
        );
        self.permissions.open.insert(r.id.clone(), OpenPermission { record: r, kind });
        if self.sessions.get(&agent).is_some_and(|l| l.busy) {
            self.set_status(&agent, pcc_core::AgentStatus::AwaitingPermission)?;
        }
        Ok(())
    }

    /// Persists a state change made without a user decision and announces it.
    fn record_transition(&mut self, mut r: PermissionRecord, status: PermissionStatus, resolution: String) {
        r.status = status;
        r.resolution = Some(resolution);
        r.updated_at = pcc_core::now();
        if let Err(e) = self.store.upsert_permission(&r) {
            tracing::error!("cannot persist permission {}: {e}", r.id);
        }
        let severity = match status {
            PermissionStatus::Lost | PermissionStatus::Expired => Severity::Warning,
            _ => Severity::Info,
        };
        self.emit(
            Event::new(
                EventKind::PermissionUpdated,
                format!("Permission {} {}: {}", r.id, status.as_str(), first_line(&r.summary, 90)),
                json!(r),
            )
            .agent(&r.agent_id)
            .mission(r.mission_id.clone())
            .with_severity(severity)
            .with_pid(r.process_id),
        );
    }

    /// After a request of `agent` closed: back to working/waiting if nothing else waits.
    fn refresh_after_permission(&mut self, agent: &str) -> Result<()> {
        if self.permissions.any_for(agent) {
            return Ok(());
        }
        if let Some(l) = self.sessions.get(agent) {
            let busy = l.busy;
            let status = self.store.agent(agent)?.status;
            if status == pcc_core::AgentStatus::AwaitingPermission || busy {
                self.set_status(
                    agent,
                    if busy { pcc_core::AgentStatus::Working } else { pcc_core::AgentStatus::Waiting },
                )?;
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ decisions

    /// Applies the user's decision. Idempotent: a second identical decision,
    /// a decision on an ended request or on an unknown id returns an
    /// explanation (`applied: false`), never an error.
    pub fn resolve_permission(&mut self, id: &str, decision: PermissionDecision) -> Result<PermissionOutcome> {
        self.resolve_permission_by(id, decision, "user")
    }

    pub(crate) fn resolve_permission_by(
        &mut self,
        id: &str,
        decision: PermissionDecision,
        by: &str,
    ) -> Result<PermissionOutcome> {
        let Some(open) = self.permissions.open.remove(id) else {
            return Ok(match self.store.get_permission(id)? {
                Some(r) if r.status.is_open() => {
                    // Persisted as open but without a delivery handle (should not
                    // happen after start-up reconciliation): it cannot be answered.
                    self.record_transition(
                        r.clone(),
                        PermissionStatus::Lost,
                        "the request was no longer attached to a running session".into(),
                    );
                    let r = self.store.get_permission(id)?.unwrap_or(r);
                    pcc_core::closed_outcome(&r, decision)
                }
                Some(r) => pcc_core::closed_outcome(&r, decision),
                None => pcc_core::unknown_outcome(id),
            });
        };
        let OpenPermission { mut record, kind } = open;
        let agent = record.agent_id.clone();
        let allow = decision != PermissionDecision::Reject;
        let now = pcc_core::now();
        record.decision = Some(decision);
        record.decided_at = Some(now.clone());
        record.decided_by = Some(by.to_string());
        record.updated_at = now;
        self.store
            .insert_decision(pcc_core::DecisionRecord {
                id: 0,
                ts: pcc_core::now(),
                agent_id: agent.clone(),
                tool_name: record.tool_name.clone(),
                capability: Some(record.capability.clone()).filter(|c| !c.is_empty()),
                summary: record.summary.clone(),
                decision: if allow { "user_allowed" } else { "user_rejected" }.into(),
                actor: by.into(),
                reason: Some(format!("{decision:?}")),
            })
            .map(|_| ())
            .unwrap_or_else(|e| tracing::error!("cannot journal decision: {e}"));
        let mut rule_note = "";
        if decision == PermissionDecision::AllowAlways {
            self.store.add_permission_rule(&agent, &record.rule_key)?;
            rule_note = " The rule was saved: the agent will not need to ask for this again.";
        }

        let (status, resolution, applied) = match kind {
            PendingKind::Tool { request_id, input, epoch, .. } => {
                if self.sessions.get(&agent).is_some_and(|l| l.epoch == epoch) {
                    let line = if allow {
                        protocol::permission_allow(&request_id, &self.harden_input(&agent, &record.tool_name, &input))
                    } else {
                        let msg = if by == "emergency" {
                            "NEXUS emergency stop: this action was refused. Do not retry it."
                        } else {
                            "The user rejected this action. Do not retry it; continue without it or report the blocker."
                        };
                        protocol::permission_deny(&request_id, msg)
                    };
                    self.write(&agent, line)?;
                    if allow {
                        (PermissionStatus::Consumed, "approval delivered to the agent's session".to_string(), true)
                    } else {
                        (PermissionStatus::Denied, "refusal delivered to the agent's session".to_string(), true)
                    }
                } else {
                    (
                        PermissionStatus::Lost,
                        "the session that asked ended before the answer could be delivered".to_string(),
                        false,
                    )
                }
            }
            PendingKind::Admin(action) => {
                if allow {
                    record.status = PermissionStatus::Approved;
                    self.store.upsert_permission(&record)?;
                    let note = match self.apply_admin(*action) {
                        Ok(n) => format!("The user approved: {n}"),
                        Err(e) => format!("The approved change failed: {e}"),
                    };
                    self.post_message(SYSTEM_ID, &agent, MessageKind::System, &note, None, None)?;
                    (PermissionStatus::Consumed, note, true)
                } else {
                    let note = format!("The user rejected: {}", record.summary);
                    self.post_message(SYSTEM_ID, &agent, MessageKind::System, &note, None, None)?;
                    (PermissionStatus::Denied, note, true)
                }
            }
            PendingKind::Merge { agent: worker } => {
                let text = if allow {
                    record.status = PermissionStatus::Approved;
                    self.store.upsert_permission(&record)?;
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
                (if allow { PermissionStatus::Consumed } else { PermissionStatus::Denied }, text, true)
            }
        };
        record.status = status;
        record.resolution = Some(resolution);
        self.store.upsert_permission(&record)?;
        let event = if applied {
            Event::new(
                EventKind::PermissionResolved,
                format!("{:?}: {}", decision, first_line(&record.summary, 100)),
                json!(record),
            )
        } else {
            Event::new(
                EventKind::PermissionUpdated,
                format!("Permission {id} lost: {}", first_line(&record.summary, 90)),
                json!(record),
            )
            .with_severity(Severity::Warning)
        };
        self.emit(event.agent(&agent).mission(record.mission_id.clone()).with_pid(record.process_id));
        self.refresh_after_permission(&agent)?;
        let message = if applied {
            format!("{}.{rule_note}", if allow { "Approved" } else { "Denied" })
        } else {
            format!("{}{rule_note}", explain(&record))
        };
        Ok(PermissionOutcome { id: id.into(), applied, status: Some(record.status), message, record: Some(record) })
    }

    // ------------------------------------------------------------ lifecycle

    /// The session of `agent` ended: its tool requests can no longer be answered.
    pub(crate) fn lose_session_permissions(&mut self, agent: &str, why: &str) {
        for id in self.permissions.tool_ids_of(agent) {
            if let Some(open) = self.permissions.open.remove(&id) {
                self.record_transition(open.record, PermissionStatus::Lost, why.to_string());
            }
        }
    }

    /// Requests nobody answered in time: the agent receives a refusal so it
    /// never waits forever. Returns how many expired.
    pub fn expire_permissions(&mut self) -> Result<usize> {
        self.expire_permissions_at(&pcc_core::now())
    }

    /// Expires the requests whose deadline is at or before `now` (RFC 3339).
    pub fn expire_permissions_at(&mut self, now: &str) -> Result<usize> {
        if self.store.read_only() {
            return Ok(0);
        }
        let ids = self.permissions.expired_ids(now);
        let minutes = self.store.settings().permission_timeout_minutes;
        for id in &ids {
            let Some(OpenPermission { mut record, kind }) = self.permissions.open.remove(id) else { continue };
            let agent = record.agent_id.clone();
            record.decision = Some(PermissionDecision::Reject);
            record.decided_at = Some(pcc_core::now());
            record.decided_by = Some("timeout".into());
            let note = format!(
                "This permission request expired after {minutes} minute(s) without an answer from the user. Continue without this action or report the blocker; ask again later only if it is still needed."
            );
            match kind {
                PendingKind::Tool { request_id, epoch, .. } => {
                    if self.sessions.get(&agent).is_some_and(|l| l.epoch == epoch) {
                        self.write(&agent, protocol::permission_deny(&request_id, &note))?;
                        let row = self.sessions.get(&agent).map(|l| l.session_row).unwrap_or(0);
                        self.log(&agent, row, LogKind::System, &format!("Permission expired: {}", record.summary));
                    }
                }
                PendingKind::Merge { .. } => self.notify_central(&format!("{}: {note}", record.summary), None, None)?,
                PendingKind::Admin(_) => {
                    let text = format!("{}: {note}", record.summary);
                    self.post_message(SYSTEM_ID, &agent, MessageKind::System, &text, None, None)?;
                }
            }
            self.record_transition(record, PermissionStatus::Expired, format!("no answer within {minutes} minute(s)"));
            self.refresh_after_permission(&agent)?;
        }
        Ok(ids.len())
    }

    /// At project open: requests left open by the previous NEXUS instance.
    /// Tool prompts died with their session (`lost`); merge and admin
    /// requests do not need a session and wait again (`recovered`).
    pub(crate) fn reconcile_permissions(&mut self) -> Result<()> {
        for mut r in self.store.open_permissions()? {
            let resumable = r.resume_data.as_ref().and_then(kind_from_resume);
            match resumable {
                Some(kind) if r.kind != PermissionKind::Tool => {
                    r.status = PermissionStatus::Recovered;
                    r.resolution = Some("NEXUS was restarted; the request is waiting again".into());
                    r.updated_at = pcc_core::now();
                    self.store.upsert_permission(&r)?;
                    self.emit(
                        Event::new(
                            EventKind::PermissionRequested,
                            format!("{} still wants (recovered): {}", r.agent_id, first_line(&r.summary, 110)),
                            json!(r),
                        )
                        .agent(&r.agent_id)
                        .mission(r.mission_id.clone())
                        .named("permission.recovered"),
                    );
                    self.permissions.open.insert(r.id.clone(), OpenPermission { record: r, kind });
                }
                _ => {
                    let ended = self
                        .store
                        .get_session(r.session_row)
                        .ok()
                        .flatten()
                        .and_then(|s| s.ended_at.map(|t| format!(" (session ended {})", pcc_core::human_time(&t))))
                        .unwrap_or_default();
                    let why = if r.kind == PermissionKind::Tool {
                        format!("NEXUS was closed or restarted while it waited; the Claude Code session that asked is gone{ended}")
                    } else {
                        "NEXUS was restarted and the request could not be restored (it carried secret values)".into()
                    };
                    self.record_transition(r, PermissionStatus::Lost, why);
                }
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ queries

    /// Real state of a request: store → agent → session/process → was the
    /// action executed → can it be asked again.
    pub fn permission_status(&self, id: &str) -> Result<PermissionStatusReport> {
        let Some(r) = self.permissions.get(id).cloned().map(Some).unwrap_or(self.store.get_permission(id)?) else {
            return Ok(PermissionStatusReport {
                id: id.into(),
                found: false,
                record: None,
                explanation: pcc_core::unknown_outcome(id).message,
                agent_name: None,
                agent_status: None,
                session_alive: false,
                process_id: None,
                same_session: false,
                executed: None,
                execution_detail: None,
                can_rerequest: false,
            });
        };
        let agent = self.store.get_agent(&r.agent_id)?;
        let live = self.sessions.get(&r.agent_id);
        let session_alive = live.is_some();
        let same_session = r.kind == PermissionKind::Tool && live.is_some_and(|l| l.epoch == r.session_epoch);
        let (executed, execution_detail) = self.execution_evidence(&r);
        let retired = agent.as_ref().is_none_or(|a| a.status == pcc_core::AgentStatus::Retired);
        let can_rerequest = !retired
            && matches!(
                r.status,
                PermissionStatus::Lost
                    | PermissionStatus::Expired
                    | PermissionStatus::Cancelled
                    | PermissionStatus::Denied
            );
        let name = agent.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| r.agent_id.clone());
        let agent_line = match (&agent, live) {
            (None, _) => format!(" The agent {} no longer exists.", r.agent_id),
            (Some(a), _) if a.status == pcc_core::AgentStatus::Retired => format!(" {name} is retired."),
            (Some(_), Some(l)) => format!(" {name} is running now (pid {}).", l.handle.pid),
            (Some(a), None) => format!(" {name} has no running session (status: {:?}).", a.status),
        };
        Ok(PermissionStatusReport {
            id: id.into(),
            found: true,
            explanation: format!("{}{agent_line}", explain(&r)),
            agent_name: Some(name),
            agent_status: agent.map(|a| a.status),
            session_alive,
            process_id: live.map(|l| l.handle.pid),
            same_session,
            executed,
            execution_detail,
            can_rerequest,
            record: Some(r),
        })
    }

    fn execution_evidence(&self, r: &PermissionRecord) -> (Option<bool>, Option<String>) {
        match r.status {
            PermissionStatus::Pending | PermissionStatus::Recovered => {
                (Some(false), Some("Not executed: waiting for a decision.".into()))
            }
            PermissionStatus::Denied
            | PermissionStatus::Expired
            | PermissionStatus::Lost
            | PermissionStatus::Cancelled => {
                (Some(false), Some("Not executed: the agent never received an approval for this request.".into()))
            }
            PermissionStatus::Approved | PermissionStatus::Consumed => {
                if r.kind != PermissionKind::Tool {
                    return (Some(r.status == PermissionStatus::Consumed), r.resolution.clone());
                }
                let cmd = r.tool_use_id.as_deref().and_then(|tu| {
                    self.store.list_commands(Some(&r.agent_id), None, 2000).ok()?.into_iter().find(|c| {
                        c.tool_use_id.as_deref() == Some(tu) && c.started_at.as_str() >= r.created_at.as_str()
                    })
                });
                match cmd {
                    Some(c) if c.ended_at.is_some() => (
                        Some(true),
                        Some(format!(
                            "Executed: finished at {}{}.",
                            pcc_core::human_time(c.ended_at.as_deref().unwrap_or_default()),
                            match (c.exit_code, c.is_error) {
                                (Some(code), _) => format!(" with exit code {code}"),
                                (None, Some(true)) => " with an error".into(),
                                _ => String::new(),
                            }
                        )),
                    ),
                    Some(_) => (Some(true), Some("Running: the command started and has not finished yet.".into())),
                    None => (None, Some("The approval was delivered; the result is in the agent's terminal.".into())),
                }
            }
        }
    }

    /// Recent requests (any state), newest first.
    pub fn permission_history(&self, agent: Option<&str>, limit: u32) -> Result<Vec<PermissionRecord>> {
        self.store.list_permissions(agent, None, limit)
    }

    /// Asks the agent to try an ended request's action again; Claude Code
    /// then shows a new (re-linked) prompt if it still needs it.
    pub fn rerequest_permission(&mut self, id: &str) -> Result<String> {
        let r = self.store.get_permission(id)?.ok_or_else(|| Error::invalid(pcc_core::unknown_outcome(id).message))?;
        if r.status.is_open() {
            return Ok("This request is already waiting for your decision.".into());
        }
        if matches!(r.status, PermissionStatus::Consumed | PermissionStatus::Approved) {
            return Ok(format!(
                "Already approved at {}; nothing to ask again.",
                pcc_core::human_time(r.decided_at.as_deref().unwrap_or(&r.updated_at))
            ));
        }
        self.ensure_not_emergency()?;
        self.autopilot = true;
        self.wake(&r.agent_id)?;
        let what = match r.kind {
            PermissionKind::Tool => format!("{} (tool {} with the same input)", r.summary, r.tool_name),
            _ => r.summary.clone(),
        };
        self.post_message(
            SYSTEM_ID,
            &r.agent_id,
            MessageKind::System,
            &format!(
                "The user asks you to retry this action if you still need it: {what}. Its previous permission request ({id}) ended as {}; a new request will be shown to the user.",
                r.status.as_str()
            ),
            r.task_id.clone(),
            r.mission_id.clone(),
        )?;
        Ok(format!("Asked {} to request it again if it still needs it.", r.agent_id))
    }
}
