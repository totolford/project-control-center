// Default workspace builder and validation/migration of layouts loaded from
// `.agent-project/settings/workspace.json`. Pure: no React, no Tauri.

import {
  PANEL_TYPES,
  appendToGrid,
  makePanel,
  split,
  uid,
  withRoot,
  type LayoutNode,
  type PanelNode,
  type PanelSpec,
  type PanelType,
  type TabView,
  type Workspace,
  type WorkspaceTab,
} from "./layout";
import type { ViewName } from "../store";

/** What the layout needs to know about the project to build/prune panels. */
export interface LayoutContext {
  agents: { id: string; kind: string; status: string; createdAt: string }[];
  connections: { id: string; kind: string }[];
}

/** Panel types that are meaningless without an agent / a connection. */
const NEEDS_AGENT: PanelType[] = ["AgentTerminal", "AgentActivity", "Diff"];
const NEEDS_CONNECTION: PanelType[] = ["Connection"];

// ------------------------------------------------------------------ default layout

/** Every main view a window tab may show (a Record so a new ViewName must be listed here). */
const VIEW_NAMES: Record<ViewName, true> = {
  ai: true,
  usage: true,
  swarm: true,
  missions: true,
  agents: true,
  models: true,
  mcp: true,
  skills: true,
  connections: true,
  commands: true,
  memory: true,
  activity: true,
  environment: true,
  claude: true,
  autonomy: true,
  capabilities: true,
  terminal: true,
  agent: true,
  tasks: true,
  git: true,
  github: true,
  master: true,
  world: true,
  market: true,
  diagnostics: true,
  settings: true,
};

/** The window tab the center opens on: the AI World. */
function worldTab(): WorkspaceTab {
  return { id: uid("t"), title: "", root: null, view: { name: "world" } };
}

/** AI World window first (the default center view), then the Swarm tiling tab. */
export function buildDefaultWorkspace(ctx: LayoutContext): Workspace {
  const world = worldTab();
  const swarm: WorkspaceTab = { id: uid("t"), title: "Swarm", root: buildSwarmRoot(ctx) };
  return { version: 2, activeTab: world.id, tabs: [world, swarm], autoAddAgents: true };
}

/** Central (+ Roblox Studio) on the left, one terminal per non-retired worker in a grid on the right. */
export function buildSwarmRoot(ctx: LayoutContext): LayoutNode | null {
  const central = ctx.agents.find((a) => a.kind === "central");
  const roblox = ctx.connections.find((c) => c.kind === "roblox_studio");
  const left: LayoutNode[] = [];
  if (central) left.push(makePanel({ type: "CentralAgent", agentId: central.id }));
  if (roblox) left.push(makePanel({ type: "RobloxStudio", connectionId: roblox.id }));

  const workers = ctx.agents
    .filter((a) => a.kind !== "central" && a.status !== "retired")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let grid: LayoutNode | null = null;
  for (const w of workers) grid = appendToGrid(grid, makePanel({ type: "AgentTerminal", agentId: w.id }));

  const columns: LayoutNode[] = [];
  if (left.length > 0) columns.push(split("vertical", left, left.length === 2 ? [0.6, 0.4] : undefined));
  if (grid) columns.push(grid);
  return columns.length === 0 ? null : columns.length === 1 ? columns[0] : split("horizontal", columns, [0.32, 0.68]);
}

// ------------------------------------------------------------------ validation / migration

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseSpec(raw: unknown, ctx: LayoutContext): PanelSpec | null {
  if (!isRecord(raw) || !PANEL_TYPES.includes(raw.type as PanelType)) return null;
  const spec: PanelSpec = { type: raw.type as PanelType };
  const agentId = optString(raw.agentId);
  const connectionId = optString(raw.connectionId);
  if (agentId) spec.agentId = agentId;
  if (connectionId) spec.connectionId = connectionId;
  if (optString(raw.missionId)) spec.missionId = raw.missionId as string;
  if (optString(raw.taskId)) spec.taskId = raw.taskId as string;
  if (NEEDS_AGENT.includes(spec.type) && !spec.agentId) return null;
  if (NEEDS_CONNECTION.includes(spec.type) && !spec.connectionId) return null;
  if (spec.agentId && !ctx.agents.some((a) => a.id === spec.agentId)) return null;
  if (spec.connectionId && !ctx.connections.some((c) => c.id === spec.connectionId)) return null;
  return spec;
}

function parseNode(raw: unknown, ctx: LayoutContext, seen: Set<string>, depth: number): LayoutNode | null {
  if (!isRecord(raw) || depth > 12) return null;
  if (raw.type === "panel") {
    const id = optString(raw.id);
    const panel = parseSpec(raw.panel, ctx);
    if (!id || !panel || seen.has(id)) return null;
    seen.add(id);
    const node: PanelNode = { type: "panel", id, panel };
    if (raw.minimized === true) node.minimized = true;
    if (raw.pinned === true) node.pinned = true;
    return node;
  }
  if (raw.type === "split" && (raw.direction === "horizontal" || raw.direction === "vertical") && Array.isArray(raw.children)) {
    const rawSizes = Array.isArray(raw.sizes) ? raw.sizes : [];
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    raw.children.forEach((c, i) => {
      const node = parseNode(c, ctx, seen, depth + 1);
      if (node) {
        children.push(node);
        sizes.push(typeof rawSizes[i] === "number" ? (rawSizes[i] as number) : 0);
      }
    });
    if (children.length === 0) return null;
    return split(raw.direction, children, sizes);
  }
  return null;
}

function parseView(raw: unknown, ctx: LayoutContext): TabView | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !(raw.name in VIEW_NAMES) || raw.name === "swarm") return null;
  const view: TabView = { name: raw.name as ViewName };
  const agentId = optString(raw.agentId);
  if (raw.name === "agent" && (!agentId || !ctx.agents.some((a) => a.id === agentId))) return null;
  if (agentId) view.agentId = agentId;
  if (optString(raw.taskId)) view.taskId = raw.taskId as string;
  if (optString(raw.section)) view.section = raw.section as string;
  return view;
}

/** Brings older layout formats to the current version; null when unrecognizable. */
export function migrateWorkspace(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw) || !Array.isArray(raw.tabs)) return null;
  if (raw.version === 2) return raw;
  // Version 1 (0.2) had tiling tabs only: the AI World window is added in front and opened.
  // Pre-versioned layouts had the same shape without `version` / `autoAddAgents`.
  if (raw.version === 1 || raw.version === undefined) {
    const world = worldTab();
    return { ...raw, version: 2, tabs: [world, ...raw.tabs], activeTab: world.id };
  }
  return null;
}

/**
 * Validates a saved layout against the current project: drops unknown panel types,
 * panels referencing deleted agents/connections, duplicate ids, and fixes sizes.
 * Returns null when nothing usable remains (caller falls back to the default layout).
 */
export function parseWorkspace(raw: unknown, ctx: LayoutContext): Workspace | null {
  const data = migrateWorkspace(raw);
  if (!data) return null;
  const seen = new Set<string>();
  const tabIds = new Set<string>();
  const tabs: WorkspaceTab[] = [];
  for (const t of data.tabs as unknown[]) {
    if (!isRecord(t)) continue;
    const id = optString(t.id);
    if (!id || tabIds.has(id)) continue;
    tabIds.add(id);
    if (t.view !== undefined) {
      const view = parseView(t.view, ctx);
      // A window whose agent is gone is dropped (same as its panels would be).
      if (view) tabs.push({ id, title: optString(t.title)?.slice(0, 40) ?? "", root: null, view });
      continue;
    }
    const root = parseNode(t.root, ctx, seen, 0);
    const title = optString(t.title)?.slice(0, 40) ?? `Tab ${tabs.length + 1}`;
    tabs.push(withRoot({ id, title, root, maximized: optString(t.maximized) }, root));
  }
  if (tabs.length === 0) return null;
  const active = optString(data.activeTab);
  return {
    version: 2,
    activeTab: active && tabIds.has(active) ? active : tabs[0].id,
    tabs,
    autoAddAgents: data.autoAddAgents !== false,
  };
}

/** Drops panels whose agent/connection no longer exists (e.g. a deleted connection). */
export function pruneWorkspace(ws: Workspace, ctx: LayoutContext): Workspace {
  return parseWorkspace(ws, ctx) ?? ws;
}
