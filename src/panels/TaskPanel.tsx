import { memo, useMemo } from "react";
import type { Agent, Task, TaskStatus } from "../lib/types";
import { useAgents, useStore, useTasks } from "../store";
import type { PanelBodyProps } from "../workspace/registry";

const COLUMNS: { title: string; statuses: TaskStatus[]; tone: string }[] = [
  { title: "To do", statuses: ["pending", "queued", "waiting"], tone: "grey" },
  { title: "In progress", statuses: ["in_progress"], tone: "green" },
  { title: "Blocked", statuses: ["blocked"], tone: "orange" },
  { title: "Review", statuses: ["review"], tone: "accent" },
  { title: "Done", statuses: ["completed"], tone: "green" },
  { title: "Failed", statuses: ["failed", "cancelled"], tone: "red" },
];

const Card = memo(function Card({ task, agent, onOpen }: { task: Task; agent: Agent | undefined; onOpen: (id: string) => void }) {
  return (
    <button className={`task-card prio-${task.priority}`} onClick={() => onOpen(task.id)}>
      <span className="task-card-title">{task.title}</span>
      <span className="muted small ellipsis">
        {agent?.name ?? "unassigned"}
        {task.status === "cancelled" && " · cancelled"}
      </span>
    </button>
  );
});

/** Compact task board; filtered to one mission when the panel has a missionId. */
export const TaskPanel = memo(function TaskPanel({ spec }: PanelBodyProps) {
  const tasks = useTasks();
  const agents = useAgents();
  const openTask = useStore((s) => s.openTask);
  const byAgent = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const scoped = spec.missionId ? tasks.filter((t) => t.missionId === spec.missionId) : tasks;
  if (scoped.length === 0) return <div className="muted pad">No tasks yet. Central creates them when it plans a mission.</div>;
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const list = scoped.filter((t) => col.statuses.includes(t.status));
        return (
          <div key={col.title} className="board-col">
            <div className="board-col-head">
              <span className={`dot tone-${col.tone}`} />
              {col.title}
              <span className="muted">{list.length}</span>
            </div>
            <div className="board-col-body">
              {list.map((t) => (
                <Card key={t.id} task={t} agent={t.agent ? byAgent.get(t.agent) : undefined} onOpen={openTask} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
});
