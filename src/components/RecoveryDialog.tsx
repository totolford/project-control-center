import { useEffect, useRef, useState } from "react";
import { History, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { formatClock, formatDateTime } from "../lib/format";
import { run } from "../lib/toast";
import type { CheckpointSummary, InterruptedMission, RecoveryInfo } from "../lib/types";
import { useStore } from "../store";
import { Modal } from "./Modal";
import { Chip } from "./StatusBadge";

/** With settings.autoRecover, resumes the previous sessions without asking. Returns true while it handles them. */
function useAutoRecover(): boolean {
  const pending = useStore((s) => Boolean(s.project?.recovery?.agents.length));
  const auto = useStore((s) => s.project?.settings.autoRecover ?? false);
  const started = useRef(false);
  useEffect(() => {
    if (!pending || !auto || started.current) return;
    started.current = true;
    void run(() => api.recover(), "Previous sessions resumed automatically").then(() => {
      useStore.getState().clearRecovery();
      void useStore.getState().refresh().catch(() => undefined);
    });
  }, [pending, auto]);
  return auto;
}

function setRecovery(next: RecoveryInfo | null) {
  useStore.setState((s) => (s.project ? { project: { ...s.project, recovery: next } } : {}));
}

/** Offered once after opening a project whose sessions were running when the app last closed. */
export function RecoveryDialog() {
  const recovery = useStore((s) => s.project?.recovery);
  const automatic = useAutoRecover();
  if (!recovery) return null;
  const missions = recovery.missions ?? [];
  if (missions.length > 0) return <InterruptedMissionsDialog recovery={recovery} missions={missions} />;
  if (recovery.agents.length === 0 || automatic) return null;
  return <SessionsDialog recovery={recovery} />;
}

function SessionsDialog({ recovery }: { recovery: RecoveryInfo }) {
  const tasks = useStore((s) => s.project?.tasks);
  const clearRecovery = useStore((s) => s.clearRecovery);
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>, text: string) => {
    setBusy(true);
    const ok = await run(fn, text);
    setBusy(false);
    if (ok) {
      clearRecovery();
      void refresh().catch(() => undefined);
    }
  };

  const n = recovery.agents.length;
  return (
    <Modal
      locked
      onClose={clearRecovery}
      title={
        <span className="perm-title">
          <History size={18} /> Recover previous project state?
        </span>
      }
      footer={
        <>
          <button className="btn" onClick={() => void act(() => api.discardRecovery(), "Previous sessions discarded")} disabled={busy}>
            Discard sessions
          </button>
          <button className="btn primary" onClick={() => void act(() => api.recover(), "Resuming sessions")} disabled={busy}>
            Recover
          </button>
        </>
      }
    >
      <p>
        {n} {n === 1 ? "agent was" : "agents were"} running when {recovery.previousRun ?? "the app last closed"}. Recovering
        resumes their Claude Code sessions.
      </p>
      <ul className="plain-list">
        {recovery.agents.map((a) => {
          const task = a.taskId ? tasks?.find((t) => t.id === a.taskId) : undefined;
          return (
            <li key={a.agentId}>
              <strong>{a.name}</strong>
              {task && <span className="muted"> · {task.title}</span>}
              {!a.claudeSessionId && <span className="muted small"> (no session id — will start fresh)</span>}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

/** "MISSION X was interrupted. Restore? [Resume] [Inspect] [Abandon]" with the facts NEXUS recorded. */
function InterruptedMissionsDialog({ recovery, missions }: { recovery: RecoveryInfo; missions: InterruptedMission[] }) {
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState<string | null>(null);

  const resume = async (m: InterruptedMission) => {
    setBusy(true);
    const ok = await run(() => api.resumeInterruptedMission(m.missionId), `Resuming ${m.missionId}`);
    setBusy(false);
    if (!ok) return;
    // Resuming restarts the previous sessions (all of them) with a precise brief.
    const left = missions.filter((x) => x.missionId !== m.missionId);
    setRecovery(recovery.agents.length > 0 ? null : left.length > 0 ? { ...recovery, missions: left } : null);
    void refresh().catch(() => undefined);
  };

  const abandon = async (m: InterruptedMission) => {
    setBusy(true);
    const ok = await run(() => api.abandonInterruptedMission(m.missionId), `${m.missionId} abandoned`);
    setBusy(false);
    setConfirmAbandon(null);
    if (!ok) return;
    const left = missions.filter((x) => x.missionId !== m.missionId);
    setRecovery(left.length > 0 || recovery.agents.length > 0 ? { ...recovery, missions: left } : null);
    void refresh().catch(() => undefined);
  };

  return (
    <Modal
      locked
      width={680}
      onClose={() => undefined}
      title={
        <span className="perm-title">
          <TriangleAlert size={18} /> {missions.length === 1 ? `Mission ${missions[0].title} was interrupted` : `${missions.length} missions were interrupted`}
        </span>
      }
    >
      <p className="muted small rec-cause">{recovery.previousRun ?? missions[0].previousRun}. Restore?</p>
      {missions.map((m) => (
        <div key={m.missionId} className="rec-mission">
          <div className="rec-mission-head">
            <Chip tone="amber">{m.missionId}</Chip>
            <strong className="ellipsis">{m.title}</strong>
            <span className="muted small">{m.status}</span>
          </div>
          <dl className="kv rec-facts">
            <dt>Interrupted during</dt>
            <dd>{m.interruptedDuring}</dd>
            <dt>Last action</dt>
            <dd>
              {m.lastAction ? (
                <>
                  <strong>{m.lastAction.agentId}</strong> · {m.lastAction.description} <span className="muted small">({formatClock(m.lastAction.at)})</span>
                </>
              ) : (
                <span className="muted">No tool call recorded for this mission</span>
              )}
            </dd>
            <dt>Files</dt>
            <dd>{m.filesNote}</dd>
            <dt>Checkpoint</dt>
            <dd>
              {m.lastCheckpoint ? (
                <>
                  {m.lastCheckpoint.name} · {m.lastCheckpoint.reason} <span className="muted small">({formatDateTime(m.lastCheckpoint.at)})</span>
                </>
              ) : (
                <span className="muted">None recorded</span>
              )}
            </dd>
          </dl>
          {inspecting === m.missionId && <MissionInspection mission={m} />}
          <div className="rec-actions">
            {confirmAbandon === m.missionId ? (
              <>
                <span className="small">Cancel {m.missionId}? Files on disk are kept.</span>
                <button className="btn" onClick={() => setConfirmAbandon(null)} disabled={busy}>
                  Keep
                </button>
                <button className="btn danger" onClick={() => void abandon(m)} disabled={busy}>
                  Abandon mission
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={() => setConfirmAbandon(m.missionId)} disabled={busy}>
                  Abandon
                </button>
                <button className="btn" onClick={() => setInspecting(inspecting === m.missionId ? null : m.missionId)} disabled={busy} aria-expanded={inspecting === m.missionId}>
                  {inspecting === m.missionId ? "Hide details" : "Inspect"}
                </button>
                <button className="btn primary" onClick={() => void resume(m)} disabled={busy}>
                  Resume
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {recovery.agents.length > 0 && (
        <p className="muted small">
          Resuming restarts the Claude Code sessions of {recovery.agents.map((a) => a.name).join(", ")} with <code>--resume</code>; Central receives the facts above.
        </p>
      )}
    </Modal>
  );
}

function MissionInspection({ mission: m }: { mission: InterruptedMission }) {
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.missionCheckpoints(m.missionId).then(setCheckpoints, (e: unknown) => setError(String(e)));
  }, [m.missionId]);
  return (
    <div className="rec-inspect">
      <div className="section-label">Tasks in progress ({m.tasksInProgress.length})</div>
      {m.tasksInProgress.length === 0 ? (
        <div className="muted small">None.</div>
      ) : (
        <ul className="plain-list">
          {m.tasksInProgress.map((t) => (
            <li key={t.id}>
              <code>{t.id}</code> {t.title} <span className="muted small">· {t.status}{t.agent ? ` · ${t.agent}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="section-label">Agents</div>
      <ul className="plain-list">
        {m.agents.map((a) => (
          <li key={a.agentId}>
            <strong>{a.name}</strong> <span className="muted small">{a.status}</span>
            {a.lastAction && (
              <span className="small">
                {" "}
                · {a.lastAction.description} <span className="muted">({formatClock(a.lastAction.at)})</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="section-label">Files written since the last checkpoint ({m.filesSinceCheckpoint.length})</div>
      {m.filesSinceCheckpoint.length === 0 ? (
        <div className="muted small">None.</div>
      ) : (
        <ul className="plain-list rec-files">
          {m.filesSinceCheckpoint.map((f) => (
            <li key={f}>
              <code>{f}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="section-label">Checkpoints</div>
      {error ? (
        <div className="muted small">Unavailable: {error}</div>
      ) : !checkpoints ? (
        <div className="muted small">Loading…</div>
      ) : checkpoints.length === 0 ? (
        <div className="muted small">No checkpoint recorded.</div>
      ) : (
        <ul className="plain-list">
          {checkpoints.slice(0, 8).map((c) => (
            <li key={c.seq} className="small">
              <code>{c.name}</code> {c.reason} <span className="muted">· {formatDateTime(c.at)} · {c.files} file(s)</span>
            </li>
          ))}
        </ul>
      )}
      <div className="section-label">Brief given to Central on resume</div>
      <pre className="json rec-brief">{m.brief}</pre>
    </div>
  );
}
