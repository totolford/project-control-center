import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, FlaskConical } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { CliRun, Connection } from "../../lib/types";
import { useAgents, useStore } from "../../store";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Common";
import {
  EMPTY_DRAFT,
  STEP_LABELS,
  buildClaudeConfig,
  buildNexusInput,
  buildTestConfig,
  draftFromConnection,
  firstInvalidStep,
  stepsFor,
  validateStep,
  type McpDraft,
  type StepKey,
} from "./mcpDraft";
import { asMcpConfig } from "./mcpModel";
import { ProbeView, type ProbeRecord } from "./ProbeView";
import { CliRunOutput } from "./CliRunOutput";
import { AgentsStep, KindStep, NameStep, PermissionsStep, ServerStep, TargetStep, TransportStep, VarsStep, type StepProps } from "./WizardSteps";

const BODIES: Partial<Record<StepKey, (p: StepProps) => React.ReactNode>> = {
  name: NameStep,
  target: TargetStep,
  transport: TransportStep,
  server: ServerStep,
  vars: VarsStep,
  kind: KindStep,
  permissions: PermissionsStep,
  agents: AgentsStep,
};

interface Props {
  onClose: () => void;
  /** Connection to edit (NEXUS MCP / Roblox Studio). */
  editing?: Connection;
  initialKind?: "mcp" | "roblox_studio";
  /** Called after a NEXUS connection was saved, or a Claude Code server was added. */
  onSaved?: (result: { connectionId?: string; claudeName?: string }) => void;
}

export function McpWizard({ onClose, editing, initialKind = "mcp", onSaved }: Props) {
  const agents = useAgents();
  const [draft, setDraft] = useState<McpDraft>(() =>
    editing
      ? draftFromConnection(editing.name, editing.kind === "roblox_studio" ? "roblox_studio" : "mcp", asMcpConfig(editing.config), agents.filter((a) => a.connections.includes(editing.id)).map((a) => a.id))
      : { ...EMPTY_DRAFT, kind: initialKind },
  );
  const steps = stepsFor(draft, Boolean(editing));
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<ProbeRecord | { error: string } | null>(null);
  const [probeAfterSave, setProbeAfterSave] = useState(true);
  const [done, setDone] = useState<{ run?: CliRun; probe?: ProbeRecord | { error: string }; message: string } | null>(null);

  const update = (patch: Partial<McpDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTestResult(null);
  };
  const problem = validateStep(step, draft);
  const blocking = firstInvalidStep(draft, Boolean(editing));

  const runTest = async () => {
    const config = buildTestConfig(draft);
    if (!config) return;
    setBusy(true);
    try {
      setTestResult({ probe: await api.testMcpConfig(config), at: new Date().toISOString() });
    } catch (e) {
      setTestResult({ error: errorMessage(e) });
    }
    setBusy(false);
  };

  const syncGrants = async (connectionId: string) => {
    const { upsertAgent } = useStore.getState();
    for (const a of agents) {
      const has = a.connections.includes(connectionId);
      const want = draft.agentIds.includes(a.id);
      if (has === want) continue;
      const next = want ? [...a.connections, connectionId] : a.connections.filter((c) => c !== connectionId);
      const updated = await attempt(() => api.updateAgent(a.id, { connections: next }));
      if (updated) upsertAgent(updated);
    }
  };

  const save = async () => {
    setBusy(true);
    if (draft.target === "claude") {
      const run = await attempt(() => api.claudeMcpAdd(draft.name.trim(), buildClaudeConfig(draft), draft.claudeScope));
      setBusy(false);
      if (!run) return;
      setDone({ run, message: run.exitCode === 0 ? "Added to Claude Code's configuration." : "Claude Code reported an error." });
      if (run.exitCode === 0) onSaved?.({ claudeName: draft.name.trim() });
      return;
    }
    const input = buildNexusInput(draft);
    const saved = await attempt(() => (editing ? api.updateConnection(editing.id, input) : api.addConnection(input)), editing ? "Connection updated" : "Connection added");
    if (!saved) {
      setBusy(false);
      return;
    }
    useStore.getState().upsertConnection(saved);
    await syncGrants(saved.id);
    let probe: ProbeRecord | { error: string } | undefined;
    if (probeAfterSave) {
      try {
        probe = { probe: await api.probeConnection(saved.id), at: new Date().toISOString() };
      } catch (e) {
        probe = { error: errorMessage(e) };
      }
      const checked = await attempt(() => api.checkConnection(saved.id));
      if (checked) useStore.getState().upsertConnection(checked);
    }
    setBusy(false);
    setDone({ probe, message: `${saved.name} saved as NEXUS connection \`${saved.id}\` (agents see mcp__${saved.id}__*).` });
    onSaved?.({ connectionId: saved.id });
  };

  const footer = done ? (
    <button className="btn primary" onClick={onClose}>
      Close
    </button>
  ) : (
    <>
      <button className="btn" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <span className="spacer" />
      <button className="btn" onClick={() => setStepIndex((i) => i - 1)} disabled={busy || stepIndex === 0}>
        <ChevronLeft size={14} /> Back
      </button>
      {step === "save" ? (
        <button className="btn primary" onClick={() => void save()} disabled={busy || blocking !== null}>
          {busy ? <Spinner size={12} /> : <Check size={14} />} {editing ? "Save changes" : draft.target === "claude" ? "Add to Claude Code" : "Create connection"}
        </button>
      ) : (
        <button className="btn primary" onClick={() => setStepIndex((i) => i + 1)} disabled={busy || problem !== null}>
          Next <ChevronRight size={14} />
        </button>
      )}
    </>
  );

  const Body = BODIES[step];
  return (
    <Modal title={editing ? `Edit ${editing.name}` : "Add MCP server"} onClose={onClose} locked={busy} width={720} footer={footer}>
      <ol className="tools-stepper">
        {steps.map((s, i) => (
          <li key={s} className={i === stepIndex ? "active" : i < stepIndex ? "done" : ""}>
            <button className="link-btn" disabled={busy || done !== null || steps.slice(0, i).some((s) => validateStep(s, draft) !== null)} onClick={() => setStepIndex(i)}>
              {i + 1}. {STEP_LABELS[s]}
            </button>
          </li>
        ))}
      </ol>
      {done ? (
        <div>
          <div className="notice">{done.message}</div>
          {done.run && <CliRunOutput run={done.run} />}
          {done.probe && ("error" in done.probe ? <div className="notice notice-error">Test failed: {done.probe.error}</div> : <ProbeView record={done.probe} />)}
        </div>
      ) : (
        <>
          {Body && <Body draft={draft} update={update} editing={Boolean(editing)} />}
          {step === "test" && <TestStep draft={draft} busy={busy} result={testResult} onTest={() => void runTest()} />}
          {step === "save" && <SaveSummary draft={draft} blocking={blocking} probeAfterSave={probeAfterSave} setProbeAfterSave={setProbeAfterSave} />}
          {problem && step !== "save" && <div className="small tone-amber-fg">{problem}</div>}
        </>
      )}
    </Modal>
  );
}

function TestStep({ draft, busy, result, onTest }: { draft: McpDraft; busy: boolean; result: ProbeRecord | { error: string } | null; onTest: () => void }) {
  const config = buildTestConfig(draft);
  return (
    <>
      <div className="notice notice-warn">
        <FlaskConical size={14} /> Testing performs a real MCP handshake: {draft.transport === "stdio" ? "it starts the server once on this machine" : "it connects to the URL"}, lists its
        tools, then stops.
        {draft.target === "claude" && " ${VAR} references are sent literally (NEXUS does not expand them), so servers needing those values may fail here."}
      </div>
      {config ? (
        <button className="btn" onClick={onTest} disabled={busy}>
          {busy ? <Spinner size={12} /> : <FlaskConical size={14} />} Test now
        </button>
      ) : (
        <p className="muted">Stored secret values cannot be read back by the UI. Save, and the saved connection will be tested with them.</p>
      )}
      {result && ("error" in result ? <div className="notice notice-error">Test failed: {result.error}</div> : <ProbeView record={result} />)}
    </>
  );
}

function SaveSummary({ draft, blocking, probeAfterSave, setProbeAfterSave }: { draft: McpDraft; blocking: StepKey | null; probeAfterSave: boolean; setProbeAfterSave: (v: boolean) => void }) {
  return (
    <>
      <dl className="kv">
        <dt>Name</dt>
        <dd>{draft.name || "—"}</dd>
        <dt>Destination</dt>
        <dd>{draft.target === "nexus" ? `NEXUS connection (${draft.kind === "roblox_studio" ? "Roblox Studio" : "MCP"})` : `Claude Code config, ${draft.claudeScope} scope`}</dd>
        <dt>Server</dt>
        <dd className="mono">{draft.transport === "stdio" ? [draft.command, ...draft.args.split(/\r?\n/).filter(Boolean)].join(" ") : `${draft.transport} ${draft.url}`}</dd>
        <dt>{draft.transport === "stdio" ? "Environment" : "Headers"}</dt>
        <dd>{draft.vars.length ? draft.vars.map((v) => `${v.key}${v.secret ? " (secret)" : ""}`).join(", ") : "none"}</dd>
        {draft.target === "nexus" && (
          <>
            <dt>Agents</dt>
            <dd>{draft.agentIds.length} granted</dd>
          </>
        )}
      </dl>
      {draft.target === "nexus" && (
        <label className="checkbox">
          <input type="checkbox" checked={probeAfterSave} onChange={(e) => setProbeAfterSave(e.target.checked)} /> Test the connection after saving
        </label>
      )}
      {blocking && <div className="small tone-amber-fg">Complete the "{STEP_LABELS[blocking]}" step first.</div>}
    </>
  );
}
