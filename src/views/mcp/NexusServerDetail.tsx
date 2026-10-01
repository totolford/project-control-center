import { useState } from "react";
import { Pencil, RefreshCw, Trash2, Zap } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { attempt, run } from "../../lib/toast";
import { formatDateTime, formatRelative } from "../../lib/format";
import type { Connection } from "../../lib/types";
import { useAgents, useStore } from "../../store";
import { JsonView, Section, Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { Modal } from "../../components/Modal";
import { agentsUsing, asMcpConfig, nexusStatus, nexusTarget, redactNexusConfig, toolPrefix } from "./mcpModel";
import { ProbeView, type ProbeRecord } from "./ProbeView";
import { AgentGrants } from "./AgentGrants";
import { ToolActivity } from "./ToolActivity";
import { McpWizard } from "./McpWizard";
import { EnableToggle } from "./EnableToggle";

interface Props {
  conn: Connection;
  probe: ProbeRecord | null;
  onProbe: (r: ProbeRecord) => void;
}

export function NexusServerDetail({ conn, probe, onProbe }: Props) {
  const agents = useAgents();
  const upsertConnection = useStore((s) => s.upsertConnection);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [reached, setReached] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const cfg = asMcpConfig(conn.config);
  const st = nexusStatus(conn);
  const using = agentsUsing(conn, agents);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      onProbe({ probe: await api.probeConnection(conn.id), at: new Date().toISOString() });
    } catch (e) {
      setTestError(errorMessage(e));
    }
    const checked = await attempt(() => api.checkConnection(conn.id));
    if (checked) upsertConnection(checked);
    setTesting(false);
  };

  const restart = async () => {
    setBusy(true);
    const ids = await attempt(() => api.reconnectMcp(conn.id));
    setBusy(false);
    if (ids) setReached(ids);
  };

  const remove = async () => {
    setBusy(true);
    const ok = await run(() => api.deleteConnection(conn.id), "Connection deleted");
    setBusy(false);
    setDeleting(false);
    if (ok) useStore.getState().removeConnection(conn.id);
  };

  return (
    <div className="tools-detail">
      <div className="tools-detail-head">
        <div className="grow">
          <div className="row">
            <h2>{conn.name}</h2>
            <Chip tone={st.tone}>{st.label}</Chip>
            <span className="muted small">NEXUS connection · {conn.kind === "roblox_studio" ? "Roblox Studio" : "MCP"}</span>
          </div>
          <div className="muted small">
            Agents call its tools as <code>{toolPrefix(conn.id)}&lt;tool&gt;</code>
          </div>
        </div>
        <button className="btn" onClick={() => void test()} disabled={testing}>
          {testing ? <Spinner size={12} /> : <Zap size={14} />} Test
        </button>
        <EnableToggle conn={conn} />
        <button className="btn" onClick={() => void restart()} disabled={busy} title="Ask every running agent session to reconnect this server">
          <RefreshCw size={14} /> Restart
        </button>
        <button className="btn" onClick={() => setEditing(true)}>
          <Pencil size={14} /> Edit
        </button>
        <button className="btn danger-ghost" onClick={() => setDeleting(true)} aria-label={`Delete ${conn.name}`}>
          <Trash2 size={14} />
        </button>
      </div>

      {reached && (
        <div className="notice">
          {reached.length === 0
            ? "No running agent session to reconnect. Sessions started later load the server automatically."
            : `Reconnect requested in ${reached.length} session(s): ${reached.map(agentName).join(", ")}.`}
        </div>
      )}
      {testError && <div className="notice notice-error">Test failed: {testError}</div>}

      <Section title="Overview">
        <dl className="kv">
          <dt>Transport</dt>
          <dd>{cfg.transport}</dd>
          <dt>Server</dt>
          <dd className="mono">{nexusTarget(cfg) || "—"}</dd>
          <dt>Scope</dt>
          <dd>This project · NEXUS agents only</dd>
          <dt>Health</dt>
          <dd>
            {conn.statusDetail ? <span className={conn.status === "error" || conn.status === "disconnected" ? "tone-red-fg" : ""}>{conn.statusDetail}</span> : "Not checked yet"}
            {conn.lastChecked && <span className="muted small"> · checked {formatRelative(conn.lastChecked)}</span>}
          </dd>
          <dt>Last activity</dt>
          <dd>{conn.lastUsed ? `${formatRelative(conn.lastUsed)} (${formatDateTime(conn.lastUsed)})` : "Never used by an agent"}</dd>
          <dt>Response time</dt>
          <dd>{probe ? `${probe.probe.latencyMs} ms (last test)` : "Not tested yet"}</dd>
          <dt>Enabled</dt>
          <dd>{conn.enabled ? "Yes" : "No: never given to agents"}</dd>
        </dl>
        <JsonView value={redactNexusConfig(cfg)} collapsible label="Configuration (secret values hidden)" />
      </Section>

      <Section title="Agents">
        <div className="muted small">{using.length ? `Granted to ${using.map((a) => a.name).join(", ")}.` : "No agent has access."}</div>
        <AgentGrants connectionId={conn.id} />
        <div className="muted small">Per-mission MCP is not supported: grants are per agent.</div>
      </Section>

      <Section title="Tools, resources, prompts">
        <ProbeView record={probe} />
      </Section>

      <Section title="Logs: tool calls by agents">
        <ToolActivity connectionId={conn.id} />
      </Section>

      {editing && <McpWizard editing={conn} onClose={() => setEditing(false)} />}
      {deleting && (
        <Modal
          title={`Delete ${conn.name}?`}
          onClose={() => setDeleting(false)}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void remove()} disabled={busy}>
                Delete
              </button>
            </>
          }
        >
          <p>The connection, its stored secrets and every agent grant are removed. Calls from running sessions are denied from now on.</p>
        </Modal>
      )}
    </div>
  );
}
