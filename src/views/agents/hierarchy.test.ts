import { describe, expect, it } from "vitest";
import type { Agent, AgentRank } from "../../lib/types";
import { buildTree, canDemote, canPromote, clampDepth, descendantCount, findNode, flatten, parentOf, pyramidStats, rankOf } from "./hierarchy";

let seq = 0;
function agent(id: string, parentAgent: string | null, rank: AgentRank, extra: Partial<Agent> = {}): Agent {
  seq += 1;
  return {
    id,
    name: id.toUpperCase(),
    kind: id === "central" ? "central" : "worker",
    provider: "claude-code",
    role: "role",
    instructions: "",
    status: "offline",
    model: null,
    permissions: {} as Agent["permissions"],
    connections: [],
    isolation: "shared",
    workdir: ".",
    branch: null,
    currentTask: null,
    currentAction: null,
    progress: null,
    claudeSessionId: null,
    totalCostUsd: 0,
    profile: {} as Agent["profile"],
    createdBy: "user",
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    updatedAt: "",
    parentAgent,
    rank,
    pausedAt: null,
    ...extra,
  };
}

function pyramid(): Agent[] {
  return [
    agent("central", null, "commander"),
    agent("lua", "central", "lieutenant"),
    agent("lua-a", "lua", "specialist", { status: "sleeping" }),
    agent("lua-b", "lua", "specialist", { pausedAt: "2026-01-01T00:00:00Z" }),
    agent("ui", "central", "lieutenant"),
    agent("ui-a", "ui", "specialist"),
    agent("solo", null, "specialist"),
  ];
}

describe("agent pyramid", () => {
  it("nests lieutenants and specialists under Central in creation order", () => {
    const tree = buildTree(pyramid());
    expect(tree).toHaveLength(1);
    const [central] = tree;
    expect(central.agent.id).toBe("central");
    expect(central.children.map((n) => n.agent.id)).toEqual(["lua", "ui", "solo"]);
    expect(findNode(tree, "lua")!.children.map((n) => n.agent.id)).toEqual(["lua-a", "lua-b"]);
    expect(flatten(tree).map((n) => [n.agent.id, n.level])).toEqual([
      ["central", 0],
      ["lua", 1],
      ["lua-a", 2],
      ["lua-b", 2],
      ["ui", 1],
      ["ui-a", 2],
      ["solo", 1],
    ]);
    expect(descendantCount(central)).toBe(6);
  });

  it("reads 0.3 agents with defaults", () => {
    const old = agent("old", null, "specialist");
    // 0.3 rows have no hierarchy fields at all.
    delete (old as Partial<Agent>).rank;
    delete (old as Partial<Agent>).parentAgent;
    expect(rankOf(old)).toBe("specialist");
    expect(parentOf(old)).toBe("central");
    expect(rankOf({ kind: "central", rank: "specialist" })).toBe("commander");
  });

  it("hangs agents with a retired parent or a parent cycle under Central", () => {
    const agents = [
      agent("central", null, "commander"),
      agent("gone", "central", "lieutenant", { status: "retired" }),
      agent("kid", "gone", "specialist"),
      agent("a", "b", "lieutenant"),
      agent("b", "a", "lieutenant"),
      agent("below", "a", "specialist"),
    ];
    const tree = buildTree(agents);
    const top = tree[0].children.map((n) => [n.agent.id, n.orphan]);
    expect(top).toEqual([
      ["kid", true],
      ["a", true],
      ["b", true],
    ]);
    expect(findNode(tree, "a")!.children.map((n) => n.agent.id)).toEqual(["below"]);
    expect(findNode(tree, "gone")).toBeUndefined();
    expect(findNode(buildTree(agents, true), "gone")!.children.map((n) => n.agent.id)).toEqual(["kid"]);
  });

  it("offers promote and demote only where the backend accepts them", () => {
    const tree = buildTree(pyramid());
    expect(canPromote(findNode(tree, "solo")!, 3).allowed).toBe(true);
    expect(canPromote(findNode(tree, "lua-a")!, 3).allowed).toBe(true);
    const deep = canPromote(findNode(tree, "lua-a")!, 2);
    expect(deep.allowed).toBe(false);
    expect(deep.reason).toContain("maximum depth of 2");
    expect(canPromote(findNode(tree, "lua")!, 3).allowed).toBe(false);
    expect(canPromote(findNode(tree, "central")!, 3).allowed).toBe(false);
    const demote = canDemote(findNode(tree, "lua")!);
    expect(demote.allowed).toBe(true);
    expect(demote.reason).toContain("2 sub-agent(s) move under its parent");
    expect(canDemote(findNode(tree, "solo")!).allowed).toBe(false);
  });

  it("counts ranks and dormant agents", () => {
    expect(pyramidStats(buildTree(pyramid()))).toEqual({ lieutenants: 2, specialists: 4, sleeping: 1, paused: 1, depth: 2 });
    expect([clampDepth(0), clampDepth(9), clampDepth(undefined), clampDepth(4)]).toEqual([1, 5, 3, 4]);
  });
});
