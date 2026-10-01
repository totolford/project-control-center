// Pure helpers of the Skills manager: filters, discovery, requirements, wizard validation.

import { CAPABILITIES } from "../../lib/labels";
import type { Agent, Connection, NewSkill, Skill } from "../../lib/types";

export type SkillFilter = "all" | "project" | "global" | "plugin" | "enabled" | "disabled";

export const SKILL_FILTERS: { value: SkillFilter; label: string }[] = [
  { value: "all", label: "Installed" },
  { value: "project", label: "Project" },
  { value: "global", label: "Global" },
  { value: "plugin", label: "Plugin" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

export function matchesFilter(s: Skill, f: SkillFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "project":
      return s.scope === "project";
    case "global":
      return s.scope === "user";
    case "plugin":
      return s.scope === "plugin";
    case "enabled":
      return s.enabled;
    case "disabled":
      return !s.enabled;
  }
}

export function isSynced(s: Skill): boolean {
  return s.scope === "user" && s.source === "synced";
}

/** Badge text for where a skill comes from. */
export function sourceLabel(s: Skill): string {
  if (s.scope === "plugin") return s.source ? `Plugin ${s.source}` : "Plugin";
  if (isSynced(s)) return "Synced (claude.ai)";
  return s.scope === "project" ? "Project" : "Global";
}

/**
 * Whether Claude Code currently lists the skill as a command (`name` or `plugin:name`).
 * null when Claude Code's command list is not available.
 */
export function isDiscovered(s: Skill, commands: Record<string, any>[] | null): boolean | null {
  if (!commands) return null;
  return commands.some((c) => {
    const name = typeof c.name === "string" ? c.name.replace(/^\//, "") : "";
    return name === s.name || name.endsWith(`:${s.name}`);
  });
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export interface Requirement {
  value: string;
  /** null = cannot be checked from NEXUS data. */
  met: boolean | null;
}

export interface Requirements {
  mcp: Requirement[];
  connections: Requirement[];
  permissions: Requirement[];
  dependencies: string[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Requirements recorded in `metadata.requires-*`, checked against this project's connections. */
export function requirements(s: Skill, connections: Connection[]): Requirements {
  const fm = s.frontmatter;
  const mcpConns = connections.filter((c) => c.kind === "mcp" || c.kind === "roblox_studio");
  const capabilityKeys = CAPABILITIES.map((c) => c.key as string);
  return {
    mcp: splitList(fm["metadata.requires-mcp"]).map((value) => ({
      value,
      met: mcpConns.some((c) => same(c.id, value) || same(c.name, value)),
    })),
    connections: splitList(fm["metadata.requires-connections"]).map((value) => ({
      value,
      met: connections.some((c) => same(c.id, value) || same(c.name, value) || same(c.kind, value)),
    })),
    permissions: splitList(fm["metadata.requires-permissions"]).map((value) => ({
      value,
      met: capabilityKeys.includes(value) ? true : null,
    })),
    dependencies: splitList(fm["metadata.dependencies"]),
  };
}

export function missingCount(r: Requirements): number {
  return [...r.mcp, ...r.connections].filter((x) => x.met === false).length;
}

/** Agents whose sessions load skills (skills are all-or-nothing per Claude Code session). */
export function agentsWithSkills(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.status !== "retired" && a.profile.skillsEnabled);
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateSkillName(name: string): string | null {
  if (!name) return "Enter a name.";
  return SKILL_NAME.test(name) ? null : "Use 1-64 lowercase letters, digits and dashes (not starting with a dash).";
}

export const COMMON_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "PowerShell", "WebFetch", "WebSearch"];

export const EMPTY_SKILL: NewSkill = {
  name: "",
  description: "",
  trigger: "",
  instructions: "",
  allowedTools: [],
  argumentHint: "",
  requiredMcp: [],
  requiredConnections: [],
  requiredPermissions: [],
  dependencies: [],
};

export function validateNewSkill(s: NewSkill): string | null {
  return validateSkillName(s.name) ?? (s.description.trim() ? null : "Enter a description: Claude Code uses it to decide when to load the skill.");
}

export function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** Lines of a unified diff with their kind, for coloring. */
export function diffLines(diff: string): { text: string; kind: "add" | "del" | "hunk" | "meta" | "ctx" }[] {
  return diff
    .split(/\r?\n/)
    .filter((l, i, all) => !(i === all.length - 1 && l === ""))
    .map((text) => {
      if (text.startsWith("+++") || text.startsWith("---")) return { text, kind: "meta" as const };
      if (text.startsWith("@@")) return { text, kind: "hunk" as const };
      if (text.startsWith("+")) return { text, kind: "add" as const };
      if (text.startsWith("-")) return { text, kind: "del" as const };
      return { text, kind: "ctx" as const };
    });
}
