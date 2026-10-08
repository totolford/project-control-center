// Human-readable labels and visual tones for backend enums.

import type {
  AgentStatus,
  Capability,
  ConnectionStatus,
  MissionStatus,
  Priority,
  TaskStatus,
} from "./types";
import { t, type MessageKey } from "../i18n";

export type Tone = "green" | "blue" | "amber" | "red" | "grey" | "orange" | "dim" | "accent";

/** `label` is read at render time, in the current interface language. */
function tone<T extends object>(key: MessageKey, rest: T): T & { readonly label: string } {
  return Object.defineProperty({ ...rest }, "label", { get: () => t(key), enumerable: true }) as T & { readonly label: string };
}

export const AGENT_STATUS: Record<AgentStatus, { readonly label: string; tone: Tone; pulse?: boolean }> = {
  offline: tone("status.agent.offline", { tone: "grey" }),
  starting: tone("status.agent.starting", { tone: "amber" }),
  working: tone("status.agent.working", { tone: "green", pulse: true }),
  waiting: tone("status.agent.waiting", { tone: "blue" }),
  awaiting_permission: tone("status.agent.awaiting_permission", { tone: "amber", pulse: true }),
  stopped: tone("status.agent.stopped", { tone: "grey" }),
  crashed: tone("status.agent.crashed", { tone: "red" }),
  disconnected: tone("status.agent.disconnected", { tone: "orange" }),
  retired: tone("status.agent.retired", { tone: "dim" }),
  sleeping: tone("status.agent.sleeping", { tone: "dim" }),
};

export const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "queued",
  "in_progress",
  "waiting",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
];

export const TASK_STATUS: Record<TaskStatus, { readonly label: string; tone: Tone }> = {
  pending: tone("status.task.pending", { tone: "grey" }),
  queued: tone("status.task.queued", { tone: "dim" }),
  in_progress: tone("status.task.in_progress", { tone: "green" }),
  waiting: tone("status.task.waiting", { tone: "blue" }),
  blocked: tone("status.task.blocked", { tone: "orange" }),
  review: tone("status.task.review", { tone: "accent" }),
  completed: tone("status.task.completed", { tone: "green" }),
  failed: tone("status.task.failed", { tone: "red" }),
  cancelled: tone("status.task.cancelled", { tone: "dim" }),
};

export const MISSION_STATUS: Record<MissionStatus, { readonly label: string; tone: Tone }> = {
  queued: tone("status.mission.queued", { tone: "blue" }),
  planning: tone("status.mission.planning", { tone: "amber" }),
  active: tone("status.mission.active", { tone: "green" }),
  completed: tone("status.mission.completed", { tone: "accent" }),
  failed: tone("status.mission.failed", { tone: "red" }),
  cancelled: tone("status.mission.cancelled", { tone: "dim" }),
};

export const CONNECTION_STATUS: Record<ConnectionStatus, { readonly label: string; tone: Tone }> = {
  unknown: tone("status.connection.unknown", { tone: "grey" }),
  connected: tone("status.connection.connected", { tone: "green" }),
  disconnected: tone("status.connection.disconnected", { tone: "orange" }),
  error: tone("status.connection.error", { tone: "red" }),
};

export const PRIORITIES: Priority[] = ["low", "normal", "high", "critical"];

export function priorityLabel(p: Priority): string {
  return t.dynamic(`status.priority.${p}`, undefined, p);
}

function cap(key: Capability, group: string, groupKey?: MessageKey): { key: Capability; readonly label: string; readonly group: string } {
  return {
    key,
    get label() {
      return t.dynamic(`status.cap.${key}`, undefined, key);
    },
    get group() {
      return groupKey ? t(groupKey) : group;
    },
  };
}

export const CAPABILITIES: { key: Capability; readonly label: string; readonly group: string }[] = [
  cap("fs_read", "Filesystem", "status.capGroup.filesystem"),
  cap("fs_write", "Filesystem", "status.capGroup.filesystem"),
  cap("fs_execute", "Filesystem", "status.capGroup.filesystem"),
  cap("network", "Network", "status.capGroup.network"),
  cap("git_read", "Git"),
  cap("git_write", "Git"),
  cap("github_read", "GitHub"),
  cap("github_write", "GitHub"),
  cap("github_admin", "GitHub"),
  cap("ssh_read", "SSH"),
  cap("ssh_execute", "SSH"),
  cap("mcp", "MCP"),
];

/** Agents whose session is alive (can be interrupted/stopped). */
export function isLive(status: AgentStatus): boolean {
  return status === "starting" || status === "working" || status === "waiting" || status === "awaiting_permission";
}
