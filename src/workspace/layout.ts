// Pure model of the center workspace: tabs that either tile panels (layout tree) or show one full
// view ("window" tabs: AI World, an agent, GitHub…), and the workspace/tab operations.
// Default layout and validation of saved layouts live in layoutPersist.ts.

import type { ViewName } from "../store";

export type PanelType =
  | "AgentTerminal"
  | "AgentActivity"
  | "CentralAgent"
  | "RobloxStudio"
  | "Connection"
  | "GitHub"
  | "TaskBoard"
  | "Mission"
  | "Memory"
  | "Diff"
  | "Review"
  | "Activity"
  | "SwarmOverview"
  | "RawTerminal"
  | "AiWorld";

export const PANEL_TYPES: PanelType[] = [
  "AgentTerminal",
  "AgentActivity",
  "CentralAgent",
  "RobloxStudio",
  "Connection",
  "GitHub",
  "TaskBoard",
  "Mission",
  "Memory",
  "Diff",
  "Review",
  "Activity",
  "SwarmOverview",
  "RawTerminal",
  "AiWorld",
];

export interface PanelSpec {
  type: PanelType;
  agentId?: string;
  connectionId?: string;
  missionId?: string;
  taskId?: string;
}

export interface PanelNode {
  type: "panel";
  id: string;
  panel: PanelSpec;
  minimized?: boolean;
  pinned?: boolean;
}

export type Direction = "horizontal" | "vertical";

export interface SplitNode {
  type: "split";
  direction: Direction;
  /** Fractions summing to 1, one per child. */
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PanelNode | SplitNode;

/** What a window tab shows: a main view and its selection (mirrors `View` in store.ts). */
export interface TabView {
  name: ViewName;
  agentId?: string;
  taskId?: string;
  section?: string;
}

export interface WorkspaceTab {
  id: string;
  title: string;
  /** Tiling tabs only (window tabs keep null). */
  root: LayoutNode | null;
  maximized?: string;
  /** Window tab: shows this view instead of a tiling layout. */
  view?: TabView;
}

export interface Workspace {
  version: 2;
  activeTab: string;
  tabs: WorkspaceTab[];
  /** Add a terminal panel automatically when a new agent appears. */
  autoAddAgents: boolean;
}

export type DockZone = "left" | "right" | "top" | "bottom" | "center";

export const MAX_PER_ROW = 4;
export const MIN_FRACTION = 0.08;

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function makePanel(panel: PanelSpec, extra: Partial<PanelNode> = {}): PanelNode {
  return { type: "panel", id: uid("p"), panel, ...extra };
}

/** Identity of what a panel shows (two panels with the same key show the same thing). */
export function specKey(s: PanelSpec): string {
  return [s.type, s.agentId ?? "", s.connectionId ?? "", s.missionId ?? "", s.taskId ?? ""].join(":");
}

export function listPanels(node: LayoutNode | null): PanelNode[] {
  if (!node) return [];
  if (node.type === "panel") return [node];
  return node.children.flatMap(listPanels);
}

export function normalizeSizes(sizes: number[], n: number): number[] {
  const raw = Array.from({ length: n }, (_, i) => {
    const v = sizes[i];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1 / n;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / total);
}

export function split(direction: Direction, children: LayoutNode[], sizes?: number[]): LayoutNode {
  if (children.length === 1) return children[0];
  return { type: "split", direction, children, sizes: normalizeSizes(sizes ?? [], children.length) };
}

/** Removes a panel; splits left with one child collapse into it. */
export function removeNode(node: LayoutNode | null, panelId: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === "panel") return node.id === panelId ? null : node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const next = removeNode(c, panelId);
    if (next) {
      kept.push(next);
      sizes.push(node.sizes[i]);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === node.children.length && kept.every((c, i) => c === node.children[i])) return node;
  return split(node.direction, kept, sizes);
}

/** Rebuilds the tree, replacing every panel with the result of `fn` (identity preserved when unchanged). */
export function mapPanels(node: LayoutNode | null, fn: (p: PanelNode) => LayoutNode): LayoutNode | null {
  if (!node) return null;
  if (node.type === "panel") return fn(node);
  let changed = false;
  const children = node.children.map((c) => {
    const next = mapPanels(c, fn)!;
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export function updatePanel(node: LayoutNode | null, panelId: string, patch: Partial<Omit<PanelNode, "type" | "id">>): LayoutNode | null {
  return mapPanels(node, (p) => (p.id === panelId ? { ...p, ...patch } : p));
}

/** Inserts `panel` next to the panel `targetId` on the side given by `zone` (not "center"). */
export function insertBeside(node: LayoutNode, targetId: string, panel: PanelNode, zone: Exclude<DockZone, "center">): LayoutNode {
  const direction: Direction = zone === "left" || zone === "right" ? "horizontal" : "vertical";
  const before = zone === "left" || zone === "top";
  if (node.type === "panel") {
    if (node.id !== targetId) return node;
    return split(direction, before ? [panel, node] : [node, panel]);
  }
  const idx = node.children.findIndex((c) => c.type === "panel" && c.id === targetId);
  if (idx >= 0 && node.direction === direction) {
    const children = node.children.slice();
    const sizes = node.sizes.slice();
    const half = sizes[idx] / 2;
    sizes[idx] = half;
    const at = before ? idx : idx + 1;
    children.splice(at, 0, panel);
    sizes.splice(at, 0, half);
    return { ...node, children, sizes };
  }
  let changed = false;
  const children = node.children.map((c) => {
    const next = insertBeside(c, targetId, panel, zone);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** Moves `sourceId` onto `targetId`: edges re-tile, center swaps the two panels. */
export function dockPanel(root: LayoutNode | null, sourceId: string, targetId: string, zone: DockZone): LayoutNode | null {
  if (!root || sourceId === targetId) return root;
  const panels = listPanels(root);
  const source = panels.find((p) => p.id === sourceId);
  const target = panels.find((p) => p.id === targetId);
  if (!source || !target) return root;
  if (zone === "center") return mapPanels(root, (p) => (p.id === sourceId ? target : p.id === targetId ? source : p));
  const without = removeNode(root, sourceId);
  return without ? insertBeside(without, targetId, source, zone) : source;
}

/** Appends a panel as a grid: rows (vertical split) of up to MAX_PER_ROW panels. */
export function appendToGrid(root: LayoutNode | null, panel: PanelNode): LayoutNode {
  if (!root) return panel;
  if (root.type === "panel") return split("horizontal", [root, panel]);
  if (root.direction === "horizontal") {
    if (root.children.length < MAX_PER_ROW) return split("horizontal", [...root.children, panel]);
    return split("vertical", [root, panel]);
  }
  const last = root.children[root.children.length - 1];
  const rows = root.children.slice(0, -1);
  let lastRows: LayoutNode[];
  if (last.type === "panel") lastRows = [split("horizontal", [last, panel])];
  else if (last.direction === "horizontal" && last.children.length < MAX_PER_ROW) lastRows = [split("horizontal", [...last.children, panel])];
  else lastRows = [last, panel];
  return split("vertical", [...rows, ...lastRows]);
}

/** Sets the sizes of the split at `path` (child indices from the root). */
export function setSplitSizes(node: LayoutNode | null, path: number[], sizes: number[]): LayoutNode | null {
  if (!node || node.type !== "split") return node;
  if (path.length === 0) {
    const n = node.children.length;
    const clamped = normalizeSizes(sizes, n).map((s) => Math.max(MIN_FRACTION, s));
    return { ...node, sizes: normalizeSizes(clamped, n) };
  }
  const [head, ...rest] = path;
  const child = node.children[head];
  if (!child) return node;
  const next = setSplitSizes(child, rest, sizes)!;
  if (next === child) return node;
  const children = node.children.slice();
  children[head] = next;
  return { ...node, children };
}

// ------------------------------------------------------------------ workspace operations

export function getActiveTab(ws: Workspace): WorkspaceTab {
  return ws.tabs.find((t) => t.id === ws.activeTab) ?? ws.tabs[0];
}

export function findPanelTab(ws: Workspace, panelId: string): WorkspaceTab | undefined {
  return ws.tabs.find((t) => listPanels(t.root).some((p) => p.id === panelId));
}

function withTab(ws: Workspace, tabId: string, fn: (t: WorkspaceTab) => WorkspaceTab): Workspace {
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId ? fn(t) : t)) };
}

export function withRoot(tab: WorkspaceTab, root: LayoutNode | null): WorkspaceTab {
  const ids = new Set(listPanels(root).map((p) => p.id));
  return { ...tab, root, maximized: tab.maximized && ids.has(tab.maximized) ? tab.maximized : undefined };
}

function nextTabTitle(ws: Workspace): string {
  const taken = new Set(ws.tabs.map((t) => t.title));
  let n = ws.tabs.length + 1;
  while (taken.has(`Tab ${n}`)) n += 1;
  return `Tab ${n}`;
}

export function addTab(ws: Workspace, root: LayoutNode | null = null, title?: string): Workspace {
  const tab: WorkspaceTab = { id: uid("t"), title: title ?? nextTabTitle(ws), root };
  return { ...ws, tabs: [...ws.tabs, tab], activeTab: tab.id };
}

/** Closes a tab; pinned panels keep the tab open. The last tab is emptied instead of removed (a last window tab stays). */
export function closeTab(ws: Workspace, tabId: string): Workspace {
  const tab = ws.tabs.find((t) => t.id === tabId);
  if (!tab || listPanels(tab.root).some((p) => p.pinned)) return ws;
  if (ws.tabs.length === 1) return tab.view ? ws : withTab(ws, tabId, (t) => withRoot(t, null));
  const idx = ws.tabs.indexOf(tab);
  const tabs = ws.tabs.filter((t) => t.id !== tabId);
  const activeTab = ws.activeTab === tabId ? tabs[Math.max(0, idx - 1)].id : ws.activeTab;
  return { ...ws, tabs, activeTab };
}

export function renameTab(ws: Workspace, tabId: string, title: string): Workspace {
  const clean = title.trim().slice(0, 40);
  return clean ? withTab(ws, tabId, (t) => ({ ...t, title: clean })) : ws;
}

export function setActiveTab(ws: Workspace, tabId: string): Workspace {
  return ws.tabs.some((t) => t.id === tabId) ? { ...ws, activeTab: tabId } : ws;
}

/** Closes a panel unless it is pinned. */
export function closePanel(ws: Workspace, panelId: string): Workspace {
  const tab = findPanelTab(ws, panelId);
  const panel = tab && listPanels(tab.root).find((p) => p.id === panelId);
  if (!tab || !panel || panel.pinned) return ws;
  return withTab(ws, tab.id, (t) => withRoot(t, removeNode(t.root, panelId)));
}

export function patchPanel(ws: Workspace, panelId: string, patch: Partial<Omit<PanelNode, "type" | "id">>): Workspace {
  const tab = findPanelTab(ws, panelId);
  if (!tab) return ws;
  return withTab(ws, tab.id, (t) => ({ ...t, root: updatePanel(t.root, panelId, patch) }));
}

export function toggleMaximize(ws: Workspace, panelId: string): Workspace {
  const tab = findPanelTab(ws, panelId);
  if (!tab) return ws;
  return withTab(ws, tab.id, (t) => ({ ...t, maximized: t.maximized === panelId ? undefined : panelId }));
}

export function restoreMaximized(ws: Workspace): Workspace {
  const tab = getActiveTab(ws);
  return tab.maximized ? withTab(ws, tab.id, (t) => ({ ...t, maximized: undefined })) : ws;
}

/** Moves a (non-pinned) panel into a new tab and activates it. */
export function movePanelToNewTab(ws: Workspace, panelId: string): Workspace {
  const tab = findPanelTab(ws, panelId);
  const panel = tab && listPanels(tab.root).find((p) => p.id === panelId);
  if (!tab || !panel || panel.pinned) return ws;
  const without = withTab(ws, tab.id, (t) => withRoot(t, removeNode(t.root, panelId)));
  return addTab(without, { ...panel, minimized: false });
}

/** Docks a panel within its tab. Pinned panels do not move. */
export function dock(ws: Workspace, sourceId: string, targetId: string, zone: DockZone): Workspace {
  const tab = findPanelTab(ws, sourceId);
  if (!tab || findPanelTab(ws, targetId) !== tab) return ws;
  const source = listPanels(tab.root).find((p) => p.id === sourceId);
  const target = listPanels(tab.root).find((p) => p.id === targetId);
  if (!source || !target || source.pinned || (zone === "center" && target.pinned)) return ws;
  return withTab(ws, tab.id, (t) => withRoot(t, dockPanel(t.root, sourceId, targetId, zone)));
}

export function resizeSplit(ws: Workspace, tabId: string, path: number[], sizes: number[]): Workspace {
  return withTab(ws, tabId, (t) => ({ ...t, root: setSplitSizes(t.root, path, sizes) }));
}

export function tabHasSpec(tab: WorkspaceTab, spec: PanelSpec): boolean {
  const key = specKey(spec);
  return listPanels(tab.root).some((p) => specKey(p.panel) === key);
}

/**
 * Adds a panel to the grid of the active tiling tab (no-op if the tab already shows it). When a window
 * tab is active, the panel goes to the first tiling tab (created, not activated, if there is none).
 */
export function addPanelToActive(ws: Workspace, spec: PanelSpec): Workspace {
  const active = getActiveTab(ws);
  let target = active.view ? ws.tabs.find((t) => !t.view) : active;
  let base = ws;
  if (!target) {
    target = { id: uid("t"), title: "Swarm", root: null };
    base = { ...ws, tabs: [...ws.tabs, target] };
  }
  if (tabHasSpec(target, spec)) return ws;
  return withTab(base, target.id, (t) => ({ ...withRoot(t, appendToGrid(t.root, makePanel(spec))), maximized: undefined }));
}

// ------------------------------------------------------------------ window tabs (one full view each)

/** At most this many window tabs stay open; opening one more closes the oldest inactive one. */
export const MAX_WINDOW_TABS = 10;

/** Identity of a window: one tab per view, one per agent. */
export function viewKey(v: Pick<TabView, "name" | "agentId">): string {
  return v.name === "agent" ? `agent:${v.agentId ?? ""}` : v.name;
}

/** The view a tab stands for ("swarm" for tiling tabs). */
export function viewOfTab(tab: WorkspaceTab): TabView {
  return tab.view ?? { name: "swarm" };
}

export function tabMatchesView(tab: WorkspaceTab, view: Pick<TabView, "name" | "agentId">): boolean {
  if (view.name === "swarm") return !tab.view;
  return Boolean(tab.view) && viewKey(tab.view!) === viewKey(view);
}

export function sameView(a: TabView, b: TabView): boolean {
  return a.name === b.name && a.agentId === b.agentId && a.taskId === b.taskId && a.section === b.section;
}

function cleanView(v: TabView): TabView {
  const out: TabView = { name: v.name };
  if (v.agentId) out.agentId = v.agentId;
  if (v.taskId) out.taskId = v.taskId;
  if (v.section) out.section = v.section;
  return out;
}

/** Activates a tiling tab (the active one, else the first, else a new one built by `buildRoot`). */
export function focusTiling(ws: Workspace, buildRoot: () => LayoutNode | null): Workspace {
  if (!getActiveTab(ws).view) return ws;
  const tiling = ws.tabs.find((t) => !t.view);
  if (tiling) return { ...ws, activeTab: tiling.id };
  return addTab(ws, buildRoot(), "Swarm");
}

/**
 * Shows a view in the center: activates its window tab (updating its selection), or opens a new
 * window tab. "swarm" goes to a tiling tab. Returns `ws` itself when nothing changes.
 */
export function openView(ws: Workspace, view: TabView, buildRoot: () => LayoutNode | null = () => null): Workspace {
  if (view.name === "swarm") return focusTiling(ws, buildRoot);
  const next = cleanView(view);
  const existing = ws.tabs.find((t) => tabMatchesView(t, next));
  if (existing) {
    if (existing.id === ws.activeTab && sameView(existing.view!, next)) return ws;
    return { ...ws, activeTab: existing.id, tabs: ws.tabs.map((t) => (t.id === existing.id ? { ...t, view: next } : t)) };
  }
  const tab: WorkspaceTab = { id: uid("t"), title: "", root: null, view: next };
  const activeIdx = ws.tabs.findIndex((t) => t.id === ws.activeTab);
  const tabs = ws.tabs.slice();
  tabs.splice(activeIdx + 1, 0, tab);
  let out: Workspace = { ...ws, tabs, activeTab: tab.id };
  const windows = out.tabs.filter((t) => t.view);
  if (windows.length > MAX_WINDOW_TABS) {
    const drop = windows.find((t) => t.id !== tab.id && t.id !== ws.activeTab) ?? windows.find((t) => t.id !== tab.id);
    if (drop) out = { ...out, tabs: out.tabs.filter((t) => t.id !== drop.id) };
  }
  return out;
}

/** Opens a new tiling tab showing one panel (e.g. a mission or Roblox Studio as its own window). */
export function openPanelTab(ws: Workspace, spec: PanelSpec, title: string): Workspace {
  const key = specKey(spec);
  const existing = ws.tabs.find((t) => !t.view && t.root?.type === "panel" && specKey(t.root.panel) === key);
  if (existing) return existing.id === ws.activeTab ? ws : { ...ws, activeTab: existing.id };
  return addTab(ws, makePanel(spec), title);
}
