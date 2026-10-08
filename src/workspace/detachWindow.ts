// Detached panels: a panel moves to its own Tauri window and re-docks when that window closes.

import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { errorMessage } from "../lib/api";
import { toast } from "../lib/toast";
import { detachLabel, detachUrl } from "./detach";
import { addPanelToActive, closePanel, type PanelNode, type PanelSpec } from "./layout";
import { useWorkspace } from "./store";
import { t } from "../i18n";

const REDOCK_EVENT = "nexus://redock";

/** Specs of panels currently shown in their own window, by window label (the "detached" markers). */
const detached = new Map<string, PanelSpec>();

function redock(label: string) {
  const spec = detached.get(label);
  if (!spec) return;
  detached.delete(label);
  useWorkspace.getState().update((ws) => addPanelToActive(ws, spec));
}

/** Opens the panel in a new window and removes it from the layout while it is detached. */
export async function detachPanel(panel: PanelNode, title: string): Promise<void> {
  const label = detachLabel(panel.id);
  try {
    const win = new WebviewWindow(label, { url: detachUrl(panel.panel), title, width: 760, height: 540 });
    await new Promise<void>((resolve, reject) => {
      void win.once("tauri://created", () => resolve());
      void win.once<unknown>("tauri://error", (e) => reject(e.payload));
    });
    detached.set(label, panel.panel);
    useWorkspace.getState().update((ws) => closePanel(ws, panel.id));
    void win.once("tauri://destroyed", () => redock(label));
  } catch (e) {
    toast.error(t("ws.detachFailed", { error: errorMessage(e) }));
  }
}

/** Main window: re-docks a panel when its window closes (destroyed event, or the child's own notice). */
export function useRedock() {
  useEffect(() => {
    const unlisten = listen<{ label?: unknown }>(REDOCK_EVENT, (e) => {
      if (typeof e.payload?.label === "string") redock(e.payload.label);
    });
    return () => void unlisten.then((f) => f());
  }, []);
}

/** Detached window: tells the main window it is going away. */
export function announceRedock(label: string): void {
  void emit(REDOCK_EVENT, { label }).catch(() => undefined);
}
