import { memo, useMemo } from "react";
import { SquareTerminal } from "lucide-react";
import { normalizeProgress } from "../lib/format";
import type { Agent } from "../lib/types";
import { ProgressBar } from "../components/ProgressBar";
import { StatusIndicator } from "../components/StatusIndicator";
import { useProviderName, useVisualState } from "../workspace/hooks";
import { addPanelToActive } from "../workspace/layout";
import type { PanelBodyProps } from "../workspace/registry";
import { useWorkspace } from "../workspace/store";
import { sortAgents, useAgentNumber, useAgents, useConnections, useStore } from "../store";
import { useT } from "../i18n";

const AgentCard = memo(function AgentCard({ agent }: { agent: Agent }) {
  const t = useT();
  const state = useVisualState(agent.id);
  const number = useAgentNumber(agent.id);
  const provider = useProviderName(agent.provider);
  const connections = useConnections();
  const openAgent = useStore((s) => s.openAgent);
  const update = useWorkspace((s) => s.update);
  const progress = normalizeProgress(agent.progress);
  const granted = connections.filter((c) => agent.connections.includes(c.id));
  return (
    <div className={`agent-card${agent.status === "retired" ? " retired" : ""}`}>
      <div className="row">
        <button className="link-btn strong grow ellipsis" onClick={() => openAgent(agent.id)} title={t("panel.swarm.openDetails")}>
          <span className="muted">#{number}</span> {agent.name}
        </button>
        {agent.kind === "worker" && (
          <button
            className="icon-btn"
            title={t("panel.swarm.showTerminal")}
            aria-label={t("panel.swarm.showTerminalOf", { name: agent.name })}
            onClick={() => update((ws) => addPanelToActive(ws, { type: "AgentTerminal", agentId: agent.id }))}
          >
            <SquareTerminal size={13} />
          </button>
        )}
      </div>
      <div className="row small">
        {state && <StatusIndicator state={state} />}
        <span className="muted">{provider}</span>
      </div>
      <div className="agent-card-action mono" title={agent.currentAction ?? undefined}>
        {agent.currentAction ?? <span className="muted">{agent.role}</span>}
      </div>
      {progress != null && <ProgressBar value={progress} />}
      {granted.length > 0 && (
        <div className="chips-row">
          {granted.map((c) => (
            <span key={c.id} className={`chip tone-${c.status === "connected" ? "green" : c.status === "error" ? "red" : "grey"}`}>
              {c.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export function SwarmGrid() {
  const t = useT();
  const agents = useAgents();
  const sorted = useMemo(() => sortAgents(agents), [agents]);
  if (sorted.length === 0) return <div className="muted pad">{t("panel.swarm.empty")}</div>;
  return (
    <div className="swarm-grid">
      {sorted.map((a) => (
        <AgentCard key={a.id} agent={a} />
      ))}
    </div>
  );
}

export const SwarmOverview = memo(function SwarmOverview(_: PanelBodyProps) {
  return (
    <div className="panel-scroll pad-sm">
      <SwarmGrid />
    </div>
  );
});
