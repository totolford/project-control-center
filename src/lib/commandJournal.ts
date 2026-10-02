// Command journal helpers (pure, tested).

import type { Tone } from "./labels";
import type { CommandRecord } from "./types";

export const COMMAND_DECISIONS: { value: string; label: string; tone: Tone }[] = [
  { value: "allowed", label: "Allowed", tone: "green" },
  { value: "auto_approved", label: "Auto-approved", tone: "accent" },
  { value: "user", label: "By you", tone: "blue" },
  { value: "asked", label: "Asked", tone: "amber" },
  { value: "denied", label: "Denied", tone: "red" },
];

export function commandDecisionMeta(decision: string | null): { label: string; tone: Tone } {
  if (decision === null) return { label: "—", tone: "dim" };
  return COMMAND_DECISIONS.find((d) => d.value === decision) ?? { label: decision, tone: "grey" };
}

/** Milliseconds as "420 ms", "3.4 s", "2m 05s", "1h 02m". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}h ${two(m)}m` : `${m}m ${two(sec)}s`;
}

/** endedAt − startedAt; "—" while unfinished or when a timestamp is invalid. */
export function commandDuration(r: Pick<CommandRecord, "startedAt" | "endedAt">): string {
  if (!r.endedAt) return "—";
  return formatMs(new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime());
}

export function formatExit(code: number | null): string {
  return code === null ? "—" : String(code);
}

/** Merges pages/refreshes by id, newest first, without duplicates. */
export function mergeCommands(current: CommandRecord[], incoming: CommandRecord[]): CommandRecord[] {
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export function oldestCommandId(list: CommandRecord[]): number | null {
  return list.length === 0 ? null : list.reduce((m, r) => Math.min(m, r.id), Number.MAX_SAFE_INTEGER);
}

export function filterCommands(list: CommandRecord[], f: { source: string; decision: string; errorsOnly: boolean }): CommandRecord[] {
  return list.filter((r) => (!f.source || r.source === f.source) && (!f.decision || r.decision === f.decision) && (!f.errorsOnly || r.isError === true));
}
