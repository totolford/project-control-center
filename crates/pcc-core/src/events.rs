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
    Error,
}

impl EventKind {
    /// High-frequency events are streamed to the UI but not written to the timeline.
    pub fn is_persistent(self) -> bool {
        !matches!(self, EventKind::AgentUpdated)
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
