// Pure state transitions for project data. Kept free of React/Tauri so it can be unit tested.

import type {
  Agent,
  CompatibilityReport,
  Connection,
  Message,
  MigrationReport,
  Mission,
  PccEvent,
  PermissionRecord,
  ProjectInfo,
  ProjectSettings,
  ProjectSnapshot,
  RecoveryInfo,
  RepoStatus,
  Task,
  UserRequest,
} from "../lib/types";

export const TIMELINE_LIMIT = 500;
export const LIVE_MESSAGES_LIMIT = 300;

export interface ProjectData {
  info: ProjectInfo;
  settings: ProjectSettings;
  agents: Agent[];
  tasks: Task[];
  missions: Mission[];
  connections: Connection[];
  /** Open requests (pending or recovered), oldest first. */
  pendingPermissions: PermissionRecord[];
  repo: RepoStatus | null;
  recovery: RecoveryInfo | null;
  /** Most recent persisted events (id > 0), newest first. */
  timeline: PccEvent[];
  /** Messages received live since the project was opened, oldest first. */
  liveMessages: Message[];
  /** Bumped on MemoryUpdated so memory views can reload. */
  memoryVersion: number;
  /** Bumped on GitChanged so git views can reload. */
  gitVersion: number;
  /** Emergency stop active: autonomy and new work are blocked until released. */
  emergency: boolean;
  /** Bumped on permission events so the approval journal can reload. */
  decisionVersion: number;
  /** Bumped on McpChanged / SkillChanged so Claude Code inventories can reload. */
  toolsVersion: number;
  /** Agents waiting for the user (secret, SSH key, GitHub sign-in, other step). */
  userRequests: UserRequest[];
  compatibility: CompatibilityReport | null;
  /** Compatibility mode: the backend refuses every change. */
  readOnly: boolean;
  /** Migration performed while opening; shown once, then cleared. */
  migration: MigrationReport | null;
  /** Bumped on ToolUsed so the command journal can reload. */
  commandVersion: number;
  /** Bumped on ProjectChanged / ConnectionChanged / McpChanged / SkillChanged so MASTER CONTROL can reload its status. */
  masterVersion: number;
}

export function fromSnapshot(snap: ProjectSnapshot, previous?: ProjectData | null): ProjectData {
  const keep = previous && previous.info.id === snap.info.id ? previous : null;
  return {
    info: snap.info,
    settings: snap.settings,
    agents: snap.agents.map(normalizeAgent),
    tasks: snap.tasks,
    missions: snap.missions,
    connections: snap.connections,
    pendingPermissions: snap.pendingPermissions,
    repo: snap.repo,
    recovery:
      snap.recovery && (snap.recovery.agents.length > 0 || (snap.recovery.missions?.length ?? 0) > 0 || snap.recovery.autoResumed) ? snap.recovery : null,
    timeline: keep?.timeline ?? [],
    liveMessages: keep?.liveMessages ?? [],
    memoryVersion: keep?.memoryVersion ?? 0,
    gitVersion: keep?.gitVersion ?? 0,
    emergency: snap.emergency,
    decisionVersion: keep?.decisionVersion ?? 0,
    toolsVersion: keep?.toolsVersion ?? 0,
    userRequests: snap.userRequests ?? [],
    compatibility: snap.compatibility,
    readOnly: snap.readOnly,
    // The report comes with the snapshot that opened the project; later refreshes never show it again.
    migration: keep ? keep.migration : snap.migration,
    commandVersion: keep?.commandVersion ?? 0,
    masterVersion: keep?.masterVersion ?? 0,
  };
}

/** Replaces the item with the same id (keeping order) or appends it. Returns the same array if unchanged. */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  if (list[idx] === item) return list;
  const next = list.slice();
  next[idx] = item;
  return next;
}

export function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return list;
  return [...list.slice(0, idx), ...list.slice(idx + 1)];
}

export function addLiveMessage(list: Message[], msg: Message): Message[] {
  const next = upsertById(list, msg);
  return next.length > LIVE_MESSAGES_LIMIT ? next.slice(next.length - LIVE_MESSAGES_LIMIT) : next;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function hasId(v: unknown): v is { id: string } {
  return isObject(v) && typeof v.id === "string";
}

/** An agent payload (not some other object carrying an id, e.g. a connection). */
function isAgentPayload(v: unknown): v is Agent {
  return isObject(v) && typeof v.id === "string" && (v.kind === "central" || v.kind === "worker") && typeof v.name === "string";
}

/** Fills a missing or partial profile so views never read `undefined.appearance`. */
export function normalizeAgent(a: Agent): Agent {
  const profile = isObject(a.profile) ? a.profile : undefined;
  if (profile && isObject(profile.env) && typeof profile.skillsEnabled === "boolean") return a;
  return {
    ...a,
    profile: {
      effort: profile?.effort ?? null,
      skillsEnabled: typeof profile?.skillsEnabled === "boolean" ? profile.skillsEnabled : true,
      env: isObject(profile?.env) ? (profile.env as Record<string, string>) : {},
      ...(profile ?? {}),
    } as Agent["profile"],
  };
}

function withTimeline(data: ProjectData, e: PccEvent): ProjectData {
  if (e.id <= 0 || data.timeline.some((x) => x.id === e.id)) return data;
  const timeline = [e, ...data.timeline];
  if (timeline.length > 1 && timeline[1].id > e.id) timeline.sort((a, b) => b.id - a.id);
  if (timeline.length > TIMELINE_LIMIT) timeline.length = TIMELINE_LIMIT;
  return { ...data, timeline };
}

/** Still waiting for a user decision. */
export function isOpenPermission(r: { status?: string }): boolean {
  return r.status === undefined || r.status === "pending" || r.status === "recovered";
}

/** Applies one real-time event to the project data. */
export function applyEvent(data: ProjectData, e: PccEvent): ProjectData {
  const next = withTimeline(data, e);
  const p: unknown = e.payload;
  switch (e.kind) {
    case "AgentCreated":
    case "AgentUpdated":
    case "AgentStarted":
    case "AgentStopped":
    case "AgentCrashed":
      return isAgentPayload(p) ? { ...next, agents: upsertById(next.agents, normalizeAgent(p)) } : next;
    case "TaskCreated":
    case "TaskUpdated":
    case "TaskCompleted":
    case "TaskFailed":
      return hasId(p) ? { ...next, tasks: upsertById(next.tasks, p as Task) } : next;
    case "MissionCreated":
    case "MissionUpdated":
    case "MissionCompleted":
      return hasId(p) ? { ...next, missions: upsertById(next.missions, p as Mission) } : next;
    case "AgentMessage":
      return hasId(p) ? { ...next, liveMessages: addLiveMessage(next.liveMessages, p as Message) } : next;
    case "PermissionRequested":
      return hasId(p)
        ? { ...next, pendingPermissions: upsertById(next.pendingPermissions, p as PermissionRecord), decisionVersion: next.decisionVersion + 1 }
        : next;
    case "PermissionResolved":
      return hasId(p) ? { ...next, pendingPermissions: removeById(next.pendingPermissions, p.id), decisionVersion: next.decisionVersion + 1 } : next;
    case "PermissionUpdated": {
      // Expired, lost, cancelled, consumed... leave the queue; recovered comes back.
      if (!hasId(p)) return next;
      const open = isOpenPermission(p as PermissionRecord);
      const pendingPermissions = open
        ? upsertById(next.pendingPermissions, p as PermissionRecord)
        : removeById(next.pendingPermissions, p.id);
      return { ...next, pendingPermissions, decisionVersion: next.decisionVersion + 1 };
    }
    case "PermissionAutoApproved":
      return { ...next, decisionVersion: next.decisionVersion + 1 };
    case "EmergencyStop":
      return isObject(p) && typeof p.active === "boolean" ? { ...next, emergency: p.active } : next;
    case "McpChanged":
    case "SkillChanged":
      return { ...next, toolsVersion: next.toolsVersion + 1, masterVersion: next.masterVersion + 1 };
    case "ConnectionChanged": {
      const bumped = { ...next, masterVersion: next.masterVersion + 1 };
      if (!hasId(p)) return bumped;
      if ((p as { deleted?: boolean }).deleted === true) {
        return { ...bumped, connections: removeById(next.connections, p.id) };
      }
      return { ...bumped, connections: upsertById(next.connections, p as Connection) };
    }
    case "ProjectChanged": {
      const bumped = { ...next, masterVersion: next.masterVersion + 1 };
      if (isObject(p) && isObject(p.settings)) return { ...bumped, settings: p.settings as unknown as ProjectSettings };
      return bumped;
    }
    case "ToolUsed":
      return { ...next, commandVersion: next.commandVersion + 1 };
    case "UserRequested":
      return hasId(p) ? { ...next, userRequests: upsertById(next.userRequests, p as UserRequest) } : next;
    case "UserRequestResolved":
      return hasId(p) ? { ...next, userRequests: removeById(next.userRequests, p.id) } : next;
    case "MemoryUpdated":
      return { ...next, memoryVersion: next.memoryVersion + 1 };
    case "GitChanged":
      return { ...next, gitVersion: next.gitVersion + 1 };
    default:
      return next;
  }
}
