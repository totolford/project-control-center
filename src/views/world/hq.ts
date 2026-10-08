// NEXUS HQ on the NEXUS side (pure, tested): where a room leads, what a
// room panel shows (real agents, tasks, missions, connections, events only),
// who Follow Mission follows, the AI World language sync and the texts drawn
// inside the world. Room types come from ai-town/data/nexusRooms.json, the
// same file the Rust side (crates/pcc-world/src/hq/catalog.rs) and the AI Town
// map generator read.

import ROOMS from "../../../ai-town/data/nexusRooms.json";
import type { MessageKey, TFunction } from "../../i18n";
import type { Locale } from "../../i18n";
import type { Agent, AgentStatus, Connection, HqConfig, HqOp, HqRoom, HqView, Mission, PccEvent, Task, TaskStatus } from "../../lib/types";
import type { ViewName } from "../../store";

type KindSpec = { names: Record<string, string>; purpose: Record<string, string> };
const KINDS = (ROOMS as unknown as { kinds: Record<string, KindSpec> }).kinds;

/** Room types, in catalog order (`custom` last). */
export const ROOM_KINDS: string[] = Object.keys(KINDS).sort((a, b) => (a === "custom" ? 1 : b === "custom" ? -1 : 0));

export function kindName(kind: string, locale: string): string {
  const k = KINDS[kind] ?? KINDS.custom;
  return k.names[locale] ?? k.names.en ?? kind;
}

/** Where a room leads in NEXUS. */
export type RoomTarget = { kind: "view"; view: ViewName } | { kind: "central" };

const TARGETS: Record<string, RoomTarget> = {
  central_hq: { kind: "central" },
  coding_office: { kind: "view", view: "swarm" },
  testing_lab: { kind: "view", view: "tasks" },
  design_studio: { kind: "view", view: "swarm" },
  roblox_studio: { kind: "view", view: "connections" },
  github_office: { kind: "view", view: "github" },
  server_room: { kind: "view", view: "connections" },
  mcp_lab: { kind: "view", view: "mcp" },
  skill_shop: { kind: "view", view: "market" },
  review_room: { kind: "view", view: "tasks" },
  archive: { kind: "view", view: "memory" },
  web_dev: { kind: "view", view: "swarm" },
  api_lab: { kind: "view", view: "swarm" },
  database_room: { kind: "view", view: "connections" },
  cicd_room: { kind: "view", view: "github" },
  docs_room: { kind: "view", view: "memory" },
};

/** The NEXUS page of a room type (custom rooms have none). */
export function roomTarget(kind: string): RoomTarget | null {
  return TARGETS[kind] ?? null;
}

export function targetLabel(target: RoomTarget, t: TFunction): string {
  return target.kind === "central" ? "Central" : t.dynamic(`nav.${target.view}`, undefined, target.view);
}

/** Room ids of NEXUS HQ (crates/pcc-world/src/hq/validate.rs `valid_id`). */
export function isRoomId(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9_-]{1,48}$/.test(v);
}

// ---------------------------------------------------------------- room panel

const ACTIVE_TASK: TaskStatus[] = ["in_progress", "waiting", "blocked", "review"];
const ABSENT: AgentStatus[] = ["offline", "stopped", "crashed", "disconnected", "retired", "sleeping"];

export interface RoomDetail {
  room: HqRoom;
  /** Drawn in the world (not archived, placed). */
  drawn: boolean;
  /** Agents the world puts in this room now (same resolution as the bridge). */
  here: Agent[];
  /** Agents Central assigned to the room (may be elsewhere now). */
  assigned: Agent[];
  tasks: Task[];
  missions: Mission[];
  /** What the agents here are really doing (their current tool call). */
  inUse: { agent: Agent; action: string }[];
  required: { name: string; configured: boolean; status: string | null }[];
  recent: PccEvent[];
}

export function roomDetail(
  roomId: string,
  view: HqView,
  data: { agents: Agent[]; tasks: Task[]; missions: Mission[]; connections: Connection[]; timeline: PccEvent[] },
): RoomDetail | null {
  const room = view.config.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const byId = new Map(data.agents.map((a) => [a.id, a]));
  const here = view.occupancy
    .filter((o) => o.roomId === roomId)
    .map((o) => byId.get(o.agentId))
    .filter((a): a is Agent => !!a);
  const assigned = room.agents.map((id) => byId.get(id)).filter((a): a is Agent => !!a);
  const ids = new Set(here.map((a) => a.id));
  const tasks = data.tasks.filter((t) => t.agent && ids.has(t.agent) && ACTIVE_TASK.includes(t.status));
  const missionIds = new Set(tasks.map((t) => t.missionId).filter(Boolean));
  const missions = data.missions.filter((m) => missionIds.has(m.id));
  const inUse = here.filter((a) => a.currentAction && !ABSENT.includes(a.status)).map((a) => ({ agent: a, action: a.currentAction as string }));
  const required = room.requiredConnections.map((name) => {
    const c = data.connections.find((x) => x.name === name || x.id === name);
    return { name, configured: !!c, status: c ? c.status : null };
  });
  const involved = new Set([...ids, ...room.agents]);
  const recent = data.timeline
    .filter((e) => (e.agentId && involved.has(e.agentId)) || worldEventRoom(e) === roomId)
    .slice(0, 8);
  return { room, drawn: view.layout.rooms.some((r) => r.id === roomId), here, assigned, tasks, missions, inUse, required, recent };
}

/** The room a `world.*` journal event is about, if any. */
function worldEventRoom(e: PccEvent): string | null {
  if (!e.name?.startsWith("world.")) return null;
  const op = e.payload?.op;
  return op && typeof op.room === "string" ? op.room : null;
}

// ---------------------------------------------------------------- Follow Mission

/** Missions that can be followed (planning or running). */
export function followableMissions(missions: Mission[]): Mission[] {
  return missions.filter((m) => m.status === "active" || m.status === "planning");
}

/**
 * The agents really working on a mission now: an in-progress task of the
 * mission is theirs and their session is up. Nothing else is invented; the
 * list may be empty (the world then says nobody is working on it).
 */
export function missionAgentIds(missionId: string, tasks: Task[], agents: Agent[]): string[] {
  const out: string[] = [];
  for (const a of agents) {
    if (ABSENT.includes(a.status)) continue;
    const working = tasks.some((t) => t.missionId === missionId && t.agent === a.id && t.status === "in_progress");
    if (working) out.push(a.id);
  }
  return out;
}

// ---------------------------------------------------------------- language

/**
 * The `change_language` that brings world.json in line with the AI World
 * language: the project preference (`auto` or a locale) and the locale it
 * resolves to here. Null when nothing changes.
 */
export function languageOp(config: Pick<HqConfig, "language" | "locale">, projectPref: string | undefined, locale: Locale): HqOp | null {
  const language = projectPref === "en" || projectPref === "fr" ? projectPref : "auto";
  if (config.language === language && config.locale === locale) return null;
  return { op: "change_language", language, locale };
}

/** Texts AI Town draws itself (ai-town/src/nexus/strings.ts keys), in the AI World language. */
export const WORLD_STRING_KEYS = [
  "crashed",
  "recoverView",
  "loading",
  "noAgents",
  "safeMode",
  "nobodyOnMission",
  "nothingActive",
  "camera_free",
  "camera_follow",
  "camera_cinematic",
  "camera_overview",
  "camera_mission",
] as const;

export function worldStrings(t: TFunction): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of WORLD_STRING_KEYS) out[k] = t(`worldhq.w.${k}` as MessageKey);
  return out;
}

// ---------------------------------------------------------------- frame

/** The iframe address, with AI World Safe Mode (`safe=1`) when asked. */
export function frameSrc(frontend: string, safe: boolean): string {
  const clean = frontend.replace(/([?&])safe=1(&|$)/, (_, a: string, b: string) => (b ? a : "")).replace(/[?&]$/, "");
  if (!safe) return clean;
  return `${clean}${clean.includes("?") ? "&" : "?"}safe=1`;
}

/** Rooms shown in the building panel: active first (as drawn), archived apart. */
export function splitRooms(config: HqConfig): { active: HqRoom[]; archived: HqRoom[] } {
  return { active: config.rooms.filter((r) => !r.archived), archived: config.rooms.filter((r) => r.archived) };
}

/** NEXUS HQ itself is never archived (crates/pcc-world/src/hq/ops.rs). */
export function canArchive(room: HqRoom): boolean {
  return !room.archived && room.type !== "central_hq";
}
