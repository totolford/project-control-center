// Pure helpers of the MCP manager: status mapping, scope grouping, redaction and
// conversion between NEXUS connection configs and Claude Code's format.

import type { Tone } from "../../lib/labels";
import type { Agent, Connection, McpConnectionConfig, PccEvent } from "../../lib/types";

export const MASK = "••••";

export interface StatusMeta {
  label: string;
  tone: Tone;
}

const CLAUDE_STATUS: Record<string, StatusMeta> = {
  connected: { label: "Connected", tone: "green" },
  failed: { label: "Error", tone: "red" },
  pending: { label: "Pending", tone: "amber" },
  "needs-auth": { label: "Needs authentication", tone: "amber" },
  disabled: { label: "Disabled", tone: "dim" },
};

/** Status reported by Claude Code; unknown values are shown raw. */
export function claudeStatus(status: unknown): StatusMeta {
  if (typeof status !== "string" || !status) return { label: "Unknown", tone: "grey" };
  return CLAUDE_STATUS[status] ?? { label: status, tone: "grey" };
}

const NEXUS_STATUS: Record<string, StatusMeta> = {
  unknown: { label: "Not tested", tone: "grey" },
  connected: { label: "Connected", tone: "green" },
  disconnected: { label: "Disconnected", tone: "orange" },
  error: { label: "Error", tone: "red" },
};

export function nexusStatus(c: Connection): StatusMeta {
  if (!c.enabled) return { label: "Disabled", tone: "dim" };
  return NEXUS_STATUS[c.status] ?? { label: c.status, tone: "grey" };
}

export type ScopeGroup = "global" | "project" | "plugin" | "other";

export const SCOPE_GROUPS: { key: ScopeGroup; label: string; hint: string }[] = [
  { key: "global", label: "Global", hint: "User configuration and claude.ai connectors: available in every project." },
  { key: "project", label: "Project", hint: ".mcp.json (shared) and local (this project only) configuration." },
  { key: "plugin", label: "Plugin", hint: "Provided by installed Claude Code plugins." },
  { key: "other", label: "Other", hint: "Scopes NEXUS does not classify; shown as reported." },
];

export function scopeGroup(scope: unknown): ScopeGroup {
  switch (scope) {
    case "user":
    case "claudeai":
      return "global";
    case "project":
    case "local":
      return "project";
    case "plugin":
      return "plugin";
    default:
      return "other";
  }
}

const SCOPE_LABEL: Record<string, string> = {
  user: "User (global)",
  claudeai: "claude.ai connector",
  project: "Project (.mcp.json)",
  local: "Local (this project only)",
  plugin: "Plugin",
};

export function scopeLabel(scope: unknown): string {
  return typeof scope === "string" ? SCOPE_LABEL[scope] ?? scope : "Unknown scope";
}

/** Only these scopes can be changed with `claude mcp remove -s <scope>`. */
export function isRemovableScope(scope: unknown): scope is "user" | "project" | "local" {
  return scope === "user" || scope === "project" || scope === "local";
}

/** A server from ClaudeEnvironment.mcpServers. */
export interface ClaudeServer {
  name: string;
  status: unknown;
  error: string | null;
  config: Record<string, unknown>;
  scope: unknown;
  source: unknown;
}

export function asClaudeServer(raw: Record<string, any>): ClaudeServer {
  return {
    name: String(raw.name ?? ""),
    status: raw.status,
    error: typeof raw.error === "string" && raw.error ? raw.error : null,
    config: raw.config && typeof raw.config === "object" ? raw.config : {},
    scope: raw.scope,
    source: raw.source,
  };
}

export function groupByScope(servers: ClaudeServer[]): { group: (typeof SCOPE_GROUPS)[number]; servers: ClaudeServer[] }[] {
  return SCOPE_GROUPS.map((group) => ({ group, servers: servers.filter((s) => scopeGroup(s.scope) === group.key) })).filter(
    (g) => g.servers.length > 0,
  );
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** Names of a key/value map (env, headers); values are never shown. */
export function mapNames(v: unknown): string[] {
  return Object.keys(record(v));
}

/** Copy of a Claude-format config whose env / header values are masked. */
export function redactClaudeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const key of ["env", "headers"]) {
    if (config[key] && typeof config[key] === "object") {
      out[key] = Object.fromEntries(mapNames(config[key]).map((k) => [k, MASK]));
    }
  }
  return out;
}

/** Transport / target summary of a Claude-format config. */
export function claudeTarget(config: Record<string, unknown>): { transport: string; target: string } {
  const transport = typeof config.type === "string" ? config.type : "stdio";
  if (typeof config.url === "string") return { transport, target: config.url };
  if (typeof config.command === "string") return { transport, target: [config.command, ...strings(config.args)].join(" ") };
  return { transport, target: "Not exposed by Claude Code" };
}

/** Reads a stored NEXUS MCP config, filling fields older connections may lack. */
export function asMcpConfig(raw: Record<string, unknown>): McpConnectionConfig {
  const transport = raw.transport === "http" || raw.transport === "sse" ? raw.transport : "stdio";
  const strMap = (v: unknown) => Object.fromEntries(Object.entries(record(v)).map(([k, x]) => [k, String(x)]));
  return {
    transport,
    command: typeof raw.command === "string" ? raw.command : "",
    args: strings(raw.args),
    env: strMap(raw.env),
    secretEnv: strings(raw.secretEnv),
    url: typeof raw.url === "string" ? raw.url : "",
    headers: strMap(raw.headers),
    secretHeaders: strings(raw.secretHeaders),
  };
}

export function isRemote(cfg: McpConnectionConfig): boolean {
  return cfg.transport === "http" || cfg.transport === "sse";
}

export function nexusTarget(cfg: McpConnectionConfig): string {
  return isRemote(cfg) ? cfg.url : [cfg.command, ...cfg.args].join(" ");
}

/** Redacted view of a NEXUS MCP config: plain values are kept, secret names are masked. */
export function redactNexusConfig(cfg: McpConnectionConfig): Record<string, unknown> {
  const masked = (names: string[]) => Object.fromEntries(names.map((n) => [n, `${MASK} (Credential Manager)`]));
  if (isRemote(cfg)) return { transport: cfg.transport, url: cfg.url, headers: { ...cfg.headers, ...masked(cfg.secretHeaders) } };
  return { transport: "stdio", command: cfg.command, args: cfg.args, env: { ...cfg.env, ...masked(cfg.secretEnv) } };
}

/**
 * Claude-format config of a NEXUS MCP config. `secretValues` fills secret names
 * (used to test a server before it is saved); missing secrets are left out.
 */
export function toClaudeConfig(cfg: McpConnectionConfig, secretValues: Record<string, string> = {}): Record<string, unknown> {
  const withSecrets = (plain: Record<string, string>, names: string[]) => {
    const out = { ...plain };
    for (const n of names) if (secretValues[n]) out[n] = secretValues[n];
    return out;
  };
  if (isRemote(cfg)) return { type: cfg.transport, url: cfg.url, headers: withSecrets(cfg.headers, cfg.secretHeaders) };
  return { type: "stdio", command: cfg.command, args: cfg.args, env: withSecrets(cfg.env, cfg.secretEnv) };
}

export function isMcpConnection(c: Connection): boolean {
  return c.kind === "mcp" || c.kind === "roblox_studio";
}

/** Agents granted the connection (launch only loads granted, enabled connections, Central included). */
export function agentsUsing(conn: Connection, agents: Agent[]): Agent[] {
  return agents.filter((a) => a.status !== "retired" && a.connections.includes(conn.id));
}

/** Tool prefix under which a NEXUS MCP connection is exposed to agents. */
export function toolPrefix(connectionId: string): string {
  return `mcp__${connectionId}__`;
}

/** ToolUsed events of a connection's tools, newest first, without duplicates. */
export function toolEvents(events: PccEvent[], connectionId: string, limit = 50): PccEvent[] {
  const prefix = toolPrefix(connectionId);
  const seen = new Set<number>();
  return events
    .filter((e) => e.kind === "ToolUsed" && typeof e.payload?.tool === "string" && e.payload.tool.startsWith(prefix))
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}
