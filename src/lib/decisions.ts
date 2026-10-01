// Approval journal helpers (pure, tested).

import type { Tone } from "./labels";
import type { DecisionRecord } from "./types";

export const DECISIONS: { value: string; label: string; tone: Tone }[] = [
  { value: "auto_approved", label: "Auto-approved", tone: "accent" },
  { value: "user_allowed", label: "User allowed", tone: "green" },
  { value: "user_rejected", label: "User rejected", tone: "red" },
  { value: "allowed", label: "Allowed (policy)", tone: "green" },
  { value: "denied", label: "Denied (policy)", tone: "red" },
  { value: "asked", label: "Asked", tone: "amber" },
];

export function decisionMeta(decision: string): { label: string; tone: Tone } {
  return DECISIONS.find((d) => d.value === decision) ?? { label: decision, tone: "grey" };
}

export interface DecisionFilter {
  agentId: string;
  decision: string;
}

export function filterDecisions(list: DecisionRecord[], f: DecisionFilter): DecisionRecord[] {
  return list.filter((d) => (!f.agentId || d.agentId === f.agentId) && (!f.decision || d.decision === f.decision));
}

/** Merges pages/refreshes by id, newest first, without duplicates. */
export function mergeDecisions(current: DecisionRecord[], incoming: DecisionRecord[]): DecisionRecord[] {
  const byId = new Map(current.map((d) => [d.id, d]));
  for (const d of incoming) byId.set(d.id, d);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export function oldestId(list: DecisionRecord[]): number | null {
  return list.length === 0 ? null : list.reduce((m, d) => Math.min(m, d.id), Number.MAX_SAFE_INTEGER);
}
