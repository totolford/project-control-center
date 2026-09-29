import { memo, useMemo } from "react";
import { Crown } from "lucide-react";
import type { Agent } from "../lib/types";
import { normalizeProgress } from "../lib/format";
import { isLive } from "../lib/labels";
import { useAgents, useStore } from "../store";
import { StatusBadge } from "../components/StatusBadge";
import { ProgressBar } from "../components/ProgressBar";

/** Central first, then live agents, then idle, retired last. */
export function sortAgents(agents: Agent[]): Agent[] {
  const rank = (a: Agent) => (a.kind === "central" ? 0 : isLive(a.status) ? 1 : a.status === "retired" ? 3 : 2);
  return [...agents].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const AgentRow = memo(function AgentRow({ agent, active, onOpen }: { agent: Agent; active: boolean; onOpen: (id: string) => void }) {
  const progress = normalizeProgress(agent.progress);
  return (
    <button className={`agent-row${active ? " active" : ""}${agent.status === "retired" ? " retired" : ""}`} onClick={() => onOpen(agent.id)}>
      <div className="agent-row-top">
        <span className="agent-row-name">
          {agent.kind === "central" && <Crown size={12} className="tone-accent-fg" />}
          {agent.name}
        </span>
        <StatusBadge status={agent.status} />
      </div>
      {agent.currentAction && (
        <div className="agent-row-action" title={agent.currentAction}>
          {agent.currentAction}
        </div>
      )}
      {progress != null && <ProgressBar value={progress} />}
    </button>
  );
});

export function AgentsPanel() {
  const agents = useAgents();
  const openAgent = useStore((s) => s.openAgent);
  const activeId = useStore((s) => (s.view.name === "agent" ? s.view.agentId : undefined));
  const sorted = useMemo(() => sortAgents(agents), [agents]);
  const live = agents.filter((a) => isLive(a.status)).length;
  return (
    <aside className="agents-panel" aria-label="Agents">
      <div className="agents-panel-header">
        <span>AGENTS</span>
        <span className="muted small">
          {live}/{agents.length} active
        </span>
      </div>
      <div className="agents-panel-list">
        {sorted.length === 0 && <div className="muted small pad">No agents yet.</div>}
        {sorted.map((a) => (
          <AgentRow key={a.id} agent={a} active={a.id === activeId} onOpen={openAgent} />
        ))}
      </div>
    </aside>
  );
}
