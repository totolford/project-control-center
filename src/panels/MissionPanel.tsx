import { memo, useMemo, useState } from "react";
import { Ban } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { MISSION_STATUS } from "../lib/labels";
import { formatRelative } from "../lib/format";
import type { Agent, Mission, Task, TaskStatus } from "../lib/types";
import { Chip } from "../components/StatusBadge";
import { MissionProgress } from "../components/ProgressBar";
import type { PanelBodyProps } from "../workspace/registry";
import { useAgents, useMissions, useStore, useTasks } from "../store";

const MARK: Record<TaskStatus, { mark: string; tone: string }> = {
  completed: { mark: "✓", tone: "green" },
  in_progress: { mark: "●", tone: "green" },
  review: { mark: "◆", tone: "accent" },
  pending: { mark: "○", tone: "grey" },
  queued: { mark: "○", tone: "grey" },
  waiting: { mark: "○", tone: "blue" },
  blocked: { mark: "!", tone: "orange" },
  failed: { mark: "!", tone: "red" },
  cancelled: { mark: "–", tone: "dim" },
};

export function isRunning(m: Mission): boolean {
  return m.status === "active" || m.status === "planning";
}

export function MissionChecklist({ tasks, agents }: { tasks: Task[]; agents: Agent[] }) {
  const openTask = useStore((s) => s.openTask);
  if (tasks.length === 0) return <div className="muted small">No tasks yet.</div>;
  return (
    <ul className="checklist-tasks">
      {tasks.map((t) => {
        const m = MARK[t.status];
        return (
          <li key={t.id}>
            <button className="check-task" onClick={() => openTask(t.id)} title={t.status}>
              <span className={`check-mark tone-${m.tone}-fg`}>{m.mark}</span>
              <span className={`grow ellipsis${t.status === "completed" || t.status === "cancelled" ? " muted" : ""}`}>{t.title}</span>
              <span className="muted small ellipsis check-agent">{agents.find((a) => a.id === t.agent)?.name ?? "unassigned"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Full mission card: status, progress, checklist, agents involved, summary, cancel. */
export const MissionCard = memo(function MissionCard({ mission }: { mission: Mission }) {
  const tasks = useTasks();
  const agents = useAgents();
  const [busy, setBusy] = useState(false);
  const own = useMemo(() => tasks.filter((t) => t.missionId === mission.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [tasks, mission.id]);
  const involved = agents.filter((a) => own.some((t) => t.agent === a.id));
  const meta = MISSION_STATUS[mission.status];

  const cancel = async () => {
    const ok = await ask(`Cancel "${mission.title}"? Central stops pursuing it; committed work stays in the repository.`, { title: "Cancel mission", kind: "warning" });
    if (!ok) return;
    setBusy(true);
    await run(() => api.cancelMission(mission.id), "Mission cancelled");
    setBusy(false);
  };

  return (
    <div className="mission-card">
      <div className="row">
        <strong className="grow ellipsis" title={mission.title}>
          {mission.title}
        </strong>
        <Chip tone={meta.tone}>{meta.label}</Chip>
        {isRunning(mission) && (
          <button className="btn btn-sm danger-ghost" onClick={() => void cancel()} disabled={busy}>
            <Ban size={12} /> Cancel
          </button>
        )}
      </div>
      <MissionProgress mission={mission} />
      <div className="muted small">
        started {formatRelative(mission.createdAt)}
        {mission.completedAt && ` · finished ${formatRelative(mission.completedAt)}`}
        {involved.length > 0 && ` · ${involved.map((a) => a.name).join(", ")}`}
      </div>
      <MissionChecklist tasks={own} agents={agents} />
      {mission.summary && (
        <>
          <div className="section-label">Summary</div>
          <div className="prewrap summary">{mission.summary}</div>
        </>
      )}
    </div>
  );
});

export const MissionPanel = memo(function MissionPanel({ spec }: PanelBodyProps) {
  const missions = useMissions();
  const navigate = useStore((s) => s.navigate);
  const mission = spec.missionId
    ? missions.find((m) => m.id === spec.missionId)
    : ([...missions].filter(isRunning).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
      [...missions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]);
  if (!mission) {
    return (
      <div className="muted pad">
        No mission yet. Describe what you want to build in the composer below, or{" "}
        <button className="link-btn" onClick={() => navigate({ name: "missions" })}>
          open Missions
        </button>
        .
      </div>
    );
  }
  return (
    <div className="panel-scroll pad-sm">
      <MissionCard mission={mission} />
    </div>
  );
});
