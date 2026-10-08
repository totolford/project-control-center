import { Plus, RotateCcw } from "lucide-react";
import { Menu, type MenuEntry } from "../components/Menu";
import { useStore } from "../store";
import { useLayoutContext } from "./hooks";
import { addPanelToActive, getActiveTab, listPanels, openPanelTab, specKey, type PanelSpec, type PanelType } from "./layout";
import { PANEL_ICON } from "./panelMeta";
import { confirmResetLayout, useWorkspace } from "./store";
import { t, useT } from "../i18n";

/** Every panel that can be shown for the current project, grouped for the "+ Panel" menu. */
function candidates(): { heading: string; items: { label: string; spec: PanelSpec }[] }[] {
  const p = useStore.getState().project;
  if (!p) return [];
  const agents = p.agents.filter((a) => a.status !== "retired");
  const workers = agents.filter((a) => a.kind === "worker");
  const central = agents.find((a) => a.kind === "central");
  return [
    {
      heading: t("ws.group.agents"),
      items: [
        ...(central ? [{ label: t("ws.title.CentralAgent"), spec: { type: "CentralAgent" as const, agentId: central.id } }] : []),
        ...workers.map((a) => ({ label: t("ws.item.terminal", { name: a.name }), spec: { type: "AgentTerminal" as const, agentId: a.id } })),
        ...workers.map((a) => ({ label: t("ws.item.activity", { name: a.name }), spec: { type: "AgentActivity" as const, agentId: a.id } })),
        ...workers.filter((a) => a.isolation === "worktree").map((a) => ({ label: t("ws.item.diff", { name: a.name }), spec: { type: "Diff" as const, agentId: a.id } })),
      ],
    },
    {
      heading: t("ws.group.connections"),
      items: p.connections.map((c) =>
        c.kind === "roblox_studio"
          ? { label: `${c.name} · Roblox Studio`, spec: { type: "RobloxStudio" as const, connectionId: c.id } }
          : c.kind === "github"
            ? { label: `${c.name} · GitHub`, spec: { type: "GitHub" as const, connectionId: c.id } }
            : { label: `${c.name} · ${c.kind}`, spec: { type: "Connection" as const, connectionId: c.id } },
      ),
    },
    {
      heading: t("ws.group.project"),
      items: [
        { label: t("ws.title.SwarmOverview"), spec: { type: "SwarmOverview" } },
        { label: t("ws.title.activeMission"), spec: { type: "Mission" } },
        { label: t("ws.title.TaskBoard"), spec: { type: "TaskBoard" } },
        { label: t("ws.title.Review"), spec: { type: "Review" } },
        { label: t("ws.title.Memory"), spec: { type: "Memory" } },
        { label: t("ws.title.Activity"), spec: { type: "Activity" } },
        { label: t("ws.title.RawTerminal"), spec: { type: "RawTerminal" } },
        { label: t("ws.title.AiWorld"), spec: { type: "AiWorld" } },
        ...(p.connections.some((c) => c.kind === "roblox_studio") ? [] : [{ label: t("ws.item.studioMissing"), spec: { type: "RobloxStudio" as const } }]),
      ],
    },
  ];
}

/** Panels that also make sense as a whole center window (Roblox Studio, a Claude session, a mission, a diff…). */
const WINDOW_PANELS: PanelType[] = ["RobloxStudio", "CentralAgent", "AgentTerminal", "Mission", "Diff", "GitHub", "RawTerminal"];

export function AddPanelMenu() {
  const tr = useT();
  const update = useWorkspace((s) => s.update);
  const ctx = useLayoutContext();

  const entries = (): MenuEntry[] => {
    const ws = useWorkspace.getState().ws;
    if (!ws) return [];
    const inTab = new Set(listPanels(getActiveTab(ws).root).map((n) => specKey(n.panel)));
    const allOpen = new Set(ws.tabs.flatMap((tab) => listPanels(tab.root)).map((n) => specKey(n.panel)));
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
          detail: allOpen.has(specKey(item.spec)) ? tr("ws.openElsewhere") : undefined,
          onSelect: () => update((w) => addPanelToActive(w, item.spec)),
        });
      }
    }
    const windows = candidates()
      .flatMap((g) => g.items)
      .filter((i) => WINDOW_PANELS.includes(i.spec.type));
    if (windows.length > 0) {
      out.push({ heading: tr("ws.group.ownTab") });
      for (const item of windows) {
        const Icon = PANEL_ICON[item.spec.type];
        out.push({ label: item.label, icon: <Icon size={13} />, onSelect: () => update((w) => openPanelTab(w, item.spec, item.label.slice(0, 40))) });
      }
    }
    out.push("separator", { label: tr("ws.resetLayout"), icon: <RotateCcw size={13} />, onSelect: () => void confirmResetLayout(ctx) });
    return out;
  };

  return (
    <Menu
      trigger={
        <>
          <Plus size={13} /> {tr("ws.panel")}
        </>
      }
      buttonClassName="btn btn-sm ghost"
      entries={entries}
      align="right"
      label={tr("ws.addPanel")}
    />
  );
}
