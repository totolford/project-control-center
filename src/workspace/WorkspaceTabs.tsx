import { memo, useState } from "react";
import { Bot, LayoutGrid, Plus, X, type LucideIcon } from "lucide-react";
import { ALL_NAV_ITEMS } from "../shell/navItems";
import { useStore } from "../store";
import { addTab, closeTab, listPanels, renameTab, setActiveTab, type WorkspaceTab } from "./layout";
import { PANEL_ICON } from "./panelMeta";
import { useWorkspace } from "./store";
import { useT } from "../i18n";

/** True when any agent shown in the tab is working (real agent status). */
function useTabWorking(tab: WorkspaceTab): boolean {
  const ids = [...listPanels(tab.root).map((p) => p.panel.agentId), tab.view?.agentId].filter((id): id is string => Boolean(id));
  return useStore((s) => ids.some((id) => s.project?.agents.find((a) => a.id === id)?.status === "working"));
}

/** Title and icon of a tab: its own title, else the view (agent name, nav label) or its single panel. */
function useTabLabel(tab: WorkspaceTab): { title: string; icon: LucideIcon } {
  const t = useT();
  const agentName = useStore((s) => (tab.view?.agentId ? s.project?.agents.find((a) => a.id === tab.view!.agentId)?.name : undefined));
  if (tab.view) {
    if (tab.view.name === "agent") return { title: tab.title || agentName || t("ws.tab.agent"), icon: Bot };
    const item = ALL_NAV_ITEMS.find((i) => i.name === tab.view!.name);
    return { title: tab.title || item?.label || tab.view.name, icon: item?.icon ?? LayoutGrid };
  }
  const icon = tab.root?.type === "panel" ? PANEL_ICON[tab.root.panel.type] : LayoutGrid;
  return { title: tab.title, icon };
}

const TabButton = memo(function TabButton({ tab, active, closable }: { tab: WorkspaceTab; active: boolean; closable: boolean }) {
  const t = useT();
  const update = useWorkspace((s) => s.update);
  const working = useTabWorking(tab);
  const { title, icon: Icon } = useTabLabel(tab);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const pinned = listPanels(tab.root).some((p) => p.pinned);

  if (editing) {
    return (
      <input
        className="ws-tab-edit"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          update((ws) => renameTab(ws, tab.id, draft));
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(title);
            setEditing(false);
          }
        }}
        aria-label={t("ws.tab.name")}
      />
    );
  }
  return (
    <div className={`ws-tab${active ? " active" : ""}${tab.view ? " is-window" : ""}`}>
      <button
        className="ws-tab-label"
        role="tab"
        aria-selected={active}
        onClick={() => update((ws) => setActiveTab(ws, tab.id))}
        onDoubleClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        title={t("ws.tab.renameHint", { title })}
      >
        <Icon size={12} aria-hidden="true" className="ws-tab-icon" />
        <span className="ws-tab-title">{title}</span>
        {working && <span className="dot tone-green pulse" aria-label={t("ws.tab.working")} />}
      </button>
      {closable && (
        <button
          className="ws-tab-close"
          onClick={() => update((ws) => closeTab(ws, tab.id))}
          disabled={pinned}
          aria-label={t("ws.tab.closeAria", { title })}
          title={pinned ? t("ws.tab.hasPinned") : t("ws.tab.close")}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
});

/** Tabs of the center window: views (AI World, an agent, GitHub…) and tiling Swarm tabs; `children` sit on the right. */
export function WorkspaceTabs({ children }: { children?: React.ReactNode }) {
  const t = useT();
  const tabs = useWorkspace((s) => s.ws?.tabs);
  const activeTab = useWorkspace((s) => s.ws?.activeTab);
  const update = useWorkspace((s) => s.update);
  if (!tabs) return null;
  return (
    <div className="ws-tabs" role="tablist" aria-label={t("ws.tab.aria")}>
      {tabs.map((tab) => (
        <TabButton key={tab.id} tab={tab} active={tab.id === activeTab} closable={tabs.length > 1 || (tab.root !== null && !tab.view)} />
      ))}
      <button className="icon-btn" onClick={() => update((ws) => addTab(ws))} aria-label={t("ws.tab.new")} title={t("ws.tab.newTitle")}>
        <Plus size={13} />
      </button>
      <span className="spacer" />
      {children}
    </div>
  );
}
