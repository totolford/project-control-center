import { Plus, RotateCcw } from "lucide-react";
import { Menu, type MenuEntry } from "../components/Menu";
import { useStore } from "../store";
import { useLayoutContext } from "./hooks";
import { addPanelToActive, getActiveTab, listPanels, openPanelTab, specKey, type PanelSpec, type PanelType } from "./layout";
import { PANEL_ICON } from "./panelMeta";
import { confirmResetLayout, useWorkspace } from "./store";

/** Every panel that can be shown for the current project, grouped for the "+ Panel" menu. */
function candidates(): { heading: string; items: { label: string; spec: PanelSpec }[] }[] {
  const p = useStore.getState().project;
  if (!p) return [];
  const agents = p.agents.filter((a) => a.status !== "retired");
  const workers = agents.filter((a) => a.kind === "worker");
  const central = agents.find((a) => a.kind === "central");
  return [
    {
      heading: "Agents",
      items: [
        ...(central ? [{ label: "Central agent", spec: { type: "CentralAgent" as const, agentId: central.id } }] : []),
        ...workers.map((a) => ({ label: `${a.name} · terminal`, spec: { type: "AgentTerminal" as const, agentId: a.id } })),
        ...workers.map((a) => ({ label: `${a.name} · activity`, spec: { type: "AgentActivity" as const, agentId: a.id } })),
        ...workers.filter((a) => a.isolation === "worktree").map((a) => ({ label: `${a.name} · diff`, spec: { type: "Diff" as const, agentId: a.id } })),
      ],
    },
    {
      heading: "Connections",
      items: p.connections.map((c) =>
        c.kind === "roblox_studio"
          ? { label: `${c.name} · Roblox Studio`, spec: { type: "RobloxStudio" as const, connectionId: c.id } }
          : c.kind === "github"
            ? { label: `${c.name} · GitHub`, spec: { type: "GitHub" as const, connectionId: c.id } }
            : { label: `${c.name} · ${c.kind}`, spec: { type: "Connection" as const, connectionId: c.id } },
      ),
    },
    {
      heading: "Project",
      items: [
        { label: "Swarm overview", spec: { type: "SwarmOverview" } },
        { label: "Active mission", spec: { type: "Mission" } },
        { label: "Task board", spec: { type: "TaskBoard" } },
        { label: "Review queue", spec: { type: "Review" } },
        { label: "Memory", spec: { type: "Memory" } },
        { label: "Activity timeline", spec: { type: "Activity" } },
        { label: "Raw terminal", spec: { type: "RawTerminal" } },
        { label: "AI World", spec: { type: "AiWorld" } },
        ...(p.connections.some((c) => c.kind === "roblox_studio") ? [] : [{ label: "Roblox Studio (not configured)", spec: { type: "RobloxStudio" as const } }]),
      ],
    },
  ];
}

/** Panels that also make sense as a whole center window (Roblox Studio, a Claude session, a mission, a diff…). */
const WINDOW_PANELS: PanelType[] = ["RobloxStudio", "CentralAgent", "AgentTerminal", "Mission", "Diff", "GitHub", "RawTerminal"];

export function AddPanelMenu() {
  const update = useWorkspace((s) => s.update);
  const ctx = useLayoutContext();

  const entries = (): MenuEntry[] => {
    const ws = useWorkspace.getState().ws;
    if (!ws) return [];
    const inTab = new Set(listPanels(getActiveTab(ws).root).map((n) => specKey(n.panel)));
    const allOpen = new Set(ws.tabs.flatMap((t) => listPanels(t.root)).map((n) => specKey(n.panel)));
    const out: MenuEntry[] = [];
    for (const group of candidates()) {
      const available = group.items.filter((i) => !inTab.has(specKey(i.spec)));
      if (available.length === 0) continue;
      out.push({ heading: group.heading });
      for (const item of available) {
        const Icon = PANEL_ICON[item.spec.type];
        out.push({
          label: item.label,
          icon: <Icon size={13} />,
          detail: allOpen.has(specKey(item.spec)) ? "open in another tab" : undefined,
          onSelect: () => update((w) => addPanelToActive(w, item.spec)),
        });
      }
    }
    const windows = candidates()
      .flatMap((g) => g.items)
      .filter((i) => WINDOW_PANELS.includes(i.spec.type));
    if (windows.length > 0) {
      out.push({ heading: "Open in its own tab" });
      for (const item of windows) {
        const Icon = PANEL_ICON[item.spec.type];
        out.push({ label: item.label, icon: <Icon size={13} />, onSelect: () => update((w) => openPanelTab(w, item.spec, item.label.slice(0, 40))) });
      }
    }
    out.push("separator", { label: "Reset workspace layout", icon: <RotateCcw size={13} />, onSelect: () => void confirmResetLayout(ctx) });
    return out;
  };

  return (
    <Menu
      trigger={
        <>
          <Plus size={13} /> Panel
        </>
      }
      buttonClassName="btn btn-sm ghost"
      entries={entries}
      align="right"
      label="Add panel"
    />
  );
}
