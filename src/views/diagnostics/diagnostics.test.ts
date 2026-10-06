import { describe, expect, it } from "vitest";
import type { Agent, Mission, PccEvent, ProcInfo } from "../../lib/types";
import { makeAgent } from "../../test/fixtures";
import { defaultName, defaultSeverity, groupByMission, isRestartEvent, matches, mergeEntries, toEntry } from "./journal";
import { agentTree, countNodes, genericTree, permissionTree, processTree, statusTone } from "./trees";

function ev(id: number, patch: Partial<PccEvent> & Record<string, unknown> = {}): PccEvent {
  return { id, ts: `2026-10-03T10:00:${String(id).padStart(2, "0")}Z`, kind: "AgentStarted", agentId: null, taskId: null, missionId: null, summary: `event ${id}`, payload: {}, ...patch } as PccEvent;
}

const mission = (id: string, title: string): Mission => ({ id, title, status: "active" }) as Mission;

describe("journal entries", () => {
  it("derives a dotted name and severity from the kind when the engine sends none", () => {
    expect(defaultName("AgentStarted")).toBe("agent.started");
    expect(defaultName("PermissionAutoApproved")).toBe("permission.autoApproved");
    expect(defaultName("Error")).toBe("controlCenter.error");
    expect(defaultSeverity("AgentCrashed")).toBe("error");
    expect(defaultSeverity("EmergencyStop")).toBe("critical");
    expect(defaultSeverity("AgentStarted")).toBe("info");
    const e = toEntry(ev(1));
    expect(e).toMatchObject({ name: "agent.started", severity: "info", source: "engine", pid: null });
  });

  it("keeps the 0.4 fields when present", () => {
    const e = toEntry(ev(1, { kind: "SystemNotice" as PccEvent["kind"], name: "recovery.mcpRestarted", severity: "warning", source: "recovery", pid: 4242 }));
    expect(e).toMatchObject({ name: "recovery.mcpRestarted", severity: "warning", source: "recovery", pid: 4242 });
    expect(toEntry(ev(2, { severity: "bogus" })).severity).toBe("info");
  });

  it("merges overlapping lists newest first, dropping non-persistent events", () => {
    const merged = mergeEntries([ev(3), ev(0)], [ev(1), ev(3), ev(2)]);
    expect(merged.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("filters by agent, mission, minimum severity, source and text", () => {
    const e = toEntry(ev(1, { agentId: "a1", missionId: "m1", severity: "error", source: "recovery", pid: 77, summary: "MCP disconnected" }));
    expect(matches(e, {})).toBe(true);
    expect(matches(e, { agentId: "a2" })).toBe(false);
    expect(matches(e, { missionId: "m1", severity: "warning" })).toBe(true);
    expect(matches(e, { severity: "critical" })).toBe(false);
    expect(matches(e, { source: "engine" })).toBe(false);
    expect(matches(e, { text: "mcp disc" })).toBe(true);
    expect(matches(e, { text: "77" })).toBe(true);
    expect(matches(e, { text: "builder" }, () => "Builder")).toBe(true);
  });

  it("groups by mission, chain oldest first, groups by latest activity", () => {
    const entries = mergeEntries([
      ev(1, { missionId: "m1" }),
      ev(2, { missionId: "m2", severity: "error" }),
      ev(3, { missionId: "m1", kind: "AgentCrashed" }),
      ev(4),
    ]);
    const groups = groupByMission(entries, [mission("m1", "Fix login")]);
    expect(groups.map((g) => g.title)).toEqual(["Outside missions", "Fix login", "Mission m2"]);
    expect(groups[1].entries.map((e) => e.id)).toEqual([1, 3]);
    expect(groups[1].counts.error).toBe(1);
    expect(groups[1].first < groups[1].last).toBe(true);
    expect(groups[2].mission).toBeNull();
  });

  it("recognizes restarts, crashes and recoveries", () => {
    expect(isRestartEvent(toEntry(ev(1, { kind: "AgentCrashed" })))).toBe(true);
    expect(isRestartEvent(toEntry(ev(1, { name: "ui.rendererRecovered" })))).toBe(true);
    expect(isRestartEvent(toEntry(ev(1)))).toBe(false);
  });
});

describe("diagnostics trees", () => {
  it("puts workers under Central when the engine has no hierarchy", () => {
    const plain = (id: string, patch: Partial<Agent>) => ({ ...makeAgent(id, patch), parentAgent: undefined, rank: undefined }) as unknown as Agent;
    const agents = [plain("c", { kind: "central", name: "Central" }), plain("w1", { name: "W1" }), plain("w2", { name: "W2" })];
    const { roots, hierarchical } = agentTree(agents);
    expect(hierarchical).toBe(false);
    expect(roots.map((r) => r.id)).toEqual(["c"]);
    expect(roots[0].children.map((c) => c.id)).toEqual(["w1", "w2"]);
  });

  it("follows parent links and ranks when present, and survives cycles", () => {
    const agents = [
      makeAgent("c", { kind: "central" }),
      { ...makeAgent("lt", {}), parentAgent: "c", rank: "lieutenant" },
      { ...makeAgent("w", {}), parentAgent: "lt", rank: "specialist" },
      { ...makeAgent("x", {}), parentAgent: "y" },
      { ...makeAgent("y", {}), parentAgent: "x" },
    ] as Agent[];
    const { roots, hierarchical } = agentTree(agents);
    expect(hierarchical).toBe(true);
    const c = roots.find((r) => r.id === "c")!;
    expect(c.children[0].id).toBe("lt");
    expect(c.children[0].detail).toMatch(/^lieutenant/);
    expect(c.children[0].children[0].id).toBe("w");
    expect(countNodes(roots)).toBe(5);
  });

  it("nests the depth-first process list", () => {
    const p = (pid: number, depth: number): ProcInfo => ({ pid, parent: null, name: `p${pid}`, memoryBytes: 1024, cpuPct: 0, depth });
    const roots = processTree([p(1, 0), p(2, 1), p(3, 2), p(4, 1)]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((c) => c.id)).toEqual(["2", "4"]);
    expect(roots[0].children[0].children[0].id).toBe("3");
  });

  it("builds a best-effort tree from unknown shapes", () => {
    const nodes = genericTree({ watch: [{ name: "mcp-github", status: "connected", pid: 9, children: [{ name: "node" }] }], orphans: [] });
    expect(nodes.map((n) => n.label)).toEqual(["watch", "orphans"]);
    const mcp = nodes[0].children[0];
    expect(mcp).toMatchObject({ label: "mcp-github", detail: "PID 9", status: { label: "connected", tone: "green" } });
    expect(mcp.children[0].label).toBe("node");
    expect(statusTone("crashed")).toBe("red");
    expect(statusTone("recovering")).toBe("amber");
    expect(statusTone("idle")).toBe("green");
    expect(statusTone("stalled")).toBe("red");
    expect(statusTone("exited")).toBe("grey");
  });

  it("groups permissions by agent, pending first, and ignores malformed rows", () => {
    const agents = [makeAgent("w1", { name: "Builder" })];
    const nodes = permissionTree(
      [
        { id: "p1", agentId: "w1", toolName: "Bash", capability: "shell", status: "consumed", kind: "tool" },
        { id: "p2", agentId: "w1", toolName: "Edit", capability: "fs_write", status: "pending", kind: "tool" },
        { id: "p3", agentId: "gone", toolName: "Bash", status: "expired" },
        { nope: true },
      ],
      agents,
    );
    expect(nodes.map((n) => n.label)).toEqual(["Builder", "gone"]);
    expect(nodes[0].detail).toBe("2 permission(s) · 1 pending");
    expect(nodes[0].children.map((c) => c.id)).toEqual(["p2", "p1"]);
    expect(nodes[0].children[0]).toMatchObject({ label: "Edit (fs_write)", status: { tone: "amber" } });
    expect(nodes[1].children[0].status?.tone).toBe("red");
    expect(permissionTree(null, agents)).toEqual([]);
  });
});
