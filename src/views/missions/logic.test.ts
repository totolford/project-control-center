import { describe, expect, it } from "vitest";
import type { Agent, Mission, MissionAnalysis, Skill, Task } from "../../lib/types";
import { makeAgent } from "../../test/fixtures";
import {
  fixView,
  groupMissions,
  missionNumber,
  missionTab,
  missionTree,
  modelNames,
  progressPct,
  queuePosition,
  selectionStatus,
  skillChoices,
  skillInvocationName,
} from "./logic";

function mission(id: string, patch: Partial<Mission> = {}): Mission {
  return {
    id,
    title: id,
    prompt: "p",
    status: "active",
    summary: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    priority: "normal",
    model: null,
    skills: [],
    mcp: [],
    connections: [],
    analysis: null,
    startedAt: null,
    archivedAt: null,
    taskTotal: 0,
    taskDone: 0,
    taskFailed: 0,
    ...patch,
  };
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    missionId: "M-0042",
    title: id,
    description: "",
    status: "pending",
    priority: "normal",
    agent: null,
    dependencies: [],
    requiresReview: false,
    progress: null,
    statusReason: null,
    result: null,
    createdBy: "central",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
    ...patch,
  };
}

function skill(name: string, patch: Partial<Skill> = {}): Skill {
  return {
    id: name,
    name,
    description: "",
    scope: "user",
    source: null,
    enabled: true,
    editable: true,
    dir: "",
    frontmatter: {},
    allowedTools: [],
    files: [],
    problems: [],
    ...patch,
  };
}

describe("tabs and queue", () => {
  it("classifies every status, archived first", () => {
    expect(missionTab(mission("a", { status: "planning" }))).toBe("active");
    expect(missionTab(mission("a", { status: "queued" }))).toBe("queued");
    expect(missionTab(mission("a", { status: "completed" }))).toBe("completed");
    expect(missionTab(mission("a", { status: "cancelled" }))).toBe("failed");
    expect(missionTab(mission("a", { status: "completed", archivedAt: "2026-02-01T00:00:00Z" }))).toBe("archived");
  });

  it("orders the queue like the backend: priority, then oldest", () => {
    const ms = [
      mission("M-1", { status: "queued", createdAt: "2026-01-01T00:00:01Z" }),
      mission("M-2", { status: "queued", createdAt: "2026-01-01T00:00:02Z", priority: "high" }),
      mission("M-3", { status: "queued", createdAt: "2026-01-01T00:00:03Z" }),
      mission("M-4", { status: "active" }),
    ];
    expect(groupMissions(ms).queued.map((m) => m.id)).toEqual(["M-2", "M-1", "M-3"]);
    expect(queuePosition(ms[2], ms)).toBe(3);
    expect(queuePosition(ms[3], ms)).toBeNull();
  });

  it("progress comes from task counters only", () => {
    expect(progressPct(mission("a"))).toBeNull();
    expect(progressPct(mission("a", { taskTotal: 8, taskDone: 5 }))).toBe(63);
    expect(missionNumber("M-0042")).toBe("#42");
  });
});

describe("tree", () => {
  it("lists the mission's tasks with their agent and open dependencies", () => {
    const agents: Agent[] = [makeAgent("ui", { name: "UI Agent" })];
    const tasks = [
      task("TASK-1", { status: "completed", createdAt: "2026-01-01T00:00:01Z" }),
      task("TASK-2", { status: "in_progress", agent: "ui", dependencies: ["TASK-1"], createdAt: "2026-01-01T00:00:02Z" }),
      task("TASK-3", { dependencies: ["TASK-2"], createdAt: "2026-01-01T00:00:03Z" }),
      task("TASK-9", { missionId: "M-0001" }),
    ];
    const rows = missionTree("M-0042", tasks, agents);
    expect(rows.map((r) => [r.task.id, r.mark, r.agentName])).toEqual([
      ["TASK-1", "done", null],
      ["TASK-2", "running", "UI Agent"],
      ["TASK-3", "waiting", null],
    ]);
    expect(rows[1].waitingFor).toEqual([]);
    expect(rows[2].waitingFor).toEqual(["TASK-2"]);
  });
});

describe("selection status", () => {
  it("says used only when a tool call was logged, granted only when an agent holds it", () => {
    const m = mission("M-0042", { skills: ["ui-ux-pro-max:design", "tests"], mcp: ["roblox"], connections: ["github", "gone"] });
    const agents = [makeAgent("ui", { name: "UI Agent", connections: ["github"] })];
    const conns = [{ id: "github", name: "GitHub", enabled: true } as never];
    const s = selectionStatus(
      m,
      {
        missionId: "M-0042",
        agents: ["central", "ui"],
        skillsUsed: [{ name: "ui-ux-pro-max:design", agents: ["ui"], count: 2, last: "" }],
        mcpUsed: [],
        from: "",
        to: null,
      },
      agents,
      conns,
    );
    expect(s.skills.map((x) => x.state)).toEqual(["used", "notYet"]);
    expect(s.mcp[0].state).toBe("notYet");
    expect(s.connections.map((x) => x.state)).toEqual(["granted", "missing"]);
    expect(selectionStatus(m, null, agents, conns).skills[0].detail).toBe("usage unknown");
  });
});

describe("skill recommendation", () => {
  const installed = [
    skill("design", { scope: "plugin", source: "ui-ux-pro-max@ui-ux-pro-max-skill" }),
    skill("old", { enabled: false }),
  ];

  it("builds plugin invocation names", () => {
    expect(skillInvocationName(installed[0])).toBe("ui-ux-pro-max:design");
    expect(skillInvocationName(skill("x", { scope: "plugin", source: "synced" }))).toBe("x");
  });

  it("checks the analysis and recommender against the installed list", () => {
    const analysis = {
      skills: [
        { name: "ui-ux-pro-max:design", reason: "UI", available: true, detail: null },
        { name: "magic", reason: "?", available: false, detail: "not installed" },
      ],
    } as unknown as MissionAnalysis;
    const recs = [
      { skill: "old", source: "local", score: 0.4, reason: "legacy", installed: true, enabled: true },
      { skill: "design", source: "plugin", score: 0.9, reason: "best match", installed: true, enabled: true },
      { skill: "frontend-design", source: "anthropics/skills", score: 0.2, reason: "web UI", installed: false, enabled: false, marketId: "mk-1" },
    ];
    const c = skillChoices(analysis, recs, installed);
    expect(c.relevant.map((x) => [x.name, x.reason])).toEqual([["ui-ux-pro-max:design", "best match"]]);
    // The recommender said enabled, the real list says disabled: the real list wins.
    expect(c.recommended.map((x) => [x.name, x.detail])).toEqual([
      ["old", "installed but disabled"],
      ["frontend-design", "not installed"],
      ["magic", "not installed"],
    ]);
    expect(c.recommended.find((x) => x.name === "frontend-design")?.marketId).toBe("mk-1");
    expect(skillChoices(null, null, installed)).toEqual({ relevant: [], recommended: [] });
  });

  it("links missing requirements to where they are fixed", () => {
    expect(fixView("skills", "not installed")).toBe("market");
    expect(fixView("skills", "installed but disabled")).toBe("skills");
    expect(fixView("mcp", null)).toBe("mcp");
    expect(modelNames([{ value: "default" }, { value: "sonnet" }])).toEqual(["sonnet"]);
    expect(modelNames(undefined)).toEqual(["haiku", "sonnet", "opus"]);
  });
});
