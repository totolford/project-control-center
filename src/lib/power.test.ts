import { describe, expect, it } from "vitest";
import { cycleAccess, detectPower, powerPreset, powerScore, POWER_LEVELS } from "./power";
import { effectiveAccess, effectivePermissions, toggleIn } from "./autonomy";
import { cyclePermission, matrixAgents, toggleGrants, toggleSkills } from "./matrix";
import type { Agent, AutonomySettings, Connection, PermissionSet } from "./types";

describe("power presets", () => {
  it("detects every preset and reports custom sets as null", () => {
    for (const level of POWER_LEVELS) expect(detectPower(powerPreset(level))).toBe(level);
    expect(detectPower({ ...powerPreset("normal"), network: "allow" })).toBeNull();
  });

  it("treats missing capabilities as deny", () => {
    expect(detectPower({ fs_read: "allow", git_read: "allow", github_read: "allow" })).toBe("low");
  });

  it("mirrors the backend presets", () => {
    const high = powerPreset("high");
    expect(high.github_write).toBe("ask");
    expect(high.github_admin).toBe("deny");
    expect(high.mcp).toBe("allow");
    expect(powerPreset("normal").git_write).toBe("ask");
    expect(Object.values(powerPreset("maximum")).every((a) => a === "allow")).toBe(true);
  });

  it("orders scores LOW < NORMAL < HIGH < MAXIMUM", () => {
    const scores = POWER_LEVELS.map((l) => powerScore(powerPreset(l)));
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    expect(scores[3]).toBe(1);
  });

  it("cycles deny → ask → allow → deny", () => {
    expect(cycleAccess("deny")).toBe("ask");
    expect(cycleAccess("ask")).toBe("allow");
    expect(cycleAccess("allow")).toBe("deny");
  });
});

describe("autonomy", () => {
  const autonomy: AutonomySettings = {
    unlocked: true,
    unlockedPermissions: { ...powerPreset("normal") },
    autoApprove: true,
    manualForDestructive: true,
    manualForOutsideWorkspace: true,
    manualCapabilities: ["mcp"],
  };

  it("marks ask capabilities as auto-approved unless kept manual", () => {
    expect(effectiveAccess(autonomy, "git_write")).toBe("auto");
    expect(effectiveAccess(autonomy, "mcp")).toBe("ask");
    expect(effectiveAccess(autonomy, "fs_read")).toBe("allow");
    expect(effectiveAccess(autonomy, "ssh_execute")).toBe("deny");
    expect(effectiveAccess({ ...autonomy, autoApprove: false }, "git_write")).toBe("ask");
  });

  it("uses the unlocked set only while unlocked", () => {
    const own = powerPreset("low");
    expect(effectivePermissions(own, autonomy)).toBe(autonomy.unlockedPermissions);
    expect(effectivePermissions(own, { ...autonomy, unlocked: false })).toBe(own);
  });

  it("toggles list membership", () => {
    expect(toggleIn(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleIn(["a", "b"], "a", false)).toEqual(["b"]);
    expect(toggleIn(["a"], "a", true)).toEqual(["a"]);
  });
});

describe("capabilities matrix", () => {
  const conn = (id: string, kind: Connection["kind"], enabled = true) => ({ id, kind, enabled }) as Connection;
  const connections = [conn("r1", "roblox_studio"), conn("r2", "roblox_studio", false), conn("m1", "mcp")];

  it("cycles one capability", () => {
    const next = cyclePermission(powerPreset("low") as PermissionSet, "network");
    expect(next.network).toBe("ask");
    expect(next.fs_read).toBe("allow");
  });

  it("grants enabled connections of a kind, or revokes them all", () => {
    expect(toggleGrants(["m1"], connections, ["roblox_studio"])).toEqual(["m1", "r1"]);
    expect(toggleGrants(["m1", "r2"], connections, ["roblox_studio"])).toEqual(["m1"]);
  });

  it("toggles skills and orders agents with Central first", () => {
    expect(toggleSkills({ effort: null, skillsEnabled: true, env: {} }).skillsEnabled).toBe(false);
    const a = (id: string, kind: Agent["kind"], createdAt: string, status: Agent["status"] = "waiting") => ({ id, kind, createdAt, status }) as Agent;
    const ordered = matrixAgents([a("w2", "worker", "3"), a("c", "central", "9"), a("w1", "worker", "1"), a("old", "worker", "0", "retired")]);
    expect(ordered.map((x) => x.id)).toEqual(["c", "w1", "w2"]);
  });
});
