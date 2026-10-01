// Global application state (zustand). Entities come exclusively from api.* results and real-time events.

import { create } from "zustand";
import { api } from "./lib/api";
import type {
  Agent,
  Connection,
  Message,
  Mission,
  PccEvent,
  PermissionRequest,
  ProjectSettings,
  ProjectSnapshot,
  Task,
} from "./lib/types";
import { addLiveMessage, applyEvent, fromSnapshot, removeById, upsertById, type ProjectData } from "./state/reducer";

export type ViewName =
  | "swarm"
  | "missions"
  | "agents"
  | "models"
  | "mcp"
  | "skills"
  | "connections"
  | "commands"
  | "memory"
  | "activity"
  | "environment"
  | "claude"
  | "autonomy"
  | "capabilities"
  | "terminal"
  | "agent"
  | "tasks"
  | "git"
  | "settings";

export interface View {
  name: ViewName;
  /** Agent id for the "agent" view. */
  agentId?: string;
  /** Selected task in the "tasks" view. */
  taskId?: string;
  /** Section to scroll to (e.g. a Settings section id). */
  section?: string;
}

interface AppState {
  project: ProjectData | null;
  view: View;
  /** Agents whose last finished turn ended in an error (from their live logs). */
  turnErrors: Record<string, boolean>;
  setTurnError: (agentId: string, error: boolean) => void;
  loadSnapshot: (snap: ProjectSnapshot) => void;
  applyEvent: (e: PccEvent) => void;
  closeProject: () => void;
  navigate: (view: View) => void;
  openAgent: (agentId: string) => void;
  openTask: (taskId: string) => void;
  upsertAgent: (a: Agent) => void;
  upsertTask: (t: Task) => void;
  upsertMission: (m: Mission) => void;
  upsertConnection: (c: Connection) => void;
  removeConnection: (id: string) => void;
  addMessage: (m: Message) => void;
  setSettings: (s: ProjectSettings) => void;
  clearRecovery: () => void;
  /** Reloads the full snapshot from the backend (safety net after actions / on focus). */
  refresh: () => Promise<void>;
}

function patchProject(state: AppState, fn: (p: ProjectData) => ProjectData): Partial<AppState> {
  return state.project ? { project: fn(state.project) } : {};
}

export const useStore = create<AppState>((set, get) => ({
  project: null,
  view: { name: "swarm" },
  turnErrors: {},
  setTurnError: (agentId, error) =>
    set((s) => (Boolean(s.turnErrors[agentId]) === error ? {} : { turnErrors: { ...s.turnErrors, [agentId]: error } })),
  loadSnapshot: (snap) => set((s) => ({ project: fromSnapshot(snap, s.project) })),
  applyEvent: (e) => set((s) => patchProject(s, (p) => applyEvent(p, e))),
  closeProject: () => set({ project: null, view: { name: "swarm" }, turnErrors: {} }),
  navigate: (view) => set({ view }),
  openAgent: (agentId) => set({ view: { name: "agent", agentId } }),
  openTask: (taskId) => set({ view: { name: "tasks", taskId } }),
  upsertAgent: (a) => set((s) => patchProject(s, (p) => ({ ...p, agents: upsertById(p.agents, a) }))),
  upsertTask: (t) => set((s) => patchProject(s, (p) => ({ ...p, tasks: upsertById(p.tasks, t) }))),
  upsertMission: (m) => set((s) => patchProject(s, (p) => ({ ...p, missions: upsertById(p.missions, m) }))),
  upsertConnection: (c) => set((s) => patchProject(s, (p) => ({ ...p, connections: upsertById(p.connections, c) }))),
  removeConnection: (id) => set((s) => patchProject(s, (p) => ({ ...p, connections: removeById(p.connections, id) }))),
  addMessage: (m) => set((s) => patchProject(s, (p) => ({ ...p, liveMessages: addLiveMessage(p.liveMessages, m) }))),
  setSettings: (settings) => set((s) => patchProject(s, (p) => ({ ...p, settings }))),
  clearRecovery: () => set((s) => patchProject(s, (p) => ({ ...p, recovery: null }))),
  refresh: async () => {
    if (!get().project) return;
    const snap = await api.snapshot();
    const current = get().project;
    if (current && current.info.id === snap.info.id) {
      // Recovery is only offered once, right after opening.
      set({ project: { ...fromSnapshot(snap, current), recovery: current.recovery } });
    }
  },
}));

// Stable empty fallbacks so selectors never return a fresh array (which would loop re-renders).
const NO_AGENTS: Agent[] = [];
const NO_TASKS: Task[] = [];
const NO_MISSIONS: Mission[] = [];
const NO_CONNECTIONS: Connection[] = [];
const NO_PERMISSIONS: PermissionRequest[] = [];
const NO_EVENTS: PccEvent[] = [];
const NO_MESSAGES: Message[] = [];

export const useAgents = () => useStore((s) => s.project?.agents ?? NO_AGENTS);
export const useTasks = () => useStore((s) => s.project?.tasks ?? NO_TASKS);
export const useMissions = () => useStore((s) => s.project?.missions ?? NO_MISSIONS);
export const useConnections = () => useStore((s) => s.project?.connections ?? NO_CONNECTIONS);
export const usePendingPermissions = () => useStore((s) => s.project?.pendingPermissions ?? NO_PERMISSIONS);
export const useTimeline = () => useStore((s) => s.project?.timeline ?? NO_EVENTS);
export const useLiveMessages = () => useStore((s) => s.project?.liveMessages ?? NO_MESSAGES);
export const useAgent = (id: string | null | undefined) =>
  useStore((s) => (id ? s.project?.agents.find((a) => a.id === id) : undefined));
export const useTask = (id: string | null | undefined) =>
  useStore((s) => (id ? s.project?.tasks.find((t) => t.id === id) : undefined));

/** Central first, then by creation order. */
export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => (a.kind === "central" ? -1 : b.kind === "central" ? 1 : a.createdAt.localeCompare(b.createdAt)));
}

/** "#n" creation-order number of an agent among all agents (1-based). */
export function useAgentNumber(id: string): number {
  return useStore((s) => {
    const agents = s.project?.agents ?? NO_AGENTS;
    const me = agents.find((a) => a.id === id);
    if (!me) return 0;
    return agents.filter((a) => a.createdAt < me.createdAt || (a.createdAt === me.createdAt && a.id <= me.id)).length;
  });
}
