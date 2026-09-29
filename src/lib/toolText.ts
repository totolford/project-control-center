// Readable descriptions of the transcript lines the backend writes:
//   tool_use:    "[↳ ]<ToolName> <compact json input>"
//   tool_result: "[↳ ]✓|✗ <ToolName>\n<output>"
// Mirrors describe_tool_use in crates/pcc-claude/src/session.rs.

export interface ToolCall {
  nested: boolean;
  name: string;
  input: Record<string, unknown> | null;
  action: string;
}

const NESTED = "↳ ";

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/** Reads a string field from parsed JSON, or from truncated JSON text as a fallback. */
function field(input: Record<string, unknown> | null, raw: string, key: string): string {
  const v = input?.[key];
  if (typeof v === "string") return v;
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  return m ? m[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"') : "";
}

export function describeTool(name: string, input: Record<string, unknown> | null, raw = ""): string {
  const f = (k: string) => field(input, raw, k);
  switch (name) {
    case "Read":
      return `Reading ${basename(f("file_path"))}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${basename(f("file_path"))}`;
    case "Write":
      return `Writing ${basename(f("file_path"))}`;
    case "Glob":
      return `Finding files ${f("pattern")}`;
    case "Grep":
      return `Searching for ${f("pattern")}`;
    case "Bash":
    case "PowerShell":
      return `Running ${(f("description") || f("command")).slice(0, 80)}`;
    case "WebFetch":
      return `Fetching ${f("url")}`;
    case "WebSearch":
      return `Searching web: ${f("query")}`;
    case "TodoWrite":
      return "Updating plan";
    default:
      if (name.startsWith("mcp__pcc__")) return `Coordinating: ${name.slice(10)}`;
      if (name.startsWith("mcp__")) return `Using ${name.slice(5).replaceAll("__", " → ")}`;
      return `Using ${name}`;
  }
}

export function parseToolUse(text: string): ToolCall {
  const nested = text.startsWith(NESTED);
  const body = nested ? text.slice(NESTED.length) : text;
  const space = body.indexOf(" ");
  const name = space === -1 ? body.trim() : body.slice(0, space);
  const raw = space === -1 ? "" : body.slice(space + 1);
  let input: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    input = null;
  }
  return { nested, name, input, action: describeTool(name, input, raw) };
}

/** Server id of an MCP tool (`mcp__<server>__<tool>`), or null. */
export function mcpServerOf(toolName: string): string | null {
  const m = toolName.match(/^mcp__(.+?)__/);
  return m ? m[1] : null;
}

/** First lines of a tool result, and how many lines were left out. */
export function previewResult(text: string, lines = 2): { head: string; hidden: number } {
  const all = text.split("\n");
  return { head: all.slice(0, lines).join("\n"), hidden: Math.max(0, all.length - lines) };
}
