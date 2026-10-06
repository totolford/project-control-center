// The agent pyramid as the UI shows it: Central (commander) → lieutenants → specialists.
// Pure: mirrors the rules of crates/pcc-orchestrator/src/hierarchy.rs (levels, depth limit,
// promotion/demotion) so buttons are only offered when the backend would accept them.

import type { Agent, AgentRank } from "../../lib/types";

export const MIN_DEPTH = 1;
export const MAX_DEPTH = 5;

export interface TreeNode {
  agent: Agent;
  /** Central 0, its direct reports 1… */
  level: number;
  children: TreeNode[];
  /** Its recorded parent is missing or retired: shown under Central. */
  orphan: boolean;
}

export function clampDepth(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 3;
  return Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.round(n)));
}

/** Rank with the 0.3 defaults (Central commander, workers specialists). */
export function rankOf(a: Pick<Agent, "kind" | "rank">): AgentRank {
  if (a.kind === "central") return "commander";
  return a.rank === "lieutenant" ? "lieutenant" : "specialist";
}

/** Supervising agent id (`null` for Central; workers without parent report to Central). */
export function parentOf(a: Pick<Agent, "kind" | "parentAgent" | "id">): string | null {
  if (a.kind === "central") return null;
  return a.parentAgent && a.parentAgent !== a.id ? a.parentAgent : "central";
}

export const RANK_LABEL: Record<AgentRank, string> = {
  commander: "Commander",
  lieutenant: "Lieutenant",
  specialist: "Specialist",
};

/**
 * Builds the tree of non-retired agents (unless `includeRetired`). Agents whose
 * parent is not shown (retired, unknown, cycle) hang under Central, flagged `orphan`.
 * Siblings keep creation order.
 */
export function buildTree(agents: Agent[], includeRetired = false): TreeNode[] {
  const shown = agents.filter((a) => includeRetired || a.status !== "retired");
  const byId = new Map(shown.map((a) => [a.id, a]));
  const central = shown.find((a) => a.kind === "central");
  const kids = new Map<string, Agent[]>();
  const orphans = new Set<string>();
  for (const a of shown) {
    if (a.kind === "central") continue;
    let p = parentOf(a);
    if (!p || !byId.has(p) || loops(a.id, byId)) {
      if (!central) continue;
      p = central.id;
      if (parentOf(a) !== central.id) orphans.add(a.id);
    }
    const list = kids.get(p) ?? [];
    list.push(a);
    kids.set(p, list);
  }
  const seen = new Set<string>();
  const node = (a: Agent, level: number): TreeNode => {
    seen.add(a.id);
    const children = (kids.get(a.id) ?? [])
      .filter((c) => !seen.has(c.id))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      .map((c) => node(c, level + 1));
    return { agent: a, level, children, orphan: orphans.has(a.id) };
  };
  const roots: TreeNode[] = central ? [node(central, 0)] : [];
  // Without Central (never happens in a valid project) every top-level agent is a root.
  for (const a of shown) if (!seen.has(a.id) && a.kind !== "central" && !central) roots.push(node(a, 1));
  return roots;
}

/** True when `id` is part of a parent cycle (it then hangs under Central; agents below it stay below it). */
function loops(id: string, byId: Map<string, Agent>): boolean {
  const visited = new Set<string>([id]);
  let cur = byId.get(id);
  while (cur) {
    const p = parentOf(cur);
    if (!p) return false;
    if (visited.has(p)) return p === id;
    visited.add(p);
    cur = byId.get(p);
  }
  return false;
}

/** Depth-first list (for rendering and keyboard order). */
export function flatten(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

export function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  return flatten(nodes).find((n) => n.agent.id === id);
}

/** Every agent below the node. */
export function descendantCount(n: TreeNode): number {
  return n.children.reduce((sum, c) => sum + 1 + descendantCount(c), 0);
}

export interface RankAction {
  allowed: boolean;
  /** Why the action is refused (tooltip), or what it will do. */
  reason: string;
}

/** Specialist → lieutenant: refused when a lieutenant there could not have sub-agents. */
export function canPromote(n: TreeNode, maxDepth: number): RankAction {
  const a = n.agent;
  if (a.kind === "central") return { allowed: false, reason: "Central is the commander" };
  if (a.status === "retired") return { allowed: false, reason: `${a.name} is retired` };
  if (rankOf(a) === "lieutenant") return { allowed: false, reason: `${a.name} is already a lieutenant` };
  const max = clampDepth(maxDepth);
  if (n.level >= max)
    return { allowed: false, reason: `Level ${n.level}: with a maximum depth of ${max} a lieutenant here could not have sub-agents` };
  return { allowed: true, reason: `Promote ${a.name} to lieutenant: it may then create and supervise specialists` };
}

/** Lieutenant → specialist; its sub-agents move to its parent. */
export function canDemote(n: TreeNode): RankAction {
  const a = n.agent;
  if (a.kind === "central") return { allowed: false, reason: "Central cannot be demoted" };
  if (rankOf(a) !== "lieutenant") return { allowed: false, reason: `${a.name} is not a lieutenant` };
  return {
    allowed: true,
    reason: n.children.length
      ? `Demote ${a.name} to specialist; its ${n.children.length} sub-agent(s) move under its parent`
      : `Demote ${a.name} to specialist`,
  };
}

export interface PyramidStats {
  lieutenants: number;
  specialists: number;
  sleeping: number;
  paused: number;
  /** Deepest level in use. */
  depth: number;
}

export function pyramidStats(nodes: TreeNode[]): PyramidStats {
  const all = flatten(nodes).filter((n) => n.agent.kind !== "central");
  return {
    lieutenants: all.filter((n) => rankOf(n.agent) === "lieutenant").length,
    specialists: all.filter((n) => rankOf(n.agent) === "specialist").length,
    sleeping: all.filter((n) => n.agent.status === "sleeping").length,
    paused: all.filter((n) => n.agent.pausedAt).length,
    depth: all.reduce((m, n) => Math.max(m, n.level), 0),
  };
}
