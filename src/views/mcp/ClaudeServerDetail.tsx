import { useState } from "react";
import { ArrowRightLeft, Power, Trash2, Zap } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { attempt, run } from "../../lib/toast";
import type { CliRun } from "../../lib/types";
import { useStore } from "../../store";
import { JsonView, Section, Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { Modal } from "../../components/Modal";
import { claudeStatus, claudeTarget, isRemovableScope, mapNames, redactClaudeConfig, scopeLabel, MASK, type ClaudeServer } from "./mcpModel";
import { ProbeView, type ProbeRecord } from "./ProbeView";
import { CliRunOutput } from "./CliRunOutput";

interface Props {
  server: ClaudeServer;
  probe: ProbeRecord | null;
  onProbe: (r: ProbeRecord) => void;
  /** Re-reads Claude Code's environment after a change. */
  onChanged: () => void;
  onImported: (connectionId: string) => void;
}

const TESTABLE = ["stdio", "http", "sse"];

export function ClaudeServerDetail({ server, probe, onProbe, onChanged, onImported }: Props) {
  const [busy, setBusy] = useState<"test" | "toggle" | "import" | "remove" | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [cli, setCli] = useState<CliRun | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const st = claudeStatus(server.status);
  const { transport, target } = claudeTarget(server.config);
  const testable = TESTABLE.includes(transport);
  const disabled = server.status === "disabled";
  const secretNames = [...mapNames(server.config.env), ...mapNames(server.config.headers)];

  const test = async () => {
    setBusy("test");
    setTestError(null);
    try {
      onProbe({ probe: await api.testMcpConfig(server.config), at: new Date().toISOString() });
    } catch (e) {
      setTestError(errorMessage(e));
    }
    setBusy(null);
  };

  const toggle = async () => {
    setBusy("toggle");
    const ok = await run(() => api.claudeMcpSetEnabled(server.name, disabled), disabled ? "Enabled for this project" : "Disabled for this project");
    setBusy(null);
    if (ok) onChanged();
  };

  const useInNexus = async () => {
    setBusy("import");
    const conn = await attempt(() => api.importClaudeMcp(server.name, server.config), "Added to NEXUS connections");
    setBusy(null);
    if (conn) {
      useStore.getState().upsertConnection(conn);
      onImported(conn.id);
    }
  };

  const remove = async () => {
    if (!isRemovableScope(server.scope)) return;
    setBusy("remove");
    const result = await attempt(() => api.claudeMcpRemove(server.name, String(server.scope)));
    setBusy(null);
    setConfirmRemove(false);
    if (result) {
      setCli(result);
      onChanged();
    }
  };

  return (
    <div className="tools-detail">
      <div className="tools-detail-head">
        <div className="grow">
          <div className="row">
            <h2>{server.name}</h2>
            <Chip tone={st.tone}>{st.label}</Chip>
            <span className="muted small">Claude Code configuration · {scopeLabel(server.scope)}</span>
          </div>
          <div className="muted small">Used when you run claude yourself. NEXUS agents run with --strict-mcp-config and do not get it.</div>
        </div>
        <button className="btn" onClick={() => void test()} disabled={busy !== null || !testable} title={testable ? "Starts / contacts the server once from NEXUS" : `Transport ${transport} cannot be tested from NEXUS`}>
          {busy === "test" ? <Spinner size={12} /> : <Zap size={14} />} Test
        </button>
        <button className="btn" onClick={() => void toggle()} disabled={busy !== null}>
          {busy === "toggle" ? <Spinner size={12} /> : <Power size={14} />} {disabled ? "Enable" : "Disable"} for this project
        </button>
        <button className="btn primary" onClick={() => void useInNexus()} disabled={busy !== null || !testable} title={testable ? "Copy it into NEXUS so agents can be granted it" : `Transport ${transport} cannot be imported`}>
          {busy === "import" ? <Spinner size={12} /> : <ArrowRightLeft size={14} />} Use in NEXUS
        </button>
        {isRemovableScope(server.scope) && (
          <button className="btn danger-ghost" onClick={() => setConfirmRemove(true)} disabled={busy !== null} aria-label={`Remove ${server.name}`}>
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {testable && <div className="muted small">Test starts the server locally (stdio) or contacts its URL once, with the configuration Claude Code reports.</div>}
      {testError && <div className="notice notice-error">Test failed: {testError}</div>}
      {cli && <CliRunOutput run={cli} />}
      {server.error && <div className="notice notice-error">{server.error}</div>}

      <Section title="Overview">
        <dl className="kv">
          <dt>Transport</dt>
          <dd>{transport}</dd>
          <dt>Server</dt>
          <dd className="mono">{target}</dd>
          <dt>Scope</dt>
          <dd>{scopeLabel(server.scope)}</dd>
          <dt>Source</dt>
          <dd className="mono">{server.source == null ? "Not reported" : String(server.source)}</dd>
          <dt>Enabled</dt>
          <dd>{disabled ? "Disabled for this project (Claude Code remembers it per project)" : "Yes"}</dd>
          <dt>Last activity</dt>
          <dd className="muted">Not exposed by Claude Code</dd>
          <dt>Response time</dt>
          <dd>{probe ? `${probe.probe.latencyMs} ms (last test)` : "Not tested yet"}</dd>
          <dt>Secrets</dt>
          <dd>{secretNames.length ? secretNames.map((n) => <code key={n}>{`${n}=${MASK}`}</code>) : "none"}</dd>
        </dl>
        {!isRemovableScope(server.scope) && (
          <div className="muted small">
            {server.scope === "plugin"
              ? "Provided by a plugin: manage it with the plugin (Command Center: claude plugin …)."
              : server.scope === "claudeai"
                ? "A claude.ai connector: manage it in your claude.ai settings."
                : "This scope cannot be removed from NEXUS."}
          </div>
        )}
        <JsonView value={redactClaudeConfig(server.config)} collapsible label="Configuration (values hidden)" />
      </Section>

      <Section title="Agents">
        <div className="muted small">
          No NEXUS agent uses it. Click "Use in NEXUS" to copy it into a NEXUS connection (values move to Windows Credential Manager), then grant it
          per agent.
        </div>
      </Section>

      <Section title="Tools, resources, prompts">
        <ProbeView record={probe} />
      </Section>

      <Section title="Logs">
        <div className="muted small">Claude Code's own MCP logs are not exposed. The server output of the last test is shown above.</div>
      </Section>

      {confirmRemove && (
        <Modal
          title={`Remove ${server.name} from Claude Code?`}
          onClose={() => setConfirmRemove(false)}
          locked={busy === "remove"}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmRemove(false)} disabled={busy === "remove"}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void remove()} disabled={busy === "remove"}>
                {busy === "remove" && <Spinner size={12} />} Remove
              </button>
            </>
          }
        >
          <p>
            Runs <code>claude mcp remove {server.name} -s {String(server.scope)}</code>. NEXUS connections are not affected.
          </p>
        </Modal>
      )}
    </div>
  );
}
