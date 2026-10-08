// Central autonomy, mirrored from crates/pcc-orchestrator/src/central.rs (autonomy_label, nudge_limit).
// Display only: the level is Central's power preset, applied by the backend (api.applyPower).

import { detectPower } from "../../lib/power";
import type { AutonomyLabel } from "../../lib/centralTypes";
import type { PermissionSet, PowerLevel } from "../../lib/types";

export function autonomyLabel(level: PowerLevel | null): AutonomyLabel {
  return level ? (level.toUpperCase() as AutonomyLabel) : "CUSTOM";
}

/** Supervisor reminders allowed on an unchanged mission state (LOW: NEXUS never continues on its own). */
export function nudgeLimit(level: PowerLevel | null): number {
  switch (level) {
    case "low":
      return 0;
    case "high":
      return 4;
    case "maximum":
      return 6;
    default:
      return 2;
  }
}

export function autonomyOf(permissions: PermissionSet | undefined): { level: PowerLevel | null; label: AutonomyLabel; reminders: number } {
  const level = permissions ? detectPower(permissions) : null;
  return { level, label: autonomyLabel(level), reminders: nudgeLimit(level) };
}

export const AUTONOMY_TONE: Record<AutonomyLabel, string> = {
  LOW: "grey",
  NORMAL: "blue",
  HIGH: "accent",
  MAXIMUM: "amber",
  CUSTOM: "dim",
};
