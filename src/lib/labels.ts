// Human-readable labels and visual tones for backend enums.

import type {
  AgentStatus,
  Capability,
  ConnectionStatus,
  MissionStatus,
  Priority,
  TaskStatus,
} from "./types";

export type Tone = "green" | "blue" | "amber" | "red" | "grey" | "orange" | "dim" | "accent";

export const AGENT_STATUS: Record<AgentStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  offline: { label: "Offline", tone: "grey" },
  starting: { label: "Starting", tone: "amber" },
  working: { label: "Working", tone: "green", pulse: true },
  waiting: { label: "Waiting", tone: "blue" },
  awaiting_permission: { label: "Awaiting permission", tone: "amber", pulse: true },
  stopped: { label: "Stopped", tone: "grey" },
  crashed: { label: "Crashed", tone: "red" },
  disconnected: { label: "Disconnected", tone: "orange" },
  retired: { label: "Retired", tone: "dim" },
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

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "grey" },
  queued: { label: "Queued", tone: "dim" },
  in_progress: { label: "In progress", tone: "green" },
  waiting: { label: "Waiting", tone: "blue" },
  blocked: { label: "Blocked", tone: "orange" },
  review: { label: "Review", tone: "accent" },
  completed: { label: "Completed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "dim" },
};

export const MISSION_STATUS: Record<MissionStatus, { label: string; tone: Tone }> = {
  planning: { label: "Planning", tone: "amber" },
  active: { label: "Active", tone: "green" },
  completed: { label: "Completed", tone: "accent" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "dim" },
};

export const CONNECTION_STATUS: Record<ConnectionStatus, { label: string; tone: Tone }> = {
  unknown: { label: "Unknown", tone: "grey" },
  connected: { label: "Connected", tone: "green" },
  disconnected: { label: "Disconnected", tone: "orange" },
  error: { label: "Error", tone: "red" },
};

export const PRIORITIES: Priority[] = ["low", "normal", "high", "critical"];

export const CAPABILITIES: { key: Capability; label: string; group: string }[] = [
  { key: "fs_read", label: "Read files", group: "Filesystem" },
  { key: "fs_write", label: "Write files", group: "Filesystem" },
  { key: "fs_execute", label: "Run commands", group: "Filesystem" },
  { key: "network", label: "Network access", group: "Network" },
  { key: "git_read", label: "Git read", group: "Git" },
  { key: "git_write", label: "Git write", group: "Git" },
  { key: "github_read", label: "GitHub read", group: "GitHub" },
  { key: "github_write", label: "GitHub write", group: "GitHub" },
  { key: "github_admin", label: "GitHub admin", group: "GitHub" },
  { key: "ssh_read", label: "SSH read", group: "SSH" },
  { key: "ssh_execute", label: "SSH execute", group: "SSH" },
  { key: "mcp", label: "MCP tools", group: "MCP" },
];

/** Agents whose session is alive (can be interrupted/stopped). */
export function isLive(status: AgentStatus): boolean {
  return status === "starting" || status === "working" || status === "waiting" || status === "awaiting_permission";
}
