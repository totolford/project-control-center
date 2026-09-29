//! Domain entities. All are serialized in camelCase for the UI and on disk.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::permissions::PermissionSet;

// ---------------------------------------------------------------- project

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub root: String,
    pub created_at: String,
    /// Layout version of the `.agent-project` directory.
    pub format_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    /// Model alias for the Central agent (`None` = Claude Code default).
    pub central_model: Option<String>,
    /// Default model alias for workers.
    pub worker_model: Option<String>,
    /// Maximum number of worker sessions running at once.
    pub max_parallel_workers: u32,
    /// Give each worker its own git worktree when the project is a git repository.
    pub use_worktrees: bool,
    /// Load the user's global Claude Code settings (permissions rules, hooks, plugins).
    pub inherit_user_settings: bool,
    /// Permissions granted to a worker when Central does not ask for anything specific.
    pub default_worker_permissions: PermissionSet,
    /// Upper bound of what Central may grant to a worker without user confirmation.
    pub max_worker_permissions: PermissionSet,
    /// Optional spend cap (USD) per session, forwarded to `--max-budget-usd`.
    pub max_budget_usd_per_session: Option<f64>,
    /// Allow workers to message each other directly instead of through Central.
    pub allow_direct_worker_messages: bool,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            central_model: None,
            worker_model: None,
            max_parallel_workers: 3,
            use_worktrees: true,
            inherit_user_settings: false,
            default_worker_permissions: PermissionSet::worker_default(),
            max_worker_permissions: PermissionSet::worker_ceiling(),
            max_budget_usd_per_session: None,
            allow_direct_worker_messages: false,
        }
    }
}

// ---------------------------------------------------------------- agents

pub const CENTRAL_ID: &str = "central";
pub const USER_ID: &str = "user";
pub const SYSTEM_ID: &str = "system";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Central,
    Worker,
}

/// Real state of the agent's Claude Code session. Never set optimistically:
/// it is derived from the process and its stream-json output.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    /// No session process.
    Offline,
    /// Process spawned, waiting for the `system/init` message.
    Starting,
    /// A turn is in progress.
    Working,
    /// Session alive and idle, waiting for input.
    Waiting,
    /// A tool call is blocked on a user permission decision.
    AwaitingPermission,
    /// Stopped on purpose.
    Stopped,
    /// Process exited unexpectedly.
    Crashed,
    /// Was running when the app last closed; no live process now.
    Disconnected,
    /// Retired by Central; kept for history.
    Retired,
}

impl AgentStatus {
    pub fn is_live(self) -> bool {
        matches!(
            self,
            AgentStatus::Starting | AgentStatus::Working | AgentStatus::Waiting | AgentStatus::AwaitingPermission
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Isolation {
    /// Works directly in the project folder.
    Shared,
    /// Works in its own git worktree on branch `agent/<id>`.
    Worktree,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub kind: AgentKind,
    pub role: String,
    pub instructions: String,
    pub status: AgentStatus,
    pub model: Option<String>,
    pub permissions: PermissionSet,
    /// Ids of project connections this agent may use.
    pub connections: Vec<String>,
    pub isolation: Isolation,
    /// Working directory of the session (project root or worktree path).
    pub workdir: String,
    pub branch: Option<String>,
    pub current_task: Option<String>,
    pub current_action: Option<String>,
    pub progress: Option<u8>,
    /// Claude Code session id, used to resume after a restart.
    pub claude_session_id: Option<String>,
    pub total_cost_usd: f64,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------- tasks

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Queued,
    InProgress,
    Waiting,
    Blocked,
    Review,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::Queued => "queued",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Waiting => "waiting",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Review => "review",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => TaskStatus::Pending,
            "queued" => TaskStatus::Queued,
            "in_progress" => TaskStatus::InProgress,
            "waiting" => TaskStatus::Waiting,
            "blocked" => TaskStatus::Blocked,
            "review" => TaskStatus::Review,
            "completed" => TaskStatus::Completed,
            "failed" => TaskStatus::Failed,
            "cancelled" => TaskStatus::Cancelled,
            _ => return None,
        })
    }
    pub fn is_terminal(self) -> bool {
        matches!(self, TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    Normal,
    High,
    Critical,
}

impl Priority {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "low" => Priority::Low,
            "normal" | "medium" => Priority::Normal,
            "high" => Priority::High,
            "critical" | "urgent" => Priority::Critical,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskResult {
    pub summary: String,
    pub files_changed: Vec<String>,
    pub tests: Option<String>,
    pub issues: Option<String>,
    /// Commit created on the agent branch when the task was completed (worktree agents).
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub mission_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub priority: Priority,
    pub agent: Option<String>,
    pub dependencies: Vec<String>,
    pub requires_review: bool,
    pub progress: Option<u8>,
    pub status_reason: Option<String>,
    pub result: Option<TaskResult>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

// ---------------------------------------------------------------- missions

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MissionStatus {
    Planning,
    Active,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub status: MissionStatus,
    pub summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// Mission with task counters, computed from the task table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionView {
    #[serde(flatten)]
    pub mission: Mission,
    pub task_total: u32,
    pub task_done: u32,
    pub task_failed: u32,
}

// ---------------------------------------------------------------- messages

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// Agent asks for something (work, info, a decision).
    Request,
    /// Answer to a request.
    Response,
    /// Informational note.
    Info,
    /// Generated by the orchestrator (task finished, permission denied, ...).
    System,
    /// Written by the human user.
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: MessageKind,
    pub subject: Option<String>,
    pub body: String,
    pub task_id: Option<String>,
    pub mission_id: Option<String>,
    pub created_at: String,
    /// When the text was actually written to the recipient's session stdin.
    pub delivered_at: Option<String>,
}

// ---------------------------------------------------------------- sessions

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: i64,
    pub agent_id: String,
    pub claude_session_id: Option<String>,
    pub pid: Option<u32>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    /// `running`, `stopped`, `crashed`, `abandoned`.
    pub state: String,
    pub cost_usd: f64,
}

// ---------------------------------------------------------------- permissions

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Reject,
    AllowOnce,
    AllowAlways,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub agent_id: String,
    pub tool_name: String,
    pub capability: String,
    /// Short human description (`Bash: rm -rf build`).
    pub summary: String,
    pub input: Value,
    pub reason: String,
    /// Key persisted when the user picks "allow for this agent".
    pub rule_key: String,
    pub created_at: String,
}

// ---------------------------------------------------------------- connections

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionKind {
    Local,
    Git,
    Github,
    Ssh,
    Mcp,
    RobloxStudio,
    Docker,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Unknown,
    Connected,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub kind: ConnectionKind,
    /// Kind-specific, non-secret configuration.
    pub config: Value,
    /// Key of a secret stored in Windows Credential Manager (never the secret itself).
    pub credential_ref: Option<String>,
    pub status: ConnectionStatus,
    pub status_detail: Option<String>,
    pub last_checked: Option<String>,
    pub created_at: String,
}

// ---------------------------------------------------------------- environment

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub key: String,
    pub label: String,
    pub detected: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentReport {
    /// Markers found in the project folder.
    pub project: Vec<Detection>,
    /// Tools found on this machine.
    pub tools: Vec<Detection>,
    pub project_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: Option<bool>,
    pub auth_method: Option<String>,
    pub subscription: Option<String>,
    pub error: Option<String>,
}
