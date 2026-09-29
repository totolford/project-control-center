// Pure tiling-layout model for the Swarm workspace: layout tree and workspace/tab operations.
// Default layout and validation of saved layouts live in layoutPersist.ts.

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
  | "SwarmOverview";

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

export interface WorkspaceTab {
  id: string;
  title: string;
  root: LayoutNode | null;
  maximized?: string;
}

export interface Workspace {
  version: 1;
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

/** Closes a tab; pinned panels keep the tab open. The last tab is emptied instead of removed. */
export function closeTab(ws: Workspace, tabId: string): Workspace {
  const tab = ws.tabs.find((t) => t.id === tabId);
  if (!tab || listPanels(tab.root).some((p) => p.pinned)) return ws;
  if (ws.tabs.length === 1) return withTab(ws, tabId, (t) => withRoot(t, null));
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

/** Adds a panel to the active tab's grid (no-op if the tab already shows it). */
export function addPanelToActive(ws: Workspace, spec: PanelSpec): Workspace {
  const tab = getActiveTab(ws);
  if (tabHasSpec(tab, spec)) return ws;
  return withTab(ws, tab.id, (t) => ({ ...withRoot(t, appendToGrid(t.root, makePanel(spec))), maximized: undefined }));
}
