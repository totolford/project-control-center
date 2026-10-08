// NEXUS HQ as the AI World page sees it (world.json, layout, occupancy,
// suggestions, snapshots), shared by the toolbar, the room panel and the
// building panel. Reloaded when the journal reports a `world.*` change
// (Central's manage_ai_world, the page itself, a rollback).

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useLocale, worldI18n } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import type { HqOp, HqView } from "../../lib/types";
import { toast } from "../../lib/toast";
import { useStore, useTimeline } from "../../store";
import { languageOp } from "./hq";

interface HqState {
  view: HqView | null;
  error: string | null;
  loading: boolean;
  load: () => Promise<void>;
  /** Applies an operation; resolves to false (and toasts) when refused. */
  apply: (op: HqOp, success?: string) => Promise<boolean>;
  restore: (snapshot: string, success?: string) => Promise<boolean>;
  reset: () => void;
}

export const useHq = create<HqState>((set) => ({
  view: null,
  error: null,
  loading: false,
  load: async () => {
    set({ loading: true });
    try {
      set({ view: await api.aiWorldHq(), error: null, loading: false });
    } catch (e) {
      set({ error: errorMessage(e), loading: false });
    }
  },
  apply: async (op, success) => {
    try {
      set({ view: await api.aiWorldHqApply(op), error: null });
      if (success) toast.success(success);
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  },
  restore: async (snapshot, success) => {
    try {
      set({ view: await api.aiWorldHqRestore(snapshot), error: null });
      if (success) toast.success(success);
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  },
  reset: () => set({ view: null, error: null, loading: false }),
}));

/** Id of the newest `world.*` journal event (changes of the building). */
export function lastWorldEvent(timeline: { id: number; name?: string }[]): number {
  return timeline.find((e) => e.name?.startsWith("world."))?.id ?? 0;
}

/**
 * Keeps `useHq` loaded for the open project, reloads it on `world.*` events,
 * and keeps world.json's language in line with the AI World language.
 */
export function useHqSync(): void {
  const projectId = useStore((s) => s.project?.info.id ?? null);
  const projectPref = useStore((s) => s.project?.settings.aiWorldLanguage);
  const changed = lastWorldEvent(useTimeline());
  const locale = useLocale(worldI18n);
  const view = useHq((s) => s.view);
  const tried = useRef<string | null>(null);

  useEffect(() => {
    useHq.getState().reset();
    if (projectId) void useHq.getState().load();
  }, [projectId]);

  useEffect(() => {
    if (projectId && changed) void useHq.getState().load();
  }, [projectId, changed]);

  useEffect(() => {
    if (!view) return;
    const op = languageOp(view.config, projectPref, locale);
    if (!op) return;
    // Once per wanted language: a refused change is not retried in a loop.
    const key = JSON.stringify(op);
    if (tried.current === key) return;
    tried.current = key;
    void useHq.getState().apply(op);
  }, [view, projectPref, locale]);
}
