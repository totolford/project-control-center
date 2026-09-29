import { memo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useStore } from "../store";
import { addTab, closeTab, listPanels, renameTab, setActiveTab, type WorkspaceTab } from "./layout";
import { useWorkspace } from "./store";

/** True when any agent shown in the tab is working (real agent status). */
function useTabWorking(tab: WorkspaceTab): boolean {
  const ids = listPanels(tab.root)
    .map((p) => p.panel.agentId)
    .filter((id): id is string => Boolean(id));
  return useStore((s) => ids.some((id) => s.project?.agents.find((a) => a.id === id)?.status === "working"));
}

const TabButton = memo(function TabButton({ tab, active, closable }: { tab: WorkspaceTab; active: boolean; closable: boolean }) {
  const update = useWorkspace((s) => s.update);
  const working = useTabWorking(tab);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
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
            setDraft(tab.title);
            setEditing(false);
          }
        }}
        aria-label="Tab name"
      />
    );
  }
  return (
    <div className={`ws-tab${active ? " active" : ""}`}>
      <button
        className="ws-tab-label"
        onClick={() => update((ws) => setActiveTab(ws, tab.id))}
        onDoubleClick={() => {
          setDraft(tab.title);
          setEditing(true);
        }}
        title="Double-click to rename"
      >
        {tab.title}
        {working && <span className="dot tone-green pulse" aria-label="agents working" />}
      </button>
      {closable && (
        <button
          className="ws-tab-close"
          onClick={() => update((ws) => closeTab(ws, tab.id))}
          disabled={pinned}
          aria-label={`Close ${tab.title}`}
          title={pinned ? "Contains pinned panels" : "Close tab"}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
});

export function WorkspaceTabs({ children }: { children?: React.ReactNode }) {
  const tabs = useWorkspace((s) => s.ws?.tabs);
  const activeTab = useWorkspace((s) => s.ws?.activeTab);
  const update = useWorkspace((s) => s.update);
  if (!tabs) return null;
  return (
    <div className="ws-tabs" role="tablist">
      {tabs.map((t) => (
        <TabButton key={t.id} tab={t} active={t.id === activeTab} closable={tabs.length > 1 || t.root !== null} />
      ))}
      <button className="icon-btn" onClick={() => update((ws) => addTab(ws))} aria-label="New tab" title="New tab">
        <Plus size={13} />
      </button>
      <span className="spacer" />
      {children}
    </div>
  );
}
