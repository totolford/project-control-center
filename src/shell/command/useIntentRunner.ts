// Executes the actions offered for an interpreted command line (each one a real API call).

import { useState } from "react";
import { api } from "../../lib/api";
import { cloneFolderName, gitCloneLine, githubRepoFromUrl, joinPath, shellMissionPrompt, sshMissionPrompt, type IntentActionId } from "../../lib/intents";
import { attempt } from "../../lib/toast";
import type { AppliedCommand, CliRun, Connection, Interpretation } from "../../lib/types";
import { cloneGithubRepo, githubSignIn, missionForCentral, pickFolder } from "../../state/opsActions";
import { openClaudeInTerminal, runInPowerShell } from "../../terminal/openInTerminal";
import { useStore } from "../../store";

export type RunnerResult =
  | { type: "applied"; applied: AppliedCommand }
  | { type: "cloned"; folder: string; viaTerminal: boolean }
  | { type: "cli"; run: CliRun }
  | { type: "done"; text: string };

export type TestResult = { ok: boolean; text: string };

/** Tests a connection created from a command: MCP servers are probed, others checked. */
async function testConnection(conn: Connection): Promise<TestResult | undefined> {
  if (conn.kind === "mcp" || conn.kind === "roblox_studio") {
    const probe = await attempt(() => api.probeConnection(conn.id));
    if (!probe) return { ok: false, text: "Probe failed (see the error message)." };
    const parts = [`${probe.tools.length} tools`];
    parts.push(probe.resources ? `${probe.resources.length} resources` : "resources not supported");
    parts.push(probe.prompts ? `${probe.prompts.length} prompts` : "prompts not supported");
    return { ok: true, text: `${probe.serverName ?? conn.name} answered in ${probe.latencyMs} ms · ${parts.join(" · ")}` };
  }
  const checked = await attempt(() => api.checkConnection(conn.id));
  if (!checked) return undefined;
  useStore.getState().upsertConnection(checked);
  return { ok: checked.status === "connected", text: `${checked.status}${checked.statusDetail ? ` · ${checked.statusDetail}` : ""}` };
}

export function useIntentRunner(interp: Interpretation) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RunnerResult | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  const perform = async (id: IntentActionId): Promise<RunnerResult | null> => {
    const intent = interp.intent;
    switch (id) {
      case "create_connection": {
        const applied = await attempt(() => api.applyCommand(interp.raw));
        if (!applied) return null;
        if (applied.connection) useStore.getState().upsertConnection(applied.connection);
        return { type: "applied", applied };
      }
      case "ask_central_ssh":
        if (intent.type !== "ssh") return null;
        return (await missionForCentral(sshMissionPrompt(intent))) ? { type: "done", text: "Central received the mission." } : null;
      case "give_central":
        return (await missionForCentral(shellMissionPrompt(interp))) ? { type: "done", text: "Central received the command as a mission." } : null;
      case "run_terminal":
        return (await runInPowerShell(interp.raw)) ? { type: "done", text: "Typed into a new PowerShell in the Terminal view." } : null;
      case "clone": {
        if (intent.type !== "clone") return null;
        const repo = githubRepoFromUrl(intent.url);
        if (repo && !intent.directory) {
          const folder = await cloneGithubRepo(repo);
          return folder ? { type: "cloned", folder, viaTerminal: false } : null;
        }
        const parent = await pickFolder("Clone into…");
        if (!parent) return null;
        if (!(await runInPowerShell(gitCloneLine(intent.url, intent.directory, parent)))) return null;
        return { type: "cloned", folder: joinPath(parent, cloneFolderName(intent.url, intent.directory)), viaTerminal: true };
      }
      case "github_login":
        return (await githubSignIn()) ? { type: "done", text: "Finish the sign-in in the Terminal view (gh auth login)." } : null;
      case "claude_run": {
        if (intent.type !== "claude_cli") return null;
        const run = await attempt(() => api.runClaudeCli(intent.args));
        return run ? { type: "cli", run } : null;
      }
      case "claude_terminal":
        if (intent.type !== "claude_cli") return null;
        await openClaudeInTerminal(intent.args, null);
        return { type: "done", text: "Opened in the Terminal view." };
    }
  };

  const act = async (id: IntentActionId) => {
    setBusy(id);
    setTest(null);
    const r = await perform(id);
    setBusy(null);
    if (r) setResult(r);
    // A new MCP connection is tested at once: start it, discover tools, resources and prompts.
    if (r?.type === "applied" && r.applied.created && r.applied.connection && (r.applied.connection.kind === "mcp" || r.applied.connection.kind === "roblox_studio")) {
      await runTest(r.applied.connection);
    }
  };

  const runTest = async (conn: Connection) => {
    setBusy("test");
    setTest((await testConnection(conn)) ?? null);
    setBusy(null);
  };

  return { busy, result, test, act, runTest };
}
