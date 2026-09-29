import { memo } from "react";
import { Link2 } from "lucide-react";
import { TASK_STATUS } from "../lib/labels";
import { normalizeProgress } from "../lib/format";
import type { Agent, Task } from "../lib/types";
import { Chip } from "./StatusBadge";
import { ProgressBar } from "./ProgressBar";

const PRIORITY_TONE = { low: "dim", normal: "grey", high: "amber", critical: "red" } as const;

export const TaskRow = memo(function TaskRow({
  task,
  agent,
  selected,
  onSelect,
}: {
  task: Task;
  agent: Agent | undefined;
  selected?: boolean;
  onSelect: (id: string) => void;
}) {
  const progress = task.status === "in_progress" ? normalizeProgress(task.progress) : null;
  return (
    <button className={`task-row${selected ? " selected" : ""}`} onClick={() => onSelect(task.id)}>
      <Chip tone={TASK_STATUS[task.status].tone}>{TASK_STATUS[task.status].label}</Chip>
      <span className="task-title">{task.title}</span>
      {task.dependencies.length > 0 && (
        <span className="muted small" title={`${task.dependencies.length} dependencies`}>
          <Link2 size={11} /> {task.dependencies.length}
        </span>
      )}
      {task.priority !== "normal" && <Chip tone={PRIORITY_TONE[task.priority]}>{task.priority}</Chip>}
      {progress != null && (
        <span className="task-progress">
          <ProgressBar value={progress} />
        </span>
      )}
      <span className="task-agent muted">{agent ? agent.name : task.agent ? task.agent : "unassigned"}</span>
    </button>
  );
});
