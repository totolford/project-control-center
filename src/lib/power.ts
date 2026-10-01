// Power presets mirrored from `PermissionSet::preset` (crates/pcc-core/src/permissions.rs).
// Used for display and detection only; presets are applied by the backend (api.applyPower).

import { CAPABILITIES } from "./labels";
import type { Access, Capability, PermissionSet, PowerLevel } from "./types";

export const POWER_LEVELS: PowerLevel[] = ["low", "normal", "high", "maximum"];

export const POWER_LABEL: Record<PowerLevel, string> = {
  low: "LOW",
  normal: "NORMAL",
  high: "HIGH",
  maximum: "MAXIMUM",
};

const ALL_CAPS: Capability[] = CAPABILITIES.map((c) => c.key);

function fromPairs(pairs: [Capability, Access][]): PermissionSet {
  const set = Object.fromEntries(ALL_CAPS.map((c) => [c, "deny"])) as PermissionSet;
  for (const [c, a] of pairs) set[c] = a;
  return set;
}

export function powerPreset(level: PowerLevel): PermissionSet {
  switch (level) {
    case "low":
      return fromPairs([
        ["fs_read", "allow"],
        ["git_read", "allow"],
        ["github_read", "allow"],
      ]);
    case "normal":
      return fromPairs([
        ["fs_read", "allow"],
        ["fs_write", "allow"],
        ["fs_execute", "allow"],
        ["git_read", "allow"],
        ["git_write", "ask"],
        ["github_read", "allow"],
        ["network", "ask"],
        ["mcp", "ask"],
      ]);
    case "high":
      return fromPairs([
        ["fs_read", "allow"],
        ["fs_write", "allow"],
        ["fs_execute", "allow"],
        ["network", "allow"],
        ["git_read", "allow"],
        ["git_write", "allow"],
        ["github_read", "allow"],
        ["github_write", "ask"],
        ["ssh_read", "ask"],
        ["ssh_execute", "ask"],
        ["mcp", "allow"],
      ]);
    case "maximum":
      return fromPairs(ALL_CAPS.map((c) => [c, "allow"]));
  }
}

/** Missing capabilities count as "deny", like the backend's serde default. */
export function accessOf(set: Partial<PermissionSet> | null | undefined, cap: Capability): Access {
  return set?.[cap] ?? "deny";
}

/** The preset equal to `set`, or null ("Custom"). */
export function detectPower(set: Partial<PermissionSet>): PowerLevel | null {
  return POWER_LEVELS.find((level) => {
    const preset = powerPreset(level);
    return ALL_CAPS.every((c) => accessOf(set, c) === preset[c]);
  }) ?? null;
}

/** Position on the LOW→MAXIMUM bar in [0, 1]: share of capabilities allowed (ask counts half). */
export function powerScore(set: Partial<PermissionSet>): number {
  const total = ALL_CAPS.reduce((sum, c) => sum + ({ deny: 0, ask: 0.5, allow: 1 } as const)[accessOf(set, c)], 0);
  return total / ALL_CAPS.length;
}

const NEXT: Record<Access, Access> = { deny: "ask", ask: "allow", allow: "deny" };

/** deny → ask → allow → deny. */
export function cycleAccess(a: Access): Access {
  return NEXT[a];
}

export const ACCESS_MARK: Record<Access, { mark: string; label: string; tone: "green" | "amber" | "red" }> = {
  allow: { mark: "✓", label: "allowed", tone: "green" },
  ask: { mark: "?", label: "asks", tone: "amber" },
  deny: { mark: "✗", label: "denied", tone: "red" },
};
