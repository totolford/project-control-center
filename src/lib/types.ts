// Types mirrored from the Rust crates (serde camelCase). Keep in sync with
// crates/pcc-core/src/model.rs and src-tauri/src/commands.rs.

export type Capability =
  | "fs_read"
  | "fs_write"
  | "fs_execute"
  | "network"
  | "git_read"
  | "git_write"
  | "github_read"
  | "github_write"
  | "github_admin"
  | "ssh_read"
  | "ssh_execute"
  | "mcp";

export type Access = "deny" | "ask" | "allow";
export type PermissionSet = Record<Capability, Access>;

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  formatVersion: number;
}

export interface ProjectSettings {
  centralModel: string | null;
  workerModel: string | null;
  maxParallelWorkers: number;
  useWorktrees: boolean;
  inheritUserSettings: boolean;
  defaultWorkerPermissions: PermissionSet;
  maxWorkerPermissions: PermissionSet;
  maxBudgetUsdPerSession: number | null;
  allowDirectWorkerMessages: boolean;
  autonomy: AutonomySettings;
  improvement: ImprovementSettings;
  /** Non-secret environment variables of every agent session. */
  sessionEnv: Record<string, string>;
  defaultEffort: string | null;
  defaultSkillsEnabled: boolean;
  autoRecover: boolean;
}

export type AgentKind = "central" | "worker";
export type AgentStatus =
  | "offline"
  | "starting"
  | "working"
  | "waiting"
  | "awaiting_permission"
  | "stopped"
  | "crashed"
  | "disconnected"
  | "retired";
export type Isolation = "shared" | "worktree";

export interface Agent {
  id: string;
  name: string;
  kind: AgentKind;
  /** Provider (runtime adapter) id, e.g. "claude-code". */
  provider: string;
  role: string;
  instructions: string;
  status: AgentStatus;
  model: string | null;
  permissions: PermissionSet;
  connections: string[];
  isolation: Isolation;
  workdir: string;
  branch: string | null;
  currentTask: string | null;
  currentAction: string | null;
  progress: number | null;
  claudeSessionId: string | null;
  totalCostUsd: number;
  profile: AgentProfile;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | "pending"
  | "queued"
  | "in_progress"
  | "waiting"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";
export type Priority = "low" | "normal" | "high" | "critical";

export interface TaskResult {
  summary: string;
  filesChanged: string[];
  tests: string | null;
  issues: string | null;
  commit: string | null;
}

export interface Task {
  id: string;
  missionId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  agent: string | null;
  dependencies: string[];
  requiresReview: boolean;
  progress: number | null;
  statusReason: string | null;
  result: TaskResult | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type MissionStatus = "planning" | "active" | "completed" | "failed" | "cancelled";

export interface Mission {
  id: string;
  title: string;
  prompt: string;
  status: MissionStatus;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  // Counters computed from tasks (MissionView).
  taskTotal: number;
  taskDone: number;
  taskFailed: number;
}

export type MessageKind = "request" | "response" | "info" | "system" | "user";

export interface Message {
  id: string;
  from: string;
  to: string;
  kind: MessageKind;
  subject: string | null;
  body: string;
  taskId: string | null;
  missionId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface SessionRecord {
  id: number;
  agentId: string;
  claudeSessionId: string | null;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  state: string;
  costUsd: number;
}

export type PermissionDecision = "reject" | "allow_once" | "allow_always";

export interface PermissionRequest {
  id: string;
  agentId: string;
  toolName: string;
  capability: string;
  summary: string;
  input: unknown;
  reason: string;
  ruleKey: string;
  createdAt: string;
}

export type ConnectionKind =
  | "local"
  | "git"
  | "github"
  | "gitlab"
  | "ssh"
  | "sftp"
  | "terminal"
  | "http"
  | "mcp"
  | "roblox_studio"
  | "docker";
export type ConnectionStatus = "unknown" | "connected" | "disconnected" | "error";

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  config: Record<string, unknown>;
  credentialRef: string | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  lastChecked: string | null;
  createdAt: string;
  /** Disabled connections are never given to agents. */
  enabled: boolean;
  lastUsed: string | null;
}

export interface SshConfig {
  host: string;
  port?: number | null;
  user: string;
  keyPath?: string | null;
  auth: "key" | "agent" | "password";
}

export interface McpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  secretEnv: string[];
}

export interface McpCandidate {
  name: string;
  source: string;
  config: McpConfig;
}

export interface RobloxDetection {
  studioInstalled: boolean;
  studioPath: string | null;
  studioRunning: boolean;
  mcpCandidates: McpCandidate[];
}

export interface Detection {
  key: string;
  label: string;
  detected: boolean;
  detail: string | null;
}

export interface EnvironmentReport {
  project: Detection[];
  tools: Detection[];
  projectTypes: string[];
}

export interface ClaudeInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  subscription: string | null;
  error: string | null;
}

export type EventKind =
  | "ProjectOpened"
  | "ProjectChanged"
  | "AgentCreated"
  | "AgentUpdated"
  | "AgentStarted"
  | "AgentStopped"
  | "AgentCrashed"
  | "AgentMessage"
  | "TaskCreated"
  | "TaskUpdated"
  | "TaskCompleted"
  | "TaskFailed"
  | "MissionCreated"
  | "MissionUpdated"
  | "MissionCompleted"
  | "PermissionRequested"
  | "PermissionResolved"
  | "ReviewRequested"
  | "ConnectionChanged"
  | "MemoryUpdated"
  | "GitChanged"
  | "PermissionAutoApproved"
  | "ToolUsed"
  | "EmergencyStop"
  | "ImprovementCycle"
  | "McpChanged"
  | "SkillChanged"
  | "Error";

/**
 * Real-time event. `payload` holds the affected entity for:
 * Agent* -> Agent, Task* -> Task, Mission* -> Mission (with counters),
 * AgentMessage -> Message, PermissionRequested -> PermissionRequest,
 * PermissionResolved -> { id: string, decision: PermissionDecision },
 * ConnectionChanged -> Connection | { id: string, deleted: true },
 * MemoryUpdated -> { key: string }, ProjectChanged -> { settings?: ProjectSettings }.
 */
export interface PccEvent {
  id: number;
  ts: string;
  kind: EventKind;
  agentId: string | null;
  taskId: string | null;
  missionId: string | null;
  summary: string;
  payload: any;
}

export type LogKind =
  | "input"
  | "assistant_text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system"
  | "result"
  | "stderr"
  | "error";

export interface LogEntry {
  id: number;
  agentId: string;
  sessionId: number;
  ts: string;
  kind: LogKind;
  text: string;
}

export interface MemoryFile {
  /** "project" | "architecture" | "decisions" | "conventions" | "discoveries" | "agent:<id>" */
  key: string;
  path: string;
  content: string;
  bytes: number;
  modified: string | null;
}

export interface RepoStatus {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  hasCommits: boolean;
  dirtyFiles: string[];
  remoteUrl: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface FileChange {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface BranchDiff {
  base: string;
  branch: string;
  commitsAhead: number;
  commitsBehind: number;
  files: FileChange[];
  uncommitted: string[];
  conflicts: string[];
  mergeable: boolean;
}

export interface Commit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface Snapshot {
  branch: string;
  commit: string;
  createdAt: string;
  label: string;
}

export interface MergeOutcome {
  merged: boolean;
  commit: string | null;
  conflicts: string[];
  snapshot: Snapshot | null;
  message: string;
}

export interface GitOverview {
  status: RepoStatus;
  /** Agent worktrees/branches with their diff against the base branch. */
  agents: { agentId: string; branch: string; workdir: string; diff: BranchDiff | null; error: string | null }[];
  recentCommits: Commit[];
  snapshots: Snapshot[];
}

export interface GithubStatus {
  cliInstalled: boolean;
  authenticated: boolean;
  account: string | null;
  repo: string | null;
  detail: string | null;
}

export interface GithubOverview {
  repo: string;
  description: string | null;
  defaultBranch: string | null;
  visibility: string | null;
  url: string | null;
  pullRequests: any[];
  issues: any[];
  branches: string[];
}

export interface RecentProject {
  name: string;
  root: string;
  lastOpened: string;
  available: boolean;
}

/** Sessions that were running when the app last closed. */
export interface RecoveryInfo {
  agents: { agentId: string; name: string; claudeSessionId: string | null; taskId: string | null }[];
}

/** Everything the main window needs after opening a project. */
export interface ProjectSnapshot {
  info: ProjectInfo;
  settings: ProjectSettings;
  agents: Agent[];
  tasks: Task[];
  missions: Mission[];
  connections: Connection[];
  pendingPermissions: PermissionRequest[];
  repo: RepoStatus | null;
  recovery: RecoveryInfo | null;
  /** Emergency stop active: new work and autonomy are blocked until released. */
  emergency: boolean;
}

export interface AgentSpec {
  id?: string;
  /** Provider id from listAgentProviders(); only `available` providers are accepted. Defaults to "claude-code". */
  provider?: string;
  name: string;
  role: string;
  instructions?: string;
  permissions?: Partial<PermissionSet>;
  connections?: string[];
  isolation?: "auto" | Isolation;
  model?: string | null;
}

export interface AgentPatch {
  name?: string;
  role?: string;
  instructions?: string;
  permissions?: PermissionSet;
  connections?: string[];
  model?: string | null;
  profile?: AgentProfile;
}

export interface TaskSpec {
  title: string;
  description?: string;
  agent?: string | null;
  dependencies?: string[];
  priority?: Priority;
  requiresReview?: boolean;
  missionId?: string | null;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  agent?: string | null;
  priority?: Priority;
  status?: TaskStatus;
  requiresReview?: boolean;
}

export interface ConnectionInput {
  name: string;
  kind: ConnectionKind;
  config: Record<string, unknown>;
  /** Secret values to store in Windows Credential Manager (never written to the project). */
  secrets?: Record<string, string>;
  /** Omit to keep the current state (new connections are enabled). Disabled connections are never given to agents. */
  enabled?: boolean;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  logDir: string;
}

/** A runtime an agent can run on. Only `available` ones can be selected. */
export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  /** An adapter exists and the runtime is installed. */
  available: boolean;
  /** The runtime was found on this machine (may still lack an adapter). */
  installed: boolean;
  detail: string;
}

// ======================================================================
// Claude Control Center (see src-tauri/src/control_commands.rs)
// ======================================================================

export type PowerLevel = "low" | "normal" | "high" | "maximum";
export type ImprovementMode = "propose" | "implement";

/** CLAUDE UNLOCKED: NEXUS answers Claude Code's permission prompts per these rules; nothing is bypassed. */
export interface AutonomySettings {
  unlocked: boolean;
  /** Effective permissions of EVERY agent while unlocked. */
  unlockedPermissions: PermissionSet;
  autoApprove: boolean;
  manualForDestructive: boolean;
  manualForOutsideWorkspace: boolean;
  /** Capabilities that always stay manual even with auto-approve. */
  manualCapabilities: Capability[];
}

export interface ImprovementSettings {
  enabled: boolean;
  intervalMinutes: number;
  mode: ImprovementMode;
  focus: string[];
  maxRunsPerDay: number;
}

export interface AgentProfile {
  /** --effort: "low" | "medium" | "high" | "xhigh" | "max"; null = Claude Code default. */
  effort: string | null;
  /** false → session starts with --disable-slash-commands (no skills). */
  skillsEnabled: boolean;
  /** Non-secret environment variables of the agent's session. */
  env: Record<string, string>;
}

export interface DecisionRecord {
  id: number;
  ts: string;
  agentId: string;
  toolName: string;
  capability: string | null;
  summary: string;
  /** allowed | denied | asked | auto_approved | user_allowed | user_rejected */
  decision: string;
  /** policy | autonomy | user */
  actor: string;
  reason: string | null;
}

/** Everything below is passed through from Claude Code; unknown fields may appear. Never invent missing ones. */
export interface ClaudeEnvironment {
  cli: ClaudeInfo;
  capturedAt: string;
  /** e.g. { value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels, supportsFastMode, ... } */
  models: Record<string, any>[];
  /** Slash commands and skills: { name, description, argumentHint? } */
  commands: Record<string, any>[];
  agents: Record<string, any>[];
  /** { email, organization, subscriptionType, apiProvider } */
  account: Record<string, any> | null;
  permissionMode: string | null;
  outputStyle: string | null;
  outputStyles: any[];
  fastMode: Record<string, any>;
  /**
   * { name, status: "connected"|"failed"|"pending"|"disabled"|..., error?, config: { type, command?, args?, env?, url?, headers? }, scope, source }
   * env/headers values are redacted ("••••••"); pass the config unchanged to testMcpConfig/importClaudeMcp, the backend restores them.
   */
  mcpServers: Record<string, any>[];
  /** get_context_usage: { categories: [{ name, tokens, kind }], totalTokens, maxTokens, percentage, ... } */
  context: Record<string, any> | null;
  /** get_usage: { session: { total_cost_usd, model_usage, ... }, subscription_type, rate_limits: { five_hour: { utilization, resets_at }, seven_day: {...}, ... } } */
  usage: Record<string, any> | null;
  /** get_settings with env values replaced by "••••••": { effective: {...}, ... } */
  settings: Record<string, any> | null;
  /** claude plugin list --json: { id, version, scope, enabled, installPath, ... } */
  plugins: Record<string, any>[];
  /** Sections Claude Code did not answer, with the reason. Show them as "Unavailable". */
  unavailable: string[];
}

export interface CliOption {
  flags: string;
  long: string | null;
  short: string | null;
  value: string | null;
  description: string;
  choices: string[];
  default: string | null;
  category: string;
}

export interface CliCommand {
  path: string[];
  aliases: string[];
  usage: string;
  signature: string;
  description: string;
  arguments: { name: string; description: string }[];
  options: CliOption[];
  subcommands: CliCommand[];
  category: string;
}

export interface CliRun {
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface McpItem {
  name: string;
  description: string | null;
}

export interface McpProbe {
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  tools: McpItem[];
  /** null = the server does not implement resources */
  resources: McpItem[] | null;
  prompts: McpItem[] | null;
  latencyMs: number;
  stderrTail: string[];
}

export type SkillScope = "user" | "project" | "plugin";

export interface Skill {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  /** plugin id for plugin skills, "synced" for claude.ai synced skills */
  source: string | null;
  enabled: boolean;
  /** user/project skills only (plugin and synced skills are read-only) */
  editable: boolean;
  dir: string;
  frontmatter: Record<string, string>;
  allowedTools: string[];
  files: string[];
  problems: string[];
}

export interface NewSkill {
  name: string;
  description: string;
  trigger: string;
  instructions: string;
  allowedTools: string[];
  argumentHint: string;
  requiredMcp: string[];
  requiredConnections: string[];
  requiredPermissions: string[];
  dependencies: string[];
}

export interface SkillTest {
  discovered: boolean;
  problems: string[];
  commandName: string | null;
}

export interface SystemReport {
  os: string;
  osVersion: string;
  arch: string;
  cpu: string;
  cpuCores: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  gpus: string[];
  disks: { mount: string; totalBytes: number; availableBytes: number }[];
}

export interface ProjectInsights {
  languages: { language: string; files: number }[];
  frameworks: string[];
  dependencies: Record<string, string[]>;
  filesScanned: number;
}

export interface AppSettings {
  /** Explicit Claude Code executable; auto-detected when null/empty. */
  claudePath: string | null;
}

export type TerminalProfile = "claude" | "claude-resume" | "powershell" | "pwsh" | "cmd" | "wsl";

export interface PtyInfo {
  id: string;
  title: string;
  program: string;
  args: string[];
  cwd: string;
  pid: number | null;
  startedAt: string;
  exitCode: number | null;
  running: boolean;
}

export type PtyEvent = { type: "data"; id: string; data: string } | { type: "exit"; id: string; code: number | null };

/** MCP connection config (kind "mcp" / "roblox_studio"). */
export interface McpConnectionConfig {
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string[];
  env: Record<string, string>;
  /** names whose values are in Windows Credential Manager (pass values in ConnectionInput.secrets) */
  secretEnv: string[];
  url: string;
  headers: Record<string, string>;
  secretHeaders: string[];
}
