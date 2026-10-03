// Pure helpers of the Skill Market: categories, filtering, sorting, labels and
// which actions an entry really supports (with the reason when it does not).

import type { MarketEntry, MarketSettings, MarketSignal, MarketStatus, SecurityReport } from "../../lib/types";
import type { Tone } from "../../lib/labels";

export type MarketCategory =
  | "all"
  | "installed"
  | "featured"
  | "popular"
  | "new"
  | "ui-ux"
  | "coding"
  | "roblox"
  | "web"
  | "devops"
  | "git"
  | "testing"
  | "security"
  | "documentation"
  | "automation"
  | "ai"
  | "3d"
  | "game-development";

export const MARKET_CATEGORIES: { id: MarketCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "featured", label: "Featured" },
  { id: "popular", label: "Popular" },
  { id: "new", label: "New" },
  { id: "ui-ux", label: "UI/UX" },
  { id: "coding", label: "Coding" },
  { id: "roblox", label: "Roblox" },
  { id: "web", label: "Web" },
  { id: "devops", label: "DevOps" },
  { id: "git", label: "Git" },
  { id: "testing", label: "Testing" },
  { id: "security", label: "Security" },
  { id: "documentation", label: "Documentation" },
  { id: "automation", label: "Automation" },
  { id: "ai", label: "AI" },
  { id: "3d", label: "3D" },
  { id: "game-development", label: "Game Development" },
];

/** "New": updated (real date from the plugin catalog or GitHub) in the last 60 days. */
export const NEW_DAYS = 60;
const DAY = 86_400_000;

function time(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function inCategory(e: MarketEntry, c: MarketCategory, now: number): boolean {
  switch (c) {
    case "all":
      return true;
    case "installed":
      return e.installed;
    case "featured":
      return e.featured;
    case "popular":
      return e.signal !== null && e.signal.value > 0;
    case "new": {
      const t = time(e.lastUpdated);
      return t !== null && now - t <= NEW_DAYS * DAY;
    }
    default:
      return e.categories.includes(c);
  }
}

export function matchesQuery(e: MarketEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [e.name, e.description, e.author ?? "", e.pluginId ?? "", e.repository ?? "", ...e.tags, ...e.skills.map((s) => s.name), ...e.sources.map((s) => s.label)]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

const byName = (a: MarketEntry, b: MarketEntry) => a.name.localeCompare(b.name);

/** Popular: real signal first; New: most recent; otherwise installed, featured, then name. */
export function sortEntries(list: MarketEntry[], c: MarketCategory): MarketEntry[] {
  const out = [...list];
  if (c === "popular") return out.sort((a, b) => (b.signal?.value ?? 0) - (a.signal?.value ?? 0) || byName(a, b));
  if (c === "new") return out.sort((a, b) => (time(b.lastUpdated) ?? 0) - (time(a.lastUpdated) ?? 0) || byName(a, b));
  return out.sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.featured) - Number(a.featured) || byName(a, b));
}

export function visibleEntries(entries: MarketEntry[], c: MarketCategory, query: string, now: number, only?: Set<string> | null): MarketEntry[] {
  return sortEntries(
    entries.filter((e) => (!only || only.has(e.id)) && inCategory(e, c, now) && matchesQuery(e, query)),
    c,
  );
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Short text of a real signal; null when there is none (no rating is ever invented). */
export function signalText(s: MarketSignal | null): string | null {
  if (!s) return null;
  return s.kind === "github-stars" ? `★ ${compactNumber(s.value)}` : `${compactNumber(s.value)} installs`;
}

export const OFFICIAL_LABEL = "Official (Anthropic)";

export function originLabel(e: MarketEntry): string {
  if (e.official) return OFFICIAL_LABEL;
  if (e.discovery === "discovered") return "Discovered on disk";
  return "Third-party";
}

export function methodLabel(e: MarketEntry): string {
  switch (e.installMethod) {
    case "plugin":
      return e.pluginId ? `Plugin ${e.pluginId}` : "Plugin";
    case "github-skill":
      return "Standalone skill (GitHub)";
    case "local":
      return "Skill on disk";
  }
}

export function isSynced(e: MarketEntry): boolean {
  return e.sources.some((s) => s.kind === "local" && s.label.startsWith("Synced"));
}

export type MarketActionKind = "install" | "enable" | "disable" | "configure" | "update" | "uninstall";

export interface ActionState {
  kind: MarketActionKind;
  available: boolean;
  /** Why it is not available (shown instead of the button). */
  reason?: string;
}

/** The actions of a card, each wired to a real mechanism or explained when impossible. */
export function entryActions(e: MarketEntry, status: MarketStatus | null): ActionState[] {
  const gh = status?.gh ?? false;
  const claude = status?.claude ?? false;
  const noClaude = "Claude Code was not detected";
  const noGh = "Needs the GitHub CLI (gh) on PATH";
  if (!e.installed) {
    if (e.installMethod === "plugin") return [{ kind: "install", available: claude, reason: claude ? undefined : noClaude }];
    if (e.installMethod === "github-skill") return [{ kind: "install", available: gh, reason: gh ? undefined : noGh }];
    return [];
  }
  if (e.installMethod === "plugin") {
    const a = (kind: MarketActionKind): ActionState => ({ kind, available: claude, reason: claude ? undefined : noClaude });
    return [a(e.enabled ? "disable" : "enable"), a("configure"), a("update"), a("uninstall")];
  }
  if (isSynced(e)) {
    const reason = "Synced from claude.ai: managed in claude.ai";
    return (["disable", "update", "uninstall"] as const).map((kind) => ({ kind, available: false, reason }));
  }
  const toggle: ActionState = { kind: e.enabled ? "disable" : "enable", available: true };
  const configure: ActionState = { kind: "configure", available: true };
  if (e.installMethod === "github-skill") {
    return [toggle, configure, { kind: "update", available: gh, reason: gh ? undefined : noGh }, { kind: "uninstall", available: true }];
  }
  return [
    toggle,
    configure,
    { kind: "update", available: false, reason: "Origin unknown: there is nothing to update from" },
    { kind: "uninstall", available: false, reason: "Not installed by NEXUS: delete it from the Skills view" },
  ];
}

export interface ScopeOption {
  value: string;
  label: string;
  available: boolean;
  hint: string;
}

export function installScopes(e: MarketEntry, status: MarketStatus | null): ScopeOption[] {
  const project = status?.project ?? false;
  const noProject = "Open a project first";
  if (e.installMethod === "plugin") {
    return [
      { value: "user", label: "User", available: true, hint: "Every project on this machine (claude plugin install --scope user)" },
      { value: "project", label: "Project (shared)", available: project, hint: project ? "Recorded in the project's .claude/settings.json" : noProject },
      { value: "local", label: "Project (local)", available: project, hint: project ? "This project, only for you (.claude/settings.local.json)" : noProject },
    ];
  }
  return [
    { value: "user", label: "User", available: true, hint: "~/.claude/skills/<name>" },
    { value: "project", label: "Project", available: project, hint: project ? "<project>/.claude/skills/<name>" : noProject },
  ];
}

export function securityTone(s: SecurityReport["status"]): Tone {
  return s === "clean" ? "green" : s === "danger" ? "red" : "amber";
}

export function securityLabel(s: SecurityReport["status"]): string {
  switch (s) {
    case "clean":
      return "No sensitive capability found";
    case "review":
      return "Review needed";
    case "danger":
      return "Dangerous capabilities";
    case "incomplete":
      return "Not inspected";
  }
}

export const AUTO_REFRESH_MS = DAY;

/** Periodic refresh when the market opens: enabled in settings and older than a day. */
export function shouldAutoRefresh(settings: MarketSettings | null, lastRefresh: string | null, now: number): boolean {
  if (!settings?.autoRefresh) return false;
  const t = time(lastRefresh);
  return t === null || now - t >= AUTO_REFRESH_MS;
}

/** Parses the "user repositories" text area (one owner/repo or GitHub URL per line). */
export function parseRepos(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export const SKILL_SCOPE_TEXT = "Skill scope: Global / Agent-compatible";
export const SKILL_LIMITATION_TEXT = "Claude Code limitation: This Skill cannot be selectively enabled per agent.";
