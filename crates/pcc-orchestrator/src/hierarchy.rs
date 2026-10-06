//! The agent pyramid: Central (commander) → lieutenants → specialists.
//!
//! * Delegation: Central and lieutenants create agents only inside their own
//!   subtree, after recording a structured decision, and never deeper than
//!   the project's `maxHierarchyDepth`. Specialists cannot create agents.
//! * Routing: an agent talks directly to its parent and to its descendants;
//!   any other message goes to its parent, which relays it (journaled).
//! * Supervision: task results go to the task's creator when it supervises the
//!   assignee (a lieutenant), otherwise to the assignee's parent or Central.
//! * Dormancy: idle sessions fall asleep (process stopped, resumed with
//!   `--resume` on the next message or task); paused agents receive nothing.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pcc_core::{
    Agent, AgentKind, AgentRank, AgentStatus, Error, Event, EventKind, Message, MessageKind, Result, Task, CENTRAL_ID,
    SYSTEM_ID, USER_ID,
};
use pcc_store::{EventFilter, TaskFilter};

use crate::engine::{first_line, Engine};

/// Bounds of the `maxHierarchyDepth` setting.
pub const MIN_DEPTH: u32 = 1;
pub const MAX_DEPTH: u32 = 5;

/// One sub-agent an agent intends to create.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PlannedChild {
    pub name: String,
    pub role: String,
    pub rank: Option<AgentRank>,
    pub reason: String,
}

/// What an agent decided before delegating ("do I need sub-agents, and which?").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DelegationDecision {
    pub needs_sub_agents: bool,
    pub reason: String,
    pub children: Vec<PlannedChild>,
}

/// A recorded decision (stored as a `DelegationDecision` event).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationRecord {
    pub id: i64,
    pub ts: String,
    pub agent_id: String,
    pub task_id: Option<String>,
    pub mission_id: Option<String>,
    #[serde(flatten)]
    pub decision: DelegationDecision,
}

/// Engine-side state of the hierarchy that only lives while the app runs.
#[derive(Default)]
pub(crate) struct Runtime {
    /// Sessions being stopped because the agent falls asleep.
    pub sleeping: HashSet<String>,
    /// Rank changed while a turn was running: restart (resume) when idle so
    /// the new tools and prompt apply.
    pub restart_pending: HashSet<String>,
    /// Local model of each agent's latest session (agents on Claude absent).
    pub local_models: HashMap<String, String>,
}

// ---------------------------------------------------------------- pure tree

/// Read-only view of the pyramid over a list of agents.
pub struct Tree<'a> {
    by_id: HashMap<&'a str, &'a Agent>,
}

impl<'a> Tree<'a> {
    pub fn new(agents: &'a [Agent]) -> Self {
        Tree { by_id: agents.iter().map(|a| (a.id.as_str(), a)).collect() }
    }

    pub fn get(&self, id: &str) -> Option<&'a Agent> {
        self.by_id.get(id).copied()
    }

    pub fn parent(&self, id: &str) -> Option<&'a str> {
        let a = self.get(id)?;
        if a.kind == AgentKind::Central {
            return None;
        }
        Some(a.parent_agent.as_deref().unwrap_or(CENTRAL_ID))
    }

    /// Parent first, up to the root. Stops on cycles or unknown agents.
    pub fn ancestors(&self, id: &str) -> Vec<&'a str> {
        let mut out: Vec<&'a str> = Vec::new();
        let mut cur = self.get(id).map(|a| a.id.as_str());
        while let Some(c) = cur {
            match self.parent(c) {
                Some(p) if p != id && !out.contains(&p) => {
                    let p = self.get(p).map(|a| a.id.as_str());
                    if let Some(p) = p {
                        out.push(p);
                    }
                    cur = p;
                }
                _ => break,
            }
        }
        out
    }

    /// Central is level 0, its direct reports level 1...
    pub fn level(&self, id: &str) -> u32 {
        self.ancestors(id).len() as u32
    }

    pub fn is_ancestor(&self, ancestor: &str, id: &str) -> bool {
        self.ancestors(id).contains(&ancestor)
    }

    /// Direct reports that are not retired.
    pub fn children(&self, id: &str) -> Vec<&'a Agent> {
        let mut v: Vec<&'a Agent> = self
            .by_id
            .values()
            .copied()
            .filter(|a| a.status != AgentStatus::Retired && self.parent(&a.id) == Some(id))
            .collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }

    /// Every non-retired agent below `id`.
    pub fn descendants(&self, id: &str) -> Vec<&'a Agent> {
        let mut v: Vec<&'a Agent> = self
            .by_id
            .values()
            .copied()
            .filter(|a| a.status != AgentStatus::Retired && a.id != id && self.is_ancestor(id, &a.id))
            .collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }

    /// Path through the tree: `from`, up to the common ancestor, down to `to`.
    pub fn path(&self, from: &str, to: &str) -> Vec<String> {
        let mut up: Vec<&str> = vec![from];
        up.extend(self.ancestors(from));
        let mut down: Vec<&str> = vec![to];
        down.extend(self.ancestors(to));
        let Some(pos) = up.iter().position(|x| down.contains(x)) else {
            return vec![from.to_string(), to.to_string()];
        };
        let common = up[pos];
        let mut path: Vec<String> = up[..=pos].iter().map(|s| s.to_string()).collect();
        let back = down.iter().position(|x| *x == common).unwrap_or(0);
        path.extend(down[..back].iter().rev().map(|s| s.to_string()));
        path
    }
}

/// How a message from one agent reaches another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    /// Parent, descendant, or a cross-branch message the project lets through
    /// (`cross_branch` is then true and the route is journaled).
    Direct { cross_branch: bool },
    /// Handed to the sender's parent, which relays it.
    Forward { via: String },
}

/// Routing rule (§16): parent and descendants directly; anything else through
/// the parent, unless direct worker messages are allowed by the project.
pub fn delivery(tree: &Tree<'_>, from: &str, to: &str, allow_direct: bool) -> Delivery {
    if matches!(from, USER_ID | SYSTEM_ID) || tree.parent(from) == Some(to) || tree.is_ancestor(from, to) {
        return Delivery::Direct { cross_branch: false };
    }
    if allow_direct {
        return Delivery::Direct { cross_branch: true };
    }
    match tree.parent(from) {
        Some(p) => Delivery::Forward { via: p.to_string() },
        None => Delivery::Direct { cross_branch: false },
    }
}

/// Checks a creation request against the pyramid (pure; see `Engine::check_new_agent`).
pub fn check_creation(tree: &Tree<'_>, creator: &str, parent: &str, rank: AgentRank, max_depth: u32) -> Result<()> {
    let p = tree.get(parent).ok_or_else(|| Error::not_found(format!("agent {parent}")))?;
    if p.status == AgentStatus::Retired {
        return Err(Error::invalid(format!("{parent} is retired")));
    }
    if creator != USER_ID {
        let c = tree.get(creator).ok_or_else(|| Error::not_found(format!("agent {creator}")))?;
        if c.rank == AgentRank::Specialist {
            return Err(Error::Denied(
                "specialists cannot create agents. Do the work yourself, or ask your parent (send_message) for more help."
                    .into(),
            ));
        }
        if parent != creator && !tree.is_ancestor(creator, parent) {
            return Err(Error::Denied(format!(
                "{parent} is outside your subtree; you can only create agents under yourself or your descendants"
            )));
        }
    }
    if p.rank == AgentRank::Specialist {
        return Err(Error::invalid(format!(
            "{parent} is a specialist and cannot have sub-agents; promote it to lieutenant first"
        )));
    }
    if rank == AgentRank::Commander {
        return Err(Error::invalid("there is only one commander (Central)"));
    }
    let level = tree.level(parent) + 1;
    let max = max_depth.clamp(MIN_DEPTH, MAX_DEPTH);
    if level > max {
        return Err(Error::Denied(format!(
            "maximum hierarchy depth reached: a sub-agent of {parent} would be at level {level}, the project allows {max} (Settings → Agents → Maximum hierarchy depth). Do the work with existing agents instead."
        )));
    }
    if rank == AgentRank::Lieutenant && level == max {
        return Err(Error::Denied(format!(
            "a lieutenant at level {level} could not have sub-agents (maximum depth {max}); create a specialist instead"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------- engine

impl Engine {
    fn tree_agents(&self) -> Result<Vec<Agent>> {
        self.store.list_agents()
    }

    pub(crate) fn max_depth(&self) -> u32 {
        self.store.settings().max_hierarchy_depth.clamp(MIN_DEPTH, MAX_DEPTH)
    }

    /// Parent and rank of a new agent, validated against the pyramid.
    pub(crate) fn place_new_agent(
        &self,
        created_by: &str,
        parent: Option<&str>,
        rank: Option<AgentRank>,
    ) -> Result<(String, AgentRank)> {
        let agents = self.tree_agents()?;
        let tree = Tree::new(&agents);
        let parent = match parent.map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => p.to_string(),
            None if created_by == USER_ID || created_by == SYSTEM_ID => CENTRAL_ID.to_string(),
            None => created_by.to_string(),
        };
        let rank = rank.unwrap_or(AgentRank::Specialist);
        let creator = if created_by == SYSTEM_ID { USER_ID } else { created_by };
        check_creation(&tree, creator, &parent, rank, self.max_depth())?;
        if creator != USER_ID && !self.has_positive_decision(creator)? {
            return Err(Error::invalid(
                "record your delegation decision first: call record_delegation_decision with needs_sub_agents=true, the reason and the children you plan (or pass decision_reason to create_agent)",
            ));
        }
        Ok((parent, rank))
    }

    // ------------------------------------------------------------ decisions

    pub fn record_delegation(&mut self, agent: &str, decision: DelegationDecision) -> Result<DelegationRecord> {
        if decision.reason.trim().is_empty() {
            return Err(Error::invalid("a delegation decision needs a reason"));
        }
        let a = self.store.agent(agent)?;
        let task = a.current_task.clone();
        let mission = match &task {
            Some(t) => self.store.get_task(t)?.and_then(|t| t.mission_id),
            None => {
                let active = self.store.active_mission_ids()?;
                (active.len() == 1).then(|| active[0].clone())
            }
        };
        let summary = if decision.needs_sub_agents {
            let names: Vec<&str> = decision.children.iter().map(|c| c.name.as_str()).collect();
            format!(
                "{} decided to delegate to {} sub-agent(s){}: {}",
                a.name,
                decision.children.len(),
                if names.is_empty() { String::new() } else { format!(" ({})", names.join(", ")) },
                first_line(&decision.reason, 120)
            )
        } else {
            format!("{} decided to work without sub-agents: {}", a.name, first_line(&decision.reason, 120))
        };
        let mut e = Event::new(EventKind::DelegationDecision, summary, json!(decision)).agent(agent).mission(mission);
        e.task_id = task;
        self.store.insert_event(&mut e)?;
        self.bus.publish(e.clone());
        Ok(record_of(&e))
    }

    /// Newest first.
    pub fn delegation_decisions(&self, agent: Option<&str>, limit: u32) -> Result<Vec<DelegationRecord>> {
        let events = self.store.list_events(&EventFilter {
            agent_id: agent.map(str::to_string),
            kind: Some(EventKind::DelegationDecision),
            limit: Some(limit.clamp(1, 500)),
            ..Default::default()
        })?;
        Ok(events.iter().map(record_of).collect())
    }

    fn has_positive_decision(&self, agent: &str) -> Result<bool> {
        Ok(self.delegation_decisions(Some(agent), 1)?.first().is_some_and(|d| d.decision.needs_sub_agents))
    }

    // ------------------------------------------------------------ routing

    /// Sends an agent's message along the hierarchy. Returns the stored
    /// message and, when it was routed, the path it takes.
    pub fn route_message(
        &mut self,
        from: &str,
        to: &str,
        kind: MessageKind,
        body: &str,
        task_id: Option<String>,
    ) -> Result<(Message, Option<Vec<String>>)> {
        if from == to {
            return Err(Error::invalid("you cannot message yourself"));
        }
        let agents = self.tree_agents()?;
        let tree = Tree::new(&agents);
        if tree.get(to).is_none() {
            return Err(Error::not_found(format!("agent {to}")));
        }
        let allow = self.store.settings().allow_direct_worker_messages;
        match delivery(&tree, from, to, allow) {
            Delivery::Direct { cross_branch: false } => {
                Ok((self.post_message(from, to, kind, body, task_id, None)?, None))
            }
            Delivery::Direct { cross_branch: true } => {
                let path = tree.path(from, to);
                let m = self.post_message(from, to, kind, body, task_id, None)?;
                self.journal_route(&m, from, to, None, &path);
                Ok((m, Some(path)))
            }
            Delivery::Forward { via } => {
                let path = tree.path(from, to);
                let text = format!(
                    "[ROUTED by NEXUS · from {from} · for {to} · path {}]\n{}\n\n{to} is not your parent or one of your descendants, so this message came to you. Relay it with send_message to {to} (add context if useful), or answer {from} yourself.",
                    path.join(" → "),
                    body.trim()
                );
                let m = self.post_message(from, &via, kind, &text, task_id, None)?;
                self.journal_route(&m, from, to, Some(&via), &path);
                Ok((m, Some(path)))
            }
        }
    }

    fn journal_route(&self, m: &Message, from: &str, to: &str, via: Option<&str>, path: &[String]) {
        let summary = match via {
            Some(v) => format!("{from} → {to} routed through {v} ({})", path.join(" → ")),
            None => format!("{from} → {to} cross-branch ({})", path.join(" → ")),
        };
        self.emit(
            Event::new(
                EventKind::MessageRouted,
                summary,
                json!({"messageId": m.id, "from": from, "to": to, "via": via, "path": path}),
            )
            .agent(from),
        );
    }

    // ------------------------------------------------------------ supervision

    /// Who receives the result of a task: its creator when that agent
    /// supervises the assignee, otherwise the assignee's parent, else Central.
    pub(crate) fn supervisor_for(&self, t: &Task) -> Result<String> {
        let agents = self.tree_agents()?;
        let tree = Tree::new(&agents);
        let usable = |id: &str| tree.get(id).is_some_and(|a| a.status != AgentStatus::Retired);
        let Some(assignee) = t.agent.as_deref() else { return Ok(CENTRAL_ID.into()) };
        if t.created_by != CENTRAL_ID && usable(&t.created_by) && tree.is_ancestor(&t.created_by, assignee) {
            return Ok(t.created_by.clone());
        }
        if t.created_by == CENTRAL_ID {
            return Ok(CENTRAL_ID.into());
        }
        match tree.parent(assignee) {
            Some(p) if usable(p) => Ok(p.to_string()),
            _ => Ok(CENTRAL_ID.into()),
        }
    }

    /// Reports a task event to its supervisor (Central or a lieutenant).
    pub(crate) fn notify_supervisor(&mut self, t: &Task, body: &str) -> Result<()> {
        let to = self.supervisor_for(t)?;
        if to == CENTRAL_ID {
            return self.notify_central(body, Some(t.id.clone()), t.mission_id.clone());
        }
        let text = format!(
            "{body}\n\n(You supervise this task. When all your sub-tasks are settled, report a synthesis to your parent: complete your own task with a summary of your specialists' results.)"
        );
        self.post_message(SYSTEM_ID, &to, MessageKind::System, &text, Some(t.id.clone()), t.mission_id.clone())?;
        Ok(())
    }

    /// Tasks this agent delegated that are still open (it is supervising).
    pub(crate) fn has_open_delegations(&self, agent: &str) -> Result<bool> {
        Ok(self
            .store
            .list_tasks(&TaskFilter::default())?
            .iter()
            .any(|t| t.created_by == agent && t.agent.as_deref() != Some(agent) && !t.status.is_terminal()))
    }

    // ------------------------------------------------------------ promote / demote

    pub fn promote_agent(&mut self, id: &str) -> Result<Agent> {
        let mut a = self.store.agent(id)?;
        if a.kind == AgentKind::Central {
            return Err(Error::invalid("Central is already the commander"));
        }
        if a.status == AgentStatus::Retired {
            return Err(Error::invalid(format!("{} is retired", a.name)));
        }
        if a.rank == AgentRank::Lieutenant {
            return Err(Error::invalid(format!("{} is already a lieutenant", a.name)));
        }
        let agents = self.tree_agents()?;
        let level = Tree::new(&agents).level(id);
        let max = self.max_depth();
        if level >= max {
            return Err(Error::Denied(format!(
                "{} is at level {level}; with a maximum depth of {max} a lieutenant there could not have sub-agents",
                a.name
            )));
        }
        a.rank = AgentRank::Lieutenant;
        self.save_agent(&mut a)?;
        self.emit(
            Event::new(EventKind::HierarchyChanged, format!("{} promoted to lieutenant", a.name), json!(a)).agent(id),
        );
        self.apply_rank_change(id)?;
        Ok(a)
    }

    /// Lieutenant → specialist. Its children move to its own parent.
    pub fn demote_agent(&mut self, id: &str) -> Result<Agent> {
        let mut a = self.store.agent(id)?;
        if a.kind == AgentKind::Central {
            return Err(Error::invalid("Central cannot be demoted"));
        }
        if a.rank != AgentRank::Lieutenant {
            return Err(Error::invalid(format!("{} is not a lieutenant", a.name)));
        }
        let agents = self.tree_agents()?;
        let tree = Tree::new(&agents);
        let new_parent = tree.parent(id).unwrap_or(CENTRAL_ID).to_string();
        let children: Vec<String> = tree.children(id).iter().map(|c| c.id.clone()).collect();
        for c in &children {
            let mut child = self.store.agent(c)?;
            child.parent_agent = Some(new_parent.clone());
            self.save_agent(&mut child)?;
        }
        a.rank = AgentRank::Specialist;
        self.save_agent(&mut a)?;
        self.emit(
            Event::new(
                EventKind::HierarchyChanged,
                if children.is_empty() {
                    format!("{} demoted to specialist", a.name)
                } else {
                    format!("{} demoted to specialist; {} moved under {new_parent}", a.name, children.join(", "))
                },
                json!({"agent": a, "reparented": children, "newParent": new_parent}),
            )
            .agent(id),
        );
        // The new supervisor must know about adopted agents that still have work.
        let mut open = Vec::new();
        for c in &children {
            for t in self.store.list_tasks(&TaskFilter { agent: Some(c.clone()), ..Default::default() })? {
                if !t.status.is_terminal() {
                    open.push(format!("{} \"{}\" ({c}, {})", t.id, t.title, t.status.as_str()));
                }
            }
        }
        if !open.is_empty() {
            self.post_message(
                SYSTEM_ID,
                &new_parent,
                MessageKind::System,
                &format!(
                    "{} was demoted by the user. You now supervise {}. Open tasks: {}. Their results now come to you.",
                    a.id,
                    children.join(", "),
                    open.join("; ")
                ),
                None,
                None,
            )?;
        }
        self.apply_rank_change(id)?;
        Ok(a)
    }

    /// Tools and prompt depend on the rank: restart a live session (resumed,
    /// so it keeps its context) now if idle, otherwise after its turn.
    fn apply_rank_change(&mut self, id: &str) -> Result<()> {
        match self.sessions.get(id) {
            Some(l) if l.busy => {
                self.hier.restart_pending.insert(id.to_string());
                Ok(())
            }
            Some(_) => self.restart_agent(id),
            None => Ok(()),
        }
    }

    /// Called at the end of each turn.
    pub(crate) fn hierarchy_turn_end(&mut self, id: &str) -> Result<()> {
        if self.hier.restart_pending.remove(id) && self.sessions.get(id).is_some_and(|l| !l.busy) {
            self.restart_agent(id)?;
        }
        Ok(())
    }

    // ------------------------------------------------------------ dormancy

    /// Paused agents get nothing delivered; a running turn is interrupted.
    pub fn pause_agent(&mut self, id: &str) -> Result<Agent> {
        let mut a = self.store.agent(id)?;
        if a.status == AgentStatus::Retired {
            return Err(Error::invalid(format!("{} is retired", a.name)));
        }
        if a.paused_at.is_some() {
            return Ok(a);
        }
        if self.sessions.get(id).is_some_and(|l| l.busy) {
            self.interrupt_agent(id)?;
        }
        a.paused_at = Some(pcc_core::now());
        self.save_agent(&mut a)?;
        self.emit(Event::new(EventKind::AgentDormancy, format!("{} paused by the user", a.name), json!(a)).agent(id));
        Ok(a)
    }

    pub fn resume_agent(&mut self, id: &str) -> Result<Agent> {
        let mut a = self.store.agent(id)?;
        if a.paused_at.take().is_none() {
            return Ok(a);
        }
        self.save_agent(&mut a)?;
        self.emit(Event::new(EventKind::AgentDormancy, format!("{} resumed", a.name), json!(a)).agent(id));
        self.autopilot = true;
        self.pump(id)?;
        self.store.agent(id)
    }

    /// Stops an idle session to free resources; the agent wakes up (resumed
    /// session) on its next message or task. Returns false when the agent is
    /// not idle (turn running, permission pending, input queued).
    pub fn sleep_agent(&mut self, id: &str) -> Result<bool> {
        let Some(live) = self.sessions.get(id) else { return Ok(false) };
        if live.busy || live.stopping || !live.got_init {
            return Ok(false);
        }
        if self.permissions.any_for(id)
            || !self.store.undelivered_for(id)?.is_empty()
            || self.store.agent(id)?.claude_session_id.is_none()
        {
            return Ok(false);
        }
        self.hier.sleeping.insert(id.to_string());
        if let Some(l) = self.sessions.get_mut(id) {
            l.stopping = true;
            l.handle.kill();
        }
        Ok(true)
    }

    /// Puts to sleep every session idle for at least `minutes`.
    pub fn sleep_idle_agents(&mut self, minutes: u32) -> Result<Vec<String>> {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        let mut slept = Vec::new();
        for id in ids {
            let a = self.store.agent(&id)?;
            if a.status != AgentStatus::Waiting {
                continue;
            }
            // A waiting agent is not saved again until its next turn.
            if minutes_since(&a.updated_at).is_some_and(|m| m >= minutes as i64) && self.sleep_agent(&id)? {
                slept.push(id);
            }
        }
        Ok(slept)
    }

    /// Minute tick: idle sessions fall asleep after the configured delay.
    pub(crate) fn hierarchy_tick(&mut self) -> Result<()> {
        let minutes = self.store.settings().sleep_after_minutes;
        if minutes == 0 || self.store.read_only() {
            return Ok(());
        }
        self.sleep_idle_agents(minutes).map(|_| ())
    }

    /// Session exit of an agent that was put to sleep. Returns true when handled.
    pub(crate) fn finish_sleep(&mut self, id: &str) -> Result<bool> {
        if !self.hier.sleeping.remove(id) {
            return Ok(false);
        }
        let a = self.set_status(id, AgentStatus::Sleeping)?;
        if let Some(row) = self.store.list_sessions(id)?.last().map(|s| s.id) {
            self.log(
                id,
                row,
                pcc_core::LogKind::System,
                "Idle: session stopped to free resources (sleeping). It resumes on the next message or task.",
            );
        }
        self.emit(
            Event::new(EventKind::AgentDormancy, format!("{} is sleeping (idle session stopped)", a.name), json!(a))
                .agent(id),
        );
        self.on_agent_sleep(&a);
        self.schedule()?;
        Ok(true)
    }

    pub(crate) fn note_session_model(&mut self, id: &str, local_model: Option<String>) {
        match local_model {
            Some(m) => self.hier.local_models.insert(id.to_string(), m),
            None => self.hier.local_models.remove(id),
        };
    }

    /// A sleeping agent on a local model frees it from the runtime's memory,
    /// unless another live session still uses the same model. The unload runs
    /// off the engine lock; its outcome is journaled.
    fn on_agent_sleep(&mut self, agent: &Agent) {
        let Some(model) = self.hier.local_models.get(&agent.id).cloned() else { return };
        if let Some(other) = self
            .hier
            .local_models
            .iter()
            .find(|(id, m)| **m == model && id.as_str() != agent.id && self.sessions.contains_key(id.as_str()))
        {
            tracing::debug!("{} sleeps; {model} kept loaded for {}", agent.id, other.0);
            return;
        }
        let ai = self.store.settings().ai;
        let (bus, store) = (self.bus.clone(), self.store.clone());
        let (id, name) = (agent.id.clone(), agent.name.clone());
        std::thread::spawn(move || {
            let provider = pcc_ai::provider_for(&ai);
            let summary = match provider.unload_model(&model) {
                Ok(()) => format!("{name} is sleeping: local model {model} unloaded"),
                Err(e) => format!("{name} is sleeping: local model {model} could not be unloaded ({e})"),
            };
            let mut e =
                Event::new(EventKind::AgentDormancy, summary, json!({"agentId": id, "model": model})).agent(&id);
            if let Err(err) = store.insert_event(&mut e) {
                tracing::warn!("journal of model unload failed: {err}");
            }
            bus.publish(e);
        });
    }

    pub(crate) fn note_wake(&self, a: &Agent) {
        self.emit(
            Event::new(EventKind::AgentDormancy, format!("{} woke up (session resumed)", a.name), json!(a))
                .agent(&a.id),
        );
    }
}

/// The "agent hierarchy" section of an agent's system prompt.
pub fn prompt_section(agents: &[Agent], me: &Agent, max_depth: u32) -> String {
    let tree = Tree::new(agents);
    let max = max_depth.clamp(MIN_DEPTH, MAX_DEPTH);
    let level = tree.level(&me.id);
    let list = |v: Vec<&Agent>| -> String {
        if v.is_empty() {
            return "none yet".into();
        }
        v.iter().map(|a| format!("`{}` ({}, {})", a.id, a.role, rank_label(a.rank))).collect::<Vec<_>>().join(", ")
    };
    match me.rank {
        AgentRank::Commander => format!(
            "You are the commander (level 0) of an agent pyramid at most {max} level(s) deep below you. Your direct reports: {}.\n\n\
- Specialists do the work. A **lieutenant** (`create_agent` with `rank: \"lieutenant\"`) owns a whole domain: it creates its own specialists, assigns and reviews their tasks and sends you a synthesis. Use lieutenants only for large, independent domains (e.g. a Lua codebase and a UI) worth several parallel specialists; otherwise create specialists directly.\n\
- Before creating agents, call `record_delegation_decision` (or pass `decision_reason` to `create_agent`). The decision is shown to the user.\n\
- Creation deeper than the maximum depth is refused. You may create an agent under one of your lieutenants with `parent`.\n\
- Messages: you can message any agent. Agents talk directly only to their parent and their own sub-agents; anything else is routed to their parent, which relays it. Messages routed to you start with `[ROUTED by NEXUS …]`: relay them to the recipient or answer yourself.\n\
- Task results go to the agent that created the task when it supervises the assignee; a lieutenant's synthesis comes to you when it completes its own task.",
            list(tree.children(&me.id))
        ),
        AgentRank::Lieutenant => {
            let parent = tree.parent(&me.id).unwrap_or(CENTRAL_ID);
            let can_nest = level + 1 < max;
            format!(
                "You are a **lieutenant** at level {level} (maximum depth {max}), reporting to `{parent}`. Your sub-agents: {}.\n\n\
You lead your domain: analyse, decompose, delegate, supervise, review, merge, test and report.\n\
1. Decide whether sub-agents really help: `record_delegation_decision` with `needs_sub_agents`, the reason and the planned children. A small task: do it yourself.\n\
2. `create_agent` creates specialists under you{}. `create_task` assigns them work; `list_tasks`, `get_task`, `update_task`, `request_changes`, `retire_agent` work on your subtree only.\n\
3. Their results, blocks and failures come to you as `[MESSAGE … from system]`. While their tasks are open you may end your turn: you are woken up when something happens.\n\
4. When your domain's work is done and verified, call `complete_task` on your own task with a SYNTHESIS for `{parent}`, e.g. \"Lua Agent: 120 files analysed, 3 problems found, 2 fixed, 1 needs validation\" (what each specialist did, files, tests, open risks). Do not forward raw transcripts.\n\
- Messages: talk directly to `{parent}` and to your sub-agents; other agents are reached through `{parent}`. Relay `[ROUTED by NEXUS …]` messages to the right sub-agent.",
                list(tree.children(&me.id)),
                if can_nest { " (a lieutenant under you only for a large sub-domain)" } else { "" }
            )
        }
        AgentRank::Specialist => {
            let parent = tree.parent(&me.id).unwrap_or(CENTRAL_ID);
            format!(
                "You are a **specialist** at level {level}, reporting to `{parent}`. You do the work yourself: you cannot create agents. Your results go to `{parent}`. `send_message` reaches `{parent}` by default; agents outside your branch are reached through `{parent}`, which relays."
            )
        }
    }
}

pub fn rank_label(r: AgentRank) -> &'static str {
    match r {
        AgentRank::Commander => "commander",
        AgentRank::Lieutenant => "lieutenant",
        AgentRank::Specialist => "specialist",
    }
}

fn record_of(e: &Event) -> DelegationRecord {
    DelegationRecord {
        id: e.id,
        ts: e.ts.clone(),
        agent_id: e.agent_id.clone().unwrap_or_default(),
        task_id: e.task_id.clone(),
        mission_id: e.mission_id.clone(),
        decision: serde_json::from_value(e.payload.clone()).unwrap_or_default(),
    }
}

fn minutes_since(ts: &str) -> Option<i64> {
    let t = chrono::DateTime::parse_from_rfc3339(ts).ok()?;
    Some((chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_minutes())
}

/// Decision arguments of `record_delegation_decision` / `create_agent`.
pub(crate) fn decision_from_args(args: &Value) -> DelegationDecision {
    let children = args
        .get("children")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|c| PlannedChild {
                    name: c.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                    role: c.get("role").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                    rank: c.get("rank").and_then(|r| serde_json::from_value(r.clone()).ok()),
                    reason: c.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    DelegationDecision {
        needs_sub_agents: args.get("needs_sub_agents").and_then(Value::as_bool).unwrap_or(false),
        reason: args.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string(),
        children,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcc_core::{Isolation, PermissionSet};

    fn agent(id: &str, parent: Option<&str>, rank: AgentRank) -> Agent {
        Agent {
            id: id.into(),
            name: id.into(),
            kind: if id == CENTRAL_ID { AgentKind::Central } else { AgentKind::Worker },
            provider: pcc_core::CLAUDE_CODE_PROVIDER.into(),
            role: "r".into(),
            instructions: String::new(),
            status: AgentStatus::Offline,
            model: None,
            permissions: PermissionSet::worker_default(),
            connections: vec![],
            isolation: Isolation::Shared,
            workdir: ".".into(),
            branch: None,
            current_task: None,
            current_action: None,
            progress: None,
            claude_session_id: None,
            total_cost_usd: 0.0,
            profile: Default::default(),
            created_by: "user".into(),
            created_at: id.into(),
            updated_at: String::new(),
            parent_agent: parent.map(str::to_string),
            rank,
            paused_at: None,
        }
    }

    fn pyramid() -> Vec<Agent> {
        vec![
            agent(CENTRAL_ID, None, AgentRank::Commander),
            agent("lua", Some(CENTRAL_ID), AgentRank::Lieutenant),
            agent("lua-a", Some("lua"), AgentRank::Specialist),
            agent("lua-b", Some("lua"), AgentRank::Specialist),
            agent("ui", Some(CENTRAL_ID), AgentRank::Lieutenant),
            agent("ui-a", Some("ui"), AgentRank::Specialist),
            agent("solo", None, AgentRank::Specialist),
        ]
    }

    #[test]
    fn levels_children_and_paths() {
        let agents = pyramid();
        let t = Tree::new(&agents);
        assert_eq!((t.level(CENTRAL_ID), t.level("lua"), t.level("lua-a"), t.level("solo")), (0, 1, 2, 1));
        assert_eq!(t.children("lua").iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["lua-a", "lua-b"]);
        assert_eq!(t.descendants(CENTRAL_ID).len(), 6);
        assert!(t.is_ancestor("lua", "lua-b") && !t.is_ancestor("ui", "lua-b"));
        assert_eq!(t.path("lua-a", "ui-a"), ["lua-a", "lua", "central", "ui", "ui-a"]);
        assert_eq!(t.path("lua-a", "lua-b"), ["lua-a", "lua", "lua-b"]);
    }

    #[test]
    fn cycles_do_not_hang() {
        let agents = vec![
            agent(CENTRAL_ID, None, AgentRank::Commander),
            agent("a", Some("b"), AgentRank::Lieutenant),
            agent("b", Some("a"), AgentRank::Lieutenant),
        ];
        let t = Tree::new(&agents);
        assert!(t.level("a") <= 2);
    }

    #[test]
    fn routing_rules() {
        let agents = pyramid();
        let t = Tree::new(&agents);
        assert_eq!(delivery(&t, "lua-a", "lua", false), Delivery::Direct { cross_branch: false });
        assert_eq!(delivery(&t, "lua", "lua-b", false), Delivery::Direct { cross_branch: false });
        assert_eq!(delivery(&t, CENTRAL_ID, "ui-a", false), Delivery::Direct { cross_branch: false });
        assert_eq!(delivery(&t, "lua-a", "lua-b", false), Delivery::Forward { via: "lua".into() });
        assert_eq!(delivery(&t, "lua-a", CENTRAL_ID, false), Delivery::Forward { via: "lua".into() });
        assert_eq!(delivery(&t, "lua", "ui-a", false), Delivery::Forward { via: CENTRAL_ID.into() });
        assert_eq!(delivery(&t, "lua-a", "ui-a", true), Delivery::Direct { cross_branch: true });
    }

    #[test]
    fn creation_rules() {
        let agents = pyramid();
        let t = Tree::new(&agents);
        assert!(check_creation(&t, "lua", "lua", AgentRank::Specialist, 3).is_ok());
        assert!(check_creation(&t, CENTRAL_ID, "lua", AgentRank::Specialist, 3).is_ok());
        let e = check_creation(&t, "lua-a", "lua-a", AgentRank::Specialist, 3).unwrap_err();
        assert!(e.to_string().contains("specialists cannot create agents"));
        assert!(check_creation(&t, "lua", "ui", AgentRank::Specialist, 3).is_err());
        let e = check_creation(&t, "lua", "lua", AgentRank::Specialist, 1).unwrap_err();
        assert!(e.to_string().contains("maximum hierarchy depth"));
        assert!(check_creation(&t, "lua", "lua", AgentRank::Lieutenant, 2).is_err());
        assert!(check_creation(&t, "lua", "lua", AgentRank::Lieutenant, 3).is_ok());
        assert!(check_creation(&t, USER_ID, "lua-a", AgentRank::Specialist, 5).is_err());
    }

    #[test]
    fn prompts_follow_rank() {
        let agents = pyramid();
        let lt = prompt_section(&agents, &agents[1], 3);
        assert!(lt.contains("You are a **lieutenant** at level 1") && lt.contains("`lua-a` (r, specialist)"));
        assert!(lt.contains("SYNTHESIS"));
        let sp = prompt_section(&agents, &agents[2], 3);
        assert!(sp.contains("reporting to `lua`") && sp.contains("cannot create agents"));
        assert!(prompt_section(&agents, &agents[0], 3).contains("record_delegation_decision"));
    }

    #[test]
    fn decision_args() {
        let d = decision_from_args(&json!({"needs_sub_agents": true, "reason": " split ",
            "children": [{"name": "Lua A", "role": "scripts", "rank": "specialist", "reason": "parallel"}]}));
        assert!(d.needs_sub_agents);
        assert_eq!(d.reason, "split");
        assert_eq!(d.children[0].rank, Some(AgentRank::Specialist));
    }
}
