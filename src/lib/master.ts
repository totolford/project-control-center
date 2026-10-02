// NEXUS MASTER CONTROL: switches and domain status rendering (pure, tested).

import type { Tone } from "./labels";
import type { MasterControl, MasterDomain, MasterStatus } from "./types";

export type MasterSwitch = Exclude<keyof MasterControl, "active">;

export const MASTER_SWITCHES: { key: MasterSwitch; label: string; hint: string }[] = [
  { key: "pc", label: "This PC", hint: "Files, commands and network on this machine" },
  { key: "github", label: "GitHub", hint: "Repositories, issues, pull requests, workflows through gh" },
  { key: "mcp", label: "MCP", hint: "Tools of the project's MCP servers" },
  { key: "ssh", label: "SSH", hint: "Remote hosts of the project's SSH connections" },
  { key: "skills", label: "Skills", hint: "Claude Code skills and slash commands" },
  { key: "manageConnections", label: "Manage connections", hint: "Create connections and MCP servers and grant them without asking" },
];

export const MASTER_CONFIRM =
  "Central can use every capability you open below, create connections/MCP and grant them without asking; destructive actions still follow your manual rules; nothing bypasses Claude Code, Windows or external services.";

export interface DomainView {
  state: "off" | "unavailable" | "partial" | "full";
  label: string;
  tone: Tone;
  percent: number;
}

/** How a domain is drawn: an enabled domain that cannot be used now is shown as unavailable, never as active. */
export function domainView(d: Pick<MasterDomain, "enabled" | "available" | "level">): DomainView {
  const percent = Math.round(Math.min(1, Math.max(0, d.level)) * 100);
  if (!d.enabled) return { state: "off", label: "Off", tone: "grey", percent };
  if (!d.available) return { state: "unavailable", label: "Unavailable", tone: "orange", percent };
  if (percent >= 100) return { state: "full", label: "Full", tone: "green", percent };
  return { state: "partial", label: `${percent}%`, tone: "amber", percent };
}

export function domainOf(status: MasterStatus | null, key: string): MasterDomain | undefined {
  return status?.domains.find((d) => d.key === key);
}

/** Same settings with MASTER CONTROL off (domain switches are kept for the next activation). */
export function masterOff(m: MasterControl): MasterControl {
  return { ...m, active: false };
}
