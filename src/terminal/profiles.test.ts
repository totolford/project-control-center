import { describe, expect, it } from "vitest";
import { isLive } from "../lib/labels";
import { makeAgent } from "../test/fixtures";
import { respawnRequest, resumableAgents } from "./profiles";

describe("terminal profiles", () => {
  const agents = [
    makeAgent("a", { name: "Movement", claudeSessionId: "s1", status: "stopped" }),
    makeAgent("b", { name: "Combat", claudeSessionId: "s2", status: "working" }),
    makeAgent("c", { name: "Fresh", claudeSessionId: null, status: "offline" }),
    makeAgent("d", { name: "Old", claudeSessionId: "s3", status: "retired" }),
  ];

  it("restarts a session with the profile matching its title", () => {
    expect(respawnRequest({ title: "PowerShell 7" }, agents)).toEqual({ profile: "pwsh", agentId: null });
    expect(respawnRequest({ title: "Claude Code" }, agents)).toEqual({ profile: "claude", agentId: null });
    expect(respawnRequest({ title: "Claude Code · Movement" }, agents)).toEqual({ profile: "claude-resume", agentId: "a" });
    expect(respawnRequest({ title: "Claude Code · Gone" }, agents)).toBeNull();
    expect(respawnRequest({ title: "Something else" }, agents)).toBeNull();
  });

  it("offers only stopped agents that have a Claude session", () => {
    expect(resumableAgents(agents, isLive).map((a) => a.id)).toEqual(["a"]);
  });
});
