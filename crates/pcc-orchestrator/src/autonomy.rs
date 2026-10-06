//! Autonomy controls: decision journal, power presets, CLAUDE UNLOCKED side
//! effects, emergency stop, revoke-all, live session controls and the
//! continuous-improvement loop.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pcc_core::permissions::ToolClassification;
use pcc_core::{DecisionRecord, Error, Event, EventKind, ImprovementMode, PermissionSet, PowerLevel, Result};

use crate::engine::{first_line, Engine};

const EMERGENCY_KEY: &str = "emergency_stop";
const IMPROVEMENT_KEY: &str = "improvement_runs";

impl Engine {
    /// Appends a permission decision to the journal and streams it.
    pub(crate) fn record_decision(
        &self,
        agent: &str,
        tool: &str,
        class: Option<&ToolClassification>,
        decision: &str,
        actor: &str,
        reason: Option<String>,
    ) {
        let summary = class.map(|c| c.summary.clone()).unwrap_or_else(|| tool.to_string());
        let record = DecisionRecord {
            id: 0,
            ts: pcc_core::now(),
            agent_id: agent.into(),
            tool_name: tool.into(),
            capability: class.and_then(|c| c.capability).map(|c| c.as_str().to_string()),
            summary: summary.clone(),
            decision: decision.into(),
            actor: actor.into(),
            reason,
        };
        match self.store.insert_decision(record) {
            Ok(r) if decision == "auto_approved" => self.emit(
                Event::new(
                    EventKind::PermissionAutoApproved,
                    format!("AUTO-APPROVED {agent}: {}", first_line(&summary, 100)),
                    json!(r),
                )
                .agent(agent),
            ),
            Ok(_) => {}
            Err(e) => tracing::error!("cannot journal decision: {e}"),
        }
    }

    /// Marks a connection as used (at most once a minute per connection).
    pub(crate) fn touch_connection(&mut self, class: &ToolClassification) {
        let id = match (&class.mcp_server, &class.ssh_host) {
            (Some(server), _) => Some(server.clone()),
            (None, Some(host)) => self.store.list_connections().ok().and_then(|cs| {
                cs.into_iter()
                    .find(|c| {
                        c.config.get("host").and_then(Value::as_str).is_some_and(|h| h.eq_ignore_ascii_case(host))
                    })
                    .map(|c| c.id)
            }),
            _ => None,
        };
        let Some(id) = id else { return };
        if self.connection_touches.get(&id).is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
            return;
        }
        self.connection_touches.insert(id.clone(), Instant::now());
        if let Ok(Some(mut c)) = self.store.get_connection(&id) {
            c.last_used = Some(pcc_core::now());
            if self.store.upsert_connection(&c).is_ok() {
                self.emit(Event::new(EventKind::ConnectionChanged, format!("{} used", c.name), json!(c)));
            }
        }
    }

    // ------------------------------------------------------------ power

    /// Applies a power preset to an agent. Power is only a preset: the
    /// resulting permissions are stored and enforced.
    pub fn apply_power(&mut self, agent: &str, level: PowerLevel) -> Result<pcc_core::Agent> {
        let mut a = self.store.agent(agent)?;
        a.permissions = PermissionSet::preset(level);
        self.save_agent(&mut a)?;
        self.emit(
            Event::new(
                EventKind::ProjectChanged,
                format!("{} power set to {:?}", a.name, level).to_lowercase(),
                json!({"agent": a.id}),
            )
            .agent(agent),
        );
        Ok(a)
    }

    // ------------------------------------------------------------ emergency

    pub fn emergency_active(&self) -> bool {
        self.emergency
    }

    pub(crate) fn ensure_not_emergency(&self) -> Result<()> {
        if self.emergency {
            Err(Error::Denied("Emergency stop is active: release it before starting new work".into()))
        } else {
            Ok(())
        }
    }

    /// Stops every managed Claude Code process and blocks autonomous actions
    /// (auto-start, auto-approval, improvement cycles) until released.
    pub fn emergency_stop(&mut self) -> Result<()> {
        self.emergency = true;
        self.store.meta_set(EMERGENCY_KEY, &pcc_core::now())?;
        self.stop_all()?;
        let pending: Vec<String> = self.permissions.keys().cloned().collect();
        for id in pending {
            let _ = self.resolve_permission_by(&id, pcc_core::PermissionDecision::Reject, "emergency");
        }
        self.emit(Event::new(
            EventKind::EmergencyStop,
            "EMERGENCY STOP: all agents stopped, autonomy blocked",
            json!({"active": true}),
        ));
        Ok(())
    }

    pub fn release_emergency(&mut self) -> Result<()> {
        self.emergency = false;
        self.store.meta_set(EMERGENCY_KEY, "")?;
        self.emit(Event::new(EventKind::EmergencyStop, "Emergency stop released", json!({"active": false})));
        Ok(())
    }

    /// Lowers every agent to the LOW preset, deletes "allow always" rules and
    /// turns CLAUDE UNLOCKED and auto-approval off.
    pub fn revoke_all_permissions(&mut self) -> Result<()> {
        for mut a in self.store.list_agents()? {
            a.permissions = PermissionSet::preset(PowerLevel::Low);
            self.save_agent(&mut a)?;
        }
        let rules = self.store.clear_permission_rules()?;
        let mut s = self.store.settings();
        s.autonomy.unlocked = false;
        s.autonomy.auto_approve = false;
        self.store.save_settings(s.clone())?;
        self.emit(Event::new(
            EventKind::ProjectChanged,
            format!("All permissions revoked ({rules} saved rule(s) deleted, CLAUDE UNLOCKED off)"),
            json!({"settings": s}),
        ));
        Ok(())
    }

    // ------------------------------------------------------------ live session controls

    fn control(&self, agent: &str, subtype: &str, args: Value) -> Result<bool> {
        let Some(live) = self.sessions.get(agent) else { return Ok(false) };
        let mut req = json!({"subtype": subtype});
        if let (Some(o), Some(extra)) = (req.as_object_mut(), args.as_object()) {
            o.extend(extra.clone());
        }
        let line =
            json!({"type": "control_request", "request_id": format!("nexus-{}", uuid::Uuid::new_v4()), "request": req});
        live.handle.send_line(line.to_string())?;
        Ok(true)
    }

    /// Changes an agent's model; a running session switches immediately.
    pub fn set_agent_model(&mut self, agent: &str, model: Option<String>) -> Result<bool> {
        let mut a = self.store.agent(agent)?;
        a.model = model.clone().filter(|m| !m.trim().is_empty());
        self.save_agent(&mut a)?;
        let live =
            self.control(agent, "set_model", json!({"model": a.model.clone().unwrap_or_else(|| "default".into())}))?;
        if live {
            let row = self.sessions.get(agent).map(|l| l.session_row).unwrap_or(0);
            self.log(
                agent,
                row,
                pcc_core::LogKind::System,
                &format!("Model switched to {}", a.model.as_deref().unwrap_or("default")),
            );
        }
        Ok(live)
    }

    /// Asks every running session to reconnect an MCP server. Returns the agents reached.
    pub fn reconnect_mcp_everywhere(&mut self, server: &str) -> Result<Vec<String>> {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        let mut reached = Vec::new();
        for id in ids {
            if self.control(&id, "mcp_reconnect", json!({"serverName": server}))? {
                reached.push(id);
            }
        }
        self.emit(Event::new(
            EventKind::McpChanged,
            format!("Reconnect {server} requested in {} session(s)", reached.len()),
            json!({"server": server, "agents": reached, "action": "restarted"}),
        ));
        Ok(reached)
    }

    /// Reloads plugins and skills in every running session.
    pub fn reload_plugins_everywhere(&mut self) -> Result<Vec<String>> {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        let mut reached = Vec::new();
        for id in ids {
            if self.control(&id, "reload_plugins", json!({}))? {
                reached.push(id);
            }
        }
        self.emit(Event::new(
            EventKind::SkillChanged,
            format!("Plugins and skills reloaded in {} session(s)", reached.len()),
            json!({"agents": reached}),
        ));
        Ok(reached)
    }

    // ------------------------------------------------------------ continuous improvement

    fn improvement_runs_today(&self) -> Vec<String> {
        let today = pcc_core::now()[..10].to_string();
        self.store
            .meta_get(IMPROVEMENT_KEY)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|t| t.starts_with(&today))
            .collect()
    }

    /// Starts an improvement mission now (also used by the scheduler).
    pub fn start_improvement_cycle(&mut self, triggered_by: &str) -> Result<pcc_core::Mission> {
        self.ensure_not_emergency()?;
        let s = self.store.settings().improvement;
        let mode = match s.mode {
            ImprovementMode::Propose => "PROPOSE mode: analyse and create tasks that require review (requires_review=true) for the improvements worth doing; do not merge anything. Explain each proposal: what, why, risk.",
            ImprovementMode::Implement => "IMPLEMENT mode: plan and implement the worthwhile improvements through workers, with tests; every task requires review; merges still need the user's approval.",
        };
        let prompt = format!(
            "CONTINUOUS IMPROVEMENT CYCLE (triggered by {triggered_by}).\n\nLoop: ANALYZE → PLAN → IMPLEMENT → TEST → REVIEW → IMPROVE.\nFocus areas: {}.\n{mode}\n\nKeep changes small and traceable: one task per improvement, each with what changed, why, files, tests and how to roll back. Record durable findings in memory (discoveries/decisions). Close the mission with complete_mission summarising every change and proposal.",
            s.focus.join(", ")
        );
        let mut runs: Vec<String> =
            self.store.meta_get(IMPROVEMENT_KEY)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        runs.push(pcc_core::now());
        let keep = runs.len().saturating_sub(100);
        self.store.meta_set(IMPROVEMENT_KEY, &serde_json::to_string(&runs[keep..])?)?;
        let label = match s.mode {
            ImprovementMode::Propose => "propose",
            ImprovementMode::Implement => "implement",
        };
        let m = self.create_mission(&prompt, Some(format!("Improvement cycle ({label})")))?;
        self.emit(
            Event::new(
                EventKind::ImprovementCycle,
                format!("Improvement cycle started: {}", m.id),
                json!({"mission": m.id, "triggeredBy": triggered_by}),
            )
            .mission(Some(m.id.clone())),
        );
        Ok(m)
    }

    /// Called every minute: runs the improvement loop when it is due.
    pub fn tick(&mut self) -> Result<()> {
        // Queued missions left behind (app closed, emergency released) start here.
        if !self.store.read_only() {
            if let Err(err) = self.start_next_queued() {
                self.emit(pcc_core::Event::new(
                    pcc_core::EventKind::Error,
                    format!("Queued mission not started: {err}"),
                    serde_json::Value::Null,
                ));
            }
        }
        let s = self.store.settings().improvement;
        if !s.enabled || self.emergency {
            return Ok(());
        }
        // Never stack cycles on active work.
        if !self.store.active_mission_ids()?.is_empty() {
            return Ok(());
        }
        let runs = self.improvement_runs_today();
        if runs.len() as u32 >= s.max_runs_per_day {
            return Ok(());
        }
        let last = self
            .store
            .list_missions()?
            .into_iter()
            .filter(|m| m.mission.title.starts_with("Improvement cycle"))
            .map(|m| m.mission.created_at)
            .max();
        let due = match last.and_then(|t| chrono_minutes_since(&t)) {
            Some(mins) => mins >= s.interval_minutes as i64,
            None => true,
        };
        if due {
            self.start_improvement_cycle("schedule")?;
        }
        Ok(())
    }
}

fn chrono_minutes_since(ts: &str) -> Option<i64> {
    let t = chrono::DateTime::parse_from_rfc3339(ts).ok()?;
    Some((chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_minutes())
}
