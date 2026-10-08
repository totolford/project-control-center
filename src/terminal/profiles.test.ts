import { describe, expect, it } from "vitest";
import { isLive } from "../lib/labels";
import { makeAgent } from "../test/fixtures";
import { terminalProfiles } from "../lib/platform";
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

  it("restarts Linux shells too", () => {
    expect(respawnRequest({ title: "Bash" }, agents)).toEqual({ profile: "bash", agentId: null });
    expect(respawnRequest({ title: "Zsh" }, agents)).toEqual({ profile: "zsh", agentId: null });
  });

  it("lists the installed shells of this machine, default first", () => {
    const shell = (id: string, name: string, available: boolean, isDefault = false) => ({ id, name, program: available ? `/usr/bin/${id}` : null, args: [], available, default: isDefault });
    const linux = terminalProfiles({ shells: [shell("bash", "Bash", true), shell("zsh", "Zsh", true, true), shell("fish", "Fish", false)] }, false);
    expect(linux.map((p) => p.profile)).toEqual(["claude", "zsh", "bash"]);
    expect(linux[1].label).toBe("Zsh (default)");
    expect(terminalProfiles(null, true).map((p) => p.label)).toEqual(["Claude Code (interactive)", "PowerShell"]);
    expect(terminalProfiles(null, false)[1]).toEqual({ profile: "shell", label: "Default shell" });
  });

  it("offers only stopped agents that have a Claude session", () => {
    expect(resumableAgents(agents, isLive).map((a) => a.id)).toEqual(["a"]);
  });
});
