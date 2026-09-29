import { describe, expect, it } from "vitest";
import { describeTool, mcpServerOf, parseToolUse, previewResult } from "./toolText";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";
import { turnOutcome } from "./logBus";

describe("tool transcript lines", () => {
  it("describes tool calls like the backend", () => {
    expect(parseToolUse(String.raw`Read {"file_path":"C:\\p\\src\\FormationController.luau"}`).action).toBe("Reading FormationController.luau");
    expect(parseToolUse(`Bash {"command":"npm test","description":"Run tests"}`).action).toBe("Running Run tests");
    expect(parseToolUse(`mcp__pcc__complete_task {"taskId":"t1"}`).action).toBe("Coordinating: complete_task");
    expect(parseToolUse(`mcp__roblox-studio__run_code {}`).action).toBe("Using roblox-studio → run_code");
    expect(describeTool("TodoWrite", null)).toBe("Updating plan");
  });

  it("handles nested calls and truncated JSON", () => {
    const call = parseToolUse(`↳ Edit {"file_path":"src/app.ts","old_string":"abc…`);
    expect(call.nested).toBe(true);
    expect(call.input).toBeNull();
    expect(call.action).toBe("Editing app.ts");
  });

  it("extracts MCP server ids and previews results", () => {
    expect(mcpServerOf("mcp__conn-1__insert_part")).toBe("conn-1");
    expect(mcpServerOf("Read")).toBeNull();
    expect(previewResult("✓ Read\nline1\nline2\nline3")).toEqual({ head: "✓ Read\nline1", hidden: 2 });
  });

  it("detects turn outcomes from log entries", () => {
    expect(turnOutcome({ kind: "result", text: "Turn finished (success)" })).toBe(false);
    expect(turnOutcome({ kind: "error", text: "Turn finished (error_max_turns) · 3 turn(s)" })).toBe(true);
    expect(turnOutcome({ kind: "error", text: "✗ Bash\nexit 1" })).toBeNull();
  });
});

describe("fuzzy search", () => {
  it("scores substrings above subsequences and rejects non-matches", () => {
    expect(fuzzyScore("move", "Movement agent")).toBeGreaterThan(fuzzyScore("mvt", "Movement agent") ?? 0);
    expect(fuzzyScore("xyz", "Movement")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("filters and ranks", () => {
    const items = ["Stop all agents", "Go to Settings", "Movement — gameplay", "Reset workspace layout"];
    expect(fuzzyFilter(items, "set", (s) => s)[0]).toBe("Go to Settings");
    expect(fuzzyFilter(items, "rwl", (s) => s)).toEqual(["Reset workspace layout"]);
    expect(fuzzyFilter(items, "", (s) => s)).toEqual(items);
  });
});
