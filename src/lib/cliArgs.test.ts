import { describe, expect, it } from "vitest";
import {
  buildArgs,
  categories,
  claudeShellLine,
  commandLabel,
  filterCommands,
  flattenCommands,
  isInteractive,
  isMutating,
  missingArgs,
  parseArgName,
  powershellLine,
  splitArgs,
} from "./cliArgs";
import type { CliCommand, CliOption } from "./types";

const opt = (flags: string, long: string | null, value: string | null, short: string | null = null): CliOption => ({
  flags,
  long,
  short,
  value,
  description: "",
  choices: [],
  default: null,
  category: "",
});

const cmd = (path: string[], patch: Partial<CliCommand> = {}): CliCommand => ({
  path,
  aliases: [],
  usage: "",
  signature: "",
  description: "",
  arguments: [],
  options: [],
  subcommands: [],
  category: "",
  ...patch,
});

const mcpAdd = cmd(["mcp", "add"], {
  arguments: [
    { name: "<name>", description: "" },
    { name: "<commandOrUrl>", description: "" },
    { name: "[args...]", description: "" },
  ],
  options: [opt("-s, --scope <scope>", "--scope", "<scope>", "-s"), opt("-e, --env <env...>", "--env", "<env...>", "-e"), opt("--debug", "--debug", null)],
  category: "mcp",
});
const root = cmd([], { subcommands: [cmd(["mcp"], { subcommands: [mcpAdd], category: "mcp" }), cmd(["doctor"], { description: "Check health", category: "general" })] });

describe("command tree", () => {
  it("flattens depth-first with the root first", () => {
    expect(flattenCommands(root).map(commandLabel)).toEqual(["claude", "claude mcp", "claude mcp add", "claude doctor"]);
    expect(categories(flattenCommands(root))).toEqual(["general", "mcp"]);
  });

  it("filters by text (label, description, flags) and category", () => {
    const all = flattenCommands(root);
    expect(filterCommands(all, "health", "").map(commandLabel)).toEqual(["claude doctor"]);
    expect(filterCommands(all, "--scope", "").map(commandLabel)).toEqual(["claude mcp add"]);
    expect(filterCommands(all, "", "mcp")).toHaveLength(2);
  });

  it("classifies mutating and interactive commands", () => {
    expect(isMutating(mcpAdd)).toBe(true);
    expect(isMutating(cmd(["mcp", "list"]))).toBe(false);
    expect(isInteractive(root)).toBe(true);
    expect(isInteractive(cmd(["auth", "login"]))).toBe(true);
    expect(isInteractive(cmd(["mcp", "list"]))).toBe(false);
  });
});

describe("argument building", () => {
  it("parses argument names", () => {
    expect(parseArgName("<name>")).toEqual({ name: "name", required: true, variadic: false });
    expect(parseArgName("[args...]")).toEqual({ name: "args", required: false, variadic: true });
  });

  it("splits on whitespace honouring quotes", () => {
    expect(splitArgs(`a "b c"  d`)).toEqual(["a", "b c", "d"]);
  });

  it("builds positional args, valued options and flags", () => {
    const args = buildArgs(
      mcpAdd,
      { "<name>": "fs", "<commandOrUrl>": "npx", "[args...]": `-y "@scope/server x"` },
      { "--scope": "user", "--env": "A=1 B=2", "--debug": true },
    );
    expect(args).toEqual(["mcp", "add", "fs", "npx", "-y", "@scope/server x", "--scope", "user", "--env", "A=1", "B=2", "--debug"]);
  });

  it("omits empty values and unchecked flags", () => {
    expect(buildArgs(mcpAdd, { "<name>": "fs" }, { "--scope": " ", "--debug": false })).toEqual(["mcp", "add", "fs"]);
  });

  it("reports missing required arguments", () => {
    expect(missingArgs(mcpAdd, { "<name>": "fs" })).toEqual(["commandOrUrl"]);
  });

  it("builds a PowerShell line, quoting what needs it", () => {
    expect(powershellLine("C:\\Program Files\\claude.exe", ["auth", "login"])).toBe("& 'C:\\Program Files\\claude.exe' auth login");
    expect(powershellLine(null, ["mcp", "add", "it's"])).toBe("claude mcp add 'it''s'");
  });

  it("builds a POSIX shell line on Linux", () => {
    expect(claudeShellLine("/home/ada/.local/bin/claude", ["auth", "login"], false)).toBe("/home/ada/.local/bin/claude auth login");
    expect(claudeShellLine(null, ["mcp", "add", "it's", "a b"], false)).toBe("claude mcp add 'it'\\''s' 'a b'");
    expect(claudeShellLine(null, ["doctor"], true)).toBe("claude doctor");
  });
});
