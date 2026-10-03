import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useLayoutContext } from "./hooks";
import { getActiveTab, openView, sameView, viewOfTab, type Workspace } from "./layout";
import { buildSwarmRoot } from "./layoutPersist";
import { useWorkspace } from "./store";

/** Shows the view of the workspace's active tab (no-op when it is already shown). */
function adopt(ws: Workspace) {
  const view = viewOfTab(getActiveTab(ws));
  const s = useStore.getState();
  if (!sameView(view, s.view)) s.navigate(view);
}

/**
 * Binds the center window to the workspace tabs: navigating anywhere (nav, links, palette) opens or
 * activates that view's tab, and activating a tab shows its view with the selection it kept. When the
 * workspace loads, its saved active tab wins (the AI World on a fresh project).
 */
export function useCenterSync() {
  const projectId = useStore((s) => s.project?.info.id ?? null);
  const loaded = useWorkspace((s) => s.ws !== null && s.projectId === projectId);
  const ctx = useLayoutContext();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    if (!loaded) return;
    const ws = useWorkspace.getState().ws;
    if (ws) adopt(ws);
    const offView = useStore.subscribe((s, prev) => {
      if (s.view === prev.view || !s.project) return;
      useWorkspace.getState().update((w) => openView(w, s.view, () => buildSwarmRoot(ctxRef.current)));
    });
    const offTabs = useWorkspace.subscribe((s, prev) => {
      if (s.ws && s.ws !== prev.ws) adopt(s.ws);
    });
    return () => {
      offView();
      offTabs();
    };
  }, [loaded]);
}
