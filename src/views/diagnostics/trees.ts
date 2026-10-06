// Trees shown by the Diagnostics page, built from real backend data (pure, tested).

import { AGENT_STATUS, CONNECTION_STATUS, MISSION_STATUS, TASK_STATUS, type Tone } from "../../lib/labels";
import { formatBytes } from "../../lib/format";
import type { Agent, Connection, Mission, ProcInfo, Task } from "../../lib/types";

export interface TreeNode {
  id: string;
  label: string;
  /** Right-aligned detail (status, PID, memory…). */
  detail?: string;
  status?: { label: string; tone: Tone };
  children: TreeNode[];
}

function agentStatus(status: string): { label: string; tone: Tone } {
  return (AGENT_STATUS as Record<string, { label: string; tone: Tone }>)[status] ?? { label: status, tone: "grey" };
}

/** Hierarchy fields added by 0.4 (absent on older backends). */
function hierarchyOf(a: Agent): { parent: string | null; rank: string | null } {
  const x = a as Agent & { parentAgent?: unknown; rank?: unknown };
  return { parent: typeof x.parentAgent === "string" ? x.parentAgent : null, rank: typeof x.rank === "string" ? x.rank : null };
}

/** Agents under their supervisors (Central at the root). `hierarchical` is false when the backend has no parent links. */
export function agentTree(agents: Agent[]): { roots: TreeNode[]; hierarchical: boolean } {
  const hierarchical = agents.some((a) => hierarchyOf(a).parent !== null || hierarchyOf(a).rank !== null);
  const central = agents.find((a) => a.kind === "central");
  const node = (a: Agent): TreeNode => {
    const { rank } = hierarchyOf(a);
    return {
      id: a.id,
      label: a.name,
      detail: [rank, a.role, a.model ?? "default model"].filter(Boolean).join(" · "),
      status: agentStatus(a.status),
      children: [],
    };
  };
  const nodes = new Map(agents.map((a) => [a.id, node(a)]));
  const roots: TreeNode[] = [];
  for (const a of agents) {
    const n = nodes.get(a.id)!;
    // Agents without a supervisor (older rows, or no hierarchy at all) report to Central.
    let parent = hierarchyOf(a).parent ?? (a.kind === "central" ? null : (central?.id ?? null));
    if (parent === a.id) parent = null;
    const p = parent ? nodes.get(parent) : undefined;
    if (p && !isAncestor(nodes, n, p)) p.children.push(n);
    else roots.push(n);
  }
  return { roots, hierarchical };
}

function isAncestor(_nodes: Map<string, TreeNode>, maybeAncestor: TreeNode, of: TreeNode): boolean {
  // Guards against cycles in bad data: a node never becomes a child of its own descendant.
  const stack = [...maybeAncestor.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n === of) return true;
    stack.push(...n.children);
  }
  return maybeAncestor === of;
}

/** Missions → tasks → assigned agent; finished/archived missions last. */
export function missionTree(missions: Mission[], tasks: Task[], agents: Agent[]): TreeNode[] {
  const name = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? id) : "unassigned");
  const order = (m: Mission) => (m.status === "active" || m.status === "planning" ? 0 : m.status === "queued" ? 1 : 2);
  const sorted = [...missions].sort((a, b) => order(a) - order(b) || b.createdAt.localeCompare(a.createdAt));
  const nodes: TreeNode[] = sorted.map((m) => ({
    id: m.id,
    label: m.title,
    status: MISSION_STATUS[m.status] ?? { label: m.status, tone: "grey" },
    detail: `${tasks.filter((t) => t.missionId === m.id && t.status === "completed").length}/${tasks.filter((t) => t.missionId === m.id).length} tasks`,
    children: tasks
      .filter((t) => t.missionId === m.id)
      .map((t) => ({ id: t.id, label: t.title, detail: name(t.agent), status: TASK_STATUS[t.status] ?? { label: t.status, tone: "grey" }, children: [] })),
  }));
  const loose = tasks.filter((t) => !t.missionId || !missions.some((m) => m.id === t.missionId));
  if (loose.length > 0)
    nodes.push({
      id: "no-mission",
      label: "Tasks outside missions",
      detail: `${loose.length} tasks`,
      children: loose.map((t) => ({ id: t.id, label: t.title, detail: name(t.agent), status: TASK_STATUS[t.status] ?? { label: t.status, tone: "grey" }, children: [] })),
    });
  return nodes;
}

/** MCP connections of the project, with the agents allowed to use them. */
export function mcpTree(connections: Connection[], agents: Agent[]): TreeNode[] {
  return connections
    .filter((c) => c.kind === "mcp" || c.kind === "roblox_studio")
    .map((c) => ({
      id: c.id,
      label: c.name,
      detail: [c.enabled === false ? "disabled" : null, c.statusDetail].filter(Boolean).join(" · ") || c.kind,
      status: CONNECTION_STATUS[c.status] ?? { label: c.status, tone: "grey" },
      children: agents
        .filter((a) => a.connections.includes(c.id))
        .map((a) => ({ id: `${c.id}:${a.id}`, label: a.name, status: agentStatus(a.status), children: [] })),
    }));
}

/** Flat depth-first process list (from the backend) → nested nodes. */
export function processTree(procs: ProcInfo[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: { node: TreeNode; depth: number }[] = [];
  for (const p of procs) {
    const node: TreeNode = {
      id: String(p.pid),
      label: p.name,
      detail: `PID ${p.pid} · ${formatBytes(p.memoryBytes)} · ${p.cpuPct.toFixed(1)} % CPU`,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].depth >= p.depth) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ node, depth: p.depth });
  }
  return roots;
}

const LABEL_KEYS = ["name", "label", "title", "toolName", "command", "id", "agentId"];
const CHILD_KEYS = ["children", "processes", "items", "nodes"];
const STATUS_KEYS = ["status", "state", "verdict"];

/**
 * Best-effort tree from another workstream's response whose exact shape this page does not know:
 * objects become nodes (name/label/title…), arrays become siblings, `children`-like keys nest.
 */
export function genericTree(value: unknown, id = "root", depth = 0): TreeNode[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => genericTree(v, `${id}.${i}`, depth + 1));
  if (typeof value !== "object") return [{ id, label: String(value), children: [] }];
  const o = value as Record<string, unknown>;
  const labelKey = LABEL_KEYS.find((k) => typeof o[k] === "string" || typeof o[k] === "number");
  const childKey = CHILD_KEYS.find((k) => Array.isArray(o[k]));
  const statusKey = STATUS_KEYS.find((k) => typeof o[k] === "string");
  if (!labelKey && !childKey) {
    // A map of named sections ({ agents: [...], mcp: [...] }).
    return Object.entries(o).map(([k, v]) => ({
      id: `${id}.${k}`,
      label: k,
      detail: typeof v === "object" ? undefined : String(v),
      children: typeof v === "object" ? genericTree(v, `${id}.${k}`, depth + 1) : [],
    }));
  }
  const pid = o.pid ?? o.processId;
  const detail = [pid !== undefined && pid !== null ? `PID ${String(pid)}` : null, typeof o.detail === "string" ? o.detail : null, typeof o.kind === "string" ? o.kind : null]
    .filter(Boolean)
    .join(" · ");
  const status = statusKey ? String(o[statusKey]) : null;
  return [
    {
      id: `${id}.${String(o.id ?? o[labelKey ?? ""] ?? depth)}`,
      label: labelKey ? String(o[labelKey]) : "(unnamed)",
      detail: detail || undefined,
      status: status ? { label: status, tone: statusTone(status) } : undefined,
      children: childKey ? genericTree(o[childKey], id, depth + 1) : [],
    },
  ];
}

export function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (/(crash|error|fail|lost|dead|zombie|denied|expired|unresponsive|stalled)/.test(s)) return "red";
  if (/(pending|wait|starting|recover|degraded|stale|sleep|paused)/.test(s)) return "amber";
  if (/(running|ok|alive|connected|active|approved|healthy|working|consumed|busy|idle)/.test(s)) return "green";
  return "grey";
}

export function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((n, x) => n + 1 + countNodes(x.children), 0);
}

/** Permission record as returned by the permissions workstream (read defensively). */
export interface PermissionLike {
  id: string;
  agentId: string;
  toolName?: string;
  capability?: string;
  summary?: string;
  status?: string;
  kind?: string;
  expiresAt?: string | null;
  missionId?: string | null;
}

/** Agents → their permission requests/grants, pending and active first. */
export function permissionTree(records: unknown, agents: Agent[]): TreeNode[] {
  if (!Array.isArray(records)) return [];
  const list = records.filter((r): r is PermissionLike => typeof r === "object" && r !== null && typeof (r as PermissionLike).id === "string");
  const rank = (s = "") => (/pending|wait|recovered/.test(s) ? 0 : /approved|granted|active/.test(s) ? 1 : 2);
  const byAgent = new Map<string, PermissionLike[]>();
  for (const r of list) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
  return [...byAgent.entries()].map(([agentId, rs]) => {
    const agent = agents.find((a) => a.id === agentId);
    const pending = rs.filter((r) => rank(r.status) === 0).length;
    return {
      id: `perm:${agentId}`,
      label: agent?.name ?? agentId,
      detail: `${rs.length} permission(s)${pending ? ` · ${pending} pending` : ""}`,
      status: agent ? agentStatus(agent.status) : undefined,
      children: [...rs]
        .sort((a, b) => rank(a.status) - rank(b.status))
        .map((r) => ({
          id: r.id,
          label: [r.toolName, r.capability ? `(${r.capability})` : null].filter(Boolean).join(" ") || r.summary || r.id,
          detail: [r.kind, r.summary, r.expiresAt ? `expires ${r.expiresAt}` : null].filter(Boolean).join(" · ") || undefined,
          status: r.status ? { label: r.status, tone: statusTone(r.status) } : undefined,
          children: [],
        })),
    };
  });
}
