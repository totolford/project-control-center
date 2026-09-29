import { memo, useMemo, useState } from "react";
import { Bot, Crown, Plus } from "lucide-react";
import { formatCost, normalizeProgress } from "../lib/format";
import type { Agent, Task } from "../lib/types";
import { useAgents, useStore, useTasks } from "../store";
import { sortAgents } from "../layout/AgentsPanel";
import { EmptyState, PageHeader } from "../components/Common";
import { StatusBadge } from "../components/StatusBadge";
import { ProgressBar } from "../components/ProgressBar";
import { NewAgentDialog } from "./agent/NewAgentDialog";

const AgentTableRow = memo(function AgentTableRow({ agent, task, onOpen }: { agent: Agent; task: Task | undefined; onOpen: (id: string) => void }) {
  const progress = normalizeProgress(agent.progress);
  return (
    <tr className={`clickable${agent.status === "retired" ? " retired" : ""}`} onClick={() => onOpen(agent.id)}>
      <td>
        <button className="link-btn strong" onClick={() => onOpen(agent.id)}>
          {agent.kind === "central" && <Crown size={12} className="tone-accent-fg" />} {agent.name}
        </button>
        <div className="muted small">{agent.role}</div>
      </td>
      <td>
        <StatusBadge status={agent.status} />
      </td>
      <td className="cell-action mono" title={agent.currentAction ?? undefined}>
        {agent.currentAction ?? <span className="muted">—</span>}
      </td>
      <td className="cell-task">{task ? task.title : <span className="muted">—</span>}</td>
      <td className="cell-progress">{progress != null ? <ProgressBar value={progress} /> : <span className="muted">—</span>}</td>
      <td className="muted">{agent.isolation === "worktree" ? (agent.branch ?? "worktree") : "shared"}</td>
      <td className="num">{formatCost(agent.totalCostUsd)}</td>
    </tr>
  );
});

export function Agents() {
  const agents = useAgents();
  const tasks = useTasks();
  const openAgent = useStore((s) => s.openAgent);
  const [creating, setCreating] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const sorted = useMemo(() => sortAgents(agents).filter((a) => showRetired || a.status !== "retired"), [agents, showRetired]);
  const retiredCount = agents.filter((a) => a.status === "retired").length;
  const totalCost = agents.reduce((sum, a) => sum + a.totalCostUsd, 0);

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        subtitle={`${agents.length} agents · total cost ${formatCost(totalCost)}`}
        actions={
          <>
            {retiredCount > 0 && (
              <label className="checkbox">
                <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
                Show retired ({retiredCount})
              </label>
            )}
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New agent
            </button>
          </>
        }
      />
      {sorted.length === 0 ? (
        <EmptyState icon={<Bot size={22} />} title="No agents yet">
          Central creates specialised agents when it plans a mission, or you can create one yourself.
        </EmptyState>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Current action</th>
                <th>Task</th>
                <th>Progress</th>
                <th>Workspace</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <AgentTableRow key={a.id} agent={a} task={a.currentTask ? tasks.find((t) => t.id === a.currentTask) : undefined} onOpen={openAgent} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewAgentDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
