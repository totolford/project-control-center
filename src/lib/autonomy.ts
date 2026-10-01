// CLAUDE UNLOCKED: user-facing checklist mapped to capabilities, and the effective
// answer NEXUS gives (mirrors `auto_approvable` in crates/pcc-orchestrator/src/policy.rs).

import { accessOf } from "./power";
import type { Access, AutonomySettings, Capability, PermissionSet } from "./types";

export interface ChecklistItem {
  label: string;
  /** Capabilities that govern the item; empty when it is not a capability. */
  caps: Capability[];
  /** Explains items governed elsewhere (or extra caveats). */
  note?: string;
}

export const CHECKLIST: ChecklistItem[] = [
  { label: "Read the project", caps: ["fs_read"] },
  { label: "Write, create and delete files", caps: ["fs_write"], note: "Destructive operations (e.g. deleting directories) follow “Keep destructive actions manual”." },
  { label: "Execute commands, run tests, install dependencies, restart services", caps: ["fs_execute"] },
  { label: "Git", caps: ["git_read", "git_write"] },
  { label: "GitHub", caps: ["github_read", "github_write", "github_admin"] },
  { label: "MCP tools", caps: ["mcp"] },
  { label: "Connections (SSH)", caps: ["ssh_read", "ssh_execute"] },
  { label: "Network", caps: ["network"] },
  { label: "Skills", caps: [], note: "Per agent: Agents → profile → Skills (on/off)." },
  { label: "Spawn agents", caps: [], note: "Always Central only." },
  { label: "Improve the project", caps: [], note: "Governed by Continuous Improvement settings." },
];

/** What happens when an agent uses a capability: "auto" = it would ask, and NEXUS answers yes. */
export type Effective = Access | "auto";

export function effectiveAccess(autonomy: AutonomySettings, cap: Capability): Effective {
  const access = accessOf(autonomy.unlockedPermissions, cap);
  if (access === "ask" && autonomy.autoApprove && !autonomy.manualCapabilities.includes(cap)) return "auto";
  return access;
}

/** Effective permission set of any agent: the unlocked set while UNLOCKED, else its own. */
export function effectivePermissions(own: PermissionSet, autonomy: AutonomySettings): PermissionSet {
  return autonomy.unlocked ? autonomy.unlockedPermissions : own;
}

export const EFFECTIVE_MARK: Record<Effective, { mark: string; label: string; tone: "green" | "amber" | "red" | "accent" }> = {
  allow: { mark: "✓", label: "allowed", tone: "green" },
  auto: { mark: "✓", label: "asks → auto-approved", tone: "accent" },
  ask: { mark: "?", label: "asks you", tone: "amber" },
  deny: { mark: "✗", label: "denied", tone: "red" },
};

export function toggleIn<T>(list: T[], item: T, on: boolean): T[] {
  const without = list.filter((x) => x !== item);
  return on ? [...without, item] : without;
}
