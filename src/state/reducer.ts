// Pure state transitions for project data. Kept free of React/Tauri so it can be unit tested.

import type {
  Agent,
  Connection,
  Message,
  Mission,
  PccEvent,
  PermissionRequest,
  ProjectInfo,
  ProjectSettings,
  ProjectSnapshot,
  RecoveryInfo,
  RepoStatus,
  Task,
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
  pendingPermissions: PermissionRequest[];
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
}

export function fromSnapshot(snap: ProjectSnapshot, previous?: ProjectData | null): ProjectData {
  const keep = previous && previous.info.id === snap.info.id ? previous : null;
  return {
    info: snap.info,
    settings: snap.settings,
    agents: snap.agents,
    tasks: snap.tasks,
    missions: snap.missions,
    connections: snap.connections,
    pendingPermissions: snap.pendingPermissions,
    repo: snap.repo,
    recovery: snap.recovery && snap.recovery.agents.length > 0 ? snap.recovery : null,
    timeline: keep?.timeline ?? [],
    liveMessages: keep?.liveMessages ?? [],
    memoryVersion: keep?.memoryVersion ?? 0,
    gitVersion: keep?.gitVersion ?? 0,
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

function withTimeline(data: ProjectData, e: PccEvent): ProjectData {
  if (e.id <= 0 || data.timeline.some((x) => x.id === e.id)) return data;
  const timeline = [e, ...data.timeline];
  if (timeline.length > 1 && timeline[1].id > e.id) timeline.sort((a, b) => b.id - a.id);
  if (timeline.length > TIMELINE_LIMIT) timeline.length = TIMELINE_LIMIT;
  return { ...data, timeline };
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
      return hasId(p) ? { ...next, agents: upsertById(next.agents, p as Agent) } : next;
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
      return hasId(p) ? { ...next, pendingPermissions: upsertById(next.pendingPermissions, p as PermissionRequest) } : next;
    case "PermissionResolved":
      return hasId(p) ? { ...next, pendingPermissions: removeById(next.pendingPermissions, p.id) } : next;
    case "ConnectionChanged":
      if (!hasId(p)) return next;
      if ((p as { deleted?: boolean }).deleted === true) {
        return { ...next, connections: removeById(next.connections, p.id) };
      }
      return { ...next, connections: upsertById(next.connections, p as Connection) };
    case "ProjectChanged":
      if (isObject(p) && isObject(p.settings)) return { ...next, settings: p.settings as unknown as ProjectSettings };
      return next;
    case "MemoryUpdated":
      return { ...next, memoryVersion: next.memoryVersion + 1 };
    case "GitChanged":
      return { ...next, gitVersion: next.gitVersion + 1 };
    default:
      return next;
  }
}
