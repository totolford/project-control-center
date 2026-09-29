import { describe, expect, it } from "vitest";
import type { Agent, Mission, PccEvent, PermissionRequest, PermissionSet, ProjectSnapshot, Task } from "../lib/types";
import { TIMELINE_LIMIT, applyEvent, fromSnapshot, upsertById } from "./reducer";

const perms = {} as PermissionSet;

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    kind: id === "central" ? "central" : "worker",
    provider: "claude-code",
    role: "r",
    instructions: "",
    status: "offline",
    model: null,
    permissions: perms,
    connections: [],
    isolation: "shared",
    workdir: "C:/p",
    branch: null,
    currentTask: null,
    currentAction: null,
    progress: null,
    claudeSessionId: null,
    totalCostUsd: 0,
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

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
    taskTotal: 0,
    taskDone: 0,
    taskFailed: 0,
    ...patch,
  };
}

function snapshot(patch: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    info: { id: "p1", name: "Proj", root: "C:/p", createdAt: "2026-01-01T00:00:00Z", formatVersion: 1 },
    settings: {
      centralModel: null,
      workerModel: null,
      maxParallelWorkers: 3,
      useWorktrees: true,
      inheritUserSettings: false,
      defaultWorkerPermissions: perms,
      maxWorkerPermissions: perms,
      maxBudgetUsdPerSession: null,
      allowDirectWorkerMessages: false,
    },
    agents: [agent("central")],
    tasks: [],
    missions: [],
    connections: [],
    pendingPermissions: [],
    repo: null,
    recovery: null,
    ...patch,
  };
}

let nextId = 1;
function ev(kind: PccEvent["kind"], payload: unknown, id = nextId++): PccEvent {
  return { id, ts: "2026-01-01T00:00:00Z", kind, agentId: null, taskId: null, missionId: null, summary: kind, payload };
}

describe("applyEvent", () => {
  it("upserts agents from Agent* events and keeps untouched agents by reference", () => {
    const base = fromSnapshot(snapshot({ agents: [agent("central"), agent("w1")] }));
    const w1 = base.agents[1];
    const next = applyEvent(base, ev("AgentUpdated", agent("central", { status: "working", currentAction: "Reading files" }), 0));
    expect(next.agents).toHaveLength(2);
    expect(next.agents[0].status).toBe("working");
    expect(next.agents[0].currentAction).toBe("Reading files");
    expect(next.agents[1]).toBe(w1);

    const created = applyEvent(next, ev("AgentCreated", agent("w2")));
    expect(created.agents.map((a) => a.id)).toEqual(["central", "w1", "w2"]);
  });

  it("does not add AgentUpdated (id 0) to the timeline but adds persisted events", () => {
    const base = fromSnapshot(snapshot());
    const a = applyEvent(base, ev("AgentUpdated", agent("central"), 0));
    expect(a.timeline).toHaveLength(0);
    const b = applyEvent(a, ev("AgentStarted", agent("central"), 42));
    expect(b.timeline.map((e) => e.id)).toEqual([42]);
    // Duplicate delivery is ignored.
    expect(applyEvent(b, ev("AgentStarted", agent("central"), 42)).timeline).toHaveLength(1);
  });

  it("bounds the timeline and keeps newest first", () => {
    let data = fromSnapshot(snapshot());
    for (let i = 1; i <= TIMELINE_LIMIT + 20; i++) data = applyEvent(data, ev("GitChanged", {}, i));
    expect(data.timeline).toHaveLength(TIMELINE_LIMIT);
    expect(data.timeline[0].id).toBe(TIMELINE_LIMIT + 20);
    expect(data.gitVersion).toBe(TIMELINE_LIMIT + 20);
  });

  it("adds and removes pending permissions", () => {
    const req: PermissionRequest = {
      id: "perm1",
      agentId: "central",
      toolName: "Bash",
      capability: "fs_execute",
      summary: "Bash: rm -rf build",
      input: { command: "rm -rf build" },
      reason: "clean",
      ruleKey: "Bash(rm:*)",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const base = fromSnapshot(snapshot());
    const requested = applyEvent(base, ev("PermissionRequested", req));
    expect(requested.pendingPermissions).toEqual([req]);
    const again = applyEvent(requested, ev("PermissionRequested", req));
    expect(again.pendingPermissions).toHaveLength(1);
    const resolved = applyEvent(again, ev("PermissionResolved", { id: "perm1", decision: "allow_once" }));
    expect(resolved.pendingPermissions).toEqual([]);
  });

  it("replaces mission counters from Mission* payloads", () => {
    const base = fromSnapshot(snapshot({ missions: [mission("m1", { taskTotal: 4, taskDone: 1 })] }));
    const next = applyEvent(base, ev("MissionUpdated", mission("m1", { taskTotal: 5, taskDone: 3, taskFailed: 1 })));
    expect(next.missions[0]).toMatchObject({ taskTotal: 5, taskDone: 3, taskFailed: 1 });
    const done = applyEvent(next, ev("MissionCompleted", mission("m1", { status: "completed", summary: "Done\nAll good" })));
    expect(done.missions[0].status).toBe("completed");
    expect(done.missions[0].summary).toBe("Done\nAll good");
  });

  it("upserts tasks and handles connection deletion and settings changes", () => {
    const base = fromSnapshot(snapshot());
    const task = { id: "t1", title: "T", status: "queued" } as Task;
    const withTask = applyEvent(base, ev("TaskCreated", task));
    expect(withTask.tasks).toHaveLength(1);
    const failed = applyEvent(withTask, ev("TaskFailed", { ...task, status: "failed" }));
    expect(failed.tasks[0].status).toBe("failed");

    const conn = { id: "c1", name: "gh", kind: "github", status: "connected" };
    const withConn = applyEvent(failed, ev("ConnectionChanged", conn));
    expect(withConn.connections).toHaveLength(1);
    expect(applyEvent(withConn, ev("ConnectionChanged", { id: "c1", deleted: true })).connections).toHaveLength(0);

    const settings = { ...base.settings, maxParallelWorkers: 8 };
    expect(applyEvent(base, ev("ProjectChanged", { settings })).settings.maxParallelWorkers).toBe(8);
    expect(applyEvent(base, ev("ProjectChanged", {})).settings).toBe(base.settings);
  });

  it("collects live messages and bumps memory version", () => {
    const base = fromSnapshot(snapshot());
    const msg = { id: "msg1", from: "central", to: "w1", kind: "request", body: "hi", deliveredAt: null };
    const a = applyEvent(base, ev("AgentMessage", msg));
    expect(a.liveMessages).toHaveLength(1);
    const delivered = applyEvent(a, ev("AgentMessage", { ...msg, deliveredAt: "2026-01-01T00:00:01Z" }));
    expect(delivered.liveMessages).toHaveLength(1);
    expect(delivered.liveMessages[0].deliveredAt).not.toBeNull();
    expect(applyEvent(base, ev("MemoryUpdated", { key: "project" })).memoryVersion).toBe(1);
  });

  it("ignores malformed payloads", () => {
    const base = fromSnapshot(snapshot());
    const next = applyEvent(base, ev("AgentUpdated", null, 0));
    expect(next).toBe(base);
  });
});

describe("fromSnapshot", () => {
  it("keeps live state when refreshing the same project and drops empty recovery", () => {
    const first = applyEvent(fromSnapshot(snapshot()), ev("MemoryUpdated", { key: "project" }, 7));
    const refreshed = fromSnapshot(snapshot({ recovery: { agents: [] } }), first);
    expect(refreshed.timeline).toBe(first.timeline);
    expect(refreshed.memoryVersion).toBe(1);
    expect(refreshed.recovery).toBeNull();
    const other = fromSnapshot(snapshot({ info: { ...snapshot().info, id: "p2" } }), first);
    expect(other.timeline).toEqual([]);
  });
});

describe("upsertById", () => {
  it("returns the same array when the item is identical", () => {
    const a = { id: "x" };
    const list = [a];
    expect(upsertById(list, a)).toBe(list);
  });
});
