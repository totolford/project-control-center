import { describe, expect, it } from "vitest";
import type { Intent, Interpretation } from "./types";
import {
  MASK,
  cloneFolderName,
  gitCloneLine,
  githubRepoFromUrl,
  intentActions,
  intentFields,
  joinPath,
  rawIsDisplayable,
  shellMissionPrompt,
  sshMissionPrompt,
} from "./intents";

const mcp: Intent = {
  type: "add_mcp",
  name: "github",
  transport: "stdio",
  scope: "project",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  url: null,
  env: [["GITHUB_TOKEN", "ghp_supersecret"]],
  headers: [["Authorization", "Bearer abc123"]],
};
const ssh: Intent = { type: "ssh", user: "pi", host: "raspberrypi.local", port: null, keyPath: null, remoteCommand: "sudo apt update" };

function interp(intent: Intent, patch: Partial<Interpretation> = {}): Interpretation {
  return { raw: "x", program: "x", tokens: [], intent, summary: "s", capability: "fs_execute", destructive: false, ...patch };
}

describe("intentFields", () => {
  it("shows env and header names but never their values", () => {
    const fields = intentFields(mcp);
    const text = JSON.stringify(fields);
    expect(text).not.toContain("ghp_supersecret");
    expect(text).not.toContain("abc123");
    expect(fields).toContainEqual({ label: "Env", value: `GITHUB_TOKEN=${MASK}`, mono: true });
    expect(fields).toContainEqual({ label: "Header", value: `Authorization: ${MASK}`, mono: true });
    expect(fields.find((f) => f.label === "Arguments")?.value).toBe("-y @modelcontextprotocol/server-github");
  });

  it("describes ssh with defaults and the remote command", () => {
    const fields = intentFields(ssh);
    expect(fields.map((f) => [f.label, f.value])).toEqual([
      ["User", "pi"],
      ["Host", "raspberrypi.local"],
      ["Port", "22 (default)"],
      ["Key", "(none given)"],
      ["Remote command", "sudo apt update"],
    ]);
  });

  it("hides the raw line only when it carries secret values", () => {
    expect(rawIsDisplayable(mcp)).toBe(false);
    expect(rawIsDisplayable({ ...mcp, env: [], headers: [] })).toBe(true);
    expect(rawIsDisplayable(ssh)).toBe(true);
  });
});

describe("intentActions", () => {
  it("maps each intent to its actions, primary first", () => {
    expect(intentActions(interp(mcp)).map((a) => a.id)).toEqual(["create_connection"]);
    expect(intentActions(interp(ssh)).map((a) => a.id)).toEqual(["create_connection", "ask_central_ssh"]);
    expect(intentActions(interp({ ...ssh, remoteCommand: null })).map((a) => a.id)).toEqual(["create_connection"]);
    expect(intentActions(interp({ type: "clone", url: "u", directory: null })).map((a) => a.id)).toEqual(["clone"]);
    expect(intentActions(interp({ type: "github_login" })).map((a) => a.id)).toEqual(["github_login"]);
    expect(intentActions(interp({ type: "claude_cli", args: ["mcp", "list"] })).map((a) => a.id)).toEqual(["claude_run", "claude_terminal"]);
    expect(intentActions(interp({ type: "shell" })).map((a) => a.id)).toEqual(["give_central", "run_terminal"]);
  });

  it("flags project-changing actions (blocked in read-only mode)", () => {
    const shell = intentActions(interp({ type: "shell" }));
    expect(shell.find((a) => a.id === "give_central")?.mutates).toBe(true);
    expect(shell.find((a) => a.id === "run_terminal")?.mutates).toBe(false);
  });
});

describe("mission prompts", () => {
  it("builds the SSH prompt", () => {
    expect(sshMissionPrompt(ssh as Extract<Intent, { type: "ssh" }>)).toBe("Use the SSH connection to pi@raspberrypi.local and run: sudo apt update. Report the output.");
  });
  it("hands a shell line to Central with its interpretation", () => {
    const p = shellMissionPrompt({ raw: "rm -rf build", summary: "Delete build", program: "rm", capability: "fs_write", destructive: true });
    expect(p).toContain("rm -rf build");
    expect(p).toContain("program `rm`, capability fs_write");
    expect(p).toContain("destructive");
  });
});

describe("clone helpers", () => {
  it("recognises github.com URLs", () => {
    expect(githubRepoFromUrl("https://github.com/acme/rocket.git")).toBe("acme/rocket");
    expect(githubRepoFromUrl("git@github.com:acme/rocket.git")).toBe("acme/rocket");
    expect(githubRepoFromUrl("github.com/acme/rocket")).toBe("acme/rocket");
    expect(githubRepoFromUrl("https://gitlab.com/acme/rocket.git")).toBeNull();
  });
  it("derives the clone folder and the PowerShell line", () => {
    expect(cloneFolderName("https://gitlab.com/acme/rocket.git", null)).toBe("rocket");
    expect(cloneFolderName("https://x/y.git", "custom")).toBe("custom");
    expect(joinPath("C:\\code\\", "rocket")).toBe("C:\\code\\rocket");
    expect(joinPath("C:\\code", "D:\\other")).toBe("D:\\other");
    expect(gitCloneLine("https://gitlab.com/a/b.git", null, "C:\\My Code")).toBe("Set-Location -LiteralPath 'C:\\My Code'; git clone https://gitlab.com/a/b.git");
  });
});
