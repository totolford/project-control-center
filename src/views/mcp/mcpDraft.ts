// State, validation and outputs of the Add / Edit MCP wizard (pure).

import type { ConnectionInput, McpCandidate, McpConnectionConfig } from "../../lib/types";
import { isRemote, toClaudeConfig } from "./mcpModel";

export type McpTarget = "nexus" | "claude";
export type ClaudeScope = "local" | "user" | "project";
export type Transport = McpConnectionConfig["transport"];

export interface DraftVar {
  key: string;
  value: string;
  secret: boolean;
}

export interface McpDraft {
  name: string;
  target: McpTarget;
  claudeScope: ClaudeScope;
  transport: Transport;
  command: string;
  /** One argument per line. */
  args: string;
  url: string;
  /** Environment variables (stdio) or HTTP headers (http / sse). */
  vars: DraftVar[];
  kind: "mcp" | "roblox_studio";
  agentIds: string[];
  /** Secret names already stored for the connection being edited (blank value = keep). */
  storedSecrets: string[];
}

export const EMPTY_DRAFT: McpDraft = {
  name: "",
  target: "nexus",
  claudeScope: "local",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  vars: [],
  kind: "mcp",
  agentIds: [],
  storedSecrets: [],
};

export type StepKey = "name" | "target" | "transport" | "server" | "vars" | "kind" | "permissions" | "agents" | "test" | "save";

export const STEP_LABELS: Record<StepKey, string> = {
  name: "Name",
  target: "Destination",
  transport: "Transport",
  server: "Server",
  vars: "Variables",
  kind: "Kind",
  permissions: "Permissions",
  agents: "Agents",
  test: "Test",
  save: "Save",
};

/** Steps shown for a draft: Claude Code config has no kind, permissions or agents; edits keep their destination. */
export function stepsFor(d: McpDraft, editing: boolean): StepKey[] {
  const all: StepKey[] = ["name", "target", "transport", "server", "vars", "kind", "permissions", "agents", "test", "save"];
  return all.filter((s) => {
    if (s === "target") return !editing;
    if (s === "kind" || s === "permissions" || s === "agents") return d.target === "nexus";
    return true;
  });
}

const ENV_NAME = /^[A-Za-z0-9_]+$/;
const HEADER_NAME = /^[A-Za-z0-9_-]+$/;
const CLAUDE_NAME = /^[A-Za-z0-9_-]+$/;

/** `${VAR}` reference accepted in Claude Code's config files. */
export function isVarReference(value: string): boolean {
  return /^\$\{[^{}\s]+\}$/.test(value.trim());
}

export function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** First problem of a step, or null when it is complete. */
export function validateStep(step: StepKey, d: McpDraft): string | null {
  switch (step) {
    case "name":
      if (!d.name.trim()) return "Enter a name.";
      if (d.target === "claude" && !CLAUDE_NAME.test(d.name.trim()))
        return "Claude Code server names use letters, digits, dashes and underscores.";
      return null;
    case "server":
      if (d.transport === "stdio") return d.command.trim() ? null : "Enter the command that starts the server.";
      return /^https?:\/\/\S+$/.test(d.url.trim()) ? null : "Enter an http(s) URL.";
    case "vars":
      return validateVars(d);
    default:
      return null;
  }
}

function validateVars(d: McpDraft): string | null {
  const headers = d.transport !== "stdio";
  const pattern = headers ? HEADER_NAME : ENV_NAME;
  const seen = new Set<string>();
  for (const v of d.vars) {
    const key = v.key.trim();
    if (!key) return "Every row needs a name.";
    if (!pattern.test(key)) return `\`${key}\` is not a valid ${headers ? "header" : "environment variable"} name.`;
    if (seen.has(key)) return `\`${key}\` is defined twice.`;
    seen.add(key);
    if (d.target === "claude") {
      if (!isVarReference(v.value))
        return `\`${key}\` must be a \${VAR} reference: Claude Code config files never receive secret values.`;
    } else if (v.secret && !v.value && !d.storedSecrets.includes(key)) {
      return `Enter the secret value of \`${key}\`.`;
    }
  }
  return null;
}

export function firstInvalidStep(d: McpDraft, editing: boolean): StepKey | null {
  return stepsFor(d, editing).find((s) => validateStep(s, d) !== null) ?? null;
}

/** NEXUS connection config plus the secret values to store (blank = keep the stored value). */
export function buildNexusInput(d: McpDraft): ConnectionInput {
  const remote = d.transport !== "stdio";
  const plain: Record<string, string> = {};
  const secretNames: string[] = [];
  const secrets: Record<string, string> = {};
  for (const v of d.vars) {
    const key = v.key.trim();
    if (v.secret) {
      secretNames.push(key);
      if (v.value) secrets[key] = v.value;
    } else plain[key] = v.value;
  }
  const config: McpConnectionConfig = {
    transport: d.transport,
    command: remote ? "" : d.command.trim(),
    args: remote ? [] : parseArgs(d.args),
    env: remote ? {} : plain,
    secretEnv: remote ? [] : secretNames,
    url: remote ? d.url.trim() : "",
    headers: remote ? plain : {},
    secretHeaders: remote ? secretNames : [],
  };
  return { name: d.name.trim(), kind: d.kind, config: { ...config }, secrets: Object.keys(secrets).length ? secrets : undefined };
}

/** Claude-format config for `claude mcp add-json` (values are ${VAR} references). */
export function buildClaudeConfig(d: McpDraft): Record<string, unknown> {
  const values = Object.fromEntries(d.vars.map((v) => [v.key.trim(), v.value.trim()]));
  if (d.transport !== "stdio") return { type: d.transport, url: d.url.trim(), headers: values };
  return { type: "stdio", command: d.command.trim(), args: parseArgs(d.args), env: values };
}

/**
 * Config to test before saving, with real values. Null when a kept secret's
 * value is not known to the UI (edit mode): the saved connection must be probed instead.
 */
export function buildTestConfig(d: McpDraft): Record<string, unknown> | null {
  if (d.target === "claude") return buildClaudeConfig(d);
  if (d.vars.some((v) => v.secret && !v.value)) return null;
  const input = buildNexusInput(d);
  return toClaudeConfig(input.config as unknown as McpConnectionConfig, input.secrets ?? {});
}

/** Draft prefilled from a stored NEXUS connection (secret values stay blank = keep). */
export function draftFromConnection(
  name: string,
  kind: "mcp" | "roblox_studio",
  cfg: McpConnectionConfig,
  agentIds: string[],
): McpDraft {
  const remote = isRemote(cfg);
  const plain = remote ? cfg.headers : cfg.env;
  const secretNames = remote ? cfg.secretHeaders : cfg.secretEnv;
  return {
    ...EMPTY_DRAFT,
    name,
    kind,
    transport: cfg.transport,
    command: cfg.command,
    args: cfg.args.join("\n"),
    url: cfg.url,
    vars: [
      ...Object.entries(plain).map(([key, value]) => ({ key, value, secret: false })),
      ...secretNames.map((key) => ({ key, value: "", secret: true })),
    ],
    agentIds,
    storedSecrets: secretNames,
  };
}

/** Applies a detected server (known servers / Roblox detection) to a draft. Values detected are treated as secrets. */
export function applyCandidate(d: McpDraft, c: McpCandidate, kind: "mcp" | "roblox_studio"): McpDraft {
  const secretNames = new Set(c.config.secretEnv);
  return {
    ...d,
    name: d.name.trim() ? d.name : c.name,
    kind,
    transport: "stdio",
    command: c.config.command,
    args: c.config.args.join("\n"),
    vars: [
      ...Object.entries(c.config.env).map(([key, value]) => ({ key, value, secret: secretNames.has(key) })),
      ...c.config.secretEnv.filter((k) => !(k in c.config.env)).map((key) => ({ key, value: "", secret: true })),
    ],
  };
}
