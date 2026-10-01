import { afterEach, describe, expect, it } from "vitest";
import { decisionMeta, filterDecisions, mergeDecisions, oldestId } from "./decisions";
import { groupOf, kindTone, toolOf } from "./activityGroups";
import { isStringList, pushRecent, readPref, writePref } from "./prefs";
import { detachLabel, detachUrl, parseDetachHash } from "../workspace/detach";
import type { DecisionRecord } from "./types";

const rec = (id: number, agentId: string, decision: string) => ({ id, agentId, decision }) as DecisionRecord;

describe("decision journal", () => {
  it("filters by agent and decision", () => {
    const list = [rec(3, "a", "auto_approved"), rec(2, "b", "denied"), rec(1, "a", "denied")];
    expect(filterDecisions(list, { agentId: "a", decision: "" }).map((d) => d.id)).toEqual([3, 1]);
    expect(filterDecisions(list, { agentId: "", decision: "denied" }).map((d) => d.id)).toEqual([2, 1]);
  });

  it("merges pages newest first without duplicates", () => {
    const merged = mergeDecisions([rec(5, "a", "asked"), rec(4, "a", "asked")], [rec(6, "a", "allowed"), rec(4, "a", "asked"), rec(2, "a", "denied")]);
    expect(merged.map((d) => d.id)).toEqual([6, 5, 4, 2]);
    expect(oldestId(merged)).toBe(2);
    expect(oldestId([])).toBeNull();
  });

  it("labels known decisions and passes unknown ones through", () => {
    expect(decisionMeta("auto_approved").tone).toBe("accent");
    expect(decisionMeta("something_new")).toEqual({ label: "something_new", tone: "grey" });
  });
});

describe("activity groups", () => {
  it("groups the Control Center event kinds", () => {
    expect(groupOf("PermissionAutoApproved")).toBe("permissions");
    expect(groupOf("ToolUsed")).toBe("tools");
    expect(groupOf("EmergencyStop")).toBe("safety");
    expect(groupOf("McpChanged")).toBe("mcp_skills");
    expect(groupOf("ImprovementCycle")).toBe("tasks");
    expect(kindTone("EmergencyStop")).toBe("red");
    expect(kindTone("MissionCreated")).toBe("accent");
  });

  it("reads the tool of a ToolUsed payload", () => {
    expect(toolOf({ tool: "Bash", input: {} })).toBe("Bash");
    expect(toolOf({ terminal: "t1" })).toBeNull();
    expect(toolOf(null)).toBeNull();
  });
});

describe("detached panels", () => {
  it("round-trips a panel spec through the URL hash", () => {
    const spec = { type: "AgentTerminal" as const, agentId: "w 1" };
    const url = detachUrl(spec);
    expect(url.startsWith("index.html#panel=")).toBe(true);
    expect(parseDetachHash(url.slice("index.html".length))).toEqual(spec);
  });

  it("rejects malformed hashes and unknown panel types", () => {
    expect(parseDetachHash("#panel=%7Bbad")).toBeNull();
    expect(parseDetachHash(`#panel=${encodeURIComponent(JSON.stringify({ type: "Nope" }))}`)).toBeNull();
    expect(parseDetachHash("#other")).toBeNull();
  });

  it("builds valid window labels", () => {
    expect(detachLabel("p-ab.c")).toBe("panel-p-ab_c");
  });
});

describe("preferences", () => {
  afterEach(() => localStorage.clear());

  it("reads back what was written and falls back on invalid data", () => {
    writePref("favs", ["a"]);
    expect(readPref("favs", [], isStringList)).toEqual(["a"]);
    localStorage.setItem("nexus.favs", "{oops");
    expect(readPref("favs", ["x"], isStringList)).toEqual(["x"]);
  });

  it("keeps recent items unique and capped", () => {
    expect(pushRecent(["a", "b", "c"], "b", 2)).toEqual(["b", "a"]);
  });
});
