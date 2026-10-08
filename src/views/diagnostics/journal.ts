// Journal entries (the persisted event log) normalized for the Activity chain and Diagnostics (pure, tested).
// Events from 0.4 carry a dotted name, severity, source and PID; older rows and live events
// that lack them get values derived from their kind.

import type { Mission, PccEvent } from "../../lib/types";
import { t } from "../../i18n";

export type Severity = "info" | "warning" | "error" | "critical";
export const SEVERITIES: Severity[] = ["info", "warning", "error", "critical"];

export interface JournalEntry extends PccEvent {
  name: string;
  severity: Severity;
  source: string;
  pid: number | null;
}

const ERROR_KINDS = new Set(["Error", "AgentCrashed", "TaskFailed"]);
const WARNING_KINDS = new Set(["PermissionRequested", "UserRequested", "ReviewRequested"]);

/** "AgentStarted" → "agent.started", "PermissionAutoApproved" → "permission.autoApproved". */
export function defaultName(kind: string): string {
  if (kind === "Error") return "controlCenter.error";
  if (kind === "EmergencyStop") return "controlCenter.emergencyStop";
  const m = /^([A-Z][a-z]+)(.*)$/.exec(kind);
  if (!m || !m[2]) return kind.toLowerCase();
  return `${m[1].toLowerCase()}.${m[2][0].toLowerCase()}${m[2].slice(1)}`;
}

export function defaultSeverity(kind: string): Severity {
  if (kind === "EmergencyStop") return "critical";
  if (ERROR_KINDS.has(kind)) return "error";
  if (WARNING_KINDS.has(kind)) return "warning";
  return "info";
}

export function toEntry(e: PccEvent): JournalEntry {
  const x = e as PccEvent & { name?: unknown; severity?: unknown; source?: unknown; pid?: unknown };
  return {
    ...e,
    name: typeof x.name === "string" && x.name ? x.name : defaultName(e.kind),
    severity: SEVERITIES.includes(x.severity as Severity) ? (x.severity as Severity) : defaultSeverity(e.kind),
    source: typeof x.source === "string" && x.source ? x.source : "engine",
    pid: typeof x.pid === "number" ? x.pid : null,
  };
}

/** Newest first, one entry per id (live events and pages overlap). */
export function mergeEntries(...lists: PccEvent[][]): JournalEntry[] {
  const byId = new Map<number, JournalEntry>();
  for (const list of lists)
    for (const e of list) {
      // Non-persistent events have id 0 and are not part of the journal.
      if (e.id > 0 && !byId.has(e.id)) byId.set(e.id, toEntry(e));
    }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export interface ChainFilter {
  agentId?: string;
  missionId?: string;
  /** Minimum severity. */
  severity?: Severity;
  source?: string;
  /** Free text over name, summary, agent and PID. */
  text?: string;
}

export function matches(e: JournalEntry, f: ChainFilter, agentName: (id: string) => string = (id) => id): boolean {
  if (f.agentId && e.agentId !== f.agentId) return false;
  if (f.missionId && e.missionId !== f.missionId) return false;
  if (f.severity && SEVERITIES.indexOf(e.severity) < SEVERITIES.indexOf(f.severity)) return false;
  if (f.source && e.source !== f.source) return false;
  if (f.text) {
    const q = f.text.toLowerCase();
    const hay = `${e.name} ${e.summary} ${e.agentId ? agentName(e.agentId) : ""} ${e.pid ?? ""} ${e.source}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export interface MissionGroup {
  /** Mission id, or null for everything outside missions. */
  missionId: string | null;
  title: string;
  mission: Mission | null;
  /** Oldest first: the chain reads top to bottom. */
  entries: JournalEntry[];
  first: string;
  last: string;
  counts: Record<Severity, number>;
}

/** Groups entries by mission; groups ordered by their latest entry (newest first). */
export function groupByMission(entries: JournalEntry[], missions: Mission[]): MissionGroup[] {
  const groups = new Map<string, MissionGroup>();
  for (const e of entries) {
    const key = e.missionId ?? "";
    let g = groups.get(key);
    if (!g) {
      const mission = missions.find((m) => m.id === e.missionId) ?? null;
      g = {
        missionId: e.missionId,
        title: e.missionId ? (mission?.title ?? t("act.missionId", { id: e.missionId })) : t("act.outsideMissions"),
        mission,
        entries: [],
        first: e.ts,
        last: e.ts,
        counts: { info: 0, warning: 0, error: 0, critical: 0 },
      };
      groups.set(key, g);
    }
    g.entries.push(e);
    g.counts[e.severity] += 1;
    if (e.ts < g.first) g.first = e.ts;
    if (e.ts > g.last) g.last = e.ts;
  }
  const list = [...groups.values()];
  for (const g of list) g.entries.sort((a, b) => a.id - b.id);
  return list.sort((a, b) => Math.max(...b.entries.map((e) => e.id)) - Math.max(...a.entries.map((e) => e.id)));
}

/** Restarts and crashes, for the Diagnostics "Restarts" section. */
export function isRestartEvent(e: JournalEntry): boolean {
  return /restart|recover|crash|resum/i.test(e.name) || e.kind === "AgentCrashed";
}
