// Typed wrappers over the Tauri commands defined in src-tauri/src/commands.rs.
// Argument names are camelCase here; Tauri maps them to snake_case in Rust.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as T from "./types";

export const EVENT_CHANNEL = "pcc://event";
export const LOG_CHANNEL = "pcc://log";
export const PTY_CHANNEL = "pcc://pty";
export const WORLD_CHANNEL = "pcc://world";

export const api = {
  // ---------------------------------------------------------------- app
  appInfo: () => invoke<T.AppInfo>("app_info"),
  detectClaude: () => invoke<T.ClaudeInfo>("detect_claude"),
  recentProjects: () => invoke<T.RecentProject[]>("recent_projects"),
  forgetRecent: (root: string) => invoke<T.RecentProject[]>("forget_recent", { root }),
  /** Detects markers in any folder (before a project exists). */
  inspectFolder: (path: string) =>
    invoke<{ path: string; isProject: boolean; suggestedName: string; environment: T.EnvironmentReport }>(
      "inspect_folder",
      { path },
    ),

  // ---------------------------------------------------------------- project
  createProject: (path: string, name: string, initGit: boolean) =>
    invoke<T.ProjectSnapshot>("create_project", { path, name, initGit }),
  openProject: (path: string) => invoke<T.ProjectSnapshot>("open_project", { path }),
  closeProject: () => invoke<void>("close_project"),
  snapshot: () => invoke<T.ProjectSnapshot>("project_snapshot"),
  environment: () => invoke<T.EnvironmentReport>("project_environment"),
  saveSettings: (settings: T.ProjectSettings) => invoke<T.ProjectSettings>("save_settings", { settings }),
  /** Restart sessions that were running when the app closed (`--resume`). */
  recover: () => invoke<void>("recover_sessions"),
  discardRecovery: () => invoke<void>("discard_recovery"),

  // ---------------------------------------------------------------- missions
  createMission: (prompt: string, title?: string) => invoke<T.Mission>("create_mission", { prompt, title: title ?? null }),
  cancelMission: (id: string) => invoke<void>("cancel_mission", { id }),

  // ---------------------------------------------------------------- agents
  createAgent: (spec: T.AgentSpec) => invoke<T.Agent>("create_agent", { spec }),
  updateAgent: (id: string, patch: T.AgentPatch) => invoke<T.Agent>("update_agent", { id, patch }),
  startAgent: (id: string) => invoke<void>("start_agent", { id }),
  stopAgent: (id: string) => invoke<void>("stop_agent", { id }),
  restartAgent: (id: string) => invoke<void>("restart_agent", { id }),
  interruptAgent: (id: string) => invoke<void>("interrupt_agent", { id }),
  retireAgent: (id: string) => invoke<void>("retire_agent", { id }),
  stopAll: () => invoke<void>("stop_all_agents"),
  /** Message from the user to an agent (delivered to its real session). */
  sendMessage: (to: string, body: string) => invoke<T.Message>("send_user_message", { to, body }),
  agentLogs: (agentId: string, before: number | null, limit: number) =>
    invoke<T.LogEntry[]>("agent_logs", { agentId, before, limit }),
  agentSessions: (agentId: string) => invoke<T.SessionRecord[]>("agent_sessions", { agentId }),
  permissionRules: (agentId: string) => invoke<string[]>("permission_rules", { agentId }),
  removePermissionRule: (agentId: string, ruleKey: string) =>
    invoke<void>("remove_permission_rule", { agentId, ruleKey }),

  // ---------------------------------------------------------------- tasks
  createTask: (spec: T.TaskSpec) => invoke<T.Task>("create_task", { spec }),
  updateTask: (id: string, patch: T.TaskPatch) => invoke<T.Task>("update_task", { id, patch }),
  retryTask: (id: string) => invoke<T.Task>("retry_task", { id }),

  // ---------------------------------------------------------------- messages / events
  messages: (agentId: string | null, limit: number) => invoke<T.Message[]>("list_messages", { agentId, limit }),
  events: (filter: { agentId?: string; missionId?: string; taskId?: string; before?: number; limit?: number }) =>
    invoke<T.PccEvent[]>("list_events", { filter }),

  // ---------------------------------------------------------------- permissions
  resolvePermission: (id: string, decision: T.PermissionDecision) =>
    invoke<void>("resolve_permission", { id, decision }),

  // ---------------------------------------------------------------- memory
  memoryFiles: () => invoke<T.MemoryFile[]>("memory_files"),
  saveMemory: (key: string, content: string) => invoke<T.MemoryFile>("save_memory", { key, content }),
  /** Asks Central to consolidate memory files (real Central turn). */
  consolidateMemory: () => invoke<void>("consolidate_memory"),

  // ---------------------------------------------------------------- connections
  addConnection: (input: T.ConnectionInput) => invoke<T.Connection>("add_connection", { input }),
  updateConnection: (id: string, input: T.ConnectionInput) => invoke<T.Connection>("update_connection", { id, input }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  checkConnection: (id: string) => invoke<T.Connection>("check_connection", { id }),
  /** Names of secrets stored for a connection (never the values). */
  connectionSecretKeys: (id: string) => invoke<string[]>("connection_secret_keys", { id }),
  robloxDetect: () => invoke<T.RobloxDetection>("roblox_detect"),
  knownMcpServers: () => invoke<T.McpCandidate[]>("known_mcp_servers"),

  // ---------------------------------------------------------------- git / github
  gitOverview: () => invoke<T.GitOverview | null>("git_overview"),
  gitInit: () => invoke<T.RepoStatus>("git_init"),
  mergeAgent: (agentId: string) => invoke<T.MergeOutcome>("merge_agent_branch", { agentId }),
  commitAgentWork: (agentId: string, message: string) => invoke<string | null>("commit_agent_work", { agentId, message }),
  createSnapshot: (label: string) => invoke<T.Snapshot>("create_snapshot", { label }),
  restoreSnapshot: (branch: string) => invoke<T.Snapshot>("restore_snapshot", { branch }),
  githubStatus: () => invoke<T.GithubStatus>("github_status"),
  githubOverview: () => invoke<T.GithubOverview>("github_overview"),
  createPullRequest: (agentId: string, title: string, body: string) =>
    invoke<string>("create_pull_request", { agentId, title, body }),

  // ---------------------------------------------------------------- workspace / providers
  /** UI-owned layout JSON stored in .agent-project/settings/workspace.json (null if never saved). */
  loadWorkspace: () => invoke<unknown | null>("load_workspace"),
  saveWorkspace: (layout: object) => invoke<void>("save_workspace", { layout }),
  listAgentProviders: () => invoke<T.ProviderInfo[]>("list_agent_providers"),


  // ---------------------------------------------------------------- Claude Control Center
  appSettings: () => invoke<T.AppSettings>("app_settings"),
  saveAppSettings: (settings: T.AppSettings) => invoke<T.AppSettings>("save_app_settings", { settings }),
  /** Live snapshot of what Claude Code exposes (one short control session, no model call). Takes a few seconds. */
  claudeEnvironment: () => invoke<T.ClaudeEnvironment>("claude_environment"),
  /** CLI command tree parsed from the installed version's --help (cached per version). */
  claudeCommandTree: (refresh = false) => invoke<T.CliCommand>("claude_command_tree", { refresh }),
  /** Runs `claude <args>` without a terminal (interactive commands time out → use the Raw Terminal). */
  runClaudeCli: (args: string[]) => invoke<T.CliRun>("run_claude_cli", { args }),

  // MCP in Claude Code's own configuration
  /** config in Claude format ({type, command, args, env} or {type:"http", url, headers}); env/header values must be ${VAR} references. */
  claudeMcpAdd: (name: string, config: object, scope: "local" | "user" | "project") =>
    invoke<T.CliRun>("claude_mcp_add", { name, config, scope }),
  claudeMcpRemove: (name: string, scope: string) => invoke<T.CliRun>("claude_mcp_remove", { name, scope }),
  /** Persisted by Claude Code for this project. */
  claudeMcpSetEnabled: (name: string, enabled: boolean) => invoke<void>("claude_mcp_set_enabled", { name, enabled }),
  /** Tests a server given in Claude format (from ClaudeEnvironment.mcpServers[].config). */
  testMcpConfig: (config: object) => invoke<T.McpProbe>("test_mcp_config", { config }),
  /** Copies a Claude Code MCP server into NEXUS (values → Credential Manager). */
  importClaudeMcp: (name: string, config: object) => invoke<T.Connection>("import_claude_mcp", { name, config }),
  /** Detailed test of a NEXUS MCP/Roblox connection (tools, resources, prompts, latency). */
  probeConnection: (id: string) => invoke<T.McpProbe>("probe_connection", { id }),
  /** Asks every running agent session to reconnect a server; returns agent ids reached. */
  reconnectMcp: (server: string) => invoke<string[]>("reconnect_mcp", { server }),
  reloadPlugins: () => invoke<string[]>("reload_plugins"),
  claudePluginSetEnabled: (id: string, enabled: boolean) => invoke<T.CliRun>("claude_plugin_set_enabled", { id, enabled }),

  // Skills
  listSkills: () => invoke<T.Skill[]>("list_skills"),
  skillPreview: (spec: T.NewSkill) => invoke<string>("skill_preview", { spec }),
  skillCreate: (scope: "user" | "project", spec: T.NewSkill) => invoke<string>("skill_create", { scope, spec }),
  skillReadFile: (dir: string, file: string) => invoke<string>("skill_read_file", { dir, file }),
  /** Unified diff current SKILL.md → content. Show it before skillSave. */
  skillDiff: (dir: string, content: string) => invoke<string>("skill_diff", { dir, content }),
  skillSave: (dir: string, content: string) => invoke<void>("skill_save", { dir, content }),
  /** Returns the new folder (disabled skills live in skills-disabled/). */
  skillSetEnabled: (dir: string, enabled: boolean) => invoke<string>("skill_set_enabled", { dir, enabled }),
  skillDuplicate: (dir: string, name: string) => invoke<string>("skill_duplicate", { dir, name }),
  /** Moves the skill to skills-trash/ (recoverable). */
  skillDelete: (dir: string) => invoke<string>("skill_delete", { dir }),
  skillExport: (dir: string, destination: string) => invoke<string>("skill_export", { dir, destination }),
  skillTest: (dir: string) => invoke<T.SkillTest>("skill_test", { dir }),

  // Models, power, autonomy
  /** true = the running session switched immediately; false = applies at next start. */
  setAgentModel: (agentId: string, model: string | null) => invoke<boolean>("set_agent_model", { agentId, model }),
  applyPower: (agentId: string, level: T.PowerLevel) => invoke<T.Agent>("apply_power", { agentId, level }),
  emergencyStop: () => invoke<void>("emergency_stop"),
  releaseEmergency: () => invoke<void>("release_emergency"),
  revokeAllPermissions: () => invoke<void>("revoke_all_permissions"),
  /** Newest first. */
  listDecisions: (agentId: string | null, before: number | null, limit: number) =>
    invoke<T.DecisionRecord[]>("list_decisions", { agentId, before, limit }),
  startImprovementCycle: () => invoke<T.Mission>("start_improvement_cycle"),

  // Environment inspector
  systemReport: () => invoke<T.SystemReport>("system_report"),
  projectInsights: () => invoke<T.ProjectInsights>("project_insights"),

  // Raw Terminal (ConPTY). Output arrives on onPty(); answer terminal queries by writing back (xterm.js does it).
  ptySpawn: (request: { profile: T.TerminalProfile; agentId?: string | null; cols: number; rows: number }) =>
    invoke<T.PtyInfo>("pty_spawn", { request }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),
  ptyList: () => invoke<T.PtyInfo[]>("pty_list"),
  /** Recent output (≤256 KB) to repaint a terminal after re-mounting. */
  ptyScrollback: (id: string) => invoke<string>("pty_scrollback", { id }),


  // ---------------------------------------------------------------- 0.2: compatibility
  /** Works on any folder (project open or not). */
  compatibilityReport: (path: string) => invoke<T.CompatibilityReport>("compatibility_report", { path }),
  projectBackups: (path: string) => invoke<T.BackupInfo[]>("project_backups", { path }),
  /** Closes the project, restores the backup (the current state is backed up first). Reopen afterwards. */
  rollbackProject: (path: string, backupId: string) => invoke<T.BackupInfo>("rollback_project", { path, backupId }),
  backupProject: (label: string) => invoke<T.BackupInfo>("backup_project", { label }),

  // interpreter & command journal
  interpretCommand: (line: string) => invoke<T.Interpretation>("interpret_command", { line }),
  /** For `claude mcp add ...` and `ssh ...` lines: creates (or reuses) the connection. */
  applyCommand: (line: string) => invoke<T.AppliedCommand>("apply_command", { line }),
  /** Newest first. */
  listCommands: (agentId: string | null, before: number | null, limit: number) =>
    invoke<T.CommandRecord[]>("list_commands", { agentId, before, limit }),

  // user requests (secrets, SSH key, GitHub sign-in)
  /** Stores the value in Windows Credential Manager for the request's connection; agents never see it. */
  provideSecret: (id: string, value: string) => invoke<void>("provide_secret", { id, value }),
  completeUserRequest: (id: string, note?: string) => invoke<void>("complete_user_request", { id, note: note ?? null }),
  dismissUserRequest: (id: string, reason?: string) => invoke<void>("dismiss_user_request", { id, reason: reason ?? null }),
  /** Generates ~/.ssh/nexus_<id>, switches the connection to key auth, opens a Raw Terminal installing the key (user types the password once). */
  sshKeySetup: (connectionId: string) => invoke<T.SshKeySetup>("ssh_key_setup", { connectionId }),
  /** Opens `gh auth login --web` (official device flow) in a Raw Terminal. */
  githubLogin: () => invoke<T.PtyInfo>("github_login"),

  // GitHub
  githubAccount: () => invoke<T.GithubAccount>("github_account"),
  githubRepositories: (owner: string | null, query: string | null) =>
    invoke<T.GithubRepo[]>("github_repositories", { owner, query }),
  githubRepository: (repo: string) => invoke<T.RepositoryDetail>("github_repository", { repo }),
  /** Clones owner/repo into parent/<name>; returns the folder (then offer to open it as a project). */
  githubClone: (repo: string, parent: string) => invoke<string>("github_clone", { repo, parent }),
  githubCreateIssue: (repo: string, title: string, body: string) => invoke<string>("github_create_issue", { repo, title, body }),
  githubRunWorkflow: (repo: string, workflow: string, gitRef: string) =>
    invoke<string>("github_run_workflow", { repo, workflow, gitRef }),

  // MASTER CONTROL (toggle/scopes are saved with saveSettings: settings.masterControl)
  masterStatus: () => invoke<T.MasterStatus>("master_status"),

  // AI World
  worldGet: () => invoke<T.World | null>("world_get"),
  worldProviders: () => invoke<T.WorldProviderInfo[]>("world_providers"),
  worldAnalyze: () => invoke<T.WorldAnalysis>("world_analyze"),
  /** One-click conversion: backup + git snapshot, world, provider setup, optional Central mission. */
  worldCreate: (spec: T.WorldSpec) => invoke<T.ConversionReport>("world_create", { spec }),
  worldSave: (world: T.World) => invoke<T.World>("world_save", { world }),
  worldControl: (opts: { running?: boolean; mode?: T.WorldMode; speed?: number }) =>
    invoke<T.World>("world_control", { running: opts.running ?? null, mode: opts.mode ?? null, speed: opts.speed ?? null }),
  worldDelete: () => invoke<void>("world_delete"),
  worldCharactersFromAgents: () => invoke<T.Character[]>("world_characters_from_agents"),
  /** Real Claude call (haiku by default): characters for a description. */
  worldGenerateCharacters: (description: string, count: number, model?: string) =>
    invoke<T.Character[]>("world_generate_characters", { description, count, model: model ?? null }),
  /** Real Claude call: one simulated conversation between two characters. */
  worldConverse: (a: string, b: string) => invoke<T.Conversation>("world_converse", { a, b }),

  // ---------------------------------------------------------------- misc
  /** Opens a file/folder of the project with the default app (folders open in Explorer). */
  openPath: (path: string) => invoke<void>("open_path", { path }),
  /** Shows the item selected in Windows Explorer. */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
};

export function onEvent(cb: (e: T.PccEvent) => void): Promise<UnlistenFn> {
  return listen<T.PccEvent>(EVENT_CHANNEL, (e) => cb(e.payload));
}

export function onLog(cb: (l: T.LogEntry) => void): Promise<UnlistenFn> {
  return listen<T.LogEntry>(LOG_CHANNEL, (e) => cb(e.payload));
}

/** Normalizes errors thrown by `invoke` (Rust errors serialize as strings). */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function onPty(cb: (e: T.PtyEvent) => void): Promise<UnlistenFn> {
  return listen<T.PtyEvent>(PTY_CHANNEL, (e) => cb(e.payload));
}

export function onWorld(cb: (f: T.WorldFrame) => void): Promise<UnlistenFn> {
  return listen<T.WorldFrame>(WORLD_CHANNEL, (e) => cb(e.payload));
}
