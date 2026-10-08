// Readers over ClaudeEnvironment. Claude Code's payloads are passed through untyped:
// these helpers only extract fields that are really present and never fill gaps.

import type { ClaudeEnvironment, CliOption, Connection } from "./types";
import { lazyLabels } from "../i18n";

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "five_hour" → "Five hour", "supportsFastMode" → "Supports fast mode". */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ------------------------------------------------------------------ usage

export interface RateLimit {
  key: string;
  label: string;
  /** Utilization percentage as reported (0..100). */
  percent: number;
  resetsAt: string | null;
}

/**
 * Documented subscription windows. get_usage also returns internal keys (code
 * names) without meaning for the user: those are not shown.
 */
const LIMIT_LABEL: Record<string, string> = lazyLabels({
  five_hour: "claudeEnv.limit.five_hour",
  seven_day: "claudeEnv.limit.seven_day",
  seven_day_opus: "claudeEnv.limit.seven_day_opus",
  seven_day_sonnet: "claudeEnv.limit.seven_day_sonnet",
  seven_day_oauth_apps: "claudeEnv.limit.seven_day_oauth_apps",
});

/** Documented rate-limit windows reported in usage.rate_limits that carry a utilization. */
export function rateLimits(usage: Obj | null | undefined): RateLimit[] {
  const raw = isObj(usage) ? usage.rate_limits : null;
  if (!isObj(raw)) return [];
  const out: RateLimit[] = [];
  for (const [key, v] of Object.entries(raw)) {
    if (!isObj(v) || !(key in LIMIT_LABEL)) continue;
    const percent = num(v.utilization);
    if (percent === null) continue;
    out.push({ key, label: LIMIT_LABEL[key], percent, resetsAt: str(v.resets_at) });
  }
  const order = (k: string) => (k === "five_hour" ? 0 : k === "seven_day" ? 1 : 2);
  return out.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
}

export interface ContextUsage {
  percent: number | null;
  totalTokens: number | null;
  maxTokens: number | null;
  categories: { name: string; tokens: number | null; kind: string | null }[];
}

export function contextUsage(context: Obj | null | undefined): ContextUsage | null {
  if (!isObj(context)) return null;
  const total = num(context.totalTokens);
  const max = num(context.maxTokens);
  const reported = num(context.percentage);
  const categories = Array.isArray(context.categories)
    ? context.categories.filter(isObj).map((c) => ({ name: str(c.name) ?? "—", tokens: num(c.tokens), kind: str(c.kind) }))
    : [];
  const percent = reported ?? (total !== null && max ? (total / max) * 100 : null);
  return { percent, totalTokens: total, maxTokens: max, categories };
}

/** Percentage (0..100) to a bar ratio. */
export function percentRatio(percent: number | null): number | null {
  return percent === null ? null : Math.min(1, Math.max(0, percent / 100));
}

// ------------------------------------------------------------------ models

const KNOWN_MODEL_KEYS = new Set(["value", "resolvedModel", "displayName", "description", "supportsEffort", "supportedEffortLevels"]);

export const DEFAULT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export function modelValue(m: Obj): string | null {
  return str(m.value);
}

export function modelLabel(m: Obj): string {
  return str(m.displayName) ?? str(m.value) ?? "—";
}

/** Effort levels the model declares; null when it declares none (caller decides the fallback). */
export function effortLevels(m: Obj | undefined): string[] | null {
  if (!m) return null;
  if (m.supportsEffort === false) return [];
  const levels = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((l): l is string => typeof l === "string") : [];
  return levels.length > 0 ? levels : null;
}

/** Boolean fields other than the ones shown in their own column, as capability chips. */
export function modelFlags(m: Obj): { key: string; label: string; value: boolean }[] {
  return Object.entries(m)
    .filter(([k, v]) => typeof v === "boolean" && !KNOWN_MODEL_KEYS.has(k))
    .map(([k, v]) => ({ key: k, label: humanize(k.replace(/^supports/, "")), value: v as boolean }));
}

/** Fields named like context/speed/cost if Claude Code reports them, else null. */
export function modelField(m: Obj, pattern: RegExp): string | null {
  const entry = Object.entries(m).find(([k, v]) => pattern.test(k) && (typeof v === "string" || typeof v === "number"));
  return entry ? String(entry[1]) : null;
}

// ------------------------------------------------------------------ MCP / skills

/** Claude Code MCP servers reported as connected + enabled healthy NEXUS MCP connections. */
export function mcpConnectedCount(env: ClaudeEnvironment | null, connections: Connection[]): { claude: number | null; nexus: number } {
  const claude = env && !env.unavailable.some((u) => u.startsWith("MCP")) ? env.mcpServers.filter((s) => s.status === "connected").length : null;
  const nexus = connections.filter((c) => (c.kind === "mcp" || c.kind === "roblox_studio") && c.enabled && c.status === "connected").length;
  return { claude, nexus };
}

// ------------------------------------------------------------------ settings

/** Value of a CLI option derivable from Claude Code's effective settings, else null. */
export function currentOptionValue(option: Pick<CliOption, "long">, settings: Obj | null | undefined): string | null {
  const effective = isObj(settings) && isObj(settings.effective) ? settings.effective : null;
  if (!effective) return null;
  const permissions = isObj(effective.permissions) ? effective.permissions : null;
  const value: unknown =
    option.long === "--model"
      ? effective.model
      : option.long === "--effort"
        ? effective.effortLevel
        : option.long === "--permission-mode"
          ? permissions?.defaultMode
          : undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Hides e-mail addresses (`a••••@example.com`) so the account can be shown on a shared screen. */
export function maskAccount(account: Obj | null | undefined): Obj | null {
  if (!isObj(account)) return null;
  const mask = (v: unknown) =>
    typeof v === "string" ? v.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g, (_m, first: string) => `${first}••••@`) : v;
  return Object.fromEntries(Object.entries(account).map(([k, v]) => [k, mask(v)]));
}
