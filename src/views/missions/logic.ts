// Pure logic of the Missions page and panel (tabs, queue order, tree, skill
// recommendation, requirement status). Everything is derived from real data:
// missions and tasks from the store, tool uses read from the logs, grants on agents.

import type {
  Agent,
  Connection,
  Mission,
  MissionActivity,
  MissionAnalysis,
  Priority,
  Skill,
  SkillRecommendation,
  Task,
  TaskStatus,
} from "../../lib/types";
import type { ViewName } from "../../store";

export type MissionTab = "active" | "queued" | "completed" | "failed" | "archived";

export const MISSION_TABS: { key: MissionTab; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "queued", label: "Queued" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
  { key: "archived", label: "Archived" },
];

export function isRunning(m: Mission): boolean {
  return m.status === "active" || m.status === "planning";
}

export function isClosed(m: Mission): boolean {
  return m.status === "completed" || m.status === "failed" || m.status === "cancelled";
}

/** Tab a mission is listed under. Cancelled missions go with the failed ones. */
export function missionTab(m: Mission): MissionTab {
  if (m.archivedAt) return "archived";
  if (m.status === "queued") return "queued";
  if (m.status === "completed") return "completed";
  if (m.status === "failed" || m.status === "cancelled") return "failed";
  return "active";
}

const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

/** Same order as the backend queue (pcc-store `queued_missions`): priority, then oldest. */
export function compareQueue(a: Mission, b: Mission): number {
  return (
    PRIORITY_RANK[b.priority ?? "normal"] - PRIORITY_RANK[a.priority ?? "normal"] ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function finishedAt(m: Mission): string {
  return m.completedAt ?? m.updatedAt;
}

export function groupMissions(missions: Mission[]): Record<MissionTab, Mission[]> {
  const g: Record<MissionTab, Mission[]> = { active: [], queued: [], completed: [], failed: [], archived: [] };
  for (const m of missions) g[missionTab(m)].push(m);
  g.active.sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
  g.queued.sort(compareQueue);
  for (const k of ["completed", "failed", "archived"] as const) g[k].sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)));
  return g;
}

/** 1-based position in the queue, null when not queued. */
export function queuePosition(m: Mission, missions: Mission[]): number | null {
  if (m.status !== "queued") return null;
  return missions.filter((x) => x.status === "queued" && !x.archivedAt).sort(compareQueue).findIndex((x) => x.id === m.id) + 1;
}

/** Real progress: completed tasks / tasks (cancelled ones excluded by the backend). Null without tasks. */
export function progressPct(m: Mission): number | null {
  return m.taskTotal > 0 ? Math.round((m.taskDone / m.taskTotal) * 100) : null;
}

/** "M-0042" → "#42". */
export function missionNumber(id: string): string {
  const n = /(\d+)$/.exec(id);
  return n ? `#${Number(n[1])}` : id;
}

// ---------------------------------------------------------------- tree

export type Mark = "done" | "running" | "review" | "waiting" | "problem" | "cancelled";

export function taskMark(s: TaskStatus): Mark {
  switch (s) {
    case "completed":
      return "done";
    case "in_progress":
      return "running";
    case "review":
      return "review";
    case "blocked":
    case "failed":
      return "problem";
    case "cancelled":
      return "cancelled";
    default:
      return "waiting";
  }
}

export const MARK_GLYPH: Record<Mark, string> = {
  done: "✓",
  running: "●",
  review: "◆",
  waiting: "○",
  problem: "!",
  cancelled: "–",
};

export interface TreeRow {
  task: Task;
  mark: Mark;
  agentName: string | null;
  /** Ids of the tasks it waits for that are not completed yet. */
  waitingFor: string[];
}

/** The mission's tasks in creation order, with their agent and what they wait for. */
export function missionTree(missionId: string, tasks: Task[], agents: Agent[]): TreeRow[] {
  const own = tasks.filter((t) => t.missionId === missionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return own.map((t) => ({
    task: t,
    mark: taskMark(t.status),
    agentName: t.agent ? (agents.find((a) => a.id === t.agent)?.name ?? t.agent) : null,
    waitingFor: t.dependencies.filter((d) => byId.get(d)?.status !== "completed"),
  }));
}

/** Agents working on the mission (assigned to one of its tasks), in first-task order. */
export function missionAgents(rows: TreeRow[], agents: Agent[]): Agent[] {
  const ids: string[] = [];
  for (const r of rows) if (r.task.agent && !ids.includes(r.task.agent)) ids.push(r.task.agent);
  return ids.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
}

// ---------------------------------------------------------------- selection status

export type UseState = "used" | "notYet" | "granted" | "notGranted" | "missing";

export interface SelectionItem {
  name: string;
  state: UseState;
  detail: string;
}

/**
 * Selected skills / MCP servers with what really happened: "used" only when a
 * Skill / mcp__ tool call was logged; connections are "granted" when one of
 * the mission's agents holds them.
 */
export function selectionStatus(
  m: Mission,
  activity: MissionActivity | null,
  agents: Agent[],
  connections: Connection[],
): { skills: SelectionItem[]; mcp: SelectionItem[]; connections: SelectionItem[] } {
  const usage = (list: MissionActivity["skillsUsed"] | undefined, name: string): SelectionItem => {
    const u = list?.find((x) => x.name === name || x.name.split(":").pop() === name.split(":").pop());
    if (u) return { name, state: "used", detail: `invoked ${u.count}× by ${u.agents.join(", ")}` };
    return { name, state: "notYet", detail: activity ? "not invoked yet" : "usage unknown" };
  };
  const involved = new Set(activity?.agents ?? []);
  return {
    skills: m.skills.map((k) => usage(activity?.skillsUsed, k)),
    mcp: m.mcp.map((k) => usage(activity?.mcpUsed, k)),
    connections: m.connections.map((id) => {
      const c = connections.find((x) => x.id === id);
      if (!c) return { name: id, state: "missing", detail: "connection removed" };
      const holders = agents.filter((a) => involved.has(a.id) && a.connections.includes(id)).map((a) => a.name);
      return holders.length > 0
        ? { name: c.name, state: "granted", detail: `granted to ${holders.join(", ")}` }
        : { name: c.name, state: "notGranted", detail: c.enabled ? "not granted to an agent of this mission yet" : "disabled" };
    }),
  };
}

// ---------------------------------------------------------------- skills recommendation

/** Name the Skill tool expects (same rule as the backend `skill_invocation_name`). */
export function skillInvocationName(s: Pick<Skill, "name" | "scope" | "source">): string {
  const plugin = s.scope === "plugin" && s.source && s.source !== "synced" ? s.source.split("@")[0] : "";
  return plugin && !s.name.includes(":") ? `${plugin}:${s.name}` : s.name;
}

/** Result of the marketplace recommender (api.recommendSkills, market workstream). */
export type SkillRecommendationInput = Pick<SkillRecommendation, "skill" | "source" | "score" | "reason" | "installed" | "enabled" | "skillId" | "marketId">;

export interface SkillChoice {
  /** Name passed to the Skill tool. */
  name: string;
  reason: string;
  /** Installed and enabled: can be used now (shown ✓). */
  usable: boolean;
  /** Not installed or disabled: needs an action first (shown as Recommended). */
  detail: string | null;
  source: string | null;
  /** Market entry (details / install panel), when the recommender knows one. */
  marketId?: string | null;
}

function sameSkill(a: string, b: string): boolean {
  const n = (s: string) => s.trim().replace(/^\//, "").toLowerCase();
  if (n(a) === n(b)) return true;
  const tail = (s: string) => n(s).split(":").pop();
  return (!a.includes(":") || !b.includes(":")) && tail(a) === tail(b);
}

/**
 * Relevant (usable) and recommended (needs install / enable) skills, from the
 * recommender when it answered, plus the analysis' skills; checked against the
 * real installed list so nothing unusable is presented as ready.
 */
export function skillChoices(
  analysis: MissionAnalysis | null,
  recs: SkillRecommendationInput[] | null,
  installed: Skill[] | null,
): { relevant: SkillChoice[]; recommended: SkillChoice[] } {
  const out: SkillChoice[] = [];
  const push = (c: SkillChoice) => {
    const i = out.findIndex((x) => sameSkill(x.name, c.name));
    if (i < 0) out.push(c);
    else if (!out[i].reason && c.reason) out[i] = { ...out[i], reason: c.reason };
  };
  const real = (name: string, id?: string | null) =>
    (id ? installed?.find((s) => s.id === id) : undefined) ?? installed?.find((s) => sameSkill(skillInvocationName(s), name));
  const resolve = (
    name: string,
    reason: string,
    source: string | null,
    fallback: { installed: boolean; enabled: boolean } | null,
    id?: string | null,
    marketId?: string | null,
  ) => {
    const r = real(name, id);
    if (r) {
      push({
        name: skillInvocationName(r),
        reason,
        usable: r.enabled,
        detail: r.enabled ? null : "installed but disabled",
        source: source ?? r.source,
        marketId,
      });
    } else if (installed === null && fallback) {
      // Installed list unknown: trust the source's own flags.
      push({ name, reason, usable: fallback.installed && fallback.enabled, detail: fallback.installed ? (fallback.enabled ? null : "disabled") : "not installed", source, marketId });
    } else {
      push({ name, reason, usable: false, detail: "not installed", source, marketId });
    }
  };
  for (const r of [...(recs ?? [])].sort((a, b) => b.score - a.score)) {
    resolve(r.skill, r.reason, r.source, { installed: r.installed, enabled: r.enabled }, r.skillId, r.marketId);
  }
  for (const s of analysis?.skills ?? []) {
    resolve(s.name, s.reason, null, { installed: s.available || s.detail === "installed but disabled", enabled: s.available });
  }
  return { relevant: out.filter((c) => c.usable), recommended: out.filter((c) => !c.usable) };
}

// ---------------------------------------------------------------- requirements

/** Where the user fixes a missing requirement. */
export function fixView(kind: "skills" | "mcp" | "connections", detail: string | null): ViewName {
  if (kind === "mcp") return "mcp";
  if (kind === "connections") return "connections";
  return detail === "not installed" ? "market" : "skills";
}

/** Model names offered for the analysis and the mission (from Claude Code, else the usual aliases). */
export function modelNames(models: Record<string, unknown>[] | undefined): string[] {
  const names = (models ?? []).map((m) => (typeof m.value === "string" ? m.value : null)).filter((v): v is string => !!v && v !== "default");
  return names.length > 0 ? Array.from(new Set(names)) : ["haiku", "sonnet", "opus"];
}
