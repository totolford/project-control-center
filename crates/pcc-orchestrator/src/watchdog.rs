//! The watchdog: periodic health checks of the project's Claude Code sessions
//! and their MCP servers, automatic restarts of crashed sessions, periodic
//! mission checkpoints.
//!
//! Escalation is always diagnose → soft recovery → graceful restart with
//! `--resume` → brief. Nothing is killed without a state check, a soft attempt,
//! a recorded reason, the saved context (Claude conversation id, mission
//! checkpoint) and a check of the agent's modified files.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pcc_core::{AgentKind, AgentStatus, Event, EventKind, LogKind, Result, Severity, CENTRAL_ID};
use pcc_recovery::{diagnose, CrashReport, RestartDecision, RestartPolicy, SessionObservation, WatchAction};

use crate::engine::Engine;
use crate::recovery::{session_key, ControlPurpose, McpHealth, PendingControl};

/// How often the orchestrator calls [`Engine::watchdog_tick`].
pub const TICK: Duration = Duration::from_secs(15);
const PERIODIC_CHECKPOINT: Duration = Duration::from_secs(5 * 60);
const MCP_POLL: Duration = Duration::from_secs(60);
/// A control request without an answer for this long is dropped (and noted).
const CONTROL_TIMEOUT: Duration = Duration::from_secs(90);

fn ago(now: Instant, t: Instant) -> Duration {
    now.saturating_duration_since(t)
}

impl Engine {
    /// One watchdog pass. `now` is injectable for tests.
    pub fn watchdog_tick(&mut self, now: Instant) -> Result<()> {
        if self.store.read_only() {
            return Ok(());
        }
        self.rec.last_tick = Some(pcc_core::now());
        self.check_live_sessions(now)?;
        self.restart_crashed(now)?;
        self.poll_mcp(now);
        if self.rec.last_periodic.is_none_or(|t| ago(now, t) >= PERIODIC_CHECKPOINT) {
            self.rec.last_periodic = Some(now);
            self.checkpoint_active_missions("periodic", false);
        }
        Ok(())
    }

    fn check_live_sessions(&mut self, now: Instant) -> Result<()> {
        let cfg = pcc_recovery::watchdog::WatchdogConfig::default();
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            let Some(live) = self.sessions.get(&id) else { continue };
            if live.stopping {
                continue;
            }
            let (busy, epoch, pid, row) = (live.busy, live.epoch, live.handle.pid, live.session_row);
            let awaiting = self.agent_status(&id) == Some(AgentStatus::AwaitingPermission);
            let Some(w) = self.rec.sessions.get_mut(&id) else { continue };
            if w.epoch != epoch {
                continue;
            }
            let info = pcc_recovery::sys::process_info(pid);
            let alive = info.is_some();
            let cpu = info.and_then(|i| i.cpu_ms);
            let cpu_active = match (w.cpu_ms, cpu) {
                (Some(a), Some(b)) => Some(b > a + 50),
                _ => None,
            };
            w.cpu_ms = cpu;
            w.dead_ticks = if alive { 0 } else { w.dead_ticks.saturating_add(1) };
            let obs = SessionObservation {
                alive,
                busy,
                awaiting_permission: awaiting,
                since_output: ago(now, w.last_output),
                inflight_tool: w.oldest_inflight().map(|(n, t)| (n.to_string(), ago(now, t))),
                cpu_active,
                soft_attempt_ago: w.soft_at.map(|t| ago(now, t)),
            };
            let d = diagnose(&obs, &cfg);
            w.diagnosis = Some(d.clone());
            w.checked_at = Some(pcc_core::now());
            let dead_ticks = w.dead_ticks;
            let key = session_key(&id);
            match d.verdict {
                pcc_recovery::Verdict::Stalled => {
                    self.rec.registry.set_state(&key, pcc_recovery::ProcessState::Unresponsive, Some(d.reason.clone()))
                }
                pcc_recovery::Verdict::Idle => {
                    self.rec.registry.set_state(&key, pcc_recovery::ProcessState::Idle, None)
                }
                _ => {}
            }
            match d.action {
                WatchAction::None => {}
                WatchAction::Interrupt => {
                    if let Some(w) = self.rec.sessions.get_mut(&id) {
                        w.soft_at = Some(now);
                    }
                    self.log(
                        &id,
                        row,
                        LogKind::System,
                        &format!("Watchdog: {} — soft recovery: interrupting the turn", d.reason),
                    );
                    if let Some(l) = self.sessions.get(&id) {
                        l.handle.interrupt()?;
                    }
                    self.rec.registry.record_restart(&key, &d.reason, "interrupted");
                    self.emit(
                        Event::new(
                            EventKind::SystemNotice,
                            format!("Watchdog interrupted {id}: {}", d.reason),
                            json!({"agentId": id, "diagnosis": d}),
                        )
                        .agent(&id)
                        .named("recovery.softRecovery")
                        .with_severity(Severity::Warning)
                        .with_source("watchdog")
                        .with_pid(Some(pid)),
                    );
                }
                WatchAction::Restart if !alive => {
                    // The process is gone but its output never ended (a child
                    // process keeps the pipe open). Confirm on two checks.
                    if dead_ticks >= 2 {
                        self.reap_dead_session(&id, epoch, pid)?;
                    }
                }
                WatchAction::Restart => self.restart_stalled(&id, &d.reason, now)?,
            }
        }
        Ok(())
    }

    /// A session whose process died without its output closing: its orphaned
    /// children (MCP servers) are stopped and the exit is processed.
    fn reap_dead_session(&mut self, id: &str, epoch: u64, pid: u32) -> Result<()> {
        let table = pcc_recovery::sys::list_processes();
        let children = pcc_recovery::sys::descendants(&table, pid);
        let row = self.sessions.get(id).map(|l| l.session_row).unwrap_or(0);
        let names: Vec<String> = children.iter().map(|c| format!("{} {}", c.name, c.pid)).collect();
        self.log(
            id,
            row,
            LogKind::Error,
            &format!(
                "Watchdog: the Claude Code process (pid {pid}) is gone but its output stayed open{}",
                if names.is_empty() { String::new() } else { format!(" (held by {})", names.join(", ")) }
            ),
        );
        for c in &children {
            let _ =
                pcc_claude::process::std_command("taskkill").args(["/PID", &c.pid.to_string(), "/T", "/F"]).output();
        }
        self.handle_output((id.to_string(), epoch), pcc_claude::SessionOutput::Exited(None))
    }

    /// Graceful restart of a live session that stays silent after a soft recovery.
    fn restart_stalled(&mut self, id: &str, reason: &str, now: Instant) -> Result<()> {
        let recent: Vec<Duration> =
            self.rec.restarts.get(id).map(|v| v.iter().map(|t| ago(now, *t)).collect()).unwrap_or_default();
        let row = self.sessions.get(id).map(|l| l.session_row).unwrap_or(0);
        match RestartPolicy::default().decide(&recent) {
            RestartDecision::Now => {}
            RestartDecision::Wait(_) => return Ok(()),
            RestartDecision::Capped => {
                self.log(
                    id,
                    row,
                    LogKind::Error,
                    &format!("Watchdog: {reason}; automatic restart limit reached, the user decides"),
                );
                return Ok(());
            }
        }
        let a = self.store.agent(id)?;
        // Context saved: conversation id and mission checkpoint; files checked.
        if a.claude_session_id.is_none() {
            self.log(
                id,
                row,
                LogKind::Error,
                &format!("Watchdog: {reason}; no Claude conversation id to resume, not restarting"),
            );
            return Ok(());
        }
        if let Some(m) = self.mission_of_agent(id) {
            self.checkpoint_mission(&m, &format!("before watchdog restart of {id}"), true);
        }
        let last = self.rec.sessions.get(id).and_then(|w| w.last_action.clone());
        let brief =
            self.restart_brief(id, "stopped answering and was restarted by the NEXUS watchdog", last.as_ref(), None);
        let dirty = self.dirty_labels(id);
        self.rec.restarts.entry(id.to_string()).or_default().push(now);
        self.rec.registry.record_restart(&session_key(id), reason, "restarted (--resume)");
        let mut r = CrashReport::new("claude-session", format!("{} was restarted by the watchdog", a.name));
        r.agent_id = Some(id.to_string());
        r.mission_id = self.mission_of_agent(id);
        r.project = Some(self.store.root().to_string_lossy().into_owned());
        r.what_happened = format!("{}'s session {reason}. An interrupt (soft recovery) did not help.", a.name);
        r.possible_cause =
            "Claude Code stopped producing output without running a tool: a hung API request or an internal deadlock."
                .into();
        r.preserved.push(format!(
            "Claude conversation {} (resumed with --resume)",
            a.claude_session_id.clone().unwrap_or_default()
        ));
        if !dirty.is_empty() {
            r.preserved.push(format!("{} uncommitted file(s): {}", dirty.len(), dirty.join(", ")));
        }
        r.restarted.push(format!("{}: session restarted with --resume and briefed", a.name));
        r.lost.push("The reply of the stalled turn".into());
        self.file_report(r);
        self.rec.briefs.insert(id.to_string(), brief);
        self.log(id, row, LogKind::System, &format!("Watchdog: {reason} — restarting the session with --resume"));
        if let Some(l) = self.sessions.get_mut(id) {
            l.stopping = true;
            l.restart_after_exit = true;
            l.handle.kill();
        }
        Ok(())
    }

    /// Crashed sessions that were doing something are restarted with
    /// `--resume`, with backoff and a cap.
    fn restart_crashed(&mut self, now: Instant) -> Result<()> {
        if !self.autopilot || self.emergency {
            return Ok(());
        }
        let ids: Vec<String> = self.rec.crashed.iter().filter(|(_, c)| !c.capped).map(|(a, _)| a.clone()).collect();
        for id in ids {
            if self.sessions.contains_key(&id) {
                self.rec.crashed.remove(&id);
                continue;
            }
            let Ok(a) = self.store.agent(&id) else { continue };
            if a.status != AgentStatus::Crashed {
                // The user (or another path) already handled it.
                self.rec.crashed.remove(&id);
                continue;
            }
            let crash = self.rec.crashed[&id].clone();
            let needed =
                crash.busy || self.has_active_task(&id)? || (a.kind == AgentKind::Central && self.has_active_mission());
            if !needed {
                continue;
            }
            let recent: Vec<Duration> =
                self.rec.restarts.get(&id).map(|v| v.iter().map(|t| ago(now, *t)).collect()).unwrap_or_default();
            match RestartPolicy::default().decide(&recent) {
                RestartDecision::Wait(_) => continue,
                RestartDecision::Capped => {
                    if let Some(c) = self.rec.crashed.get_mut(&id) {
                        c.capped = true;
                    }
                    let policy = RestartPolicy::default();
                    let text = format!(
                        "automatic restart limit reached ({} restarts within {} min); restart {} manually after checking its terminal",
                        policy.max_in_window,
                        policy.window.as_secs() / 60,
                        a.name
                    );
                    self.amend_report(crash.report_id.as_deref(), |r| r.details.push(text.clone()));
                    if a.kind == AgentKind::Worker {
                        self.notify_central(
                            &format!("Agent {id} keeps crashing: {text}."),
                            a.current_task.clone(),
                            None,
                        )?;
                    }
                    continue;
                }
                RestartDecision::Now => {}
            }
            self.rec.restarts.entry(id.clone()).or_default().push(now);
            let cause = format!(
                "exited unexpectedly (exit code {})",
                crash.code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
            );
            let brief = self.restart_brief(&id, &cause, crash.last_action.as_ref(), crash.inflight.as_deref());
            let resume = a.claude_session_id.is_some();
            match self.start_agent(&id, resume) {
                Ok(()) => {
                    self.rec.registry.record_restart(
                        &session_key(&id),
                        &cause,
                        if resume { "restarted (--resume)" } else { "restarted (fresh)" },
                    );
                    let pid = self.sessions.get(&id).map(|l| l.handle.pid);
                    let a = self.store.agent(&id)?;
                    self.emit(
                        Event::new(EventKind::AgentRestarted, format!("{} restarted after a crash", a.name), json!(a))
                            .agent(&id)
                            .with_pid(pid)
                            .with_source("watchdog"),
                    );
                    let name = a.name.clone();
                    self.amend_report(crash.report_id.as_deref(), |r| {
                        r.restarted.push(format!(
                            "{name}: Claude Code session restarted {} and briefed",
                            if resume { "with --resume" } else { "fresh (no conversation id)" }
                        ))
                    });
                    self.rec.briefs.insert(id.clone(), brief);
                    self.redispatch_current(&id)?;
                }
                Err(e) => {
                    let msg = e.to_string();
                    self.amend_report(crash.report_id.as_deref(), |r| {
                        r.details.push(format!("automatic restart failed: {msg}"))
                    });
                    self.rec.registry.record_restart(&session_key(&id), &cause, &format!("failed: {e}"));
                }
            }
        }
        Ok(())
    }

    fn dirty_labels(&self, id: &str) -> Vec<String> {
        let Ok(a) = self.store.agent(id) else { return Vec::new() };
        let dir = std::path::Path::new(&a.workdir);
        pcc_git::Repo::discover(dir).and_then(|r| r.dirty_files(dir).ok()).unwrap_or_default()
    }

    /// What an agent is told when its restarted session comes up.
    pub(crate) fn restart_brief(
        &self,
        id: &str,
        cause: &str,
        last: Option<&pcc_recovery::LastAction>,
        inflight: Option<&str>,
    ) -> String {
        let mut s = format!(
            "[MESSAGE from system · notification]\nYour Claude Code session {cause}. NEXUS restarted it{}.\n",
            if self.store.agent(id).ok().and_then(|a| a.claude_session_id).is_some() {
                " with your previous conversation (--resume)"
            } else {
                ""
            }
        );
        let a = self.store.agent(id).ok();
        if let Some(t) =
            a.as_ref().and_then(|a| a.current_task.clone()).and_then(|t| self.store.get_task(&t).ok().flatten())
        {
            s.push_str(&format!("You were working on {} \"{}\".\n", t.id, t.title));
        } else if id == CENTRAL_ID {
            let missions = self.store.active_mission_ids().unwrap_or_default();
            if !missions.is_empty() {
                s.push_str(&format!("Running mission(s): {}.\n", missions.join(", ")));
            }
        }
        if let Some(l) = last {
            s.push_str(&format!("Last action recorded: {} ({}).\n", l.description, l.tool));
        }
        if let Some(t) = inflight {
            s.push_str(&format!(
                "Your {t} call had not returned: its result is unknown. Check its effects before running it again.\n"
            ));
        }
        let dirty = self.dirty_labels(id);
        if !dirty.is_empty() {
            let shown: Vec<String> = dirty.iter().take(15).cloned().collect();
            s.push_str(&format!(
                "Uncommitted files in your workspace: {}{}.\n",
                shown.join(", "),
                if dirty.len() > 15 { ", ..." } else { "" }
            ));
        }
        s.push_str(if id == CENTRAL_ID {
            "Review the state with list_tasks and list_agents and continue coordinating."
        } else {
            "Continue where you left off, then report with complete_task / block_task / fail_task."
        });
        s
    }

    // ------------------------------------------------------------ MCP supervision

    fn poll_mcp(&mut self, now: Instant) {
        // Unanswered control requests.
        let stale: Vec<String> = self
            .rec
            .pending
            .iter()
            .filter(|(_, p)| ago(now, p.sent) > CONTROL_TIMEOUT)
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale {
            if let Some(p) = self.rec.pending.remove(&k) {
                let row = self.sessions.get(&p.agent).map(|l| l.session_row).unwrap_or(0);
                self.log(
                    &p.agent,
                    row,
                    LogKind::System,
                    &format!("Watchdog: no answer to {:?} within {}s", p.purpose, CONTROL_TIMEOUT.as_secs()),
                );
            }
        }
        if self.rec.last_mcp_poll.is_some_and(|t| ago(now, t) < MCP_POLL) {
            return;
        }
        self.rec.last_mcp_poll = Some(now);
        let ids: Vec<String> = self.sessions.iter().filter(|(_, l)| !l.stopping).map(|(k, _)| k.clone()).collect();
        for id in ids {
            // Agents without granted MCP connections only have NEXUS's own server.
            let has_mcp = self.store.agent(&id).map(|a| !a.connections.is_empty()).unwrap_or(false)
                || self.rec.mcp.keys().any(|(a, _)| a == &id);
            if !has_mcp
                || self.rec.pending.values().any(|p| p.agent == id && matches!(p.purpose, ControlPurpose::McpStatus))
            {
                continue;
            }
            self.send_tracked_control(&id, "mcp_status", json!({}), ControlPurpose::McpStatus, now);
        }
    }

    pub(crate) fn send_tracked_control(
        &mut self,
        agent: &str,
        subtype: &str,
        args: Value,
        purpose: ControlPurpose,
        now: Instant,
    ) -> bool {
        let Some(live) = self.sessions.get(agent) else { return false };
        let rid = format!("nexus-rec-{}", uuid::Uuid::new_v4().simple());
        let mut req = json!({"subtype": subtype});
        if let (Some(o), Some(extra)) = (req.as_object_mut(), args.as_object()) {
            o.extend(extra.clone());
        }
        let line = json!({"type": "control_request", "request_id": rid, "request": req}).to_string();
        if live.handle.send_line(line).is_err() {
            return false;
        }
        self.rec.pending.insert(rid, PendingControl { agent: agent.to_string(), purpose, sent: now });
        true
    }

    /// Applies an `mcp_status` answer: health per server, automatic reconnect
    /// of failed ones, and a note to the agent when one comes back.
    pub(crate) fn update_mcp_health(&mut self, agent: &str, response: &Value) {
        let Some(servers) = response.get("mcpServers").and_then(Value::as_array) else { return };
        let now_str = pcc_core::now();
        let pid = self.sessions.get(agent).map(|l| l.handle.pid);
        let mut failed = Vec::new();
        let mut recovered = Vec::new();
        for s in servers {
            let Some(name) = s.get("name").and_then(Value::as_str) else { continue };
            if name == crate::launch::PCC_SERVER {
                continue;
            }
            let status = s.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();
            let tools: Option<Vec<String>> = s
                .get("tools")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string)).collect());
            let error = s.get("error").and_then(Value::as_str).map(str::to_string);
            let key = (agent.to_string(), name.to_string());
            let h = self.rec.mcp.entry(key.clone()).or_insert_with(|| McpHealth {
                agent_id: agent.to_string(),
                server: name.to_string(),
                ..Default::default()
            });
            let was = std::mem::replace(&mut h.status, status.clone());
            h.transport = s.pointer("/config/type").and_then(Value::as_str).map(str::to_string).or(h.transport.take());
            h.server_version = s.pointer("/serverInfo/version").and_then(Value::as_str).map(str::to_string);
            h.tools = tools.as_ref().map(Vec::len);
            h.tool_names = tools.unwrap_or_default().into_iter().take(60).collect();
            h.cause = error.as_deref().map(mcp_cause);
            h.error = error;
            h.last_checked_at = now_str.clone();
            h.session_pid = pid;
            if status == "connected" {
                h.last_response_at = Some(now_str.clone());
                if h.reconnecting || (was == "failed") {
                    h.reconnecting = false;
                    if let Some(r) = h.restarts.last_mut() {
                        r.outcome = format!("reconnected ({} tools)", h.tools.unwrap_or(0));
                    }
                    recovered.push((name.to_string(), h.tools));
                }
            } else if status == "failed" && !h.reconnecting {
                failed.push(name.to_string());
            }
        }
        for (server, tools) in recovered {
            let _ = self.post_message(
                pcc_core::SYSTEM_ID,
                agent,
                pcc_core::MessageKind::System,
                &format!(
                    "MCP server {server} was reconnected by NEXUS{}. If a call to it failed, you can retry it now.",
                    tools.map(|n| format!(" ({n} tools available again)")).unwrap_or_default()
                ),
                None,
                None,
            );
            self.emit(
                Event::new(
                    EventKind::McpChanged,
                    format!("MCP {server} reconnected in {agent}'s session"),
                    json!({"server": server, "agentId": agent}),
                )
                .agent(agent)
                .named("mcp.recovered")
                .with_source("watchdog"),
            );
        }
        for server in failed {
            self.auto_reconnect_mcp(agent, &server);
        }
    }

    fn auto_reconnect_mcp(&mut self, agent: &str, server: &str) {
        let now = Instant::now();
        let key = (agent.to_string(), server.to_string());
        let recent: Vec<Duration> =
            self.rec.mcp_restarts.get(&key).map(|v| v.iter().map(|t| ago(now, *t)).collect()).unwrap_or_default();
        let error = self.rec.mcp.get(&key).and_then(|h| h.error.clone()).unwrap_or_default();
        match RestartPolicy::default().decide(&recent) {
            RestartDecision::Now => {}
            RestartDecision::Wait(_) => return,
            RestartDecision::Capped => {
                if let Some(h) = self.rec.mcp.get_mut(&key) {
                    if !h.restarts.last().is_some_and(|r| r.outcome.starts_with("skipped")) {
                        h.restarts.push(pcc_recovery::RestartRecord {
                            at: pcc_core::now(),
                            reason: error,
                            outcome: "skipped: automatic reconnect limit reached".into(),
                        });
                    }
                }
                return;
            }
        }
        if !self.send_tracked_control(
            agent,
            "mcp_reconnect",
            json!({"serverName": server}),
            ControlPurpose::McpReconnect { server: server.to_string(), automatic: true },
            now,
        ) {
            return;
        }
        self.rec.mcp_restarts.entry(key.clone()).or_default().push(now);
        if let Some(h) = self.rec.mcp.get_mut(&key) {
            h.reconnecting = true;
            h.restarts.push(pcc_recovery::RestartRecord {
                at: pcc_core::now(),
                reason: if error.is_empty() { "reported failed by Claude Code".into() } else { error.clone() },
                outcome: "reconnecting".into(),
            });
        }
        let mut r = CrashReport::new("mcp", format!("MCP server {server} failed in {agent}'s session"));
        r.agent_id = Some(agent.to_string());
        r.project = Some(self.store.root().to_string_lossy().into_owned());
        r.what_happened = format!(
            "Claude Code reported the MCP server {server} as failed{}.",
            if error.is_empty() { String::new() } else { format!(": {error}") }
        );
        r.possible_cause = mcp_cause(&error);
        r.preserved.push(format!("{agent}'s session and its conversation (only the MCP connection is renewed)"));
        r.restarted.push(format!("{server}: mcp_reconnect requested in {agent}'s session"));
        r.lost.push("Calls to the server that failed while it was down (the agent is told it can retry)".into());
        self.file_report(r);
    }

    /// "Restart" from the supervision panel: reconnect the server in the
    /// sessions that have it (Claude Code owns those processes).
    pub fn restart_mcp(&mut self, agent: Option<&str>, server: &str) -> Result<Vec<String>> {
        let now = Instant::now();
        let targets: Vec<String> = match agent {
            Some(a) => vec![a.to_string()],
            None => {
                let mut v = self.mcp_sessions_with(server);
                if v.is_empty() {
                    v = self.sessions.keys().cloned().collect();
                }
                v
            }
        };
        let mut reached = Vec::new();
        for a in targets {
            if self.send_tracked_control(
                &a,
                "mcp_reconnect",
                json!({"serverName": server}),
                ControlPurpose::McpReconnect { server: server.to_string(), automatic: false },
                now,
            ) {
                let key = (a.clone(), server.to_string());
                let h = self.rec.mcp.entry(key).or_insert_with(|| McpHealth {
                    agent_id: a.clone(),
                    server: server.to_string(),
                    status: "unknown".into(),
                    ..Default::default()
                });
                h.reconnecting = true;
                h.restarts.push(pcc_recovery::RestartRecord {
                    at: pcc_core::now(),
                    reason: "requested by the user".into(),
                    outcome: "reconnecting".into(),
                });
                reached.push(a);
            }
        }
        if !reached.is_empty() {
            self.emit(Event::new(
                EventKind::McpChanged,
                format!("Reconnect {server} requested in {} session(s)", reached.len()),
                json!({"server": server, "agents": reached}),
            ));
        }
        Ok(reached)
    }

    /// Asks every live session for its MCP status now (supervision panel refresh).
    pub fn refresh_mcp_status(&mut self) -> usize {
        let now = Instant::now();
        let ids: Vec<String> = self.sessions.iter().filter(|(_, l)| !l.stopping).map(|(k, _)| k.clone()).collect();
        ids.into_iter()
            .filter(|id| self.send_tracked_control(id, "mcp_status", json!({}), ControlPurpose::McpStatus, now))
            .count()
    }
}

/// NEXUS's reading of an MCP error.
pub fn mcp_cause(error: &str) -> String {
    let e = error.to_ascii_lowercase();
    if e.is_empty() {
        "Claude Code reported the server as failed without an error message".into()
    } else if e.contains("enoent") || e.contains("not found") || e.contains("not recognized") {
        "The server command was not found (path or program missing)".into()
    } else if e.contains("closed") || e.contains("exit") || e.contains("terminated") {
        "Process exited unexpectedly".into()
    } else if e.contains("timeout") || e.contains("timed out") {
        "The server did not answer in time".into()
    } else if e.contains("401") || e.contains("403") || e.contains("auth") {
        "Authentication refused by the server".into()
    } else if e.contains("econnrefused") || e.contains("connect") {
        "Connection refused (the server is not listening)".into()
    } else {
        format!("Server error: {}", error.chars().take(200).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_causes() {
        assert_eq!(mcp_cause("MCP error -32000: Connection closed"), "Process exited unexpectedly");
        assert!(mcp_cause("spawn mcp.bat ENOENT").contains("not found"));
        assert!(mcp_cause("").contains("without an error"));
    }
}
