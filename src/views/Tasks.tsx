import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks, Plus } from "lucide-react";
import { TASK_STATUS, TASK_STATUSES } from "../lib/labels";
import type { Agent, Task, TaskStatus } from "../lib/types";
import { useAgents, useMissions, useStore, useTasks } from "../store";
import { EmptyState, PageHeader } from "../components/Common";
import { Chip } from "../components/StatusBadge";
import { TaskRow } from "../components/TaskRow";
import { TaskDetail } from "./TaskDetail";
import { NewTaskDialog } from "./NewTaskDialog";

const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 } as const;
const COLLAPSED_BY_DEFAULT: TaskStatus[] = ["completed", "cancelled"];

function StatusGroup({
  status,
  tasks,
  agents,
  selectedId,
  onSelect,
}: {
  status: TaskStatus;
  tasks: Task[];
  agents: Map<string, Agent>;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(!COLLAPSED_BY_DEFAULT.includes(status));
  const meta = TASK_STATUS[status];
  return (
    <div className="task-group">
      <button className="task-group-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Chip tone={meta.tone}>{meta.label}</Chip>
        <span className="muted">{tasks.length}</span>
      </button>
      {open && (
        <div className="task-list">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} agent={t.agent ? agents.get(t.agent) : undefined} selected={t.id === selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Tasks() {
  const tasks = useTasks();
  const agents = useAgents();
  const missions = useMissions();
  const selectedId = useStore((s) => (s.view.name === "tasks" ? s.view.taskId : undefined));
  const openTask = useStore((s) => s.openTask);
  const navigate = useStore((s) => s.navigate);
  const [missionFilter, setMissionFilter] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = tasks.filter(
      (t) =>
        (!missionFilter || (missionFilter === "none" ? !t.missionId : t.missionId === missionFilter)) &&
        (!agentFilter || (agentFilter === "none" ? !t.agent : t.agent === agentFilter)) &&
        (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)),
    );
    const byStatus = new Map<TaskStatus, Task[]>();
    for (const t of filtered) {
      const list = byStatus.get(t.status) ?? [];
      list.push(t);
      byStatus.set(t.status, list);
    }
    for (const list of byStatus.values()) {
      list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
    }
    return { byStatus, count: filtered.length };
  }, [tasks, missionFilter, agentFilter, query]);

  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : undefined;

  return (
    <div className="page page-fill">
      <PageHeader
        title="Tasks"
        subtitle={`${groups.count} of ${tasks.length} tasks`}
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New task
          </button>
        }
      />
      <div className="filters">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks…" aria-label="Search tasks" />
        <select value={missionFilter} onChange={(e) => setMissionFilter(e.target.value)} aria-label="Filter by mission">
          <option value="">All missions</option>
          <option value="none">No mission</option>
          {missions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          <option value="none">Unassigned</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="split">
        <div className="split-main scroll">
          {tasks.length === 0 ? (
            <EmptyState icon={<ListChecks size={22} />} title="No tasks yet">
              Central creates tasks when it plans a mission. You can also create one manually.
            </EmptyState>
          ) : groups.count === 0 ? (
            <div className="muted pad">No task matches these filters.</div>
          ) : (
            TASK_STATUSES.filter((s) => groups.byStatus.has(s)).map((s) => (
              <StatusGroup key={s} status={s} tasks={groups.byStatus.get(s)!} agents={agentMap} selectedId={selectedId} onSelect={openTask} />
            ))
          )}
        </div>
        {selected && <TaskDetail key={selected.id} task={selected} onClose={() => navigate({ name: "tasks" })} />}
      </div>
      {creating && <NewTaskDialog onClose={() => setCreating(false)} missionId={missionFilter && missionFilter !== "none" ? missionFilter : null} />}
    </div>
  );
}
