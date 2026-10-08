// Workspace layout state for the open project: loaded from / saved to workspace.json via the backend.

import { create } from "zustand";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { buildDefaultWorkspace, parseWorkspace, pruneWorkspace, type LayoutContext } from "./layoutPersist";
import type { DockZone, Workspace } from "./layout";
import { t } from "../i18n";

export const SAVE_DELAY_MS = 500;

interface WorkspaceState {
  projectId: string | null;
  ws: Workspace | null;
  /** Loads the saved layout (or builds the default one) for a project. */
  load: (projectId: string, ctx: LayoutContext) => Promise<void>;
  /** Applies a layout change and schedules a debounced save. */
  update: (fn: (ws: Workspace) => Workspace) => void;
  /** Rebuilds the default layout and saves it. */
  reset: (ctx: LayoutContext) => void;
  /** Removes panels whose agent/connection disappeared. */
  prune: (ctx: LayoutContext) => void;
  clear: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(ws: Workspace) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveWorkspace(ws).catch((e) => toast.error(e));
  }, SAVE_DELAY_MS);
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  projectId: null,
  ws: null,
  load: async (projectId, ctx) => {
    clearTimeout(saveTimer);
    set({ projectId, ws: null });
    let raw: unknown = null;
    try {
      raw = await api.loadWorkspace();
    } catch (e) {
      toast.error(e);
    }
    if (get().projectId !== projectId) return;
    set({ ws: parseWorkspace(raw, ctx) ?? buildDefaultWorkspace(ctx) });
  },
  update: (fn) => {
    const current = get().ws;
    if (!current) return;
    const next = fn(current);
    if (next === current) return;
    set({ ws: next });
    scheduleSave(next);
  },
  reset: (ctx) => {
    const ws = buildDefaultWorkspace(ctx);
    set({ ws });
    scheduleSave(ws);
  },
  prune: (ctx) => {
    const current = get().ws;
    if (!current) return;
    const next = pruneWorkspace(current, ctx);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    set({ ws: next });
    scheduleSave(next);
  },
  clear: () => {
    clearTimeout(saveTimer);
    set({ projectId: null, ws: null });
  },
}));

/** Transient drag-and-drop state, kept apart so only the hovered panel re-renders. */
interface DragState {
  sourceId: string | null;
  hover: { panelId: string; zone: DockZone } | null;
  setSource: (id: string | null) => void;
  setHover: (hover: { panelId: string; zone: DockZone } | null) => void;
}

export const useDrag = create<DragState>((set, get) => ({
  sourceId: null,
  hover: null,
  setSource: (sourceId) => set({ sourceId, hover: null }),
  setHover: (hover) => {
    const cur = get().hover;
    if (cur?.panelId === hover?.panelId && cur?.zone === hover?.zone) return;
    set({ hover });
  },
}));

/** Asks for confirmation, then rebuilds the default layout. */
export async function confirmResetLayout(ctx: LayoutContext): Promise<void> {
  const ok = await ask(t("ws.resetConfirm"), { title: t("ws.resetLayout"), kind: "warning" });
  if (ok) useWorkspace.getState().reset(ctx);
}
