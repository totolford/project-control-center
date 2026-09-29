import { useEffect } from "react";
import { Loading } from "../components/Common";
import { SwarmGrid } from "../panels/SwarmOverview";
import { dock, getActiveTab, listPanels, restoreMaximized, type DockZone } from "./layout";
import { AddPanelMenu } from "./AddPanelMenu";
import { PanelFrame } from "./PanelFrame";
import { NodeView } from "./SplitView";
import { useDrag, useWorkspace } from "./store";
import { WorkspaceTabs } from "./WorkspaceTabs";

const EDGE = 0.25;

function zoneAt(rect: DOMRect, x: number, y: number): DockZone {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const edges: [DockZone, number][] = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry],
  ];
  const [zone, dist] = edges.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  return dist < EDGE ? zone : "center";
}

/** Pointer-driven docking: while a panel grip is held, track the hovered panel and zone. */
function usePanelDragging() {
  const sourceId = useDrag((s) => s.sourceId);
  useEffect(() => {
    if (!sourceId) return;
    const { setHover, setSource } = useDrag.getState();
    document.body.classList.add("dragging-panel");
    const onMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-panel-id]");
      const id = el?.dataset.panelId;
      if (!el || !id || id === sourceId) return setHover(null);
      setHover({ panelId: id, zone: zoneAt(el.getBoundingClientRect(), e.clientX, e.clientY) });
    };
    const onUp = () => {
      const hover = useDrag.getState().hover;
      if (hover) useWorkspace.getState().update((ws) => dock(ws, sourceId, hover.panelId, hover.zone));
      setSource(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSource(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("dragging-panel");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [sourceId]);
}

/** Esc restores a maximized panel (unless a modal or menu handled the key). */
function useEscapeRestores() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".modal-backdrop")) return;
      useWorkspace.getState().update(restoreMaximized);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The Swarm view: workspace tabs + the tiling layout of the active tab. */
export function SwarmWorkspace() {
  const ws = useWorkspace((s) => s.ws);
  usePanelDragging();
  useEscapeRestores();
  if (!ws) return <Loading text="Loading workspace…" />;
  const tab = getActiveTab(ws);
  const maximized = tab.maximized ? listPanels(tab.root).find((p) => p.id === tab.maximized) : undefined;
  return (
    <div className="swarm">
      <WorkspaceTabs>
        <AddPanelMenu />
      </WorkspaceTabs>
      <div className="swarm-body">
        {maximized ? (
          <div className="tile maximized">
            <PanelFrame panel={maximized} maximized />
          </div>
        ) : tab.root ? (
          <div className="tile root-tile">
            <NodeView key={tab.id} node={tab.root} tabId={tab.id} path={[]} />
          </div>
        ) : (
          <div className="swarm-empty">
            <div className="muted small pad">This tab is empty — add panels with “+ Panel”. The swarm right now:</div>
            <SwarmGrid />
          </div>
        )}
      </div>
    </div>
  );
}
