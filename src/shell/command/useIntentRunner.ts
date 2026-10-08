// Executes the actions offered for an interpreted command line (each one a real API call).

import { useState } from "react";
import { api } from "../../lib/api";
import { cloneFolderName, gitCloneLine, githubRepoFromUrl, joinPath, shellMissionPrompt, sshMissionPrompt, type IntentActionId } from "../../lib/intents";
import { attempt } from "../../lib/toast";
import type { AppliedCommand, CliRun, Connection, Interpretation } from "../../lib/types";
import { cloneGithubRepo, githubSignIn, missionForCentral, pickFolder } from "../../state/opsActions";
import { openClaudeInTerminal, runInPowerShell } from "../../terminal/openInTerminal";
import { useStore } from "../../store";
import { t } from "../../i18n";

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
    if (!probe) return { ok: false, text: t("msg.cmd.probeFailed") };
    const parts = [t("msg.cmd.tools", { count: probe.tools.length })];
    parts.push(probe.resources ? t("msg.cmd.resources", { count: probe.resources.length }) : t("msg.cmd.noResources"));
    parts.push(probe.prompts ? t("msg.cmd.prompts", { count: probe.prompts.length }) : t("msg.cmd.noPrompts"));
    return { ok: true, text: t("msg.cmd.answered", { name: probe.serverName ?? conn.name, ms: probe.latencyMs, parts: parts.join(" · ") }) };
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
        return (await missionForCentral(sshMissionPrompt(intent))) ? { type: "done", text: t("msg.cmd.centralMission") } : null;
      case "give_central":
        return (await missionForCentral(shellMissionPrompt(interp))) ? { type: "done", text: t("msg.cmd.centralCommand") } : null;
      case "run_terminal":
        return (await runInPowerShell(interp.raw)) ? { type: "done", text: t("msg.cmd.typed") } : null;
      case "clone": {
        if (intent.type !== "clone") return null;
        const repo = githubRepoFromUrl(intent.url);
        if (repo && !intent.directory) {
          const folder = await cloneGithubRepo(repo);
          return folder ? { type: "cloned", folder, viaTerminal: false } : null;
        }
        const parent = await pickFolder(t("msg.cmd.cloneInto"));
        if (!parent) return null;
        if (!(await runInPowerShell(gitCloneLine(intent.url, intent.directory, parent)))) return null;
        return { type: "cloned", folder: joinPath(parent, cloneFolderName(intent.url, intent.directory)), viaTerminal: true };
      }
      case "github_login":
        return (await githubSignIn()) ? { type: "done", text: t("msg.cmd.finishSignIn") } : null;
      case "claude_run": {
        if (intent.type !== "claude_cli") return null;
        const run = await attempt(() => api.runClaudeCli(intent.args));
        return run ? { type: "cli", run } : null;
      }
      case "claude_terminal":
        if (intent.type !== "claude_cli") return null;
        await openClaudeInTerminal(intent.args, null);
        return { type: "done", text: t("msg.cmd.openedTerminal") };
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
