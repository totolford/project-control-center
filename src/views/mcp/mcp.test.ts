import { describe, expect, it } from "vitest";
import type { Agent, Connection, PccEvent } from "../../lib/types";
import {
  agentsUsing,
  asMcpConfig,
  claudeStatus,
  claudeTarget,
  groupByScope,
  isRemovableScope,
  nexusStatus,
  redactClaudeConfig,
  redactNexusConfig,
  scopeGroup,
  toClaudeConfig,
  toolEvents,
  type ClaudeServer,
} from "./mcpModel";
import {
  EMPTY_DRAFT,
  applyCandidate,
  buildClaudeConfig,
  buildNexusInput,
  buildTestConfig,
  draftFromConnection,
  firstInvalidStep,
  isVarReference,
  stepsFor,
  validateStep,
  type McpDraft,
} from "./mcpDraft";

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: "fs",
  name: "Filesystem",
  kind: "mcp",
  config: {},
  credentialRef: null,
  status: "connected",
  statusDetail: null,
  lastChecked: null,
  createdAt: "2026-01-01T00:00:00Z",
  enabled: true,
  lastUsed: null,
  ...over,
});

const agent = (id: string, over: Partial<Agent> = {}) => ({ id, kind: "worker", status: "waiting", connections: [], ...over }) as Agent;

describe("mcp status and scopes", () => {
  it("maps Claude Code statuses and keeps unknown values raw", () => {
    expect(claudeStatus("connected")).toEqual({ label: "Connected", tone: "green" });
    expect(claudeStatus("failed").label).toBe("Error");
    expect(claudeStatus("needs-auth").tone).toBe("amber");
    expect(claudeStatus("weird")).toEqual({ label: "weird", tone: "grey" });
    expect(claudeStatus(undefined).label).toBe("Unknown");
  });

  it("shows disabled NEXUS connections as disabled", () => {
    expect(nexusStatus(conn({ enabled: false })).label).toBe("Disabled");
    expect(nexusStatus(conn({ status: "unknown" })).label).toBe("Not tested");
  });

  it("groups scopes", () => {
    expect(scopeGroup("user")).toBe("global");
    expect(scopeGroup("claudeai")).toBe("global");
    expect(scopeGroup("local")).toBe("project");
    expect(scopeGroup("plugin")).toBe("plugin");
    expect(scopeGroup("dynamic")).toBe("other");
    expect(isRemovableScope("claudeai")).toBe(false);
    expect(isRemovableScope("project")).toBe(true);
    const s = (name: string, scope: string): ClaudeServer => ({ name, scope, status: "connected", error: null, config: {}, source: null });
    const groups = groupByScope([s("a", "plugin"), s("b", "user"), s("c", "local")]);
    expect(groups.map((g) => g.group.key)).toEqual(["global", "project", "plugin"]);
  });
});

describe("mcp configs", () => {
  it("never exposes env or header values", () => {
    const r = redactClaudeConfig({ type: "stdio", command: "x", env: { TOKEN: "secret" }, headers: { Authorization: "Bearer y" } });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(r)).not.toContain("Bearer");
    expect(Object.keys(r.env as object)).toEqual(["TOKEN"]);
  });

  it("describes targets", () => {
    expect(claudeTarget({ type: "http", url: "https://x" })).toEqual({ transport: "http", target: "https://x" });
    expect(claudeTarget({ command: "npx", args: ["-y", "srv"] })).toEqual({ transport: "stdio", target: "npx -y srv" });
  });

  it("reads old connection configs and converts to Claude format", () => {
    const cfg = asMcpConfig({ command: "node", args: ["s.js"], env: { A: "1" }, secretEnv: ["KEY"] });
    expect(cfg.transport).toBe("stdio");
    expect(cfg.url).toBe("");
    expect(toClaudeConfig(cfg)).toEqual({ type: "stdio", command: "node", args: ["s.js"], env: { A: "1" } });
    expect(toClaudeConfig(cfg, { KEY: "v" })).toEqual({ type: "stdio", command: "node", args: ["s.js"], env: { A: "1", KEY: "v" } });
    expect(JSON.stringify(redactNexusConfig(cfg))).toContain("KEY");
    const remote = asMcpConfig({ transport: "sse", url: "https://h", headers: {}, secretHeaders: ["Authorization"] });
    expect(toClaudeConfig(remote, { Authorization: "t" })).toEqual({ type: "sse", url: "https://h", headers: { Authorization: "t" } });
  });

  it("lists agents granted a connection, ignoring retired ones", () => {
    const agents = [agent("a", { connections: ["fs"] }), agent("b"), agent("central", { kind: "central", connections: ["fs"] }), agent("r", { connections: ["fs"], status: "retired" })];
    expect(agentsUsing(conn(), agents).map((a) => a.id)).toEqual(["a", "central"]);
  });

  it("filters tool events by connection prefix", () => {
    const ev = (id: number, tool: string, kind = "ToolUsed") => ({ id, kind, payload: { tool } }) as PccEvent;
    const out = toolEvents([ev(1, "mcp__fs__read"), ev(3, "mcp__fs2__x"), ev(2, "mcp__fs__write"), ev(2, "mcp__fs__write"), ev(4, "mcp__fs__a", "Error")], "fs");
    expect(out.map((e) => e.id)).toEqual([2, 1]);
  });
});

describe("mcp wizard draft", () => {
  const stdio: McpDraft = { ...EMPTY_DRAFT, name: "fs", command: "npx", args: "-y\n server ", vars: [{ key: "TOKEN", value: "abc", secret: true }, { key: "MODE", value: "ro", secret: false }] };

  it("skips NEXUS-only steps for Claude Code config and the destination when editing", () => {
    expect(stepsFor({ ...EMPTY_DRAFT, target: "claude" }, false)).not.toContain("agents");
    expect(stepsFor(EMPTY_DRAFT, true)).not.toContain("target");
    expect(stepsFor(EMPTY_DRAFT, false)).toHaveLength(10);
  });

  it("validates names, servers and variables", () => {
    expect(validateStep("name", EMPTY_DRAFT)).not.toBeNull();
    expect(validateStep("name", { ...EMPTY_DRAFT, name: "has space", target: "claude" })).not.toBeNull();
    expect(validateStep("server", { ...EMPTY_DRAFT, transport: "http", url: "ftp://x" })).not.toBeNull();
    expect(validateStep("server", { ...EMPTY_DRAFT, transport: "http", url: "https://x/mcp" })).toBeNull();
    expect(validateStep("vars", { ...stdio, vars: [{ key: "BAD-NAME", value: "", secret: false }] })).toContain("not a valid");
    expect(validateStep("vars", { ...stdio, vars: [...stdio.vars, stdio.vars[0]] })).toContain("twice");
    expect(validateStep("vars", { ...stdio, vars: [{ key: "K", value: "", secret: true }] })).toContain("secret value");
    expect(validateStep("vars", { ...stdio, vars: [{ key: "K", value: "", secret: true }], storedSecrets: ["K"] })).toBeNull();
    expect(validateStep("vars", { ...stdio, transport: "http", vars: [{ key: "X-Api-Key", value: "v", secret: false }] })).toBeNull();
    expect(firstInvalidStep(stdio, false)).toBeNull();
  });

  it("requires ${VAR} references for Claude Code config", () => {
    expect(isVarReference("${TOKEN}")).toBe(true);
    expect(isVarReference("plain")).toBe(false);
    expect(validateStep("vars", { ...stdio, target: "claude" })).toContain("${VAR}");
    const ok = { ...stdio, target: "claude" as const, vars: [{ key: "TOKEN", value: "${MY_TOKEN}", secret: false }] };
    expect(validateStep("vars", ok)).toBeNull();
    expect(buildClaudeConfig(ok)).toEqual({ type: "stdio", command: "npx", args: ["-y", "server"], env: { TOKEN: "${MY_TOKEN}" } });
  });

  it("builds NEXUS inputs with secrets apart", () => {
    const input = buildNexusInput(stdio);
    expect(input.config).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "server"], env: { MODE: "ro" }, secretEnv: ["TOKEN"] });
    expect(JSON.stringify(input.config)).not.toContain("abc");
    expect(input.secrets).toEqual({ TOKEN: "abc" });
    expect(buildTestConfig(stdio)).toEqual({ type: "stdio", command: "npx", args: ["-y", "server"], env: { MODE: "ro", TOKEN: "abc" } });
  });

  it("keeps stored secrets when editing", () => {
    const cfg = asMcpConfig({ transport: "http", url: "https://h", headers: { A: "1" }, secretHeaders: ["Authorization"] });
    const d = draftFromConnection("srv", "mcp", cfg, ["a"]);
    expect(d.vars).toEqual([{ key: "A", value: "1", secret: false }, { key: "Authorization", value: "", secret: true }]);
    expect(validateStep("vars", d)).toBeNull();
    expect(buildNexusInput(d).secrets).toBeUndefined();
    expect(buildTestConfig(d)).toBeNull();
  });

  it("applies detected candidates", () => {
    const d = applyCandidate(EMPTY_DRAFT, { name: "roblox", source: "x", config: { command: "rbx.exe", args: ["--stdio"], env: {}, secretEnv: ["K"] } }, "roblox_studio");
    expect(d).toMatchObject({ name: "roblox", kind: "roblox_studio", command: "rbx.exe", args: "--stdio" });
    expect(d.vars).toEqual([{ key: "K", value: "", secret: true }]);
  });
});
