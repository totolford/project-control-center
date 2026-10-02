import { describe, expect, it } from "vitest";
import type { CommandRecord, CompatibilityReport, UserRequest } from "./types";
import { compatBanner, compatRows, integrityLine } from "./compat";
import { domainView, masterOff, MASTER_SWITCHES } from "./master";
import { commandDecisionMeta, commandDuration, filterCommands, formatExit, formatMs, mergeCommands, oldestCommandId } from "./commandJournal";
import { orderRequests, requestHeadline } from "./userRequests";

function report(patch: Partial<CompatibilityReport> = {}): CompatibilityReport {
  return {
    status: "compatible",
    projectFormat: 2,
    supportedFormat: 2,
    appVersion: "0.2.0",
    createdWith: "0.1.0",
    lastOpenedWith: null,
    minimumNexusVersion: null,
    databaseSchema: 3,
    supportedDatabaseSchema: 3,
    unknownFields: [],
    plan: [],
    notes: [],
    readOnly: false,
    ...patch,
  };
}

describe("compatibility", () => {
  it("picks the banner: read-only first, then newer format, else none", () => {
    expect(compatBanner(false, report())).toBeNull();
    expect(compatBanner(false, null)).toBeNull();
    expect(compatBanner(false, report({ status: "newer_format", notes: ["n"] }))).toEqual({ kind: "newer_format", notes: ["n"] });
    expect(compatBanner(true, report({ status: "requires_newer_nexus", minimumNexusVersion: "0.3.0", notes: ["x"] }))).toEqual({ kind: "read_only", minimum: "0.3.0", notes: ["x"] });
  });
  it("lists report rows with warnings where versions differ", () => {
    const rows = compatRows(report({ projectFormat: 3, unknownFields: ["world.extra"], databaseSchema: 4 }));
    expect(rows.find((r) => r.label === "Project format")).toEqual({ label: "Project format", value: "3 (supported 2)", warn: true });
    expect(rows.find((r) => r.label === "Last opened with")?.value).toBe("unknown");
    expect(rows.find((r) => r.label === "Unknown fields")).toMatchObject({ value: "world.extra", warn: true });
    expect(rows.find((r) => r.label === "Database schema")?.warn).toBe(true);
  });
  it("parses integrity lines", () => {
    expect(integrityLine("ok: agents.json")).toEqual({ state: "ok", text: "agents.json" });
    expect(integrityLine("error: tasks missing")).toEqual({ state: "error", text: "tasks missing" });
    expect(integrityLine("note")).toEqual({ state: "info", text: "note" });
  });
});

describe("MASTER CONTROL", () => {
  it("never shows an enabled but unavailable domain as active", () => {
    expect(domainView({ enabled: true, available: false, level: 1 })).toMatchObject({ state: "unavailable", tone: "orange", percent: 100 });
    expect(domainView({ enabled: false, available: true, level: 0.5 })).toMatchObject({ state: "off" });
    expect(domainView({ enabled: true, available: true, level: 1 })).toMatchObject({ state: "full", tone: "green" });
    expect(domainView({ enabled: true, available: true, level: 0.333 })).toMatchObject({ state: "partial", label: "33%" });
    expect(domainView({ enabled: true, available: true, level: 7 }).percent).toBe(100);
  });
  it("covers every switch of MasterControl and turns it off without losing them", () => {
    expect(MASTER_SWITCHES.map((s) => s.key)).toEqual(["pc", "github", "mcp", "ssh", "skills", "manageConnections"]);
    const m = { active: true, pc: true, github: false, mcp: true, ssh: false, skills: true, manageConnections: true };
    expect(masterOff(m)).toEqual({ ...m, active: false });
  });
});

function rec(id: number, patch: Partial<CommandRecord> = {}): CommandRecord {
  return {
    id,
    agentId: "central",
    source: "agent",
    toolUseId: null,
    raw: "ls",
    program: "ls",
    parsed: null,
    target: null,
    capability: "fs_read",
    decision: "allowed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.500Z",
    exitCode: 0,
    isError: false,
    output: null,
    ...patch,
  };
}

describe("command journal", () => {
  it("formats durations and exit codes", () => {
    expect(formatMs(420)).toBe("420 ms");
    expect(formatMs(3400)).toBe("3.4 s");
    expect(formatMs(125_000)).toBe("2m 05s");
    expect(formatMs(3_720_000)).toBe("1h 02m");
    expect(commandDuration(rec(1))).toBe("1.5 s");
    expect(commandDuration(rec(1, { endedAt: null }))).toBe("—");
    expect(formatExit(null)).toBe("—");
    expect(formatExit(2)).toBe("2");
  });
  it("labels decisions, merges pages and filters", () => {
    expect(commandDecisionMeta("auto_approved").label).toBe("Auto-approved");
    expect(commandDecisionMeta(null).label).toBe("—");
    expect(commandDecisionMeta("weird").label).toBe("weird");
    const merged = mergeCommands([rec(3), rec(2)], [rec(4), rec(2, { raw: "pwd" })]);
    expect(merged.map((r) => r.id)).toEqual([4, 3, 2]);
    expect(merged[2].raw).toBe("pwd");
    expect(oldestCommandId(merged)).toBe(2);
    expect(oldestCommandId([])).toBeNull();
    const list = [rec(1, { isError: true, source: "user" }), rec(2, { decision: "denied" })];
    expect(filterCommands(list, { source: "user", decision: "", errorsOnly: false }).map((r) => r.id)).toEqual([1]);
    expect(filterCommands(list, { source: "", decision: "denied", errorsOnly: false }).map((r) => r.id)).toEqual([2]);
    expect(filterCommands(list, { source: "", decision: "", errorsOnly: true }).map((r) => r.id)).toEqual([1]);
  });
});

function req(patch: Partial<UserRequest>): UserRequest {
  return { id: "r", agentId: "central", kind: "action", title: "Plug the Pi in", reason: "", connectionId: null, key: null, createdAt: "2026-01-01T00:00:00Z", ...patch };
}

describe("user requests", () => {
  it("writes a headline per kind", () => {
    expect(requestHeadline(req({ kind: "secret", key: "password" }), "Central", "Pi")).toBe("Central needs `password` for Pi");
    expect(requestHeadline(req({ kind: "ssh_key_setup", connectionId: "c1" }), "Central", null)).toBe("Central needs SSH key access to c1");
    expect(requestHeadline(req({ kind: "github_login" }), "Builder", null)).toBe("Builder needs you to sign in to GitHub");
    expect(requestHeadline(req({}), "Central", null)).toBe("Plug the Pi in");
  });
  it("orders requests oldest first", () => {
    const list = [req({ id: "b", createdAt: "2026-01-02T00:00:00Z" }), req({ id: "a" })];
    expect(orderRequests(list).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
