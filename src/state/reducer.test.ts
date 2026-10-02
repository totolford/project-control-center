import { describe, expect, it } from "vitest";
import type { Agent, Mission, PccEvent, PermissionRequest, ProjectSnapshot, Task } from "../lib/types";
import { makeAgent, makeInfo, makeSnapshot } from "../test/fixtures";
import { TIMELINE_LIMIT, applyEvent, fromSnapshot, upsertById } from "./reducer";

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return makeAgent(id, { createdBy: "user", ...patch });
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
  return makeSnapshot({ info: makeInfo({ name: "Proj", root: "C:/p" }), ...patch });
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

  it("tracks the emergency stop and bumps journal / inventory versions", () => {
    const base = fromSnapshot(snapshot({ emergency: true }));
    expect(base.emergency).toBe(true);
    const released = applyEvent(base, ev("EmergencyStop", { active: false }));
    expect(released.emergency).toBe(false);
    expect(applyEvent(released, ev("EmergencyStop", {})).emergency).toBe(false);
    expect(applyEvent(base, ev("PermissionAutoApproved", { id: 3 })).decisionVersion).toBe(1);
    expect(applyEvent(base, ev("SkillChanged", null)).toolsVersion).toBe(1);
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

describe("0.2 project data", () => {
  const request = { id: "r1", agentId: "central", kind: "secret", title: "Pi password", reason: "ssh", connectionId: "c1", key: "password", createdAt: "2026-01-01T00:00:00Z" };

  it("adds and resolves user requests from events", () => {
    const base = fromSnapshot(snapshot());
    expect(base.userRequests).toEqual([]);
    const asked = applyEvent(base, ev("UserRequested", request));
    expect(asked.userRequests.map((r) => r.id)).toEqual(["r1"]);
    expect(applyEvent(asked, ev("UserRequestResolved", { id: "r1" })).userRequests).toEqual([]);
    expect(applyEvent(asked, ev("UserRequestResolved", null)).userRequests).toHaveLength(1);
  });

  it("shows the migration report only from the snapshot that opened the project", () => {
    const migration = {
      fromFormat: 1,
      toFormat: 2,
      backup: { id: "b1", path: "C:/b", createdAt: "2026-01-01T00:00:00Z", formatVersion: 1, reason: "migration" },
      steps: [],
      integrity: [],
      ok: true,
      reportPath: "C:/r.md",
    };
    const opened = fromSnapshot(snapshot({ migration }));
    expect(opened.migration).toEqual(migration);
    const cleared = { ...opened, migration: null };
    expect(fromSnapshot(snapshot({ migration }), cleared).migration).toBeNull();
  });

  it("keeps compatibility mode and bumps reload counters", () => {
    const base = fromSnapshot(snapshot({ readOnly: true }));
    expect(base.readOnly).toBe(true);
    expect(applyEvent(base, ev("ToolUsed", { tool: "Bash" })).commandVersion).toBe(1);
    expect(applyEvent(base, ev("ProjectChanged", {})).masterVersion).toBe(1);
    expect(applyEvent(base, ev("ConnectionChanged", { id: "c1", deleted: true })).masterVersion).toBe(1);
  });
});
