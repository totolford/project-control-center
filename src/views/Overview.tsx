import { useMemo } from "react";
import { GitBranch, ShieldAlert, Target } from "lucide-react";
import { MISSION_STATUS, TASK_STATUS, TASK_STATUSES, isLive } from "../lib/labels";
import { truncate } from "../lib/format";
import { useAgents, useMissions, usePendingPermissions, useStore, useTasks } from "../store";
import { EmptyState, PageHeader, Section } from "../components/Common";
import { Chip, StatusBadge } from "../components/StatusBadge";
import { MissionProgress } from "../components/ProgressBar";
import { MessageList } from "../components/MessageList";

export function Overview() {
  const missions = useMissions();
  const agents = useAgents();
  const tasks = useTasks();
  const pending = usePendingPermissions();
  const repo = useStore((s) => s.project?.repo);
  const navigate = useStore((s) => s.navigate);
  const openAgent = useStore((s) => s.openAgent);
  const openTask = useStore((s) => s.openTask);

  const active = missions.filter((m) => m.status === "planning" || m.status === "active");
  const working = agents.filter((a) => isLive(a.status));
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tasks) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tasks]);

  return (
    <div className="page">
      <PageHeader title="Overview" />
      <div className="stat-row">
        <button className="stat" onClick={() => navigate({ name: "missions" })}>
          <span className="stat-value">{active.length}</span>
          <span className="stat-label">active missions</span>
        </button>
        <button className="stat" onClick={() => navigate({ name: "agents" })}>
          <span className="stat-value">
            {working.length}
            <span className="muted">/{agents.length}</span>
          </span>
          <span className="stat-label">agents running</span>
        </button>
        <div className={`stat${pending.length > 0 ? " stat-warn" : ""}`}>
          <span className="stat-value">
            <ShieldAlert size={16} /> {pending.length}
          </span>
          <span className="stat-label">pending permissions</span>
        </div>
        <button className="stat" onClick={() => navigate({ name: "git" })}>
          <span className="stat-value stat-small">
            <GitBranch size={15} /> {repo?.isRepo ? (repo.branch ?? "detached") : "no repo"}
          </span>
          <span className="stat-label">{repo?.isRepo ? `${repo.dirtyFiles.length} uncommitted files` : "git not initialized"}</span>
        </button>
      </div>

      <div className="grid-2">
        <Section title="Active missions">
          {active.length === 0 ? (
            <EmptyState icon={<Target size={20} />} title="No active mission">
              <button className="btn primary" onClick={() => navigate({ name: "missions" })}>
                Give Central a mission
              </button>
            </EmptyState>
          ) : (
            active.map((m) => (
              <div key={m.id} className="mission-mini">
                <div className="row">
                  <strong className="grow">{m.title}</strong>
                  <Chip tone={MISSION_STATUS[m.status].tone}>{MISSION_STATUS[m.status].label}</Chip>
                </div>
                <MissionProgress mission={m} />
              </div>
            ))
          )}
        </Section>

        <Section title="Tasks by status" actions={<button className="link-btn" onClick={() => navigate({ name: "tasks" })}>Open board</button>}>
          {tasks.length === 0 ? (
            <div className="muted small">No tasks yet.</div>
          ) : (
            <div className="status-counts">
              {TASK_STATUSES.map((s) => (
                <div key={s} className={`status-count${counts[s] ? "" : " zero"}`}>
                  <Chip tone={TASK_STATUS[s].tone}>{TASK_STATUS[s].label}</Chip>
                  <span className="status-count-n">{counts[s] ?? 0}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section title="Current activity">
        {working.length === 0 ? (
          <div className="muted small">No agent is running.</div>
        ) : (
          <div className="activity-list">
            {working.map((a) => {
              const task = a.currentTask ? tasks.find((t) => t.id === a.currentTask) : undefined;
              return (
                <div key={a.id} className="activity-item">
                  <button className="link-btn strong" onClick={() => openAgent(a.id)}>
                    {a.name}
                  </button>
                  <StatusBadge status={a.status} />
                  {task && (
                    <button className="link-btn muted" onClick={() => openTask(task.id)}>
                      {truncate(task.title, 50)}
                    </button>
                  )}
                  <span className="activity-action mono">{a.currentAction ?? ""}</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Recent agent communication">
        <MessageList agentId={null} limit={30} compact />
      </Section>
    </div>
  );
}
