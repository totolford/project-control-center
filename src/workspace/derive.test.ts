import { describe, expect, it } from "vitest";
import type { AgentStatus, PccEvent, TaskStatus } from "../lib/types";
import { deriveVisualState, lastTaskOf } from "./agentState";
import { deriveNotifications, unreadCount } from "./notifications";

const agent = (status: AgentStatus, currentAction: string | null = null) => ({ status, currentAction });
const task = (status: TaskStatus) => ({ status });

describe("deriveVisualState", () => {
  it("maps live statuses directly", () => {
    expect(deriveVisualState({ agent: agent("working", "Reading Formation.luau") })).toBe("working");
    expect(deriveVisualState({ agent: agent("working", "Thinking") })).toBe("thinking");
    expect(deriveVisualState({ agent: agent("awaiting_permission") })).toBe("awaiting_permission");
    expect(deriveVisualState({ agent: agent("starting") })).toBe("starting");
    expect(deriveVisualState({ agent: agent("crashed") })).toBe("error");
    expect(deriveVisualState({ agent: agent("disconnected") })).toBe("disconnected");
    expect(deriveVisualState({ agent: agent("retired"), lastTurnError: true })).toBe("retired");
  });

  it("working wins over task state and turn errors", () => {
    expect(deriveVisualState({ agent: agent("working"), currentTask: task("blocked"), lastTurnError: true })).toBe("working");
  });

  it("derives idle states from tasks and the last turn", () => {
    expect(deriveVisualState({ agent: agent("waiting"), lastTurnError: true })).toBe("error");
    expect(deriveVisualState({ agent: agent("waiting"), currentTask: task("blocked") })).toBe("blocked");
    expect(deriveVisualState({ agent: agent("waiting"), currentTask: task("waiting") })).toBe("blocked");
    expect(deriveVisualState({ agent: agent("waiting"), currentTask: task("review") })).toBe("review");
    expect(deriveVisualState({ agent: agent("waiting"), lastTask: task("review") })).toBe("review");
    expect(deriveVisualState({ agent: agent("waiting"), lastTask: task("completed") })).toBe("completed");
    expect(deriveVisualState({ agent: agent("waiting"), currentTask: task("in_progress"), lastTask: task("completed") })).toBe("waiting");
    expect(deriveVisualState({ agent: agent("waiting") })).toBe("waiting");
    expect(deriveVisualState({ agent: agent("offline") })).toBe("offline");
    expect(deriveVisualState({ agent: agent("offline"), lastTask: task("completed") })).toBe("completed");
    expect(deriveVisualState({ agent: agent("stopped") })).toBe("stopped");
  });

  it("lastTaskOf picks the most recently updated task of the agent", () => {
    const tasks = [
      { id: "1", agent: "a", updatedAt: "2026-01-01T00:00:01Z" },
      { id: "2", agent: "a", updatedAt: "2026-01-01T00:00:03Z" },
      { id: "3", agent: "b", updatedAt: "2026-01-01T00:00:09Z" },
    ] as Parameters<typeof lastTaskOf>[0];
    expect(lastTaskOf(tasks, "a")?.id).toBe("2");
    expect(lastTaskOf(tasks, "z")).toBeUndefined();
  });
});

let n = 100;
function ev(kind: PccEvent["kind"], payload: unknown, extra: Partial<PccEvent> = {}): PccEvent {
  n -= 1;
  return { id: n, ts: "2026-01-01T00:00:00Z", kind, agentId: null, taskId: null, missionId: null, summary: `${kind} summary`, payload, ...extra };
}

describe("deriveNotifications", () => {
  const names: Record<string, string> = { central: "Central", w1: "Movement" };
  const name = (id: string) => names[id] ?? id;

  it("turns relevant events into notifications with targets", () => {
    const events = [
      ev("PermissionRequested", { id: "perm1", agentId: "w1", summary: "Bash: rm -rf build" }),
      ev("AgentMessage", { id: "m1", from: "w1", to: "central", kind: "request", subject: null, body: "Need the API spec\nsecond line" }),
      ev("TaskUpdated", { id: "t1", title: "Build UI", status: "review" }),
      ev("TaskUpdated", { id: "t2", title: "Other", status: "in_progress" }),
      ev("AgentCrashed", null, { agentId: "w1" }),
      ev("MissionCompleted", {}, { missionId: "mi1" }),
      ev("AgentUpdated", {}),
      ev("GitChanged", {}),
    ];
    const list = deriveNotifications(events, name);
    expect(list.map((x) => x.title)).toEqual(["Movement needs permission", "Movement → Central", "Task ready for review", "Movement crashed", "Mission finished"]);
    expect(list[0].target).toEqual({ type: "permission", id: "perm1" });
    expect(list[1].body).toBe("request: Need the API spec");
    expect(list[1].target?.type).toBe("message");
    expect(list[2].target).toEqual({ type: "task", id: "t1" });
    expect(list[4].target).toEqual({ type: "mission", id: "mi1" });
  });

  it("keeps only the newest notification per task status", () => {
    const events = [ev("TaskUpdated", { id: "t1", title: "A", status: "failed" }), ev("TaskFailed", { id: "t1", title: "A", status: "failed" })];
    expect(deriveNotifications(events, name)).toHaveLength(1);
  });

  it("counts unread by event id", () => {
    const list = deriveNotifications([ev("AgentCreated", {}, { id: 10 }), ev("AgentCreated", {}, { id: 5 })], name);
    expect(unreadCount(list, 0)).toBe(2);
    expect(unreadCount(list, 5)).toBe(1);
    expect(unreadCount(list, 10)).toBe(0);
  });
});
