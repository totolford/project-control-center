// Test-only builders for backend entities (complete objects matching the contract).

import { powerPreset } from "../lib/power";
import type { Agent, PermissionSet, ProjectInfo, ProjectSettings, ProjectSnapshot } from "../lib/types";

export function makeAgent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    kind: id === "central" ? "central" : "worker",
    provider: "claude-code",
    role: "Role",
    instructions: "",
    status: "offline",
    model: null,
    permissions: powerPreset("normal"),
    connections: [],
    isolation: "shared",
    workdir: "C:/proj",
    branch: null,
    currentTask: null,
    currentAction: null,
    progress: null,
    claudeSessionId: null,
    totalCostUsd: 0,
    profile: { effort: null, skillsEnabled: true, env: {} },
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    parentAgent: id === "central" ? null : "central",
    rank: id === "central" ? "commander" : "specialist",
    pausedAt: null,
    ...patch,
  };
}

export function makeSettings(patch: Partial<ProjectSettings> = {}): ProjectSettings {
  const perms: PermissionSet = powerPreset("normal");
  return {
    centralModel: null,
    workerModel: null,
    maxParallelWorkers: 3,
    useWorktrees: true,
    inheritUserSettings: false,
    defaultWorkerPermissions: perms,
    maxWorkerPermissions: powerPreset("maximum"),
    maxBudgetUsdPerSession: null,
    allowDirectWorkerMessages: false,
    autonomy: {
      unlocked: false,
      unlockedPermissions: powerPreset("high"),
      autoApprove: false,
      manualForDestructive: true,
      manualForOutsideWorkspace: true,
      manualCapabilities: [],
    },
    improvement: { enabled: false, intervalMinutes: 120, mode: "propose", focus: ["bugs", "tests"], maxRunsPerDay: 4 },
    sessionEnv: {},
    defaultEffort: null,
    defaultSkillsEnabled: true,
    autoRecover: false,
    masterControl: { active: false, pc: false, github: false, mcp: false, ssh: false, skills: false, manageConnections: false },
    maxHierarchyDepth: 3,
    sleepAfterMinutes: 20,
    permissionTimeoutMinutes: 30,
    ...patch,
  };
}

export function makeInfo(patch: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    name: "Demo",
    root: "C:/proj",
    createdAt: "2026-01-01T00:00:00Z",
    formatVersion: 1,
    createdWith: "0.2.0",
    lastOpenedWith: "0.2.0",
    minimumNexusVersion: null,
    ...patch,
  };
}

export function makeSnapshot(patch: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    info: makeInfo(),
    settings: makeSettings(),
    agents: [makeAgent("central")],
    tasks: [],
    missions: [],
    connections: [],
    pendingPermissions: [],
    repo: null,
    recovery: null,
    emergency: false,
    userRequests: [],
    compatibility: null,
    readOnly: false,
    migration: null,
    ...patch,
  };
}
