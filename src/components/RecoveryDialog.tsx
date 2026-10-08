import { useEffect, useRef, useState } from "react";
import { History, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { formatClock, formatDateTime } from "../lib/format";
import { run } from "../lib/toast";
import type { CheckpointSummary, InterruptedMission, RecoveryInfo } from "../lib/types";
import { useStore } from "../store";
import { Modal } from "./Modal";
import { AutoResumeNotice } from "./AutoResumeNotice";
import { Chip } from "./StatusBadge";
import { rich, t, useT } from "../i18n";

/** With settings.autoRecover, resumes the previous sessions without asking. Returns true while it handles them. */
function useAutoRecover(): boolean {
  const pending = useStore((s) => Boolean(s.project?.recovery?.agents.length));
  const auto = useStore((s) => s.project?.settings.autoRecover ?? false);
  const started = useRef(false);
  useEffect(() => {
    if (!pending || !auto || started.current) return;
    started.current = true;
    void run(() => api.recover(), t("comp.rec.autoResumed")).then(() => {
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
  // Auto-resume (Settings → Missions → Recovery): what NEXUS already resumed is a notice, not a blocker.
  const notice = recovery.autoResumed ? <AutoResumeNotice notice={recovery.autoResumed} recovery={recovery} /> : null;
  if (missions.length > 0)
    return (
      <>
        {notice}
        <InterruptedMissionsDialog recovery={recovery} missions={missions} />
      </>
    );
  if (recovery.agents.length === 0 || automatic) return notice;
  return (
    <>
      {notice}
      <SessionsDialog recovery={recovery} />
    </>
  );
}

function SessionsDialog({ recovery }: { recovery: RecoveryInfo }) {
  const t = useT();
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
          <History size={18} /> {t("comp.rec.title")}
        </span>
      }
      footer={
        <>
          <button className="btn" onClick={() => void act(() => api.discardRecovery(), t("comp.rec.discarded"))} disabled={busy}>
            {t("comp.rec.discard")}
          </button>
          <button className="btn primary" onClick={() => void act(() => api.recover(), t("comp.rec.resuming"))} disabled={busy}>
            {t("comp.rec.recover")}
          </button>
        </>
      }
    >
      <p>{t("comp.rec.agentsRunning", { count: n, when: recovery.previousRun ?? t("comp.rec.lastClosed") })}</p>
      <ul className="plain-list">
        {recovery.agents.map((a) => {
          const task = a.taskId ? tasks?.find((x) => x.id === a.taskId) : undefined;
          return (
            <li key={a.agentId}>
              <strong>{a.name}</strong>
              {task && <span className="muted"> · {task.title}</span>}
              {!a.claudeSessionId && <span className="muted small"> {t("comp.rec.noSession")}</span>}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

/** "MISSION X was interrupted. Restore? [Resume] [Inspect] [Abandon]" with the facts NEXUS recorded. */
function InterruptedMissionsDialog({ recovery, missions }: { recovery: RecoveryInfo; missions: InterruptedMission[] }) {
  const t = useT();
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState<string | null>(null);

  const resume = async (m: InterruptedMission) => {
    setBusy(true);
    const ok = await run(() => api.resumeInterruptedMission(m.missionId), t("comp.rec.resumingMission", { id: m.missionId }));
    setBusy(false);
    if (!ok) return;
    // Resuming restarts the previous sessions (all of them) with a precise brief.
    const left = missions.filter((x) => x.missionId !== m.missionId);
    setRecovery(recovery.agents.length > 0 ? null : left.length > 0 ? { ...recovery, missions: left } : null);
    void refresh().catch(() => undefined);
  };

  const abandon = async (m: InterruptedMission) => {
    setBusy(true);
    const ok = await run(() => api.abandonInterruptedMission(m.missionId), t("comp.rec.abandoned", { id: m.missionId }));
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
          <TriangleAlert size={18} /> {missions.length === 1 ? t("comp.rec.missionInterrupted", { title: missions[0].title }) : t("comp.rec.missionsInterrupted", { count: missions.length })}
        </span>
      }
    >
      <p className="muted small rec-cause">{t("comp.rec.restore", { cause: recovery.previousRun ?? missions[0].previousRun })}</p>
      {missions.map((m) => (
        <div key={m.missionId} className="rec-mission">
          <div className="rec-mission-head">
            <Chip tone="amber">{m.missionId}</Chip>
            <strong className="ellipsis">{m.title}</strong>
            <span className="muted small">{m.status}</span>
          </div>
          <dl className="kv rec-facts">
            <dt>{t("comp.rec.during")}</dt>
            <dd>{m.interruptedDuring}</dd>
            <dt>{t("comp.rec.lastAction")}</dt>
            <dd>
              {m.lastAction ? (
                <>
                  <strong>{m.lastAction.agentId}</strong> · {m.lastAction.description} <span className="muted small">({formatClock(m.lastAction.at)})</span>
                </>
              ) : (
                <span className="muted">{t("comp.rec.noToolCall")}</span>
              )}
            </dd>
            <dt>{t("comp.rec.files")}</dt>
            <dd>{m.filesNote}</dd>
            <dt>{t("comp.rec.checkpoint")}</dt>
            <dd>
              {m.lastCheckpoint ? (
                <>
                  {m.lastCheckpoint.name} · {m.lastCheckpoint.reason} <span className="muted small">({formatDateTime(m.lastCheckpoint.at)})</span>
                </>
              ) : (
                <span className="muted">{t("comp.rec.noneRecorded")}</span>
              )}
            </dd>
          </dl>
          {inspecting === m.missionId && <MissionInspection mission={m} />}
          <div className="rec-actions">
            {confirmAbandon === m.missionId ? (
              <>
                <span className="small">{t("comp.rec.confirmAbandon", { id: m.missionId })}</span>
                <button className="btn" onClick={() => setConfirmAbandon(null)} disabled={busy}>
                  {t("comp.rec.keep")}
                </button>
                <button className="btn danger" onClick={() => void abandon(m)} disabled={busy}>
                  {t("comp.rec.abandonMission")}
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={() => setConfirmAbandon(m.missionId)} disabled={busy}>
                  {t("comp.rec.abandon")}
                </button>
                <button className="btn" onClick={() => setInspecting(inspecting === m.missionId ? null : m.missionId)} disabled={busy} aria-expanded={inspecting === m.missionId}>
                  {inspecting === m.missionId ? t("comp.hideDetails") : t("comp.rec.inspect")}
                </button>
                <button className="btn primary" onClick={() => void resume(m)} disabled={busy}>
                  {t("comp.rec.resume")}
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {recovery.agents.length > 0 && (
        <p className="muted small">
          {rich(t("comp.rec.resumeNote", { names: recovery.agents.map((a) => a.name).join(", ") }), { flag: <code>--resume</code> })}
        </p>
      )}
    </Modal>
  );
}

function MissionInspection({ mission: m }: { mission: InterruptedMission }) {
  const t = useT();
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.missionCheckpoints(m.missionId).then(setCheckpoints, (e: unknown) => setError(String(e)));
  }, [m.missionId]);
  return (
    <div className="rec-inspect">
      <div className="section-label">{t("comp.rec.tasksInProgress", { count: m.tasksInProgress.length })}</div>
      {m.tasksInProgress.length === 0 ? (
        <div className="muted small">{t("comp.rec.noneDot")}</div>
      ) : (
        <ul className="plain-list">
          {m.tasksInProgress.map((task) => (
            <li key={task.id}>
              <code>{task.id}</code> {task.title} <span className="muted small">· {task.status}{task.agent ? ` · ${task.agent}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="section-label">{t("comp.rec.agents")}</div>
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
      <div className="section-label">{t("comp.rec.filesSince", { count: m.filesSinceCheckpoint.length })}</div>
      {m.filesSinceCheckpoint.length === 0 ? (
        <div className="muted small">{t("comp.rec.noneDot")}</div>
      ) : (
        <ul className="plain-list rec-files">
          {m.filesSinceCheckpoint.map((f) => (
            <li key={f}>
              <code>{f}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="section-label">{t("comp.rec.checkpoints")}</div>
      {error ? (
        <div className="muted small">{t("comp.rec.unavailable", { error })}</div>
      ) : !checkpoints ? (
        <div className="muted small">{t("common.loading")}</div>
      ) : checkpoints.length === 0 ? (
        <div className="muted small">{t("comp.rec.noCheckpoint")}</div>
      ) : (
        <ul className="plain-list">
          {checkpoints.slice(0, 8).map((c) => (
            <li key={c.seq} className="small">
              <code>{c.name}</code> {c.reason} <span className="muted">· {formatDateTime(c.at)} · {t("comp.rec.fileCount", { count: c.files })}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="section-label">{t("comp.rec.brief")}</div>
      <pre className="json rec-brief">{m.brief}</pre>
    </div>
  );
}
