// Local checkpoint of unsaved UI state, restored after the interface is reloaded
// (open view, right-panel context, command-bar draft). Workspace tabs are saved
// by the backend already (workspace.json). Storage may be unavailable: every
// access is guarded and a missing checkpoint simply restores nothing.

import type { RightContext } from "../../state/context";
import type { View } from "../../store";

const KEY = "nexus.uiCheckpoint";
const RELOADS_KEY = "nexus.autoReloads";
/** Older checkpoints are ignored (another session, or a long time ago). */
export const CHECKPOINT_MAX_AGE_MS = 15 * 60_000;

export interface UiCheckpoint {
  v: 1;
  savedAt: number;
  projectId: string;
  view: View;
  right: RightContext;
  barText: string;
}

const RIGHT_KINDS = ["central", "agent", "mission", "skill"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseCheckpoint(raw: string | null, projectId: string, now: number): UiCheckpoint | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(v) || v.v !== 1 || v.projectId !== projectId) return null;
  if (typeof v.savedAt !== "number" || now - v.savedAt > CHECKPOINT_MAX_AGE_MS || v.savedAt > now + 60_000) return null;
  if (!isObject(v.view) || typeof v.view.name !== "string") return null;
  if (!isObject(v.right) || !RIGHT_KINDS.includes(String(v.right.kind))) return null;
  return {
    v: 1,
    savedAt: v.savedAt,
    projectId,
    view: v.view as unknown as View,
    right: v.right as unknown as RightContext,
    barText: typeof v.barText === "string" ? v.barText : "",
  };
}

function read(key: string): string | null {
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try {
      const raw = storage().getItem(key);
      if (raw !== null) return raw;
    } catch {
      // Unavailable: try the next one.
    }
  }
  return null;
}

function write(key: string, value: string): void {
  // sessionStorage survives a reload; localStorage also survives a recreated window.
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try {
      storage().setItem(key, value);
    } catch {
      // Full or blocked: that copy is simply not kept.
    }
  }
}

export function saveCheckpoint(cp: Omit<UiCheckpoint, "v" | "savedAt">, now = Date.now()): void {
  write(KEY, JSON.stringify({ v: 1, savedAt: now, ...cp }));
}

export function loadCheckpoint(projectId: string, now = Date.now()): UiCheckpoint | null {
  return parseCheckpoint(read(KEY), projectId, now);
}

/** Times of the automatic reloads done by the Safe Recovery Overlay (to avoid reload loops). */
export function autoReloadHistory(): number[] {
  try {
    const v: unknown = JSON.parse(read(RELOADS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((t): t is number => typeof t === "number") : [];
  } catch {
    return [];
  }
}

export function pushAutoReload(now = Date.now()): void {
  write(RELOADS_KEY, JSON.stringify([...autoReloadHistory().filter((t) => now - t < 3_600_000), now].slice(-10)));
}
