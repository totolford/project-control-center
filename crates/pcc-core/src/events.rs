//! Internal event system. Every state change produces an [`Event`]; the
//! orchestrator persists it and the UI receives it in real time.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum EventKind {
    ProjectOpened,
    ProjectChanged,
    AgentCreated,
    AgentUpdated,
    AgentStarted,
    AgentStopped,
    AgentCrashed,
    AgentMessage,
    TaskCreated,
    TaskUpdated,
    TaskCompleted,
    TaskFailed,
    MissionCreated,
    MissionUpdated,
    MissionCompleted,
    PermissionRequested,
    PermissionResolved,
    ReviewRequested,
    ConnectionChanged,
    MemoryUpdated,
    GitChanged,
    /// A permission prompt answered automatically under CLAUDE UNLOCKED.
    PermissionAutoApproved,
    /// An agent called a tool that changes things (command, edit, MCP...).
    ToolUsed,
    EmergencyStop,
    ImprovementCycle,
    McpChanged,
    SkillChanged,
    /// An agent needs the user (secret, SSH key setup, sign-in...).
    UserRequested,
    UserRequestResolved,
    /// An agent recorded whether it needs sub-agents (and which) before delegating.
    DelegationDecision,
    /// A message was forwarded along the hierarchy (cross-branch routing).
    MessageRouted,
    /// Promotion, demotion or re-parenting in the agent pyramid.
    HierarchyChanged,
    /// An agent fell asleep, woke up, was paused or resumed.
    AgentDormancy,
    /// A session was restarted (user restart, failed resume, recovery).
    AgentRestarted,
    /// A permission request changed state without a user decision
    /// (expired, lost, recovered, cancelled, consumed). Payload: the record.
    PermissionUpdated,
    /// A local AI runtime started, stopped or crashed (`runtime.*`).
    RuntimeChanged,
    /// Application-level notice (`controlCenter.restarted`, `ui.rendererRecovered`...).
    SystemNotice,
    Error,
}

impl EventKind {
    /// High-frequency events are streamed to the UI but not written to the timeline.
    pub fn is_persistent(self) -> bool {
        !matches!(self, EventKind::AgentUpdated)
    }

    /// Dotted journal name used when the event does not carry a more precise one.
    pub fn default_name(self) -> &'static str {
        match self {
            EventKind::ProjectOpened => "project.opened",
            EventKind::ProjectChanged => "project.changed",
            EventKind::AgentCreated => "agent.created",
            EventKind::AgentUpdated => "agent.updated",
            EventKind::AgentStarted => "agent.started",
            EventKind::AgentStopped => "agent.stopped",
            EventKind::AgentCrashed => "agent.crashed",
            EventKind::AgentRestarted => "agent.restarted",
            EventKind::AgentMessage => "agent.message",
            EventKind::TaskCreated => "task.created",
            EventKind::TaskUpdated => "task.updated",
            EventKind::TaskCompleted => "task.completed",
            EventKind::TaskFailed => "task.failed",
            EventKind::MissionCreated => "mission.created",
            EventKind::MissionUpdated => "mission.updated",
            EventKind::MissionCompleted => "mission.completed",
            EventKind::PermissionRequested => "permission.created",
            EventKind::PermissionResolved => "permission.resolved",
            EventKind::PermissionUpdated => "permission.updated",
            EventKind::PermissionAutoApproved => "permission.autoApproved",
            EventKind::ReviewRequested => "task.reviewRequested",
            EventKind::ConnectionChanged => "connection.updated",
            EventKind::MemoryUpdated => "memory.updated",
            EventKind::GitChanged => "git.changed",
            EventKind::ToolUsed => "tool.used",
            EventKind::EmergencyStop => "controlCenter.emergencyStop",
            EventKind::ImprovementCycle => "mission.improvementCycle",
            EventKind::McpChanged => "mcp.changed",
            EventKind::SkillChanged => "skill.changed",
            EventKind::UserRequested => "user.requested",
            EventKind::UserRequestResolved => "user.requestResolved",
            EventKind::DelegationDecision => "agent.delegationDecision",
            EventKind::MessageRouted => "agent.messageRouted",
            EventKind::HierarchyChanged => "agent.hierarchyChanged",
            EventKind::AgentDormancy => "agent.dormancy",
            EventKind::RuntimeChanged => "runtime.changed",
            EventKind::SystemNotice => "controlCenter.notice",
            EventKind::Error => "controlCenter.error",
        }
    }

    pub fn default_severity(self) -> Severity {
        match self {
            EventKind::Error | EventKind::AgentCrashed | EventKind::TaskFailed => Severity::Error,
            EventKind::EmergencyStop => Severity::Critical,
            EventKind::PermissionRequested | EventKind::UserRequested | EventKind::ReviewRequested => Severity::Warning,
            _ => Severity::Info,
        }
    }
}

/// Importance of a journal entry.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    #[default]
    Info,
    Warning,
    Error,
    Critical,
}

impl Severity {
    pub const ALL: [Severity; 4] = [Severity::Info, Severity::Warning, Severity::Error, Severity::Critical];
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Error => "error",
            Severity::Critical => "critical",
        }
    }
    pub fn parse(s: &str) -> Severity {
        match s {
            "warning" => Severity::Warning,
            "error" => Severity::Error,
            "critical" => Severity::Critical,
            _ => Severity::Info,
        }
    }
}

/// Precise dotted name of an event, refined from its payload where the kind
/// alone is ambiguous (a resolved permission is `approved` or `denied`...).
pub fn journal_name(kind: EventKind, payload: &Value) -> String {
    let field = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("");
    match kind {
        EventKind::PermissionResolved => match field("decision") {
            "reject" => "permission.denied".into(),
            "allow_once" | "allow_always" => "permission.approved".into(),
            _ => kind.default_name().into(),
        },
        EventKind::PermissionUpdated if !field("status").is_empty() => format!("permission.{}", field("status")),
        EventKind::MissionCompleted => match field("status") {
            "failed" => "mission.failed".into(),
            "cancelled" => "mission.cancelled".into(),
            _ => kind.default_name().into(),
        },
        EventKind::ConnectionChanged if payload.get("deleted").and_then(Value::as_bool) == Some(true) => {
            "connection.deleted".into()
        }
        EventKind::McpChanged if !field("action").is_empty() => format!("mcp.{}", field("action")),
        EventKind::EmergencyStop if payload.get("active").and_then(Value::as_bool) == Some(false) => {
            "controlCenter.emergencyReleased".into()
        }
        _ => kind.default_name().into(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Row id in the `events` table (0 for non-persistent events).
    pub id: i64,
    pub ts: String,
    pub kind: EventKind,
    pub agent_id: Option<String>,
    pub task_id: Option<String>,
    pub mission_id: Option<String>,
    /// One line for the timeline.
    pub summary: String,
    /// The affected entity or details.
    pub payload: Value,
    /// Dotted journal name (`agent.started`, `permission.expired`...).
    /// Filled from the kind and payload when persisted unless set with [`Event::named`].
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub severity: Severity,
    /// Emitter: `engine` (default), `ui`, `runtime`, `mcp`...
    #[serde(default)]
    pub source: String,
    /// PID of the process concerned (agent's Claude Code session, runtime...).
    #[serde(default)]
    pub pid: Option<u32>,
}

impl Event {
    pub fn new(kind: EventKind, summary: impl Into<String>, payload: Value) -> Self {
        Event {
            id: 0,
            ts: crate::now(),
            kind,
            agent_id: None,
            task_id: None,
            mission_id: None,
            summary: summary.into(),
            payload,
            name: String::new(),
            severity: kind.default_severity(),
            source: "engine".into(),
            pid: None,
        }
    }
    /// Overrides the dotted journal name.
    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }
    pub fn with_severity(mut self, s: Severity) -> Self {
        self.severity = s;
        self
    }
    pub fn with_source(mut self, s: impl Into<String>) -> Self {
        self.source = s.into();
        self
    }
    pub fn with_pid(mut self, pid: Option<u32>) -> Self {
        self.pid = pid;
        self
    }
    /// Fills the journal name from the kind and payload if not set explicitly.
    pub fn ensure_name(&mut self) {
        if self.name.is_empty() {
            self.name = journal_name(self.kind, &self.payload);
        }
    }
    pub fn agent(mut self, id: impl Into<String>) -> Self {
        self.agent_id = Some(id.into());
        self
    }
    pub fn task(mut self, id: impl Into<String>) -> Self {
        self.task_id = Some(id.into());
        self
    }
    pub fn mission(mut self, id: Option<String>) -> Self {
        self.mission_id = id;
        self
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogKind {
    /// Text we wrote to the session (task, message, instruction).
    Input,
    AssistantText,
    Thinking,
    ToolUse,
    ToolResult,
    System,
    Result,
    Stderr,
    Error,
}

impl LogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LogKind::Input => "input",
            LogKind::AssistantText => "assistant_text",
            LogKind::Thinking => "thinking",
            LogKind::ToolUse => "tool_use",
            LogKind::ToolResult => "tool_result",
            LogKind::System => "system",
            LogKind::Result => "result",
            LogKind::Stderr => "stderr",
            LogKind::Error => "error",
        }
    }
    pub fn parse(s: &str) -> LogKind {
        match s {
            "input" => LogKind::Input,
            "assistant_text" => LogKind::AssistantText,
            "thinking" => LogKind::Thinking,
            "tool_use" => LogKind::ToolUse,
            "tool_result" => LogKind::ToolResult,
            "result" => LogKind::Result,
            "stderr" => LogKind::Stderr,
            "error" => LogKind::Error,
            _ => LogKind::System,
        }
    }
}

/// One line of an agent's session transcript, as shown in the agent terminal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: i64,
    pub agent_id: String,
    pub session_id: i64,
    pub ts: String,
    pub kind: LogKind,
    pub text: String,
}

/// Fan-out channel for events and log lines.
#[derive(Clone)]
pub struct EventBus {
    events: broadcast::Sender<Event>,
    logs: broadcast::Sender<LogEntry>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(4096);
        let (logs, _) = broadcast::channel(8192);
        EventBus { events, logs }
    }
    pub fn publish(&self, e: Event) {
        // No subscriber is fine (e.g. in tests).
        let _ = self.events.send(e);
    }
    pub fn publish_log(&self, l: LogEntry) {
        let _ = self.logs.send(l);
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }
    pub fn subscribe_logs(&self) -> broadcast::Receiver<LogEntry> {
        self.logs.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn journal_names_refine_the_kind() {
        let name = |k, p| journal_name(k, &p);
        assert_eq!(name(EventKind::AgentStarted, json!({})), "agent.started");
        assert_eq!(name(EventKind::PermissionResolved, json!({"decision": "reject"})), "permission.denied");
        assert_eq!(name(EventKind::PermissionResolved, json!({"decision": "allow_once"})), "permission.approved");
        assert_eq!(name(EventKind::PermissionUpdated, json!({"status": "expired"})), "permission.expired");
        assert_eq!(name(EventKind::MissionCompleted, json!({"status": "failed"})), "mission.failed");
        assert_eq!(name(EventKind::McpChanged, json!({"action": "restarted"})), "mcp.restarted");
        assert_eq!(name(EventKind::McpChanged, json!({"name": "pi"})), "mcp.changed");
        assert_eq!(name(EventKind::EmergencyStop, json!({"active": false})), "controlCenter.emergencyReleased");
        let mut e = Event::new(EventKind::AgentCrashed, "x", json!({}));
        assert_eq!(e.severity, Severity::Error);
        e.ensure_name();
        assert_eq!(e.name, "agent.crashed");
        let mut n = Event::new(EventKind::SystemNotice, "x", json!({})).named("ui.rendererRecovered");
        n.ensure_name();
        assert_eq!(n.name, "ui.rendererRecovered");
        // Events serialized before 0.4 still parse.
        let old: Event = serde_json::from_value(json!({"id": 1, "ts": "t", "kind": "AgentStarted", "agentId": null,
            "taskId": null, "missionId": null, "summary": "s", "payload": {}}))
        .unwrap();
        assert_eq!((old.severity, old.pid), (Severity::Info, None));
    }
}
