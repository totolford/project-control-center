// Event kinds grouped for the Live Activity filters, with their tones (pure, tested).

import type { Tone } from "./labels";
import type { EventKind } from "./types";

export type ActivityGroup = "agents" | "tasks" | "messages" | "tools" | "permissions" | "mcp_skills" | "git" | "safety" | "project";

export const ACTIVITY_GROUPS: { key: ActivityGroup; label: string }[] = [
  { key: "agents", label: "Agents" },
  { key: "tasks", label: "Tasks & missions" },
  { key: "messages", label: "Messages" },
  { key: "tools", label: "Tools" },
  { key: "permissions", label: "Permissions" },
  { key: "mcp_skills", label: "MCP / skills" },
  { key: "git", label: "Git" },
  { key: "safety", label: "Safety" },
  { key: "project", label: "Project" },
];

const GROUP_OF: Record<EventKind, ActivityGroup> = {
  ProjectOpened: "project",
  ProjectChanged: "project",
  MemoryUpdated: "project",
  ConnectionChanged: "project",
  AgentCreated: "agents",
  AgentUpdated: "agents",
  AgentStarted: "agents",
  AgentStopped: "agents",
  AgentCrashed: "agents",
  AgentMessage: "messages",
  TaskCreated: "tasks",
  TaskUpdated: "tasks",
  TaskCompleted: "tasks",
  TaskFailed: "tasks",
  MissionCreated: "tasks",
  MissionUpdated: "tasks",
  MissionCompleted: "tasks",
  ReviewRequested: "tasks",
  ImprovementCycle: "tasks",
  PermissionRequested: "permissions",
  PermissionResolved: "permissions",
  PermissionAutoApproved: "permissions",
  ToolUsed: "tools",
  McpChanged: "mcp_skills",
  SkillChanged: "mcp_skills",
  GitChanged: "git",
  EmergencyStop: "safety",
  Error: "safety",
};

export function groupOf(kind: EventKind): ActivityGroup {
  return GROUP_OF[kind] ?? "project";
}

export function kindTone(kind: EventKind): Tone {
  switch (kind) {
    case "Error":
    case "AgentCrashed":
    case "TaskFailed":
    case "EmergencyStop":
      return "red";
    case "PermissionAutoApproved":
    case "ImprovementCycle":
      return "accent";
    case "PermissionRequested":
    case "PermissionResolved":
    case "ReviewRequested":
      return "amber";
    case "TaskCompleted":
      return "green";
    case "AgentMessage":
    case "ToolUsed":
      return "blue";
    case "McpChanged":
    case "SkillChanged":
      return "orange";
    default:
      return kind.startsWith("Mission") ? "accent" : "grey";
  }
}

/** ToolUsed payload: { tool, input } (or { terminal } for Raw Terminal sessions). */
export function toolOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const tool = (payload as Record<string, unknown>).tool;
  return typeof tool === "string" ? tool : null;
}
