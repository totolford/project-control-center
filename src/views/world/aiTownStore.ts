// Integrated AI Town runtime as seen by the UI: status, the open project's
// world, progress lines. Shared by the AI World page and its workspace panel.

import { create } from "zustand";
import { api, errorMessage, onAiTown } from "../../lib/api";
import type { AiTownStatus, AiTownWorld } from "../../lib/types";

export type AiTownBusy = "install" | "start" | "stop" | null;

interface AiTownState {
  status: AiTownStatus | null;
  /** World of `projectId` (the runtime serves one project at a time). */
  world: AiTownWorld | null;
  projectId: string | null;
  busy: AiTownBusy;
  /** Progress lines of the current install / start (pcc://ai-town). */
  progress: string[];
  error: string | null;
  /** The built frontend is served at /ai-town/ (null = not checked yet). */
  frontendBuilt: boolean | null;
  refresh: () => Promise<void>;
  install: () => Promise<boolean>;
  start: (projectId: string) => Promise<AiTownWorld | null>;
  stop: () => Promise<void>;
  forProject: (projectId: string | null) => void;
}

let listening = false;

export const useAiTown = create<AiTownState>((set, get) => {
  const fail = (e: unknown) => set({ error: errorMessage(e), busy: null });
  return {
    status: null,
    world: null,
    projectId: null,
    busy: null,
    progress: [],
    error: null,
    frontendBuilt: null,
    refresh: async () => {
      if (!listening) {
        listening = true;
        void onAiTown((p) => set((s) => ({ progress: [...s.progress, p.message].slice(-30) }))).catch(() => (listening = false));
      }
      try {
        const [status, frontendBuilt] = await Promise.all([api.aiTownStatus(), checkFrontend()]);
        set({ status, frontendBuilt, world: status.running ? get().world : null });
      } catch (e) {
        fail(e);
      }
    },
    install: async () => {
      set({ busy: "install", error: null, progress: [] });
      try {
        const status = await api.aiTownInstall();
        set({ status, busy: null });
        return status.installed;
      } catch (e) {
        fail(e);
        void get().refresh();
        return false;
      }
    },
    start: async (projectId) => {
      set({ busy: "start", error: null, progress: get().busy === "install" ? get().progress : [] });
      try {
        const world = await api.aiTownStart();
        set({ world, projectId, busy: null });
        void get().refresh();
        return world;
      } catch (e) {
        fail(e);
        void get().refresh();
        return null;
      }
    },
    stop: async () => {
      set({ busy: "stop", error: null });
      try {
        const status = await api.aiTownStop();
        set({ status, world: null, busy: null });
      } catch (e) {
        fail(e);
      }
    },
    forProject: (projectId) => {
      if (get().projectId !== projectId) set({ world: null, projectId });
    },
  };
});

async function checkFrontend(): Promise<boolean> {
  try {
    // GET, not HEAD: Tauri's asset protocol does not answer HEAD reliably, and a
    // missing file may fall back to NEXUS's own index.html — so check the content.
    const r = await fetch("/ai-town/index.html", { cache: "no-store" });
    return r.ok && (await r.text()).includes("/ai-town/assets/");
  } catch {
    return false;
  }
}
