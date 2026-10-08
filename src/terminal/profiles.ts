// Raw Terminal profiles (pure, tested). Titles mirror the shell names of
// crates/pcc-platform/src/shells.rs used by pty_spawn; the list of shells on this
// machine comes from `terminalProfiles` in src/lib/platform.ts.

import type { Agent, PtyInfo, TerminalProfile } from "../lib/types";

const BY_TITLE: Record<string, TerminalProfile> = {
  "Claude Code": "claude",
  PowerShell: "powershell",
  "PowerShell 7": "pwsh",
  "Command Prompt": "cmd",
  WSL: "wsl",
  Bash: "bash",
  Zsh: "zsh",
  Fish: "fish",
  "POSIX sh": "sh",
};

export interface SpawnRequest {
  profile: TerminalProfile;
  agentId: string | null;
}

/** How to start the same kind of session again (Restart), or null when it cannot be told. */
export function respawnRequest(info: Pick<PtyInfo, "title">, agents: Pick<Agent, "id" | "name">[]): SpawnRequest | null {
  const direct = BY_TITLE[info.title];
  if (direct) return { profile: direct, agentId: null };
  const prefix = "Claude Code · ";
  if (info.title.startsWith(prefix)) {
    const agent = agents.find((a) => a.name === info.title.slice(prefix.length));
    return agent ? { profile: "claude-resume", agentId: agent.id } : null;
  }
  return null;
}

/** Agents whose Claude session can be opened in a terminal: not running in NEXUS and with a session id. */
export function resumableAgents<A extends Pick<Agent, "status" | "claudeSessionId">>(agents: A[], isLive: (s: A["status"]) => boolean): A[] {
  return agents.filter((a) => a.claudeSessionId && !isLive(a.status) && a.status !== "retired");
}
