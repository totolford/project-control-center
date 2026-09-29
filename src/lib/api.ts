// Typed wrappers over the Tauri commands defined in src-tauri/src/commands.rs.
// Argument names are camelCase here; Tauri maps them to snake_case in Rust.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as T from "./types";

export const EVENT_CHANNEL = "pcc://event";
export const LOG_CHANNEL = "pcc://log";

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
