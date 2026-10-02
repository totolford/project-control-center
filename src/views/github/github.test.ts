import { describe, expect, it } from "vitest";
import { powerPreset } from "../../lib/power";
import { makeAgent } from "../../test/fixtures";
import { accountState, agentGithubAccess, field, firstField, ownerOptions, repoRow, runTone } from "./githubModel";

describe("githubModel", () => {
  it("tells the account state from gh status", () => {
    expect(accountState({ cliInstalled: false, authenticated: false })).toBe("not_installed");
    expect(accountState({ cliInstalled: true, authenticated: false })).toBe("not_signed_in");
    expect(accountState({ cliInstalled: true, authenticated: true })).toBe("signed_in");
  });

  it("reads gh and REST fields defensively", () => {
    const it_ = { number: 4, author: { login: "ann" }, nested: { obj: {} } };
    expect(field(it_, "number")).toBe("4");
    expect(field(it_, "author.login")).toBe("ann");
    expect(field(it_, "nested.obj")).toBeNull();
    expect(field(null, "x")).toBeNull();
    expect(firstField({ html_url: "u" }, "url", "html_url")).toBe("u");
  });

  it("builds repository rows from gh JSON", () => {
    expect(
      repoRow({ name: "rocket", nameWithOwner: "acme/rocket", isPrivate: true, primaryLanguage: { name: "Rust" }, updatedAt: "2026-01-01T00:00:00Z", description: null, isFork: false, url: "https://github.com/acme/rocket" }),
    ).toEqual({ fullName: "acme/rocket", name: "rocket", visibility: "private", language: "Rust", updatedAt: "2026-01-01T00:00:00Z", description: null, fork: false, url: "https://github.com/acme/rocket" });
    expect(repoRow({ name: "nameless" })).toBeNull();
    expect(repoRow({ nameWithOwner: "a/b", visibility: "INTERNAL" })?.visibility).toBe("internal");
  });

  it("lists owners and run tones", () => {
    expect(ownerOptions({ login: "ann", organizations: ["acme", "ann"] })).toEqual(["ann", "acme"]);
    expect(ownerOptions(null)).toEqual([]);
    expect(runTone("in_progress", null)).toBe("blue");
    expect(runTone("completed", "success")).toBe("green");
    expect(runTone("completed", "failure")).toBe("red");
    expect(runTone("completed", "cancelled")).toBe("grey");
  });

  it("gives each agent its effective GitHub access (UNLOCKED overrides)", () => {
    const agents = [makeAgent("central", { name: "Central", permissions: powerPreset("low") }), makeAgent("old", { status: "retired" })];
    const own = agentGithubAccess(agents, null);
    expect(own).toHaveLength(1);
    expect(own[0].access).toEqual([powerPreset("low").github_read, powerPreset("low").github_write, powerPreset("low").github_admin]);
    expect(agentGithubAccess(agents, { github_read: "allow", github_write: "ask", github_admin: "deny" })[0].access).toEqual(["allow", "ask", "deny"]);
  });
});
