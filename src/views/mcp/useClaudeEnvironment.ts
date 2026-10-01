// Shared, cached snapshot of what Claude Code exposes (api.claudeEnvironment takes a few seconds).

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, errorMessage } from "../../lib/api";
import type { ClaudeEnvironment } from "../../lib/types";

interface EnvState {
  env: ClaudeEnvironment | null;
  loading: boolean;
  error: string | null;
}

let state: EnvState = { env: null, loading: false, error: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<EnvState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function load(): Promise<void> {
  if (inflight) return inflight;
  set({ loading: true, error: null });
  inflight = api
    .claudeEnvironment()
    .then((env) => set({ env, loading: false }))
    .catch((e) => set({ loading: false, error: errorMessage(e) }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Loads once per app session; `refresh` asks Claude Code again. */
export function useClaudeEnvironment(): EnvState & { refresh: () => Promise<void> } {
  const snap = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!state.env && !state.loading && !state.error) void load();
  }, []);
  const refresh = useCallback(() => load(), []);
  return { ...snap, refresh };
}
