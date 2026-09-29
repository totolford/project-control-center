import { useState } from "react";
import { Ban, CircleCheck, RotateCw, X } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import { PRIORITIES, TASK_STATUS, TASK_STATUSES } from "../lib/labels";
import { formatDateTime, normalizeProgress } from "../lib/format";
import type { Task, TaskPatch } from "../lib/types";
import { useAgents, useMissions, useStore, useTasks } from "../store";
import { Chip } from "../components/StatusBadge";
import { ProgressBar } from "../components/ProgressBar";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function TaskLink({ id, tasks }: { id: string; tasks: Task[] }) {
  const openTask = useStore((s) => s.openTask);
  const t = tasks.find((x) => x.id === id);
  return (
    <button className="dep-link" onClick={() => openTask(id)}>
      {t ? <Chip tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Chip> : null}
      <span>{t?.title ?? id}</span>
    </button>
  );
}

export function TaskDetail({ task, onClose }: { task: Task; onClose: () => void }) {
  const tasks = useTasks();
  const agents = useAgents();
  const missions = useMissions();
  const upsertTask = useStore((s) => s.upsertTask);
  const openAgent = useStore((s) => s.openAgent);
  const navigate = useStore((s) => s.navigate);
  const [busy, setBusy] = useState(false);

  const mission = task.missionId ? missions.find((m) => m.id === task.missionId) : undefined;
  const dependents = tasks.filter((t) => t.dependencies.includes(task.id));
  const assignable = agents.filter((a) => a.status !== "retired" || a.id === task.agent);
  const progress = normalizeProgress(task.progress);

  const apply = async (fn: () => Promise<Task>, text: string) => {
    setBusy(true);
    const updated = await attempt(fn, text);
    setBusy(false);
    if (updated) upsertTask(updated);
  };
  const patch = (p: TaskPatch, text: string) => apply(() => api.updateTask(task.id, p), text);

  return (
    <aside className="drawer" aria-label="Task detail">
      <div className="drawer-header">
        <Chip tone={TASK_STATUS[task.status].tone}>{TASK_STATUS[task.status].label}</Chip>
        <h2 className="grow">{task.title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close task detail">
          <X size={16} />
        </button>
      </div>
      <div className="drawer-body">
        <div className="drawer-actions">
          {task.status === "review" && (
            <button className="btn primary" disabled={busy} onClick={() => void patch({ status: "completed" }, "Task marked completed")}>
              <CircleCheck size={13} /> Mark completed
            </button>
          )}
          {(task.status === "failed" || task.status === "cancelled") && (
            <button className="btn primary" disabled={busy} onClick={() => void apply(() => api.retryTask(task.id), "Task queued for retry")}>
              <RotateCw size={13} /> Retry
            </button>
          )}
          {!TERMINAL.has(task.status) && (
            <button className="btn danger-ghost" disabled={busy} onClick={() => void patch({ status: "cancelled" }, "Task cancelled")}>
              <Ban size={13} /> Cancel task
            </button>
          )}
        </div>

        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <select value={task.status} disabled={busy} onChange={(e) => void patch({ status: e.target.value as Task["status"] }, "Status updated")}>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS[s].label}
                </option>
              ))}
            </select>
          </dd>
          <dt>Agent</dt>
          <dd className="row">
            <select
              value={task.agent ?? ""}
              disabled={busy}
              onChange={(e) => void patch({ agent: e.target.value || null }, "Task reassigned")}
              aria-label="Assigned agent"
            >
              <option value="">Unassigned</option>
              {assignable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {task.agent && agents.some((a) => a.id === task.agent) && (
              <button className="link-btn small" onClick={() => openAgent(task.agent!)}>
                open
              </button>
            )}
          </dd>
          <dt>Priority</dt>
          <dd>
            <select value={task.priority} disabled={busy} onChange={(e) => void patch({ priority: e.target.value as Task["priority"] }, "Priority updated")}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </dd>
          <dt>Review</dt>
          <dd>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={task.requiresReview}
                disabled={busy}
                onChange={(e) => void patch({ requiresReview: e.target.checked }, "Review requirement updated")}
              />
              Requires review
            </label>
          </dd>
          {mission && (
            <>
              <dt>Mission</dt>
              <dd>
                <button className="link-btn" onClick={() => navigate({ name: "missions" })}>
                  {mission.title}
                </button>
              </dd>
            </>
          )}
          <dt>Created</dt>
          <dd>
            {formatDateTime(task.createdAt)} by {task.createdBy}
          </dd>
          {task.startedAt && (
            <>
              <dt>Started</dt>
              <dd>{formatDateTime(task.startedAt)}</dd>
            </>
          )}
          {task.completedAt && (
            <>
              <dt>Finished</dt>
              <dd>{formatDateTime(task.completedAt)}</dd>
            </>
          )}
        </dl>

        {progress != null && <ProgressBar value={progress} />}
        {task.statusReason && <div className="notice">{task.statusReason}</div>}

        <div className="section-label">Description</div>
        <div className="prewrap">{task.description || <span className="muted">No description.</span>}</div>

        {task.dependencies.length > 0 && (
          <>
            <div className="section-label">Depends on</div>
            {task.dependencies.map((d) => (
              <TaskLink key={d} id={d} tasks={tasks} />
            ))}
          </>
        )}
        {dependents.length > 0 && (
          <>
            <div className="section-label">Blocks</div>
            {dependents.map((d) => (
              <TaskLink key={d.id} id={d.id} tasks={tasks} />
            ))}
          </>
        )}

        {task.result && (
          <>
            <div className="section-label">Result</div>
            <div className="prewrap summary">{task.result.summary}</div>
            {task.result.filesChanged.length > 0 && (
              <>
                <div className="section-label">Files changed ({task.result.filesChanged.length})</div>
                <ul className="file-list mono">
                  {task.result.filesChanged.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </>
            )}
            {task.result.tests && (
              <>
                <div className="section-label">Tests</div>
                <div className="prewrap">{task.result.tests}</div>
              </>
            )}
            {task.result.issues && (
              <>
                <div className="section-label">Issues</div>
                <div className="prewrap tone-amber-fg">{task.result.issues}</div>
              </>
            )}
            {task.result.commit && (
              <>
                <div className="section-label">Commit</div>
                <code>{task.result.commit}</code>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
