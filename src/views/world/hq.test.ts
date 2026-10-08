import { describe, expect, it } from "vitest";
import STRINGS_SRC from "../../../ai-town/src/nexus/strings.ts?raw";
import { I18nManager, worldI18n, type MessageKey, type TFunction } from "../../i18n";
import { CATALOGS } from "../../i18n/catalog";
import { makeAgent } from "../../test/fixtures";
import type { Connection, Mission, PccEvent, Task } from "../../lib/types";
import { makeHqRoom, makeHqView } from "./fixtures";
import {
  ROOM_KINDS,
  WORLD_STRING_KEYS,
  canArchive,
  followableMissions,
  frameSrc,
  kindName,
  languageOp,
  missionAgentIds,
  roomDetail,
  roomTarget,
  worldStrings,
} from "./hq";

/** `WORLD_STRINGS` of ai-town/src/nexus/strings.ts (read as text: that tree is type-checked by AI Town itself). */
const WORLD_STRINGS = Object.fromEntries(
  [...(STRINGS_SRC.split("WORLD_STRINGS = {")[1] ?? "").split("};")[0].matchAll(/^\s+(\w+): '([^']*)',$/gm)].map((m) => [m[1], m[2]]),
);

const task = (id: string, patch: Partial<Task>): Task => ({ id, title: id, missionId: null, agent: null, status: "pending", ...patch }) as Task;
const mission = (id: string, status: Mission["status"]): Mission => ({ id, title: `Mission ${id}`, status }) as Mission;
const event = (id: number, patch: Partial<PccEvent>): PccEvent =>
  ({ id, ts: "2026-01-01T00:00:00Z", kind: "SystemNotice", agentId: null, taskId: null, missionId: null, summary: `e${id}`, payload: {}, ...patch }) as PccEvent;

describe("room types", () => {
  it("come from the shared catalog, in English and French", () => {
    expect(ROOM_KINDS).toContain("server_room");
    expect(ROOM_KINDS[ROOM_KINDS.length - 1]).toBe("custom");
    expect(kindName("server_room", "fr")).toBe("Salle des serveurs");
    expect(kindName("server_room", "en")).toBe("Server Room");
    expect(kindName("unknown_kind", "en")).toBe("Room");
  });

  it("every room type except custom leads to a real NEXUS page", () => {
    for (const k of ROOM_KINDS.filter((k) => k !== "custom")) expect(roomTarget(k), k).not.toBeNull();
    expect(roomTarget("custom")).toBeNull();
    expect(roomTarget("central_hq")).toEqual({ kind: "central" });
    expect(roomTarget("skill_shop")).toEqual({ kind: "view", view: "market" });
  });

  it("never archives NEXUS HQ", () => {
    expect(canArchive(makeHqRoom("central_hq", "central_hq"))).toBe(false);
    expect(canArchive(makeHqRoom("api_lab", "api_lab"))).toBe(true);
    expect(canArchive(makeHqRoom("api_lab", "api_lab", { archived: true }))).toBe(false);
  });
});

describe("room panel", () => {
  const coder = { ...makeAgent("w1", { name: "Coder" }), status: "working" as const, currentAction: "Edit: src/app.ts" };
  const ops = { ...makeAgent("w2", { name: "Ops" }), status: "working" as const, currentAction: "Bash: ssh pi@192.0.2.10 uptime" };
  const sleeper = { ...makeAgent("w3", { name: "Sleeper" }), status: "sleeping" as const, currentAction: "Bash: old" };
  const view = makeHqView(
    [
      makeHqRoom("coding_office", "coding_office", { agents: ["w1"] }),
      makeHqRoom("server_room", "server_room", { requiredConnections: ["pi", "mcp:docker"] }),
      makeHqRoom("old", "custom", { archived: true }),
    ],
    [
      { agentId: "w1", roomId: "coding_office" },
      { agentId: "w2", roomId: "server_room" },
      { agentId: "w3", roomId: "server_room" },
    ],
  );
  const data = {
    agents: [coder, ops, sleeper],
    tasks: [
      task("t1", { agent: "w2", missionId: "m1", status: "in_progress" }),
      task("t2", { agent: "w2", status: "completed" }),
      task("t3", { agent: "w1", status: "review" }),
    ],
    missions: [mission("m1", "active")],
    connections: [{ id: "c1", name: "pi", status: "ok" } as unknown as Connection],
    timeline: [
      event(5, { agentId: "w2", summary: "ssh" }),
      event(4, { agentId: "w1", summary: "edit" }),
      event(3, { name: "world.rename_room", payload: { op: { op: "rename_room", room: "server_room" } }, summary: "renamed" }),
    ],
  };

  it("shows only real occupants, their active work and their real tool calls", () => {
    const d = roomDetail("server_room", view, data)!;
    expect(d.drawn).toBe(true);
    expect(d.here.map((a) => a.id)).toEqual(["w2", "w3"]);
    expect(d.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(d.missions.map((m) => m.id)).toEqual(["m1"]);
    // A sleeping agent's last action is not "in use".
    expect(d.inUse).toEqual([{ agent: ops, action: "Bash: ssh pi@192.0.2.10 uptime" }]);
    expect(d.required).toEqual([
      { name: "pi", configured: true, status: "ok" },
      { name: "mcp:docker", configured: false, status: null },
    ]);
    expect(d.recent.map((e) => e.summary)).toEqual(["ssh", "renamed"]);
  });

  it("lists assigned agents and knows archived rooms are not drawn", () => {
    expect(roomDetail("coding_office", view, data)!.assigned.map((a) => a.id)).toEqual(["w1"]);
    expect(roomDetail("old", view, data)!.drawn).toBe(false);
    expect(roomDetail("nope", view, data)).toBeNull();
  });
});

describe("Follow Mission", () => {
  it("follows only agents with an in-progress task of the mission and a live session", () => {
    const agents = [
      { ...makeAgent("a"), status: "working" as const },
      { ...makeAgent("b"), status: "offline" as const },
      { ...makeAgent("c"), status: "waiting" as const },
    ];
    const tasks = [
      task("1", { missionId: "m", agent: "a", status: "in_progress" }),
      task("2", { missionId: "m", agent: "b", status: "in_progress" }),
      task("3", { missionId: "m", agent: "c", status: "pending" }),
      task("4", { missionId: "x", agent: "c", status: "in_progress" }),
    ];
    expect(missionAgentIds("m", tasks, agents)).toEqual(["a"]);
    expect(missionAgentIds("none", tasks, agents)).toEqual([]);
    expect(followableMissions([mission("1", "active"), mission("2", "completed"), mission("3", "planning")]).map((m) => m.id)).toEqual(["1", "3"]);
  });
});

describe("AI World language", () => {
  it("brings world.json in line with the project preference and the resolved locale", () => {
    expect(languageOp({ language: "auto", locale: "en" }, undefined, "en")).toBeNull();
    expect(languageOp({ language: "auto", locale: "en" }, "auto", "fr")).toEqual({ op: "change_language", language: "auto", locale: "fr" });
    expect(languageOp({ language: "auto", locale: "en" }, "fr", "fr")).toEqual({ op: "change_language", language: "fr", locale: "fr" });
    // Languages that are not supported any more count as auto.
    expect(languageOp({ language: "auto", locale: "en" }, "de", "en")).toBeNull();
  });

  it("translates every text AI Town draws, in the world's own language", () => {
    expect(Object.keys(WORLD_STRINGS).length).toBeGreaterThan(10);
    expect([...WORLD_STRING_KEYS].sort()).toEqual(Object.keys(WORLD_STRINGS).sort());
    const fr = new I18nManager<MessageKey>(CATALOGS, "fr");
    const t = ((k: MessageKey) => fr.t(k)) as TFunction;
    const s = worldStrings(t);
    expect(s.recoverView).toBe("Récupérer la vue");
    expect(s.camera_mission).toBe("SUIVI DE MISSION");
    for (const k of WORLD_STRING_KEYS) expect(s[k].length).toBeGreaterThan(0);
    // English texts are the ones AI Town shows before NEXUS sends any.
    const en = worldStrings(((k: MessageKey) => worldI18n.t(k)) as TFunction);
    expect(en).toEqual(WORLD_STRINGS);
  });
});

describe("Safe Mode frame", () => {
  it("adds and removes safe=1 without touching the other parameters", () => {
    const f = "/ai-town/index.html?embed=nexus&world=w9";
    expect(frameSrc(f, false)).toBe(f);
    expect(frameSrc(f, true)).toBe(`${f}&safe=1`);
    expect(frameSrc(`${f}&safe=1`, false)).toBe(f);
    expect(frameSrc(`${f}&safe=1`, true)).toBe(`${f}&safe=1`);
    expect(frameSrc("/ai-town/index.html", true)).toBe("/ai-town/index.html?safe=1");
  });
});
