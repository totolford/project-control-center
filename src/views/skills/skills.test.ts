import { describe, expect, it } from "vitest";
import type { Agent, Connection, Skill } from "../../lib/types";
import {
  EMPTY_SKILL,
  agentsWithSkills,
  diffLines,
  isDiscovered,
  matchesFilter,
  missingCount,
  requirements,
  sourceLabel,
  splitList,
  toggle,
  validateNewSkill,
  validateSkillName,
} from "./skillModel";

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: "s",
  name: "deploy",
  description: "Deploys",
  scope: "project",
  source: null,
  enabled: true,
  editable: true,
  dir: "C:/p/.claude/skills/deploy",
  frontmatter: {},
  allowedTools: [],
  files: ["SKILL.md"],
  problems: [],
  ...over,
});

const conn = (id: string, kind: Connection["kind"], name = id) => ({ id, name, kind }) as Connection;

describe("skills model", () => {
  it("filters by scope and state", () => {
    expect(matchesFilter(skill({ scope: "user" }), "global")).toBe(true);
    expect(matchesFilter(skill({ scope: "user" }), "project")).toBe(false);
    expect(matchesFilter(skill({ enabled: false }), "disabled")).toBe(true);
    expect(matchesFilter(skill({ scope: "plugin" }), "plugin")).toBe(true);
  });

  it("labels sources", () => {
    expect(sourceLabel(skill({ scope: "user", source: "synced" }))).toBe("Synced (claude.ai)");
    expect(sourceLabel(skill({ scope: "plugin", source: "tools@market" }))).toBe("Plugin tools@market");
    expect(sourceLabel(skill({ scope: "user" }))).toBe("Global");
  });

  it("detects discovery in Claude Code's command list", () => {
    expect(isDiscovered(skill(), null)).toBeNull();
    expect(isDiscovered(skill(), [{ name: "deploy" }])).toBe(true);
    expect(isDiscovered(skill(), [{ name: "plugin:deploy" }])).toBe(true);
    expect(isDiscovered(skill(), [{ name: "deployer" }])).toBe(false);
  });

  it("checks requirements against project connections", () => {
    const s = skill({
      frontmatter: {
        "metadata.requires-mcp": "roblox-studio, figma",
        "metadata.requires-connections": "github, prod",
        "metadata.requires-permissions": "network, sudo",
        "metadata.dependencies": "node",
      },
    });
    const r = requirements(s, [conn("roblox-studio", "roblox_studio"), conn("gh", "github"), conn("figma", "ssh")]);
    expect(r.mcp).toEqual([{ value: "roblox-studio", met: true }, { value: "figma", met: false }]);
    expect(r.connections).toEqual([{ value: "github", met: true }, { value: "prod", met: false }]);
    expect(r.permissions).toEqual([{ value: "network", met: true }, { value: "sudo", met: null }]);
    expect(r.dependencies).toEqual(["node"]);
    expect(missingCount(r)).toBe(2);
    expect(splitList(undefined)).toEqual([]);
  });

  it("lists agents loading skills", () => {
    const a = (id: string, skillsEnabled: boolean, status = "waiting") => ({ id, status, profile: { skillsEnabled } }) as Agent;
    expect(agentsWithSkills([a("x", true), a("y", false), a("z", true, "retired")]).map((x) => x.id)).toEqual(["x"]);
  });

  it("validates new skills", () => {
    expect(validateSkillName("my-skill")).toBeNull();
    expect(validateSkillName("My Skill")).not.toBeNull();
    expect(validateSkillName("-x")).not.toBeNull();
    expect(validateSkillName("a".repeat(65))).not.toBeNull();
    expect(validateNewSkill({ ...EMPTY_SKILL, name: "ok" })).toContain("description");
    expect(validateNewSkill({ ...EMPTY_SKILL, name: "ok", description: "d" })).toBeNull();
    expect(toggle(["a"], "a")).toEqual([]);
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
  });

  it("classifies diff lines", () => {
    const kinds = diffLines("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same\n").map((l) => l.kind);
    expect(kinds).toEqual(["meta", "meta", "hunk", "del", "add", "ctx"]);
  });
});
