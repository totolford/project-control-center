// Capabilities matrix: columns and cell edits (pure, tested).

import { accessOf, cycleAccess } from "./power";
import type { Agent, AgentProfile, Capability, Connection, ConnectionKind, PermissionSet } from "./types";

export type MatrixColumn =
  | { key: string; label: string; type: "cap"; cap: Capability; grantKinds?: ConnectionKind[] }
  | { key: string; label: string; type: "grant"; kinds: ConnectionKind[] }
  | { key: string; label: string; type: "skills" };

export const MATRIX_COLUMNS: MatrixColumn[] = [
  { key: "mcp", label: "MCP", type: "cap", cap: "mcp", grantKinds: ["mcp", "roblox_studio"] },
  { key: "skills", label: "Skills", type: "skills" },
  { key: "git", label: "Git", type: "cap", cap: "git_write" },
  { key: "github", label: "GitHub", type: "cap", cap: "github_write" },
  { key: "ssh", label: "SSH", type: "cap", cap: "ssh_execute" },
  { key: "roblox", label: "Roblox", type: "grant", kinds: ["roblox_studio"] },
  { key: "terminal", label: "Terminal", type: "cap", cap: "fs_execute" },
  { key: "network", label: "Network", type: "cap", cap: "network" },
];

/** The agent's permissions with `cap` advanced deny → ask → allow → deny. */
export function cyclePermission(perms: PermissionSet, cap: Capability): PermissionSet {
  return { ...perms, [cap]: cycleAccess(accessOf(perms, cap)) };
}

export function grantedOfKinds(granted: string[], connections: Connection[], kinds: ConnectionKind[]): Connection[] {
  return connections.filter((c) => kinds.includes(c.kind) && granted.includes(c.id));
}

/** Revokes every connection of `kinds` if any is granted, else grants all enabled ones. */
export function toggleGrants(granted: string[], connections: Connection[], kinds: ConnectionKind[]): string[] {
  const ofKind = connections.filter((c) => kinds.includes(c.kind));
  if (ofKind.some((c) => granted.includes(c.id))) return granted.filter((id) => !ofKind.some((c) => c.id === id));
  return [...granted, ...ofKind.filter((c) => c.enabled && !granted.includes(c.id)).map((c) => c.id)];
}

export function toggleSkills(profile: AgentProfile): AgentProfile {
  return { ...profile, skillsEnabled: !profile.skillsEnabled };
}

/** Agents shown in the matrix: Central first, retired ones excluded. */
export function matrixAgents(agents: Agent[]): Agent[] {
  return agents
    .filter((a) => a.status !== "retired")
    .sort((a, b) => (a.kind === "central" ? -1 : b.kind === "central" ? 1 : a.createdAt.localeCompare(b.createdAt)));
}
