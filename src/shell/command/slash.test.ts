import { describe, expect, it } from "vitest";
import { looksLikeCommandLine, matchAgentPrefix, parseBar, suggest, type SuggestContext } from "./slash";

const agents = [
  { id: "central", name: "Central" },
  { id: "w1", name: "Movement" },
  { id: "w2", name: "Movement Agent" },
];

const ctx: SuggestContext = { agents, skills: ["frontend-design", "pdf"], mcp: ["github", "roblox-studio"], models: ["default", "opus", "sonnet"] };

describe("parseBar", () => {
  it("sends plain text to Central and explains command lines", () => {
    expect(parseBar("   ", agents)).toEqual({ type: "empty" });
    expect(parseBar("How is the build going?", agents)).toEqual({ type: "ask", text: "How is the build going?" });
    expect(parseBar("ssh pi@raspberrypi.local", agents)).toEqual({ type: "interpret", line: "ssh pi@raspberrypi.local" });
    expect(parseBar("ssh pi@raspberrypi.local", agents, true)).toEqual({ type: "ask", text: "ssh pi@raspberrypi.local" });
  });

  it("parses /mission, /mcp, /skill, /github and /ssh", () => {
    expect(parseBar("/mission  Fix the login flow ", agents)).toEqual({ type: "mission", text: "Fix the login flow" });
    expect(parseBar("/mission", agents)).toEqual({ type: "mission", text: "" });
    expect(parseBar("/mcp github", agents)).toEqual({ type: "mcp", query: "github" });
    expect(parseBar("/skills pdf", agents)).toEqual({ type: "skill", query: "pdf" });
    expect(parseBar("/gh", agents)).toEqual({ type: "github", query: "" });
    expect(parseBar("/ssh pi@host -p 2222", agents)).toEqual({ type: "interpret", line: "ssh pi@host -p 2222" });
    expect(parseBar("/ssh", agents)).toEqual({ type: "unknown", command: "ssh" });
    expect(parseBar("/run git clone https://x/y", agents)).toEqual({ type: "interpret", line: "git clone https://x/y" });
    expect(parseBar("/teleport", agents)).toEqual({ type: "unknown", command: "teleport" });
  });

  it("resolves /agent with the longest matching name, then the message", () => {
    expect(parseBar("/agent movement agent jump higher", agents)).toEqual({ type: "agent", agentId: "w2", query: "movement agent jump higher", message: "jump higher" });
    expect(parseBar("/agent Movement fix it", agents)).toMatchObject({ agentId: "w1", message: "fix it" });
    expect(parseBar("/agent w1", agents)).toMatchObject({ agentId: "w1", message: "" });
    expect(parseBar("/agent nobody hi", agents)).toEqual({ type: "agent", agentId: null, query: "nobody hi", message: "" });
    expect(parseBar("/agent", agents)).toMatchObject({ agentId: null, query: "" });
  });

  it("parses /model <agent> <model>", () => {
    expect(parseBar("/model central opus", agents)).toEqual({ type: "model", agentId: "central", model: "opus", query: "central opus" });
    expect(parseBar("/model Movement Agent", agents)).toMatchObject({ agentId: "w2", model: null });
    expect(parseBar("/model ghost opus", agents)).toMatchObject({ agentId: null, model: null });
  });
});

describe("helpers", () => {
  it("recognizes command lines of known programs only", () => {
    expect(looksLikeCommandLine("claude mcp add x -- npx y")).toBe(true);
    expect(looksLikeCommandLine("git.exe status")).toBe(true);
    expect(looksLikeCommandLine("git")).toBe(false);
    expect(looksLikeCommandLine("git is broken, why?")).toBe(false);
    expect(looksLikeCommandLine("please ssh to the pi")).toBe(false);
    expect(looksLikeCommandLine("ssh a\nssh b")).toBe(false);
  });

  it("matches agent names on word boundaries", () => {
    expect(matchAgentPrefix("Movementally", agents)).toBeNull();
    expect(matchAgentPrefix("central   hello", agents)).toMatchObject({ agent: { id: "central" }, rest: "hello" });
  });
});

describe("suggest", () => {
  it("lists commands for a bare slash and filters by prefix", () => {
    expect(suggest("hello", ctx)).toEqual([]);
    expect(suggest("/", ctx).map((s) => s.insert)).toContain("/mission ");
    expect(suggest("/m", ctx).map((s) => s.insert)).toEqual(["/mission ", "/mcp ", "/model "]);
  });

  it("completes agents, models, skills and MCP servers", () => {
    expect(suggest("/agent mov", ctx).map((s) => s.insert)).toEqual(["/agent Movement ", "/agent Movement Agent "]);
    expect(suggest("/model Central ", ctx).map((s) => s.insert)).toEqual(["/model Central default", "/model Central opus", "/model Central sonnet"]);
    expect(suggest("/model Central so", ctx).map((s) => s.insert)).toEqual(["/model Central sonnet"]);
    expect(suggest("/model Central opus", ctx)).toEqual([]);
    expect(suggest("/skill f", ctx).map((s) => s.insert)).toEqual(["/skill frontend-design"]);
    expect(suggest("/mcp ro", ctx).map((s) => s.insert)).toEqual(["/mcp roblox-studio"]);
    expect(suggest("/github x", ctx)).toEqual([]);
  });
});
