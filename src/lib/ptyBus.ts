// Fans out the single Tauri PTY channel to per-session subscribers (like logBus for agent logs).

import type { UnlistenFn } from "@tauri-apps/api/event";
import { onPty } from "./api";
import type { PtyEvent } from "./types";

type Listener = (e: PtyEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const observers = new Set<Listener>();
let native: Promise<UnlistenFn> | null = null;

function dispatch(e: PtyEvent) {
  for (const o of observers) o(e);
  const set = listeners.get(e.id);
  if (set) for (const l of set) l(e);
}

function ensureNative() {
  if (!native) native = onPty(dispatch);
}

/** Every PTY event (all sessions). Returns an unsubscribe function. */
export function observeAllPty(observer: Listener): () => void {
  ensureNative();
  observers.add(observer);
  return () => observers.delete(observer);
}

/** Events of one terminal session. Returns an unsubscribe function. */
export function subscribePty(id: string, listener: Listener): () => void {
  ensureNative();
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}
