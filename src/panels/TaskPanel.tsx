import { memo, useMemo } from "react";
import type { Agent, Task, TaskStatus } from "../lib/types";
import { useAgents, useStore, useTasks } from "../store";
import type { PanelBodyProps } from "../workspace/registry";
import { t as translate, useT, type MessageKey } from "../i18n";

const COLUMNS: { title: MessageKey; statuses: TaskStatus[]; tone: string }[] = [
  { title: "panel.col.todo", statuses: ["pending", "queued", "waiting"], tone: "grey" },
  { title: "panel.col.inProgress", statuses: ["in_progress"], tone: "green" },
  { title: "panel.col.blocked", statuses: ["blocked"], tone: "orange" },
  { title: "panel.col.review", statuses: ["review"], tone: "accent" },
  { title: "panel.col.done", statuses: ["completed"], tone: "green" },
  { title: "panel.col.failed", statuses: ["failed", "cancelled"], tone: "red" },
];

const Card = memo(function Card({ task, agent, onOpen }: { task: Task; agent: Agent | undefined; onOpen: (id: string) => void }) {
  return (
    <button className={`task-card prio-${task.priority}`} onClick={() => onOpen(task.id)}>
      <span className="task-card-title">{task.title}</span>
      <span className="muted small ellipsis">
        {agent?.name ?? translate("panel.unassigned")}
        {task.status === "cancelled" && ` · ${translate("panel.cancelledSuffix")}`}
      </span>
    </button>
  );
});

/** Compact task board; filtered to one mission when the panel has a missionId. */
export const TaskPanel = memo(function TaskPanel({ spec }: PanelBodyProps) {
  const t = useT();
  const tasks = useTasks();
  const agents = useAgents();
  const openTask = useStore((s) => s.openTask);
  const byAgent = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const scoped = spec.missionId ? tasks.filter((x) => x.missionId === spec.missionId) : tasks;
  if (scoped.length === 0) return <div className="muted pad">{t("panel.noTasksPlan")}</div>;
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const list = scoped.filter((x) => col.statuses.includes(x.status));
        return (
          <div key={col.title} className="board-col">
            <div className="board-col-head">
              <span className={`dot tone-${col.tone}`} />
              {t(col.title)}
              <span className="muted">{list.length}</span>
            </div>
            <div className="board-col-body">
              {list.map((x) => (
                <Card key={x.id} task={x} agent={x.agent ? byAgent.get(x.agent) : undefined} onOpen={openTask} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
});
