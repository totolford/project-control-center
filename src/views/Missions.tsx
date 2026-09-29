import { memo, useMemo, useState } from "react";
import { Ban, ChevronDown, ChevronRight, Send, Target } from "lucide-react";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import { MISSION_STATUS } from "../lib/labels";
import { formatDateTime, formatRelative } from "../lib/format";
import type { Agent, Mission, Task } from "../lib/types";
import { useAgents, useMissions, useStore, useTasks } from "../store";
import { EmptyState, PageHeader, Spinner } from "../components/Common";
import { Chip } from "../components/StatusBadge";
import { MissionProgress } from "../components/ProgressBar";
import { TaskRow } from "../components/TaskRow";
import { Modal } from "../components/Modal";

function MissionComposer() {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const upsertMission = useStore((s) => s.upsertMission);

  const submit = async () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    const mission = await attempt(() => api.createMission(text, title.trim() || undefined), "Mission sent to Central");
    setBusy(false);
    if (mission) {
      upsertMission(mission);
      setPrompt("");
      setTitle("");
    }
  };

  return (
    <div className="panel composer">
      <textarea
        className="mission-input"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Give Central a mission in natural language — e.g. “Add OAuth login with GitHub, with tests and docs.”"
        rows={4}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
        }}
        aria-label="Mission prompt"
      />
      <div className="row">
        <input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" disabled={busy} />
        <span className="muted small">Ctrl+Enter</span>
        <button className="btn primary" onClick={() => void submit()} disabled={busy || !prompt.trim()}>
          {busy ? <Spinner size={13} /> : <Send size={13} />} Launch mission
        </button>
      </div>
    </div>
  );
}

const MissionCard = memo(function MissionCard({
  mission,
  tasks,
  agents,
  onCancel,
}: {
  mission: Mission;
  tasks: Task[];
  agents: Agent[];
  onCancel: (m: Mission) => void;
}) {
  const [open, setOpen] = useState(mission.status === "active" || mission.status === "planning");
  const openTask = useStore((s) => s.openTask);
  const running = mission.status === "active" || mission.status === "planning";
  const meta = MISSION_STATUS[mission.status];
  return (
    <div className="panel mission">
      <div className="mission-head">
        <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Toggle details">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div className="grow">
          <div className="row">
            <strong>{mission.title}</strong>
            <Chip tone={meta.tone}>{meta.label}</Chip>
          </div>
          <div className="muted small" title={formatDateTime(mission.createdAt)}>
            created {formatRelative(mission.createdAt)}
            {mission.completedAt && ` · finished ${formatRelative(mission.completedAt)}`}
          </div>
        </div>
        <div className="mission-progress">
          <MissionProgress mission={mission} />
        </div>
        {running && (
          <button className="btn danger-ghost" onClick={() => onCancel(mission)}>
            <Ban size={13} /> Cancel
          </button>
        )}
      </div>
      {open && (
        <div className="mission-body">
          <div className="section-label">Prompt</div>
          <div className="prewrap">{mission.prompt}</div>
          {mission.summary && (
            <>
              <div className="section-label">Summary</div>
              <div className="prewrap summary">{mission.summary}</div>
            </>
          )}
          <div className="section-label">Tasks ({tasks.length})</div>
          {tasks.length === 0 ? (
            <div className="muted small">{running ? "Central has not created tasks for this mission yet." : "No tasks."}</div>
          ) : (
            <div className="task-list">
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} agent={agents.find((a) => a.id === t.agent)} onSelect={openTask} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export function Missions() {
  const missions = useMissions();
  const tasks = useTasks();
  const agents = useAgents();
  const refresh = useStore((s) => s.refresh);
  const [cancelling, setCancelling] = useState<Mission | null>(null);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => [...missions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [missions]);
  const tasksByMission = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.missionId) continue;
      const list = map.get(t.missionId) ?? [];
      list.push(t);
      map.set(t.missionId, list);
    }
    return map;
  }, [tasks]);

  const confirmCancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    const ok = await run(() => api.cancelMission(cancelling.id), "Mission cancelled");
    setBusy(false);
    setCancelling(null);
    if (ok) void refresh().catch(() => undefined);
  };

  return (
    <div className="page">
      <PageHeader title="Missions" subtitle="Central plans each mission, creates specialised agents and tasks, and routes their work." />
      <MissionComposer />
      {sorted.length === 0 ? (
        <EmptyState icon={<Target size={22} />} title="No missions yet">
          Describe what you want done above; Central will plan it.
        </EmptyState>
      ) : (
        sorted.map((m) => (
          <MissionCard key={m.id} mission={m} tasks={tasksByMission.get(m.id) ?? NO_TASKS} agents={agents} onCancel={setCancelling} />
        ))
      )}
      {cancelling && (
        <Modal
          title="Cancel mission?"
          onClose={() => setCancelling(null)}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={() => setCancelling(null)} disabled={busy}>
                Keep running
              </button>
              <button className="btn danger" onClick={() => void confirmCancel()} disabled={busy}>
                Cancel mission
              </button>
            </>
          }
        >
          <p>
            “{cancelling.title}” will be cancelled and Central will stop pursuing it. Work already committed stays in the repository.
          </p>
        </Modal>
      )}
    </div>
  );
}

const NO_TASKS: Task[] = [];
