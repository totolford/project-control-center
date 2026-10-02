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
  createdWith: string | null;
  lastOpenedWith: string | null;
  minimumNexusVersion: string | null;
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
  /** NEXUS MASTER CONTROL (Central only). */
  masterControl: MasterControl;
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
  | "UserRequested"
  | "UserRequestResolved"
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
  /** Agents waiting for the user. */
  userRequests: UserRequest[];
  compatibility: CompatibilityReport | null;
  /** Compatibility mode: the project needs a newer NEXUS; every change is refused. */
  readOnly: boolean;
  /** Migration performed while opening (show its report once). */
  migration: MigrationReport | null;
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

// ======================================================================
// 0.2: compatibility, interpreter, autonomy, GitHub, MASTER CONTROL, AI World
// ======================================================================

export type CompatStatus = "compatible" | "migration_available" | "newer_format" | "requires_newer_nexus";

export interface MigrationStep {
  from: number;
  to: number;
  title: string;
  description: string;
}

export interface CompatibilityReport {
  status: CompatStatus;
  projectFormat: number;
  supportedFormat: number;
  appVersion: string;
  createdWith: string | null;
  lastOpenedWith: string | null;
  minimumNexusVersion: string | null;
  databaseSchema: number | null;
  supportedDatabaseSchema: number;
  unknownFields: string[];
  plan: MigrationStep[];
  notes: string[];
  readOnly: boolean;
}

export interface BackupInfo {
  id: string;
  path: string;
  createdAt: string;
  formatVersion: number | null;
  reason: string;
}

export interface MigrationReport {
  fromFormat: number;
  toFormat: number;
  backup: BackupInfo;
  steps: string[];
  /** lines starting with "ok:" or "error:" */
  integrity: string[];
  ok: boolean;
  reportPath: string;
}

/** Interpreter output. Secret values (env/header) are NOT included in `intent` from agents' tools, but the UI's own interpretCommand returns them as typed: never display env/header values. */
export type Intent =
  | {
      type: "add_mcp";
      name: string;
      transport: string;
      scope: string | null;
      command: string | null;
      args: string[];
      url: string | null;
      env: [string, string][];
      headers: [string, string][];
    }
  | { type: "ssh"; user: string | null; host: string; port: number | null; keyPath: string | null; remoteCommand: string | null }
  | { type: "clone"; url: string; directory: string | null }
  | { type: "github_login" }
  | { type: "claude_cli"; args: string[] }
  | { type: "shell" };

export interface Interpretation {
  raw: string;
  program: string;
  tokens: string[];
  intent: Intent;
  summary: string;
  capability: Capability;
  destructive: boolean;
}

export interface AppliedCommand {
  connection: Connection | null;
  created: boolean;
  message: string;
}

export interface CommandRecord {
  id: number;
  agentId: string;
  /** agent | user | interpreter */
  source: string;
  toolUseId: string | null;
  raw: string;
  program: string | null;
  parsed: unknown;
  target: string | null;
  capability: string | null;
  /** allowed | auto_approved | denied | asked | user */
  decision: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Only when Claude Code reported it ("Exit code N"); otherwise null — use isError. */
  exitCode: number | null;
  isError: boolean | null;
  output: string | null;
}

export type UserRequestKind = "secret" | "ssh_key_setup" | "github_login" | "action";

/** An agent needs a human: a secret (typed into Credential Manager), an SSH key install, a GitHub sign-in, or another step. */
export interface UserRequest {
  id: string;
  agentId: string;
  kind: UserRequestKind;
  title: string;
  reason: string;
  connectionId: string | null;
  /** secret name, e.g. "password", "token", "API_KEY" */
  key: string | null;
  createdAt: string;
}

export interface SshKeySetup {
  keyPath: string;
  createdKey: boolean;
  /** Raw Terminal where the user types the remote password once. */
  terminal: PtyInfo;
}

export interface MasterControl {
  active: boolean;
  pc: boolean;
  github: boolean;
  mcp: boolean;
  ssh: boolean;
  skills: boolean;
  /** Central may create connections, add MCP servers and grant them without a prompt. */
  manageConnections: boolean;
}

export interface MasterDomain {
  key: "claude" | "pc" | "github" | "mcp" | "ssh" | "skills";
  label: string;
  enabled: boolean;
  /** really usable now (e.g. gh signed in, connections exist) */
  available: boolean;
  /** 0..1 share of the domain's capabilities Central effectively has */
  level: number;
  detail: string;
}

export interface MasterStatus {
  active: boolean;
  domains: MasterDomain[];
  centralPermissions: PermissionSet;
}

export interface GithubAbility {
  action: string;
  allowedByToken: boolean;
  requires: string;
}

export interface GithubAccount {
  login: string;
  name: string | null;
  url: string | null;
  scopes: string[];
  organizations: string[];
  gitProtocol: string | null;
  abilities: GithubAbility[];
}

/** gh JSON: { name, nameWithOwner, description, visibility, isPrivate, isFork, updatedAt, url, defaultBranchRef: { name }, primaryLanguage: { name } | null } */
export type GithubRepo = Record<string, any>;

export interface RepositoryDetail {
  repo: string;
  /** GitHub REST repo object */
  info: Record<string, any>;
  issues: Record<string, any>[];
  pullRequests: Record<string, any>[];
  /** { databaseId, name, status, conclusion, headBranch, event, createdAt, url } */
  runs: Record<string, any>[];
  /** { tagName, name, isLatest, isDraft, isPrerelease, publishedAt } */
  releases: Record<string, any>[];
  branches: string[];
  /** { sha, message, author, date, url } */
  commits: Record<string, any>[];
  unavailable: string[];
}

// ---------------------------------------------------------------- AI World

export type WorldMode = "simulation" | "hybrid" | "real_execution";
export type RoomKind = "workshop" | "review" | "meeting" | "lounge" | "server_room" | "security" | "gate" | "infirmary" | "library";

export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Character {
  id: string;
  name: string;
  /** linked NEXUS agent id (hybrid / real execution) */
  nexusAgent: string | null;
  personality: string;
  goals: string[];
  memory: string[];
  skills: string[];
  tools: string[];
  mcp: string[];
  model: string | null;
  autonomy: string;
  relationships: { with: string; kind: string }[];
  /** f1..f8 */
  sprite: string;
  x: number;
  y: number;
  room: string | null;
  targetRoom: string | null;
  /** real current action when linked */
  activity: string | null;
  /** simulated mood: simulation mode only, null for linked characters */
  mood: string | null;
  lastAction: string | null;
}

export interface Conversation {
  id: string;
  participants: string[];
  room: string | null;
  lines: { speaker: string; text: string; ts: string }[];
  /** "simulated" (generated by Claude) or "real" */
  origin: string;
  startedAt: string;
}

export interface WorldEvent {
  ts: string;
  character: string | null;
  text: string;
}

export interface WorldSettings {
  speed: number;
  llmConversations: boolean;
  conversationModel: string;
  maxConversationsPerHour: number;
  rules: string[];
  environment: string;
}

export interface World {
  format: number;
  name: string;
  description: string;
  /** nexus_native | ai_town_compatible | ai_town | custom */
  provider: string;
  mode: WorldMode;
  running: boolean;
  tick: number;
  width: number;
  height: number;
  rooms: Room[];
  characters: Character[];
  conversations: Conversation[];
  events: WorldEvent[];
  settings: WorldSettings;
  providerState: any;
  createdAt: string;
}

/**
 * Streamed on WORLD_CHANNEL every tick while running, and once after worldControl/worldSave
 * (so pauses and mode changes made anywhere reach every view).
 */
export interface WorldFrame {
  tick: number;
  running: boolean;
  mode: WorldMode;
  characters: Character[];
  /** Events since the previous frame (all of them, not only the last few). */
  events: WorldEvent[];
  /**
   * All conversations, only when they changed (otherwise null). Includes "real" conversations
   * built from NEXUS messages between linked agents (hybrid/real execution) and "simulated" ones
   * generated automatically when settings.llmConversations is on (capped by maxConversationsPerHour).
   */
  conversations: Conversation[] | null;
}

export interface WorldPrerequisite {
  name: string;
  met: boolean;
  detail: string;
  required: boolean;
}

export interface WorldProviderInfo {
  id: string;
  name: string;
  description: string;
  prerequisites: WorldPrerequisite[];
  ready: boolean;
}

export interface AgentSeed {
  id: string;
  name: string;
  role: string;
  isCentral: boolean;
  model: string | null;
  power: string | null;
  skillsEnabled: boolean;
  connections: string[];
  recentTasks: string[];
}

export interface WorldAnalysis {
  projectTypes: string[];
  agents: AgentSeed[];
  providers: WorldProviderInfo[];
  recommendedProvider: string;
  reason: string;
  existingWorld: boolean;
}

export interface WorldSpec {
  name: string;
  description: string;
  provider: "nexus_native" | "ai_town_compatible" | "ai_town" | "custom";
  mode: WorldMode;
  environment?: string | null;
  rules: string[];
  speed?: number | null;
  characters: Character[];
  /** AI Town fork / custom world folder */
  targetDir?: string | null;
  letCentralFinish: boolean;
  /** frontend, backend, database, llm, authentication, deployment */
  infrastructure: Record<string, string>;
}

export interface ConversionReport {
  world: World;
  steps: string[];
  warnings: string[];
  missionId: string | null;
  backup: BackupInfo | null;
}
