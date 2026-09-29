// Fans out the single Tauri log channel to per-agent subscribers, so each terminal
// doesn't register its own native listener.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { onLog } from "./api";
import type { LogEntry } from "./types";

type Listener = (entry: LogEntry) => void;

const listeners = new Map<string, Set<Listener>>();
let native: Promise<UnlistenFn> | null = null;

function dispatch(entry: LogEntry) {
  const set = listeners.get(entry.agentId);
  if (set) for (const l of set) l(entry);
}

/** Subscribes to live log entries of one agent. Returns an unsubscribe function. */
export function subscribeLogs(agentId: string, listener: Listener): () => void {
  if (!native) native = onLog(dispatch);
  let set = listeners.get(agentId);
  if (!set) {
    set = new Set();
    listeners.set(agentId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(agentId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(agentId);
  };
}

/** Merges two id-sorted log lists, dropping duplicates. */
export function mergeLogs(a: LogEntry[], b: LogEntry[]): LogEntry[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const seen = new Set<number>();
  const out: LogEntry[] = [];
  for (const e of [...a, ...b].sort((x, y) => x.id - y.id)) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}
