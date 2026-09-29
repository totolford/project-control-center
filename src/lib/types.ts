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

export type ConnectionKind = "local" | "git" | "github" | "ssh" | "mcp" | "roblox_studio" | "docker";
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
}

export interface AgentSpec {
  id?: string;
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
}

export interface AppInfo {
  version: string;
  dataDir: string;
  logDir: string;
}
