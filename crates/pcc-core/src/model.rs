//! Domain entities. All are serialized in camelCase for the UI and on disk.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use std::collections::BTreeMap;

use crate::permissions::{Capability, PermissionSet, PowerLevel};

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
    /// NEXUS version that created the project.
    #[serde(default)]
    pub created_with: Option<String>,
    /// NEXUS version that last opened it.
    #[serde(default)]
    pub last_opened_with: Option<String>,
    /// Oldest NEXUS version able to open it.
    #[serde(default)]
    pub minimum_nexus_version: Option<String>,
    /// Fields written by other NEXUS versions, preserved on rewrite.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
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
    /// CLAUDE UNLOCKED and auto-approval rules.
    pub autonomy: AutonomySettings,
    /// Periodic project analysis and improvement missions.
    pub improvement: ImprovementSettings,
    /// Non-secret environment variables given to every agent session.
    pub session_env: BTreeMap<String, String>,
    /// Default reasoning effort for new agents (`--effort`), `None` = Claude Code default.
    pub default_effort: Option<String>,
    /// Skills (slash commands) enabled for new agents.
    pub default_skills_enabled: bool,
    /// Restart sessions that were running when the app closed without asking.
    pub auto_recover: bool,
    /// NEXUS MASTER CONTROL: Central may use every enabled connection and
    /// manage connections, MCP and grants without asking, within the scopes.
    pub master_control: MasterControl,
    /// Deepest level of the agent pyramid below Central (1 = flat, 1..=5).
    pub max_hierarchy_depth: u32,
    /// Idle minutes before an agent's session is stopped (sleeping); 0 = never.
    pub sleep_after_minutes: u32,
    /// Minutes a permission request waits for the user before it expires
    /// (the agent then receives a refusal); 0 = never.
    pub permission_timeout_minutes: u32,
    /// AI engines: Claude, local runtime or hybrid, for Central, workers and NEXUS's own AI work.
    pub ai: crate::ai::AiEngineSettings,
    /// Interface language override for this project: "auto" (use the app setting) or a locale
    /// ("fr", "en").
    pub ui_language: String,
    /// AI World language override for this project, same values as `ui_language`.
    pub ai_world_language: String,
    /// Settings → Missions → Recovery: what NEXUS does by itself after a crash or restart.
    pub mission_recovery: MissionRecoverySettings,
    /// Settings written by other NEXUS versions, preserved on rewrite.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Domains MASTER CONTROL may open to Central. Nothing here bypasses Claude
/// Code, the OS or external services: it only groups permissions NEXUS grants.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MasterControl {
    pub active: bool,
    pub pc: bool,
    pub github: bool,
    pub mcp: bool,
    pub ssh: bool,
    pub skills: bool,
    /// Central may create connections, add MCP servers and grant them without a prompt.
    pub manage_connections: bool,
}

impl Default for MasterControl {
    fn default() -> Self {
        Self { active: false, pc: true, github: true, mcp: true, ssh: true, skills: true, manage_connections: true }
    }
}

/// Maximum-autonomy mode. NEXUS never bypasses Claude Code's own safety: it
/// answers Claude Code's permission prompts on the user's behalf according to
/// these rules, and journals every decision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AutonomySettings {
    /// Every agent's effective permissions become `unlocked_permissions`.
    pub unlocked: bool,
    pub unlocked_permissions: PermissionSet,
    /// Answer "ask" decisions automatically (journaled as auto-approved).
    pub auto_approve: bool,
    /// Keep asking the user for destructive commands even with auto-approve.
    pub manual_for_destructive: bool,
    /// Keep asking for paths outside the agent's workspace.
    pub manual_for_outside_workspace: bool,
    /// Capabilities that always stay manual.
    pub manual_capabilities: Vec<Capability>,
}

impl Default for AutonomySettings {
    fn default() -> Self {
        Self {
            unlocked: false,
            unlocked_permissions: PermissionSet::preset(PowerLevel::Maximum),
            auto_approve: false,
            manual_for_destructive: true,
            manual_for_outside_workspace: true,
            manual_capabilities: vec![Capability::GithubAdmin],
        }
    }
}

/// Recovery behaviour after a crash or restart (Settings → Missions → Recovery).
/// Every switch defaults to on; projects written before 0.5 read the defaults.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MissionRecoverySettings {
    /// After a crash or restart, run the recovery scan and resume running missions
    /// without asking (the interrupted-mission dialog becomes a notice).
    pub auto_resume_missions: bool,
    /// Reconnect MCP servers Claude Code reports as failed, and check a server as
    /// soon as one of its tools fails.
    pub auto_reconnect_mcp: bool,
    /// Restart crashed agent sessions that were working (with `--resume`, backoff and a cap).
    pub auto_restart_agents: bool,
    /// Restore the AI World (AI Town) state of the project after a restart.
    pub restore_world: bool,
    /// Restore pending permission requests that can survive a restart.
    pub recover_permissions: bool,
    /// Check the files completed tasks reported against the disk before resuming.
    pub validate_files_before_resume: bool,
}

impl Default for MissionRecoverySettings {
    fn default() -> Self {
        Self {
            auto_resume_missions: true,
            auto_reconnect_mcp: true,
            auto_restart_agents: true,
            restore_world: true,
            recover_permissions: true,
            validate_files_before_resume: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImprovementMode {
    /// Central analyses and creates tasks that require review.
    Propose,
    /// Central plans and implements; merges still need approval.
    Implement,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ImprovementSettings {
    pub enabled: bool,
    pub interval_minutes: u32,
    pub mode: ImprovementMode,
    /// Focus areas, e.g. "bugs", "dead code", "tests", "documentation".
    pub focus: Vec<String>,
    pub max_runs_per_day: u32,
}

impl Default for ImprovementSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: 120,
            mode: ImprovementMode::Propose,
            focus: ["bugs", "dead code", "tests", "documentation", "conventions"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            max_runs_per_day: 4,
        }
    }
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
            autonomy: AutonomySettings::default(),
            improvement: ImprovementSettings::default(),
            session_env: BTreeMap::new(),
            default_effort: None,
            default_skills_enabled: true,
            auto_recover: false,
            master_control: MasterControl::default(),
            max_hierarchy_depth: 3,
            sleep_after_minutes: 20,
            permission_timeout_minutes: 30,
            ai: crate::ai::AiEngineSettings::default(),
            ui_language: "auto".into(),
            ai_world_language: "auto".into(),
            mission_recovery: MissionRecoverySettings::default(),
            extra: serde_json::Map::new(),
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
    /// Idle beyond the project's sleep delay: the session process was stopped
    /// to free resources and is resumed (`--resume`) on the next message or task.
    Sleeping,
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

/// Position of an agent in the delegation pyramid.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentRank {
    /// The Central agent, root of the hierarchy.
    Commander,
    /// May create specialists under itself and supervise them.
    Lieutenant,
    /// Does the work; cannot create agents.
    #[default]
    Specialist,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub kind: AgentKind,
    /// Agent provider (runtime adapter) id, e.g. `claude-code`.
    #[serde(default = "default_provider")]
    pub provider: String,
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
    /// Runtime profile: effort, skills, environment.
    #[serde(default)]
    pub profile: AgentProfile,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    // Fields below were added in 0.4; older agents read with their defaults
    // and are normalized by `normalize_hierarchy`.
    /// Supervising agent (`None` only for Central).
    #[serde(default)]
    pub parent_agent: Option<String>,
    #[serde(default)]
    pub rank: AgentRank,
    /// Paused by the user: nothing is delivered until resumed.
    #[serde(default)]
    pub paused_at: Option<String>,
}

impl Agent {
    /// Defaults for agents written before the hierarchy existed: Central is the
    /// commander without parent, workers without parent report to Central.
    pub fn normalize_hierarchy(&mut self) {
        match self.kind {
            AgentKind::Central => {
                self.rank = AgentRank::Commander;
                self.parent_agent = None;
            }
            AgentKind::Worker => {
                if self.rank == AgentRank::Commander {
                    self.rank = AgentRank::Specialist;
                }
                if self.parent_agent.as_deref().is_none_or(|p| p.is_empty() || p == self.id) {
                    self.parent_agent = Some(CENTRAL_ID.to_string());
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentProfile {
    /// Reasoning effort passed as `--effort` (low, medium, high, xhigh, max).
    pub effort: Option<String>,
    /// When false the session starts with `--disable-slash-commands` (no skills).
    pub skills_enabled: bool,
    /// Non-secret environment variables for this agent's session.
    pub env: BTreeMap<String, String>,
    /// How the agent's character looks in the AI World.
    pub appearance: AgentAppearance,
    /// Engine override for this agent (`None` = project default for its kind).
    pub engine: Option<crate::ai::EngineProvider>,
}

/// Character customization ("Customize Character"). The sprite is a whole
/// AI Town spritesheet: hair or clothes can only differ through another
/// spritesheet, so there are no separate hair/clothes fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentAppearance {
    /// AI Town character (`f1`..`f8`) or an imported `nexus-skin:<name>`.
    pub skin: Option<String>,
    /// Preset id the skin came from (`developer`, `robot`...), informational.
    pub preset: Option<String>,
    /// Name shown above the character instead of the agent name.
    pub display_name: Option<String>,
    /// Short badge shown next to the name (e.g. "QA", "★").
    pub badge: Option<String>,
    /// Tint applied to the sprite, `#rrggbb`.
    pub tint: Option<String>,
}

impl Default for AgentProfile {
    fn default() -> Self {
        Self {
            effort: None,
            skills_enabled: true,
            env: BTreeMap::new(),
            appearance: AgentAppearance::default(),
            engine: None,
        }
    }
}

/// The provider every agent used before providers existed, and the default.
pub const CLAUDE_CODE_PROVIDER: &str = "claude-code";

fn default_provider() -> String {
    CLAUDE_CODE_PROVIDER.to_string()
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
    /// Skills the worker is asked to invoke with the Skill tool (set by Central,
    /// usually from the mission's selection). Empty for tasks created before 0.3.
    #[serde(default)]
    pub skills: Vec<String>,
}

// ---------------------------------------------------------------- missions

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MissionStatus {
    /// Waiting for the running mission to finish (Central has not received it yet).
    Queued,
    Planning,
    Active,
    Completed,
    Failed,
    Cancelled,
}

impl MissionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MissionStatus::Queued => "queued",
            MissionStatus::Planning => "planning",
            MissionStatus::Active => "active",
            MissionStatus::Completed => "completed",
            MissionStatus::Failed => "failed",
            MissionStatus::Cancelled => "cancelled",
        }
    }
    /// Central is working on it.
    pub fn is_running(self) -> bool {
        matches!(self, MissionStatus::Planning | MissionStatus::Active)
    }
    pub fn is_closed(self) -> bool {
        matches!(self, MissionStatus::Completed | MissionStatus::Failed | MissionStatus::Cancelled)
    }
}

fn normal_priority() -> Priority {
    Priority::Normal
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub id: String,
    pub title: String,
    /// The objective, as written by the user.
    pub prompt: String,
    pub status: MissionStatus,
    pub summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    // Fields below were added in 0.3; older missions read with their defaults.
    /// Orders the queue (higher first, then oldest first).
    #[serde(default = "normal_priority")]
    pub priority: Priority,
    /// Model the user wants for the workers of this mission (told to Central).
    #[serde(default)]
    pub model: Option<String>,
    /// Skills selected by the user; Central is asked to invoke them with the Skill tool.
    #[serde(default)]
    pub skills: Vec<String>,
    /// MCP servers selected by the user (names as Claude Code reports them).
    #[serde(default)]
    pub mcp: Vec<String>,
    /// Project connection ids selected by the user.
    #[serde(default)]
    pub connections: Vec<String>,
    /// Pre-mission analysis (an estimate made by one Claude call), if one was run.
    #[serde(default)]
    pub analysis: Option<MissionAnalysis>,
    /// When the mission was handed to Central.
    #[serde(default)]
    pub started_at: Option<String>,
    /// Hidden from the main lists; recoverable.
    #[serde(default)]
    pub archived_at: Option<String>,
}

/// What a mission probably needs, estimated by Claude from the objective and the
/// real project context. Availability flags are computed by NEXUS, not by Claude.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MissionAnalysis {
    pub title: String,
    pub summary: String,
    pub agents: Vec<RequiredAgent>,
    pub skills: Vec<Requirement>,
    pub mcp: Vec<Requirement>,
    pub connections: Vec<Requirement>,
    pub model: Option<String>,
    pub model_reason: Option<String>,
    pub steps: Vec<String>,
    pub estimated_steps: u32,
    /// Model that produced the estimate.
    pub analyzed_with: String,
    pub analyzed_at: String,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RequiredAgent {
    pub role: String,
    pub reason: String,
    /// Id of an existing agent whose role fits, when Claude named a real one.
    pub existing: Option<String>,
}

/// One required skill, MCP server or connection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Requirement {
    /// Exact name (skill `plugin:name`, MCP server name, connection id) when it
    /// matches something real, otherwise what Claude suggested.
    pub name: String,
    pub reason: String,
    /// Exists in this environment (installed skill, configured server, project connection).
    pub available: bool,
    /// Exists but is disabled / not connected.
    pub detail: Option<String>,
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
    Gitlab,
    Ssh,
    Sftp,
    Terminal,
    Http,
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
    /// Disabled connections are never given to agents.
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// Last time an agent was allowed to use it.
    #[serde(default)]
    pub last_used: Option<String>,
}

fn enabled_by_default() -> bool {
    true
}

/// One command run by an agent or the user, kept for the command journal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRecord {
    pub id: i64,
    pub agent_id: String,
    /// `agent` (Bash/PowerShell tool), `user` (NEXUS UI) or `interpreter`.
    pub source: String,
    pub tool_use_id: Option<String>,
    pub raw: String,
    pub program: Option<String>,
    /// Parsed command (interpreter output) as JSON.
    pub parsed: Value,
    /// Connection, host or repository the command targets, when known.
    pub target: Option<String>,
    pub capability: Option<String>,
    /// Permission decision that let it run.
    pub decision: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// Only set when the tool reported it ("Exit code N"); `None` otherwise.
    pub exit_code: Option<i32>,
    pub is_error: Option<bool>,
    /// Output (truncated, secrets redacted).
    pub output: Option<String>,
}

/// One permission decision, kept for the audit journal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRecord {
    pub id: i64,
    pub ts: String,
    pub agent_id: String,
    pub tool_name: String,
    pub capability: Option<String>,
    pub summary: String,
    /// `allowed`, `denied`, `asked`, `auto_approved`, `user_allowed`, `user_rejected`.
    pub decision: String,
    /// `policy`, `rule`, `autonomy` or `user`.
    pub actor: String,
    pub reason: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_from_0_3_get_hierarchy_defaults() {
        let old = r#"{"id":"builder","name":"Builder","kind":"worker","role":"r","instructions":"","status":"offline",
            "model":null,"permissions":{},"connections":[],"isolation":"shared","workdir":".","branch":null,
            "currentTask":null,"currentAction":null,"progress":null,"claudeSessionId":null,"totalCostUsd":0,
            "createdBy":"central","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}"#;
        let mut a: Agent = serde_json::from_str(old).unwrap();
        assert_eq!((a.parent_agent.as_deref(), a.rank, a.paused_at.as_deref()), (None, AgentRank::Specialist, None));
        a.normalize_hierarchy();
        assert_eq!(a.parent_agent.as_deref(), Some(CENTRAL_ID));
        let json = serde_json::to_value(&a).unwrap();
        assert_eq!(json["parentAgent"], "central");
        assert_eq!(json["rank"], "specialist");
        let s: ProjectSettings = serde_json::from_str("{}").unwrap();
        assert_eq!((s.max_hierarchy_depth, s.sleep_after_minutes), (3, 20));
    }
}
