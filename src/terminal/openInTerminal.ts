// Opens interactive Claude Code commands, command lines and backend-spawned sessions in the Raw Terminal.

import { api } from "../lib/api";
import { powershellLine } from "../lib/cliArgs";
import { run } from "../lib/toast";
import type { PtyInfo } from "../lib/types";
import { useStore } from "../store";
import { usePty } from "./ptyStore";

/**
 * `claude` alone opens an interactive Claude Code session; any other command is typed into a new
 * PowerShell so its output and prompts stay visible after it ends.
 */
export async function openClaudeInTerminal(args: string[], exe: string | null): Promise<void> {
  const { spawn } = usePty.getState();
  const info = args.length === 0 ? await spawn("claude") : await spawn("powershell");
  if (!info) return;
  if (args.length > 0) await run(() => api.ptyWrite(info.id, `${powershellLine(exe, args)}\r`));
  useStore.getState().navigate({ name: "terminal" });
}

/** Types `line` into a new PowerShell session and switches to the Terminal view. */
export async function runInPowerShell(line: string): Promise<boolean> {
  const info = await usePty.getState().spawn("powershell");
  if (!info) return false;
  const ok = await run(() => api.ptyWrite(info.id, `${line}`));
  useStore.getState().navigate({ name: "terminal" });
  return ok;
}

/** Selects a session the backend opened (e.g. `gh auth login`) and switches to the Terminal view. */
export function showTerminal(info: PtyInfo): void {
  usePty.getState().adopt(info);
  useStore.getState().navigate({ name: "terminal" });
}
