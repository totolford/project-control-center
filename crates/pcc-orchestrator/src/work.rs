//! Agents, tasks and missions: operations shared by the UI commands and the
//! tools agents call.

use serde_json::json;

use pcc_core::{
    ids, Access, Agent, AgentKind, AgentStatus, Error, Event, EventKind, Isolation, Mission, MissionStatus, Priority,
    Result, Task, TaskResult, TaskStatus, CENTRAL_ID, SYSTEM_ID, USER_ID,
};
use pcc_store::{MemoryScope, TaskFilter};

use crate::dto::{AgentPatch, AgentSpec, MissionSpec, TaskPatch, TaskSpec};
use crate::engine::{first_line, valid_agent_id, Engine};

impl Engine {
    // ------------------------------------------------------------ agents

    /// Creates a worker. When Central asks, permissions are clamped to the
    /// project's ceiling; the user can grant more by editing the agent.
    pub fn create_agent(&mut self, spec: AgentSpec, created_by: &str) -> Result<Agent> {
        let name = spec.name.trim();
        if name.is_empty() || spec.role.trim().is_empty() {
            return Err(Error::invalid("an agent needs a name and a role"));
        }
        let id = match spec.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => id.to_string(),
            None => ids::slugify(name),
        };
        valid_agent_id(&id)?;
        if let Some(p) = &spec.provider {
            crate::providers::ensure_supported(p)?;
        }
        if self.store.get_agent(&id)?.is_some() {
            return Err(Error::Conflict(format!("an agent with id `{id}` already exists")));
        }
        let (parent, rank) = self.place_new_agent(created_by, spec.parent.as_deref(), spec.rank)?;
        let settings = self.store.settings();
        let mut perms = settings.default_worker_permissions.clone();
        if let Some(p) = &spec.permissions {
            for (c, a) in p {
                perms.set(*c, *a);
            }
        }
        if created_by != USER_ID {
            perms = perms.clamp_to(&settings.max_worker_permissions);
            // A sub-agent never gets more than its supervisor.
            if parent != CENTRAL_ID {
                perms = perms.clamp_to(&self.store.agent(&parent)?.permissions);
            }
        }
        let connections = spec.connections.clone().unwrap_or_default();
        let known: Vec<String> = self.store.list_connections()?.into_iter().map(|c| c.id).collect();
        if let Some(bad) = connections.iter().find(|c| !known.contains(c)) {
            return Err(Error::invalid(format!("unknown connection `{bad}`")));
        }
        let git_ok = self.repo.as_ref().is_some_and(|r| r.has_commits());
        let isolation = match spec.isolation.as_deref().unwrap_or("auto") {
            "shared" => Isolation::Shared,
            "worktree" => Isolation::Worktree,
            "auto" => {
                if git_ok && settings.use_worktrees {
                    Isolation::Worktree
                } else {
                    Isolation::Shared
                }
            }
            other => return Err(Error::invalid(format!("unknown isolation `{other}`"))),
        };
        let now = pcc_core::now();
        let a = Agent {
            id: id.clone(),
            name: name.to_string(),
            kind: AgentKind::Worker,
            provider: spec.provider.clone().unwrap_or_else(|| pcc_core::CLAUDE_CODE_PROVIDER.into()),
            role: spec.role.trim().to_string(),
            instructions: spec.instructions.unwrap_or_default().trim().to_string(),
            status: AgentStatus::Offline,
            model: spec.model.filter(|m| !m.trim().is_empty()),
            permissions: perms,
            connections,
            isolation,
            workdir: self.store.root().to_string_lossy().into_owned(),
            branch: (isolation == Isolation::Worktree).then(|| format!("agent/{id}")),
            current_task: None,
            current_action: None,
            progress: None,
            claude_session_id: None,
            total_cost_usd: 0.0,
            profile: pcc_core::AgentProfile {
                effort: settings.default_effort.clone(),
                skills_enabled: settings.default_skills_enabled,
                ..Default::default()
            },
            created_by: created_by.into(),
            created_at: now.clone(),
            updated_at: now,
            parent_agent: Some(parent),
            rank,
            paused_at: None,
        };
        self.store.upsert_agent(&a)?;
        self.emit_agent(EventKind::AgentCreated, &a, format!("{created_by} created agent {} ({})", a.name, a.role));
        Ok(a)
    }

    pub fn update_agent(&mut self, id: &str, patch: AgentPatch) -> Result<Agent> {
        let mut a = self.store.agent(id)?;
        if let Some(n) = patch.name.filter(|n| !n.trim().is_empty()) {
            a.name = n.trim().into();
        }
        if let Some(r) = patch.role.filter(|r| !r.trim().is_empty()) {
            a.role = r.trim().into();
        }
        if let Some(i) = patch.instructions {
            a.instructions = i.trim().into();
        }
        if let Some(p) = patch.permissions {
            a.permissions = p;
        }
        if let Some(c) = patch.connections {
            let known: Vec<String> = self.store.list_connections()?.into_iter().map(|c| c.id).collect();
            if let Some(bad) = c.iter().find(|x| !known.contains(x)) {
                return Err(Error::invalid(format!("unknown connection `{bad}`")));
            }
            a.connections = c;
        }
        if let Some(m) = patch.model {
            a.model = m.filter(|m| !m.trim().is_empty());
        }
        if let Some(mut p) = patch.profile {
            if let Some(e) = &p.effort {
                if !matches!(e.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
                    return Err(Error::invalid(format!("unknown effort level `{e}`")));
                }
            }
            p.env.retain(|k, _| !k.trim().is_empty());
            if let Some(bad) = p.env.keys().find(|k| !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
                return Err(Error::invalid(format!("invalid environment variable name `{bad}`")));
            }
            a.profile = p;
        }
        self.save_agent(&mut a)?;
        Ok(a)
    }

    pub fn retire_agent(&mut self, id: &str, reason: Option<&str>) -> Result<()> {
        if id == CENTRAL_ID {
            return Err(Error::invalid("the Central agent cannot be retired"));
        }
        if self.store.get_agent(id)?.is_some_and(|a| a.status == AgentStatus::Retired) {
            return Ok(());
        }
        if self.has_active_task(id)? {
            return Err(Error::Conflict(format!("{id} still has a task in progress; reassign or cancel it first")));
        }
        self.stop_agent(id)?;
        let mut a = self.store.agent(id)?;
        a.status = AgentStatus::Retired;
        a.current_task = None;
        self.save_agent(&mut a)?;
        for mut t in self.store.list_tasks(&TaskFilter { agent: Some(id.into()), ..Default::default() })? {
            if matches!(t.status, TaskStatus::Pending | TaskStatus::Queued) {
                t.agent = None;
                self.transition(&mut t, TaskStatus::Pending, Some(format!("unassigned: {id} was retired")))?;
            }
        }
        self.emit(
            Event::new(
                EventKind::AgentStopped,
                format!("{} retired{}", a.name, reason.map(|r| format!(": {r}")).unwrap_or_default()),
                json!(a),
            )
            .agent(id),
        );
        Ok(())
    }

    // ------------------------------------------------------------ tasks

    pub fn create_task(&mut self, spec: TaskSpec, created_by: &str) -> Result<Task> {
        if spec.title.trim().is_empty() {
            return Err(Error::invalid("a task needs a title"));
        }
        if let Some(a) = &spec.agent {
            let agent = self.store.agent(a)?;
            if agent.kind == AgentKind::Central {
                return Err(Error::invalid("tasks are assigned to workers, not to Central"));
            }
            if agent.status == AgentStatus::Retired {
                return Err(Error::invalid(format!("{a} is retired")));
            }
        }
        let all = self.store.list_tasks(&TaskFilter::default())?;
        let deps = spec.dependencies.clone().unwrap_or_default();
        let id = self.store.next_task_id()?;
        pcc_core::tasks::validate_dependencies(&all, &id, &deps)?;
        let mission_id = match spec.mission_id.filter(|m| !m.is_empty()) {
            Some(m) => {
                self.store.get_mission(&m)?.ok_or_else(|| Error::not_found(format!("mission {m}")))?;
                Some(m)
            }
            // Central's tasks belong to the single active mission, if any.
            None if created_by == CENTRAL_ID => {
                let active = self.store.active_mission_ids()?;
                (active.len() == 1).then(|| active[0].clone())
            }
            // A lieutenant's sub-tasks belong to the mission of its own task.
            None if created_by != USER_ID && created_by != SYSTEM_ID => {
                match self.store.get_agent(created_by)?.and_then(|a| a.current_task) {
                    Some(t) => self.store.get_task(&t)?.and_then(|t| t.mission_id),
                    None => None,
                }
            }
            None => None,
        };
        let now = pcc_core::now();
        let t = Task {
            id,
            mission_id: mission_id.clone(),
            title: spec.title.trim().into(),
            description: spec.description.unwrap_or_default().trim().into(),
            status: TaskStatus::Pending,
            priority: spec.priority.unwrap_or(Priority::Normal),
            agent: spec.agent,
            dependencies: deps,
            requires_review: spec.requires_review.unwrap_or(false),
            progress: None,
            status_reason: None,
            result: None,
            created_by: created_by.into(),
            created_at: now.clone(),
            updated_at: now,
            started_at: None,
            completed_at: None,
            skills: spec
                .skills
                .map(|v| v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
                .unwrap_or_default(),
        };
        self.store.upsert_task(&t)?;
        self.emit_task(EventKind::TaskCreated, &t, format!("{} created {}: {}", created_by, t.id, t.title));
        if let Some(mid) = &mission_id {
            let mut m = self.store.get_mission(mid)?.expect("checked above");
            if m.status == MissionStatus::Planning {
                m.status = MissionStatus::Active;
                m.updated_at = pcc_core::now();
                self.store.upsert_mission(&m)?;
            }
            self.emit_mission(EventKind::MissionUpdated, mid, format!("{mid}: task {} added", t.id));
        }
        if created_by == USER_ID {
            self.autopilot = true;
        }
        self.schedule()?;
        self.store.task(&t.id)
    }

    /// Validated status change with events and mission counters.
    pub(crate) fn transition(&mut self, t: &mut Task, to: TaskStatus, reason: Option<String>) -> Result<()> {
        if !pcc_core::tasks::can_transition(t.status, to) {
            return Err(Error::invalid(format!("{} cannot go from {} to {}", t.id, t.status.as_str(), to.as_str())));
        }
        let from = t.status;
        t.status = to;
        t.status_reason = reason;
        t.updated_at = pcc_core::now();
        if to.is_terminal() || to == TaskStatus::Review {
            t.completed_at = Some(t.updated_at.clone());
        }
        self.store.upsert_task(t)?;
        let kind = match to {
            TaskStatus::Completed => EventKind::TaskCompleted,
            TaskStatus::Failed => EventKind::TaskFailed,
            TaskStatus::Review => EventKind::ReviewRequested,
            _ => EventKind::TaskUpdated,
        };
        let mut summary = format!("{} {} → {}", t.id, from.as_str(), to.as_str());
        if let Some(r) = &t.status_reason {
            summary.push_str(&format!(" ({})", first_line(r, 80)));
        }
        self.emit_task(kind, t, summary);
        if let Some(mid) = t.mission_id.clone() {
            self.emit_mission(EventKind::MissionUpdated, &mid, format!("{mid} progress"));
            self.checkpoint_mission(&mid, &format!("{} {} → {}", t.id, from.as_str(), to.as_str()), false);
        }
        // Free the agent when its current task leaves the active states.
        if let Some(agent) = t.agent.clone() {
            if !matches!(to, TaskStatus::InProgress | TaskStatus::Waiting | TaskStatus::Blocked) {
                let mut a = self.store.agent(&agent)?;
                if a.current_task.as_deref() == Some(t.id.as_str()) {
                    a.current_task = None;
                    a.progress = None;
                    self.save_agent(&mut a)?;
                }
            }
        }
        Ok(())
    }

    pub fn update_task(&mut self, id: &str, patch: TaskPatch, by: &str) -> Result<Task> {
        let mut t = self.store.task(id)?;
        if let Some(title) = patch.title.filter(|s| !s.trim().is_empty()) {
            t.title = title.trim().into();
        }
        if let Some(d) = patch.description {
            t.description = d;
        }
        if let Some(p) = patch.priority {
            t.priority = p;
        }
        if let Some(r) = patch.requires_review {
            t.requires_review = r;
        }
        // Assigning to the current agent again is a no-op (double submit).
        if let Some(agent) = patch.agent.filter(|a| *a != t.agent) {
            if matches!(t.status, TaskStatus::InProgress) {
                return Err(Error::Conflict(format!("{id} is in progress; cancel or wait before reassigning")));
            }
            if let Some(a) = &agent {
                let ag = self.store.agent(a)?;
                if ag.kind == AgentKind::Central || ag.status == AgentStatus::Retired {
                    return Err(Error::invalid(format!("cannot assign to {a}")));
                }
            }
            t.agent = agent;
        }
        t.updated_at = pcc_core::now();
        self.store.upsert_task(&t)?;
        if let Some(s) = patch.status {
            if s != t.status {
                let was_running = t.status == TaskStatus::InProgress;
                self.transition(&mut t, s, Some(format!("set by {by}")))?;
                if was_running && s == TaskStatus::Cancelled {
                    if let Some(a) = t.agent.clone() {
                        self.post_message(
                            SYSTEM_ID,
                            &a,
                            pcc_core::MessageKind::System,
                            &format!("{id} was cancelled by {by}. Stop working on it."),
                            Some(id.into()),
                            t.mission_id.clone(),
                        )?;
                    }
                }
            }
        } else {
            self.emit_task(EventKind::TaskUpdated, &t, format!("{id} updated by {by}"));
        }
        self.schedule()?;
        self.store.task(id)
    }

    pub fn retry_task(&mut self, id: &str) -> Result<Task> {
        let mut t = self.store.task(id)?;
        match t.status {
            TaskStatus::Failed | TaskStatus::Blocked | TaskStatus::Waiting | TaskStatus::Review => {
                self.nudges.remove(id);
                self.transition(&mut t, TaskStatus::Queued, Some("retry".into()))?;
                self.autopilot = true;
                self.schedule()?;
                self.store.task(id)
            }
            s => Err(Error::invalid(format!(
                "{id} is {}; only failed, blocked, waiting or review tasks can be retried",
                s.as_str()
            ))),
        }
    }

    /// Worker reports completion.
    pub fn complete_task(&mut self, agent: &str, task_id: &str, mut result: TaskResult) -> Result<Task> {
        let mut t = self.owned_task(agent, task_id)?;
        let a = self.store.agent(agent)?;
        if a.isolation == Isolation::Worktree {
            if let Some(repo) = &self.repo {
                match repo.commit_all(std::path::Path::new(&a.workdir), &format!("{}: {}", t.id, t.title)) {
                    Ok(c) => result.commit = c,
                    Err(e) => {
                        result.issues = Some(format!(
                            "{}Automatic commit failed: {e}",
                            result.issues.map(|i| format!("{i}\n")).unwrap_or_default()
                        ))
                    }
                }
            }
        }
        t.result = Some(result.clone());
        t.progress = Some(100);
        let to = if t.requires_review { TaskStatus::Review } else { TaskStatus::Completed };
        self.transition(&mut t, to, None)?;
        self.nudges.remove(task_id);
        let mut note = format!("{} \"{}\" completed by {}.\nSummary: {}", t.id, t.title, agent, result.summary.trim());
        if !result.files_changed.is_empty() {
            note.push_str(&format!("\nFiles: {}", result.files_changed.join(", ")));
        }
        if let Some(x) = &result.tests {
            note.push_str(&format!("\nTests: {x}"));
        }
        if let Some(x) = &result.issues {
            note.push_str(&format!("\nPotential issues: {x}"));
        }
        if let Some(c) = &result.commit {
            note.push_str(&format!("\nCommitted on {} as {c}.", a.branch.clone().unwrap_or_default()));
        }
        if to == TaskStatus::Review {
            note.push_str("\nREVIEW REQUIRED: approve with update_task(status=\"completed\") or call request_changes.");
        }
        self.notify_supervisor(&t, &note)?;
        self.store.task(task_id)
    }

    pub fn fail_task(&mut self, agent: &str, task_id: &str, reason: &str) -> Result<Task> {
        let mut t = self.owned_task(agent, task_id)?;
        self.transition(&mut t, TaskStatus::Failed, Some(reason.into()))?;
        self.notify_supervisor(&t, &format!("{} \"{}\" FAILED ({}): {reason}", t.id, t.title, agent))?;
        self.store.task(task_id)
    }

    pub fn block_task(&mut self, agent: &str, task_id: &str, reason: &str) -> Result<Task> {
        let mut t = self.owned_task(agent, task_id)?;
        self.transition(&mut t, TaskStatus::Blocked, Some(reason.into()))?;
        self.notify_supervisor(&t, &format!("{} \"{}\" is BLOCKED ({}): {reason}\nProvide what is needed with send_message to {agent}; the task resumes when the agent receives your message.", t.id, t.title, agent))?;
        self.store.task(task_id)
    }

    pub fn report_progress(&mut self, agent: &str, task_id: &str, percent: u8, action: Option<String>) -> Result<()> {
        let mut t = self.owned_task(agent, task_id)?;
        let pct = percent.min(99);
        t.progress = Some(pct);
        t.updated_at = pcc_core::now();
        self.store.upsert_task(&t)?;
        self.emit_task(EventKind::TaskUpdated, &t, format!("{} {}%", t.id, pct));
        let mut a = self.store.agent(agent)?;
        a.progress = Some(pct);
        if let Some(act) = action.filter(|s| !s.trim().is_empty()) {
            a.current_action = Some(act);
        }
        self.save_agent(&mut a)
    }

    /// Central asks for rework on a task in review (or a completed one).
    pub fn request_changes(&mut self, task_id: &str, feedback: &str) -> Result<Task> {
        let mut t = self.store.task(task_id)?;
        if !matches!(t.status, TaskStatus::Review | TaskStatus::Failed | TaskStatus::Waiting | TaskStatus::Blocked) {
            return Err(Error::invalid(format!(
                "{task_id} is {}; changes can be requested on tasks in review, failed, waiting or blocked",
                t.status.as_str()
            )));
        }
        t.description = format!(
            "{}\n\n## Review feedback ({})\n{}",
            t.description.trim_end(),
            pcc_core::now().get(..16).unwrap_or(""),
            feedback.trim()
        );
        t.completed_at = None;
        self.store.upsert_task(&t)?;
        self.transition(&mut t, TaskStatus::Queued, Some("changes requested".into()))?;
        self.schedule()?;
        self.store.task(task_id)
    }

    fn owned_task(&self, agent: &str, task_id: &str) -> Result<Task> {
        let t = self.store.task(task_id)?;
        if t.agent.as_deref() != Some(agent) {
            return Err(Error::Denied(format!(
                "{task_id} is assigned to {}, not to you",
                t.agent.as_deref().unwrap_or("nobody")
            )));
        }
        if !matches!(t.status, TaskStatus::InProgress | TaskStatus::Waiting | TaskStatus::Blocked) {
            return Err(Error::invalid(format!("{task_id} is {}, not in progress", t.status.as_str())));
        }
        Ok(t)
    }

    // ------------------------------------------------------------ missions

    /// Plain mission (composer, improvement cycle): queued when another one runs.
    pub fn create_mission(&mut self, prompt: &str, title: Option<String>) -> Result<Mission> {
        self.create_mission_from(MissionSpec { prompt: prompt.into(), title, ..Default::default() })
    }

    /// Closes a mission, then hands the next queued one to Central.
    pub fn finish_mission(&mut self, id: &str, status: MissionStatus, summary: &str) -> Result<Mission> {
        let m = self.close_mission(id, status, summary)?;
        self.start_next_queued()?;
        Ok(m)
    }

    fn close_mission(&mut self, id: &str, status: MissionStatus, summary: &str) -> Result<Mission> {
        let mut m = self.store.get_mission(id)?.ok_or_else(|| Error::not_found(format!("mission {id}")))?;
        if m.status.is_closed() {
            return Err(Error::invalid(format!("{id} is already closed")));
        }
        if status == MissionStatus::Completed {
            let open: Vec<String> = self
                .store
                .list_tasks(&TaskFilter { mission_id: Some(id.into()), ..Default::default() })?
                .into_iter()
                .filter(|t| !t.status.is_terminal())
                .map(|t| format!("{} ({})", t.id, t.status.as_str()))
                .collect();
            if !open.is_empty() {
                return Err(Error::Conflict(format!(
                    "{id} still has open tasks: {}. Complete or cancel them first.",
                    open.join(", ")
                )));
            }
        }
        m.status = status;
        m.summary = Some(summary.trim().into());
        m.updated_at = pcc_core::now();
        m.completed_at = Some(m.updated_at.clone());
        self.store.upsert_mission(&m)?;
        self.emit_mission(EventKind::MissionCompleted, id, format!("Mission {id} {:?}", status).to_lowercase());
        self.checkpoint_mission(id, &format!("mission {}", status.as_str()), true);
        Ok(m)
    }

    pub fn cancel_mission(&mut self, id: &str) -> Result<()> {
        for t in self.store.list_tasks(&TaskFilter { mission_id: Some(id.into()), ..Default::default() })? {
            if !t.status.is_terminal() {
                self.update_task(
                    &t.id,
                    TaskPatch { status: Some(TaskStatus::Cancelled), ..Default::default() },
                    USER_ID,
                )?;
            }
        }
        let was_queued = self.store.get_mission(id)?.is_some_and(|m| m.status == MissionStatus::Queued);
        self.close_mission(id, MissionStatus::Cancelled, "Cancelled by the user.")?;
        // Central never received a queued mission: nothing to tell it.
        if !was_queued {
            self.notify_central(
                &format!("The user cancelled mission {id}; its open tasks were cancelled."),
                None,
                Some(id.into()),
            )?;
        }
        self.start_next_queued()?;
        Ok(())
    }

    // ------------------------------------------------------------ memory

    pub fn save_memory(&mut self, key: &str, content: &str, author: &str) -> Result<()> {
        let scope = MemoryScope::parse(key)?;
        if let MemoryScope::Agent(a) = &scope {
            self.store.agent(a)?;
        }
        self.store.write_memory(&scope, content)?;
        self.emit(Event::new(
            EventKind::MemoryUpdated,
            format!("{author} updated memory {}", scope.key()),
            json!({"key": scope.key()}),
        ));
        Ok(())
    }

    pub fn append_memory(&mut self, key: &str, entry: &str, author: &str) -> Result<()> {
        let scope = MemoryScope::parse(key)?;
        self.store.append_memory(&scope, author, entry)?;
        self.emit(
            Event::new(
                EventKind::MemoryUpdated,
                format!("{author} added to memory {}", scope.key()),
                json!({"key": scope.key()}),
            )
            .agent(author),
        );
        Ok(())
    }

    pub fn consolidate_memory(&mut self) -> Result<()> {
        self.send_user_message(
            CENTRAL_ID,
            "Consolidate the project memory now: read each memory file (project, architecture, decisions, conventions, discoveries and the agents' memories), merge duplicates, drop outdated or transient details, keep durable facts, and rewrite the files with write_memory. Keep each file concise.",
        )?;
        Ok(())
    }
}

/// Human description of an access level, used by tool outputs.
pub fn access_str(a: Access) -> &'static str {
    match a {
        Access::Deny => "deny",
        Access::Ask => "ask",
        Access::Allow => "allow",
    }
}
