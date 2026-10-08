// Event kinds grouped for the Live Activity filters, with their tones (pure, tested).

import type { Tone } from "./labels";
import type { EventKind } from "./types";
import { t } from "../i18n";

export type ActivityGroup = "agents" | "tasks" | "messages" | "tools" | "permissions" | "mcp_skills" | "git" | "safety" | "requests" | "project";

const GROUP_KEYS: ActivityGroup[] = ["agents", "tasks", "messages", "tools", "permissions", "mcp_skills", "git", "safety", "requests", "project"];

/** Label read at render time, in the interface language. */
export const ACTIVITY_GROUPS: { key: ActivityGroup; readonly label: string }[] = GROUP_KEYS.map((key) => ({
  key,
  get label() {
    return t.dynamic(`activity.group.${key}`, undefined, key);
  },
}));

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
  DelegationDecision: "agents",
  MessageRouted: "messages",
  HierarchyChanged: "agents",
  AgentDormancy: "agents",
  AgentRestarted: "agents",
  PermissionUpdated: "permissions",
  RuntimeChanged: "project",
  SystemNotice: "project",
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
  UserRequested: "requests",
  UserRequestResolved: "requests",
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
    case "UserRequested":
    case "ReviewRequested":
      return "amber";
    case "TaskCompleted":
    case "UserRequestResolved":
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
