import { useState } from "react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { sortAgents, useAgents, useStore } from "../../store";
import { StatusBadge } from "../../components/StatusBadge";

/** Grant / revoke a connection per agent (Agent.connections). */
export function AgentGrants({ connectionId }: { connectionId: string }) {
  const agents = sortAgents(useAgents()).filter((a) => a.status !== "retired");
  const upsertAgent = useStore((s) => s.upsertAgent);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (agentId: string, current: string[], grant: boolean) => {
    setBusy(agentId);
    const next = grant ? [...current, connectionId] : current.filter((c) => c !== connectionId);
    const updated = await attempt(() => api.updateAgent(agentId, { connections: next }), grant ? "Access granted" : "Access removed");
    setBusy(null);
    if (updated) upsertAgent(updated);
  };

  return (
    <div>
      {agents.length === 0 ? (
        <div className="muted small">No agents yet.</div>
      ) : (
        agents.map((a) => {
          const granted = a.connections.includes(connectionId);
          return (
            <label key={a.id} className="checkbox tools-grant">
              <input type="checkbox" checked={granted} disabled={busy !== null} onChange={() => void toggle(a.id, a.connections, !granted)} />
              <span className="grow">{a.name}</span>
              <StatusBadge status={a.status} />
            </label>
          );
        })
      )}
      <div className="muted small">
        Connections are loaded when a session starts, so a new grant applies at the agent's next start. MCP and SSH calls are checked against the
        current grants, so revoking blocks them immediately.
      </div>
    </div>
  );
}
