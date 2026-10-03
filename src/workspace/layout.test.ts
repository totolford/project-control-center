import { describe, expect, it } from "vitest";
import {
  addPanelToActive,
  addTab,
  appendToGrid,
  closePanel,
  closeTab,
  dock,
  dockPanel,
  getActiveTab,
  listPanels,
  makePanel,
  movePanelToNewTab,
  patchPanel,
  removeNode,
  renameTab,
  resizeSplit,
  restoreMaximized,
  setSplitSizes,
  specKey,
  toggleMaximize,
  openPanelTab,
  openView,
  viewOfTab,
  MAX_WINDOW_TABS,
  MIN_FRACTION,
  type LayoutNode,
  type PanelNode,
  type SplitNode,
  type Workspace,
} from "./layout";
import { buildDefaultWorkspace, migrateWorkspace, parseWorkspace, pruneWorkspace, type LayoutContext } from "./layoutPersist";

const ctx: LayoutContext = {
  agents: [
    { id: "central", kind: "central", status: "working", createdAt: "2026-01-01T00:00:00Z" },
    { id: "w1", kind: "worker", status: "waiting", createdAt: "2026-01-01T00:01:00Z" },
    { id: "w2", kind: "worker", status: "working", createdAt: "2026-01-01T00:02:00Z" },
    { id: "old", kind: "worker", status: "retired", createdAt: "2026-01-01T00:00:30Z" },
  ],
  connections: [
    { id: "roblox", kind: "roblox_studio" },
    { id: "gh", kind: "github" },
  ],
};

const term = (agentId: string, id = `p-${agentId}`): PanelNode => ({ type: "panel", id, panel: { type: "AgentTerminal", agentId } });

function wsWith(root: LayoutNode | null): Workspace {
  return { version: 2, activeTab: "t1", tabs: [{ id: "t1", title: "Main", root }], autoAddAgents: true };
}

function sum(sizes: number[]): number {
  return sizes.reduce((a, b) => a + b, 0);
}

describe("tree operations", () => {
  it("appendToGrid builds rows of at most 4 panels", () => {
    let root: LayoutNode | null = null;
    for (let i = 0; i < 6; i++) root = appendToGrid(root, term(`a${i}`));
    const r = root as SplitNode;
    expect(r.direction).toBe("vertical");
    expect(r.children).toHaveLength(2);
    expect((r.children[0] as SplitNode).children).toHaveLength(4);
    expect((r.children[1] as SplitNode).children).toHaveLength(2);
    expect(listPanels(root).map((p) => p.panel.agentId)).toEqual(["a0", "a1", "a2", "a3", "a4", "a5"]);
  });

  it("removeNode collapses single-child splits and renormalizes sizes", () => {
    const root: SplitNode = { type: "split", direction: "horizontal", sizes: [0.2, 0.3, 0.5], children: [term("a"), term("b"), term("c")] };
    const after = removeNode(root, "p-b") as SplitNode;
    expect(after.children.map((c) => (c as PanelNode).id)).toEqual(["p-a", "p-c"]);
    expect(sum(after.sizes)).toBeCloseTo(1);
    expect(after.sizes[0]).toBeCloseTo(0.2 / 0.7);
    const single = removeNode(after, "p-a");
    expect(single).toEqual(term("c"));
    expect(removeNode(single, "p-c")).toBeNull();
    expect(removeNode(root, "missing")).toBe(root);
  });

  it("dockPanel splits beside the target or swaps on center", () => {
    const root: SplitNode = { type: "split", direction: "horizontal", sizes: [0.5, 0.5], children: [term("a"), term("b")] };
    const below = dockPanel(root, "p-a", "p-b", "bottom") as LayoutNode;
    expect(below).toMatchObject({ type: "split", direction: "vertical" });
    expect(listPanels(below).map((p) => p.id)).toEqual(["p-b", "p-a"]);

    const swapped = dockPanel(root, "p-a", "p-b", "center") as SplitNode;
    expect(swapped.children.map((c) => (c as PanelNode).id)).toEqual(["p-b", "p-a"]);

    const three: SplitNode = { type: "split", direction: "horizontal", sizes: [0.5, 0.5], children: [term("a"), { type: "split", direction: "vertical", sizes: [0.5, 0.5], children: [term("b"), term("c")] }] };
    const left = dockPanel(three, "p-c", "p-a", "left") as SplitNode;
    expect(left.direction).toBe("horizontal");
    expect(left.children).toHaveLength(3);
    expect(sum(left.sizes)).toBeCloseTo(1);
    expect(listPanels(left).map((p) => p.id)).toEqual(["p-c", "p-a", "p-b"]);
    expect(dockPanel(root, "p-a", "p-a", "left")).toBe(root);
  });

  it("setSplitSizes clamps to the minimum fraction and normalizes", () => {
    const root: SplitNode = {
      type: "split",
      direction: "vertical",
      sizes: [0.5, 0.5],
      children: [term("a"), { type: "split", direction: "horizontal", sizes: [0.5, 0.5], children: [term("b"), term("c")] }],
    };
    const next = setSplitSizes(root, [1], [0.001, 0.999]) as SplitNode;
    const inner = next.children[1] as SplitNode;
    expect(inner.sizes[0]).toBeGreaterThanOrEqual(MIN_FRACTION - 0.01);
    expect(sum(inner.sizes)).toBeCloseTo(1);
    expect(next.children[0]).toBe(root.children[0]);
    expect(setSplitSizes(root, [5], [1])).toBe(root);
  });
});

describe("workspace operations", () => {
  it("adds panels once per tab and clears maximize", () => {
    let ws = wsWith(term("a"));
    ws = toggleMaximize(ws, "p-a");
    expect(getActiveTab(ws).maximized).toBe("p-a");
    ws = addPanelToActive(ws, { type: "Memory" });
    expect(listPanels(getActiveTab(ws).root)).toHaveLength(2);
    expect(getActiveTab(ws).maximized).toBeUndefined();
    expect(addPanelToActive(ws, { type: "Memory" })).toBe(ws);
  });

  it("respects pinned panels on close, move and dock", () => {
    let ws = wsWith({ type: "split", direction: "horizontal", sizes: [0.5, 0.5], children: [term("a"), term("b")] });
    ws = patchPanel(ws, "p-a", { pinned: true });
    expect(closePanel(ws, "p-a")).toBe(ws);
    expect(movePanelToNewTab(ws, "p-a")).toBe(ws);
    expect(dock(ws, "p-a", "p-b", "left")).toBe(ws);
    expect(dock(ws, "p-b", "p-a", "center")).toBe(ws);
    expect(closeTab(addTab(ws), "t1").tabs.map((t) => t.id)).toContain("t1");
    const closed = closePanel(ws, "p-b");
    expect(listPanels(getActiveTab(closed).root).map((p) => p.id)).toEqual(["p-a"]);
  });

  it("moves a panel to a new tab and handles tab lifecycle", () => {
    let ws = wsWith({ type: "split", direction: "horizontal", sizes: [0.5, 0.5], children: [term("a"), term("b", "p-b")] });
    ws = toggleMaximize(ws, "p-b");
    ws = movePanelToNewTab(ws, "p-b");
    expect(ws.tabs).toHaveLength(2);
    expect(ws.tabs[0].maximized).toBeUndefined();
    expect(listPanels(getActiveTab(ws).root).map((p) => p.id)).toEqual(["p-b"]);
    ws = renameTab(ws, ws.activeTab, "  Builders  ");
    expect(getActiveTab(ws).title).toBe("Builders");
    expect(renameTab(ws, ws.activeTab, "   ")).toBe(ws);
    ws = closeTab(ws, ws.activeTab);
    expect(ws.tabs).toHaveLength(1);
    expect(ws.activeTab).toBe("t1");
    const emptied = closeTab(ws, "t1");
    expect(emptied.tabs).toHaveLength(1);
    expect(emptied.tabs[0].root).toBeNull();
  });

  it("resizes and restores", () => {
    let ws = wsWith({ type: "split", direction: "horizontal", sizes: [0.5, 0.5], children: [term("a"), term("b")] });
    ws = resizeSplit(ws, "t1", [], [0.7, 0.3]);
    expect((getActiveTab(ws).root as SplitNode).sizes[0]).toBeCloseTo(0.7);
    ws = toggleMaximize(ws, "p-a");
    ws = restoreMaximized(ws);
    expect(getActiveTab(ws).maximized).toBeUndefined();
    expect(restoreMaximized(ws)).toBe(ws);
  });
});

describe("default layout", () => {
  it("opens on the AI World window, then a Swarm tab", () => {
    const ws = buildDefaultWorkspace(ctx);
    expect(getActiveTab(ws).view).toEqual({ name: "world" });
    expect(ws.tabs).toHaveLength(2);
    expect(ws.tabs[1].view).toBeUndefined();
  });

  it("has Central + Roblox on the left and one terminal per non-retired worker", () => {
    const ws = buildDefaultWorkspace(ctx);
    const panels = listPanels(ws.tabs[1].root);
    expect(panels.map((p) => p.panel.type)).toEqual(["CentralAgent", "RobloxStudio", "AgentTerminal", "AgentTerminal"]);
    expect(panels.filter((p) => p.panel.type === "AgentTerminal").map((p) => p.panel.agentId)).toEqual(["w1", "w2"]);
    expect(ws.autoAddAgents).toBe(true);
  });

  it("handles a project with no agents", () => {
    const ws = buildDefaultWorkspace({ agents: [], connections: [] });
    expect(ws.tabs[1].root).toBeNull();
  });
});

describe("parseWorkspace", () => {
  const saved = {
    version: 2,
    activeTab: "t1",
    autoAddAgents: false,
    tabs: [
      {
        id: "t1",
        title: "Main",
        maximized: "p-gone",
        root: {
          type: "split",
          direction: "horizontal",
          sizes: [0.5, "x", 0.5],
          children: [
            { type: "panel", id: "p-w1", panel: { type: "AgentTerminal", agentId: "w1" }, pinned: true },
            { type: "panel", id: "p-gone", panel: { type: "AgentTerminal", agentId: "deleted-agent" } },
            { type: "panel", id: "p-conn", panel: { type: "Connection", connectionId: "gh" } },
          ],
        },
      },
    ],
  };

  it("keeps valid panels, drops references to deleted agents, fixes sizes and maximize", () => {
    const ws = parseWorkspace(saved, ctx)!;
    expect(ws.autoAddAgents).toBe(false);
    const tab = getActiveTab(ws);
    expect(listPanels(tab.root).map((p) => p.id)).toEqual(["p-w1", "p-conn"]);
    expect(listPanels(tab.root)[0].pinned).toBe(true);
    expect(sum((tab.root as SplitNode).sizes)).toBeCloseTo(1);
    expect(tab.maximized).toBeUndefined();
  });

  it("falls back (null) for invalid or unknown data", () => {
    expect(parseWorkspace(null, ctx)).toBeNull();
    expect(parseWorkspace("garbage", ctx)).toBeNull();
    expect(parseWorkspace({ version: 99, tabs: [] }, ctx)).toBeNull();
    expect(parseWorkspace({ version: 2, tabs: [{ title: "no id" }] }, ctx)).toBeNull();
    expect(parseWorkspace({ version: 2, tabs: "nope" }, ctx)).toBeNull();
  });

  it("drops unknown panel types, duplicate ids and panels missing required refs", () => {
    const ws = parseWorkspace(
      {
        version: 2,
        activeTab: "missing",
        tabs: [
          {
            id: "t1",
            title: "",
            root: {
              type: "split",
              direction: "vertical",
              sizes: [1, 1, 1, 1],
              children: [
                { type: "panel", id: "x", panel: { type: "Hologram" } },
                { type: "panel", id: "a", panel: { type: "Diff" } },
                { type: "panel", id: "b", panel: { type: "Memory" } },
                { type: "panel", id: "b", panel: { type: "Activity" } },
              ],
            },
          },
        ],
      },
      ctx,
    )!;
    const tab = getActiveTab(ws);
    expect(ws.activeTab).toBe("t1");
    expect(tab.title).toBe("Tab 1");
    expect(tab.root).toEqual({ type: "panel", id: "b", panel: { type: "Memory" } });
  });

  it("migrates pre-versioned and 0.2 layouts, opening the AI World window in front", () => {
    const legacy = { activeTab: "t1", tabs: [{ id: "t1", title: "Old", root: { type: "panel", id: "m", panel: { type: "Memory" } } }] };
    expect(migrateWorkspace(legacy)).toMatchObject({ version: 2 });
    for (const raw of [legacy, { ...legacy, version: 1 }]) {
      const ws = parseWorkspace(raw, ctx)!;
      expect(ws.tabs.map((t) => t.view?.name ?? t.title)).toEqual(["world", "Old"]);
      expect(getActiveTab(ws).view).toEqual({ name: "world" });
    }
  });

  it("keeps window tabs, drops unknown views and windows of deleted agents", () => {
    const ws = parseWorkspace(
      {
        version: 2,
        activeTab: "w-agent",
        tabs: [
          { id: "w-world", title: "", root: null, view: { name: "world" } },
          { id: "w-agent", title: "", root: null, view: { name: "agent", agentId: "w1" } },
          { id: "w-gone", title: "", root: null, view: { name: "agent", agentId: "deleted-agent" } },
          { id: "w-bad", title: "", root: null, view: { name: "hologram" } },
          { id: "w-tasks", title: "Mine", root: null, view: { name: "tasks", taskId: "TASK-1", extra: 1 } },
        ],
      },
      ctx,
    )!;
    expect(ws.tabs.map((t) => t.id)).toEqual(["w-world", "w-agent", "w-tasks"]);
    expect(ws.activeTab).toBe("w-agent");
    expect(ws.tabs[2]).toEqual({ id: "w-tasks", title: "Mine", root: null, view: { name: "tasks", taskId: "TASK-1" } });
  });

  it("round-trips through JSON", () => {
    const ws = buildDefaultWorkspace(ctx);
    expect(parseWorkspace(JSON.parse(JSON.stringify(ws)), ctx)).toEqual(ws);
  });

  it("prunes panels of removed connections", () => {
    const ws = wsWith({ type: "split", direction: "horizontal", sizes: [0.5, 0.5], children: [makePanel({ type: "Connection", connectionId: "gh" }), term("w1")] });
    const pruned = pruneWorkspace(ws, { ...ctx, connections: [] });
    expect(listPanels(getActiveTab(pruned).root).map((p) => specKey(p.panel))).toEqual([specKey({ type: "AgentTerminal", agentId: "w1" })]);
  });
});

describe("window tabs", () => {
  const base = (): Workspace => ({ version: 2, activeTab: "t1", tabs: [{ id: "t1", title: "Swarm", root: term("w1") }], autoAddAgents: true });

  it("opens one window per view, next to the active tab, and re-activates it with its new selection", () => {
    let ws = openView(base(), { name: "github" });
    expect(ws.tabs.map((t) => viewOfTab(t).name)).toEqual(["swarm", "github"]);
    ws = openView({ ...ws, activeTab: "t1" }, { name: "tasks", taskId: "A" });
    expect(ws.tabs.map((t) => viewOfTab(t).name)).toEqual(["swarm", "tasks", "github"]);
    const tasksTab = getActiveTab(ws).id;
    ws = openView(ws, { name: "github" });
    ws = openView(ws, { name: "tasks", taskId: "B" });
    expect(ws.activeTab).toBe(tasksTab);
    expect(getActiveTab(ws).view).toEqual({ name: "tasks", taskId: "B" });
    expect(openView(ws, { name: "tasks", taskId: "B" })).toBe(ws);
  });

  it("keeps one window per agent", () => {
    let ws = openView(base(), { name: "agent", agentId: "w1" });
    ws = openView(ws, { name: "agent", agentId: "w2" });
    ws = openView(ws, { name: "agent", agentId: "w1" });
    expect(ws.tabs.filter((t) => t.view?.name === "agent").map((t) => t.view!.agentId)).toEqual(["w1", "w2"]);
    expect(getActiveTab(ws).view?.agentId).toBe("w1");
  });

  it("sends swarm to a tiling tab, creating one when only windows are open", () => {
    let ws = openView(base(), { name: "world" });
    ws = openView(ws, { name: "swarm" });
    expect(ws.activeTab).toBe("t1");
    let windows: Workspace = { version: 2, activeTab: "w", tabs: [{ id: "w", title: "", root: null, view: { name: "world" } }], autoAddAgents: true };
    windows = openView(windows, { name: "swarm" }, () => term("w2"));
    expect(getActiveTab(windows).view).toBeUndefined();
    expect(listPanels(getActiveTab(windows).root)[0].panel.agentId).toBe("w2");
  });

  it("caps open windows, closing the oldest inactive one", () => {
    let ws = base();
    const names = ["world", "missions", "agents", "models", "mcp", "skills", "connections", "commands", "memory", "activity", "github"] as const;
    for (const name of names) ws = openView(ws, { name });
    expect(ws.tabs.filter((t) => t.view)).toHaveLength(MAX_WINDOW_TABS);
    expect(getActiveTab(ws).view?.name).toBe("github");
    expect(ws.tabs.some((t) => t.view?.name === "world")).toBe(false);
  });

  it("adds panels to a tiling tab when a window is active, and opens panels as their own tab once", () => {
    let ws = openView(base(), { name: "world" });
    ws = addPanelToActive(ws, { type: "Memory" });
    expect(getActiveTab(ws).view?.name).toBe("world");
    expect(listPanels(ws.tabs[0].root).map((p) => p.panel.type)).toEqual(["AgentTerminal", "Memory"]);
    ws = openPanelTab(ws, { type: "Mission", missionId: "M1" }, "Mission M1");
    const missionTab = ws.activeTab;
    expect(getActiveTab(ws).title).toBe("Mission M1");
    ws = openPanelTab({ ...ws, activeTab: "t1" }, { type: "Mission", missionId: "M1" }, "Mission M1");
    expect(ws.activeTab).toBe(missionTab);
  });

  it("closing the last tab keeps a window tab open", () => {
    const ws: Workspace = { version: 2, activeTab: "w", tabs: [{ id: "w", title: "", root: null, view: { name: "world" } }], autoAddAgents: true };
    expect(closeTab(ws, "w")).toBe(ws);
  });
});
