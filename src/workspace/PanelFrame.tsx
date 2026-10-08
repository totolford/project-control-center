import { memo, useMemo } from "react";
import { AppWindow, ExternalLink, GripVertical, Maximize2, Minimize2, Minus, Pin, PinOff, Plus, X } from "lucide-react";
import type { MenuEntry } from "../components/Menu";
import { closePanel, movePanelToNewTab, patchPanel, toggleMaximize, type PanelNode } from "./layout";
import { detachPanel } from "./detachWindow";
import { usePanelTitle } from "./panelMeta";
import { PANELS } from "./registry";
import { useDrag, useWorkspace } from "./store";
import { lazyLabels, useT } from "../i18n";

const ZONE_LABEL = lazyLabels({ left: "ws.zone.left", right: "ws.zone.right", top: "ws.zone.top", bottom: "ws.zone.bottom", center: "ws.zone.center" });

export interface PanelChrome {
  panel: PanelNode;
  maximized: boolean;
  /** Drag grip for re-tiling (absent on pinned panels). */
  grip: React.ReactNode;
  /** Minimize / maximize / close buttons. */
  controls: React.ReactNode;
  /** Panel-level menu entries (pin, open in new tab, …). */
  menu: MenuEntry[];
}

function usePanelChrome(panel: PanelNode, maximized: boolean): PanelChrome {
  const t = useT();
  const update = useWorkspace((s) => s.update);
  const setSource = useDrag((s) => s.setSource);
  const title = usePanelTitle(panel.panel);
  return useMemo(() => {
    const { id, pinned, minimized } = panel;
    const grip = pinned ? (
      <span className="panel-grip pinned" title={t("ws.pinned")}>
        <Pin size={12} />
      </span>
    ) : (
      <span
        className="panel-grip"
        title={t("ws.drag")}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          setSource(id);
        }}
      >
        <GripVertical size={14} />
      </span>
    );
    const controls = (
      <>
        <button
          className="icon-btn"
          onClick={() => update((ws) => patchPanel(ws, id, { minimized: !minimized }))}
          aria-label={minimized ? t("ws.expandPanel") : t("ws.minimizePanel")}
          title={minimized ? t("ws.expand") : t("ws.minimize")}
        >
          {minimized ? <Plus size={13} /> : <Minus size={13} />}
        </button>
        <button
          className="icon-btn"
          onClick={() => update((ws) => toggleMaximize(ws, id))}
          aria-label={maximized ? t("ws.restorePanel") : t("ws.maximizePanel")}
          title={maximized ? t("ws.restoreEsc") : t("ws.maximize")}
        >
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        {!pinned && (
          <button className="icon-btn" onClick={() => update((ws) => closePanel(ws, id))} aria-label={t("ws.closePanel")} title={t("common.close")}>
            <X size={13} />
          </button>
        )}
      </>
    );
    const menu: MenuEntry[] = [
      {
        label: pinned ? t("ws.unpin") : t("ws.pin"),
        detail: pinned ? undefined : t("ws.pinDetail"),
        icon: pinned ? <PinOff size={13} /> : <Pin size={13} />,
        onSelect: () => update((ws) => patchPanel(ws, id, { pinned: !pinned })),
      },
      {
        label: t("ws.openNewTab"),
        icon: <ExternalLink size={13} />,
        disabled: pinned,
        onSelect: () => update((ws) => movePanelToNewTab(ws, id)),
      },
      {
        label: t("ws.detach"),
        detail: pinned ? t("ws.unpinFirst") : t("ws.detachDetail"),
        icon: <AppWindow size={13} />,
        disabled: pinned,
        onSelect: () => void detachPanel(panel, title),
      },
    ];
    return { panel, maximized, grip, controls, menu };
  }, [panel, maximized, update, setSource, title, t]);
}

/** One tile: header (generic or panel-specific) + body, with drop zones while dragging. */
export const PanelFrame = memo(function PanelFrame({ panel, maximized }: { panel: PanelNode; maximized: boolean }) {
  const chrome = usePanelChrome(panel, maximized);
  const def = PANELS[panel.panel.type];
  const zone = useDrag((s) => (s.hover?.panelId === panel.id ? s.hover.zone : null));
  const dragging = useDrag((s) => s.sourceId === panel.id);
  const { Header, Body } = def;
  return (
    <section
      className={`tile-panel${panel.minimized ? " minimized" : ""}${dragging ? " drag-source" : ""}`}
      data-panel-id={panel.id}
      aria-label={panel.panel.type}
    >
      <Header spec={panel.panel} chrome={chrome} />
      {!panel.minimized && (
        <div className="tile-body">
          <Body spec={panel.panel} panelId={panel.id} />
        </div>
      )}
      {zone && (
        <div className={`drop-zone drop-${zone}`}>
          <span>{ZONE_LABEL[zone]}</span>
        </div>
      )}
    </section>
  );
});
