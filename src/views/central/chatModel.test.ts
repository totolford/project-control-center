import { describe, expect, it } from "vitest";
import type { LogEntry, LogKind } from "../../lib/types";
import { buildChat, classifyTool, parseInput, parseToolResult, type ChatItem } from "./chatModel";

let nextId = 1;
function log(kind: LogKind, text: string, sessionId = 1): LogEntry {
  const id = nextId++;
  return { id, agentId: "central", sessionId, ts: `2026-01-01T00:00:${String(id % 60).padStart(2, "0")}Z`, kind, text };
}

function types(items: ChatItem[]): string[] {
  return items.map((i) => i.type);
}

describe("classifyTool", () => {
  it("recognizes commands, edits, MCP tools, skills and sub-agents", () => {
    expect(classifyTool('Bash {"command":"npm test","description":"tests"}')).toMatchObject({ category: "command", detail: "npm test", nested: false });
    expect(classifyTool('Edit {"file_path":"C:/p/src/App.tsx","old_string":"a"}')).toMatchObject({ category: "edit", detail: "C:/p/src/App.tsx" });
    expect(classifyTool('mcp__roblox-studio__run_code {"code":"print(1)"}')).toMatchObject({ category: "mcp", detail: "roblox-studio → run_code" });
    expect(classifyTool('Skill {"skill":"frontend-design"}')).toMatchObject({ category: "skill", detail: "frontend-design", action: "Using skill frontend-design" });
    expect(classifyTool('↳ Read {"file_path":"a.ts"}')).toMatchObject({ category: "read", nested: true, detail: "a.ts" });
    expect(classifyTool('Task {"description":"Audit","prompt":"Look"}')).toMatchObject({ category: "subagent", action: "Sub-agent: Audit" });
  });

  it("turns NEXUS coordination calls into delegations", () => {
    expect(classifyTool('mcp__pcc__create_task {"title":"Add jump","description":"…","agent":"w1"}')).toMatchObject({
      category: "nexus",
      delegation: { kind: "task", to: "w1", text: "Add jump" },
    });
    expect(classifyTool('mcp__pcc__send_message {"to":"w2","body":"Status?"}').delegation).toEqual({ kind: "message", to: "w2", text: "Status?" });
    expect(classifyTool('mcp__pcc__send_message {"body":"Done"}').delegation).toEqual({ kind: "message", to: "central", text: "Done" });
    expect(classifyTool('mcp__pcc__list_tasks {}')).toMatchObject({ category: "nexus", detail: "list_tasks" });
    expect(classifyTool('mcp__pcc__list_tasks {}').delegation).toBeUndefined();
  });

  it("reads fields from JSON truncated by the backend", () => {
    expect(classifyTool('Bash {"command":"echo a very long line that was cut')).toMatchObject({ category: "command", detail: "echo a very long line that was cut" });
  });
});

describe("parsers", () => {
  it("parses tool results", () => {
    expect(parseToolResult("✓ Bash\nok")).toEqual({ nested: false, ok: true, name: "Bash", output: "ok" });
    expect(parseToolResult("↳ ✗ Edit\nno match")).toEqual({ nested: true, ok: false, name: "Edit", output: "no match" });
    expect(parseToolResult("Turn finished (success)")).toBeNull();
  });

  it("splits joined inputs into user messages, agent messages, notifications and tasks", () => {
    const entry = log(
      "input",
      [
        "[MESSAGE MSG-1 · from user · from the human user]\nAdd a jump",
        "[MESSAGE MSG-2 · from w1 · response · re TASK-1]\nSubject: Done\nJump added",
        "[MESSAGE from system · notification]\nYour session was restarted.",
        "[TASK TASK-3] (resumed) Polish\nPriority: High\n\nMake it nice",
        "Free instructions",
      ].join("\n\n---\n\n"),
    );
    const items = parseInput(entry);
    expect(types(items)).toEqual(["user", "incoming", "incoming", "task", "prompt"]);
    expect(items[0]).toMatchObject({ text: "Add a jump" });
    expect(items[1]).toMatchObject({ from: "w1", kind: "response", subject: "Done", text: "Jump added" });
    expect(items[2]).toMatchObject({ from: "system", kind: "notification", subject: null });
    expect(items[3]).toMatchObject({ taskId: "TASK-3", title: "Polish" });
  });
});

describe("buildChat", () => {
  it("groups consecutive tool calls with their results and sums them up", () => {
    const items = buildChat([
      log("input", "[MESSAGE MSG-1 · from user · from the human user]\nShip it"),
      log("thinking", "Plan: test, then delegate."),
      log("assistant_text", "On it."),
      log("tool_use", 'Bash {"command":"npm test"}'),
      log("tool_use", 'Edit {"file_path":"src/a.ts"}'),
      log("tool_use", 'Edit {"file_path":"src/a.ts"}'),
      log("tool_use", 'mcp__github__create_pr {"title":"x"}'),
      log("tool_use", 'Skill {"skill":"pdf"}'),
      log("tool_use", 'mcp__pcc__create_task {"title":"Docs","agent":"w1"}'),
      log("tool_result", "✓ Bash\n12 passed"),
      log("error", "✗ Edit\nold_string not found"),
      log("tool_result", "✓ Edit\nok"),
      log("assistant_text", "Done."),
      log("result", "Turn finished (success) · 3 turn(s) · 4.0s · session cost $0.0100"),
    ]);
    expect(types(items)).toEqual(["user", "reasoning", "agent", "steps", "agent", "turn"]);
    const steps = items[3] as Extract<ChatItem, { type: "steps" }>;
    expect(steps.steps.map((s) => s.result?.ok)).toEqual([true, false, true, undefined, undefined, undefined]);
    expect(steps.summary).toEqual({ commands: 1, files: ["src/a.ts"], mcp: ["github → create_pr"], skills: ["pdf"], agents: ["w1"], failed: 1 });
  });

  it("merges consecutive agent text, marks sessions, collects stderr and status lines", () => {
    const items = buildChat([
      log("assistant_text", "Part 1"),
      log("assistant_text", "Part 2"),
      log("assistant_text", "↳ sub-agent text"),
      log("stderr", "warn a"),
      log("stderr", "warn b"),
      log("system", "Claude Code ready · model opus · 40 tools", 2),
      log("system", "Denied: Bash rm -rf", 2),
      log("error", "Turn finished (error_max_turns) · 9 turn(s)", 2),
      log("error", "API overloaded", 2),
    ]);
    expect(types(items)).toEqual(["agent", "agent", "stderr", "session", "status", "status", "turn", "error"]);
    expect(items[0]).toMatchObject({ text: "Part 1\n\nPart 2", nested: false });
    expect(items[1]).toMatchObject({ nested: true, text: "sub-agent text" });
    expect(items[2]).toMatchObject({ lines: ["warn a", "warn b"] });
    expect(items[3]).toMatchObject({ sessionId: 2 });
    expect(items[5]).toMatchObject({ warn: true });
    expect(items[6]).toMatchObject({ ok: false });
  });

  it("drops results whose call is older than the loaded history, keeps such errors", () => {
    const items = buildChat([log("tool_result", "✓ Bash\nold"), log("error", "✗ Bash\nboom")]);
    expect(items).toEqual([expect.objectContaining({ type: "error", text: "boom" })]);
  });
});
