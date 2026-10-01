import { memo, useMemo } from "react";
import { FlaskConical, GitBranch, Settings2 } from "lucide-react";
import { api } from "../../lib/api";
import { MISSION_STATUS, TASK_STATUS } from "../../lib/labels";
import { formatRelative } from "../../lib/format";
import { run } from "../../lib/toast";
import type { Mission, Task } from "../../lib/types";
import { useMissions, useStore, useTasks } from "../../store";
import { Chip } from "../../components/StatusBadge";
import { MODE_HELP } from "../settings/ImprovementSettings";

const LOOP = ["ANALYZE", "PLAN", "IMPLEMENT", "TEST", "REVIEW", "IMPROVE"];

function isImprovement(m: Mission): boolean {
  return m.title.startsWith("Improvement cycle");
}

function LoopDiagram() {
  return (
    <figure className="loop">
      <figcaption className="muted tiny">How a cycle works</figcaption>
      <div className="loop-steps">
        {LOOP.map((step, i) => (
          <span key={step} className="loop-step">
            {step}
            {i < LOOP.length - 1 && <span className="loop-arrow">→</span>}
          </span>
        ))}
        <span className="loop-arrow">↺</span>
      </div>
    </figure>
  );
}

/** Traceability of one task: files, tests and commit reported by the worker. */
function TaskTrace({ task }: { task: Task }) {
  const openTask = useStore((s) => s.openTask);
  const meta = TASK_STATUS[task.status];
  const r = task.result;
  return (
    <li className="trace">
      <div className="row">
        <button className="link-btn grow ellipsis" onClick={() => openTask(task.id)}>
          {task.title}
        </button>
        <Chip tone={meta.tone}>{meta.label}</Chip>
      </div>
      {r && (
        <div className="muted tiny">
          {r.filesChanged.length} files{r.filesChanged.length > 0 ? `: ${r.filesChanged.slice(0, 4).join(", ")}${r.filesChanged.length > 4 ? "…" : ""}` : ""}
          {` · tests: ${r.tests ?? "—"}`}
          {` · commit: `}
          <span className="mono">{r.commit ? r.commit.slice(0, 10) : "—"}</span>
        </div>
      )}
    </li>
  );
}

const CycleRow = memo(function CycleRow({ mission, tasks }: { mission: Mission; tasks: Task[] }) {
  const meta = MISSION_STATUS[mission.status];
  return (
    <li className="cycle">
      <div className="row">
        <strong className="grow ellipsis">{mission.title}</strong>
        <span className="muted tiny">{formatRelative(mission.createdAt)}</span>
        <Chip tone={meta.tone}>{meta.label}</Chip>
      </div>
      {mission.summary && <div className="prewrap small summary">{mission.summary}</div>}
      {tasks.length > 0 ? <ul>{tasks.map((t) => <TaskTrace key={t.id} task={t} />)}</ul> : <div className="muted tiny">No task yet.</div>}
    </li>
  );
});

/** Missions page card: improvement settings at a glance, the loop, and every cycle with its traceability. */
export function ImprovementCard() {
  const improvement = useStore((s) => s.project?.settings.improvement);
  const navigate = useStore((s) => s.navigate);
  const missions = useMissions();
  const tasks = useTasks();
  const cycles = useMemo(() => missions.filter(isImprovement).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [missions]);
  if (!improvement) return null;
  return (
    <div className="panel pad-md improvement-card">
      <div className="row">
        <FlaskConical size={14} />
        <strong className="grow">Continuous improvement</strong>
        <Chip tone={improvement.enabled ? "green" : "grey"}>{improvement.enabled ? `every ${improvement.intervalMinutes} min` : "off"}</Chip>
        <Chip tone="accent">{improvement.mode}</Chip>
        <button className="btn btn-sm" onClick={() => void run(() => api.startImprovementCycle(), "Improvement cycle started")}>
          Run a cycle now
        </button>
        <button className="icon-btn" onClick={() => navigate({ name: "settings", section: "improvement" })} title="Improvement settings" aria-label="Improvement settings">
          <Settings2 size={13} />
        </button>
      </div>
      <div className="muted small">
        {MODE_HELP[improvement.mode]} Focus: {improvement.focus.join(", ") || "—"} · at most {improvement.maxRunsPerDay} runs/day.
      </div>
      <LoopDiagram />
      {cycles.length === 0 ? (
        <div className="muted small">No improvement cycle has run yet.</div>
      ) : (
        <ul className="cycles">
          {cycles.map((m) => (
            <CycleRow key={m.id} mission={m} tasks={tasks.filter((t) => t.missionId === m.id)} />
          ))}
        </ul>
      )}
      <button className="link-btn small" onClick={() => navigate({ name: "git" })}>
        <GitBranch size={11} /> Roll back: snapshots are in the Git view
      </button>
    </div>
  );
}
