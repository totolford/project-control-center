// One mission, from real data only: task tree (store), skills / MCP really
// invoked (logs, api.missionActivity), connections granted to its agents,
// recent events (api.events) and Central's result. Used by the Missions page
// (full) and the right panel (compact).

import { memo, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Ban, Play } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../../lib/api";
import { formatClock, formatCost, formatRelative } from "../../lib/format";
import { MISSION_STATUS } from "../../lib/labels";
import { run } from "../../lib/toast";
import type { Mission, MissionActivity, PccEvent, Priority } from "../../lib/types";
import { Chip } from "../../components/StatusBadge";
import { MissionProgress } from "../../components/ProgressBar";
import { useRightContext } from "../../state/context";
import { useAgents, useConnections, useMissions, useReadOnly, useStore, useTasks } from "../../store";
import {
  MARK_GLYPH,
  isClosed,
  isRunning,
  missionAgents,
  missionNumber,
  missionTree,
  progressPct,
  queuePosition,
  selectionStatus,
  type SelectionItem,
} from "./logic";
import "./missions.css";
import { UsageBlock } from "../usage/UsageBlock";
import { t } from "../../i18n";

const PRIORITIES: Priority[] = ["low", "normal", "high", "critical"];

/** Skills / MCP used by the mission's agents; re-read while it runs (tool calls do not update the mission). */
function useMissionActivity(m: Mission): { activity: MissionActivity | null; error: string | null } {
  const [activity, setActivity] = useState<MissionActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = isRunning(m);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.missionActivity(m.id).then(
        (a) => alive && (setActivity(a), setError(null)),
        (e) => alive && setError(errorMessage(e)),
      );
    void load();
    const timer = running ? window.setInterval(load, 10_000) : undefined;
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [m.id, m.updatedAt, m.taskDone, m.taskTotal, running]);
  return { activity, error };
}

function useMissionEvents(m: Mission, limit: number): PccEvent[] | null {
  const [events, setEvents] = useState<PccEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.events({ missionId: m.id, limit }).then(
      (v) => alive && setEvents(v),
      () => alive && setEvents([]),
    );
    return () => {
      alive = false;
    };
  }, [m.id, m.updatedAt, m.taskDone, m.taskTotal, limit]);
  return events;
}

function UseList({ items, empty }: { items: SelectionItem[]; empty: string }) {
  if (items.length === 0) return <span className="muted">{empty}</span>;
  return (
    <>
      {items.map((i) => {
        const ok = i.state === "used" || i.state === "granted";
        return (
          <span key={i.name} className="use-item" title={i.detail}>
            <span className={ok ? "tone-green-fg" : i.state === "missing" ? "tone-red-fg" : "muted"} aria-hidden="true">
              {ok ? "✓" : i.state === "missing" ? "!" : "○"}
            </span>
            <span className="mono">{i.name}</span>
            <span className="sr-only">{i.detail}</span>
          </span>
        );
      })}
    </>
  );
}

export const MissionDetail = memo(function MissionDetail({ mission: m, compact = false }: { mission: Mission; compact?: boolean }) {
  const tasks = useTasks();
  const agents = useAgents();
  const connections = useConnections();
  const missions = useMissions();
  const readOnly = useReadOnly();
  const openTask = useStore((s) => s.openTask);
  const openContext = useRightContext((s) => s.openContext);
  const { activity, error: activityError } = useMissionActivity(m);
  const events = useMissionEvents(m, compact ? 6 : 15);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => missionTree(m.id, tasks, agents), [m.id, tasks, agents]);
  const involved = useMemo(() => missionAgents(rows, agents), [rows, agents]);
  const sel = useMemo(() => selectionStatus(m, activity, agents, connections), [m, activity, agents, connections]);
  const meta = MISSION_STATUS[m.status];
  const pct = progressPct(m);
  const position = queuePosition(m, missions);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    await run(fn, done);
    setBusy(false);
  };
  const cancel = async () => {
    const text =
      m.status === "queued"
        ? `Cancel "${m.title}"? It was never sent to Central.`
        : `Cancel "${m.title}"? Central stops pursuing it and its open tasks are cancelled; committed work stays in the repository.`;
    if (await ask(text, { title: "Cancel mission", kind: "warning" })) await act(() => api.cancelMission(m.id), "Mission cancelled");
  };

  // Usage by other skills: Central plus every agent with a task in the mission.
  const usedOutside = activity
    ? [...activity.skillsUsed.filter((u) => !m.skills.some((k) => k === u.name || k.split(":").pop() === u.name.split(":").pop()))]
    : [];

  return (
    <div className="mission-detail">
      <div className="mission-detail-head">
        <span className="mission-num">MISSION {missionNumber(m.id)}</span>
        <h2 className="grow">{m.title}</h2>
        {pct !== null && <span className="mission-pct">{pct}%</span>}
      </div>
      <div className="row">
        <Chip tone={meta.tone}>{meta.label}</Chip>
        {position !== null && <span className="muted small">position {position} in the queue</span>}
        <span className="muted small">priority {m.priority}</span>
        {m.model && <span className="muted small">· model {m.model}</span>}
        <span className="muted small">
          · created {formatRelative(m.createdAt)}
          {m.startedAt && ` · started ${formatRelative(m.startedAt)}`}
          {m.completedAt && ` · finished ${formatRelative(m.completedAt)}`}
        </span>
      </div>
      <MissionProgress mission={m} />

      {!readOnly && (
        <div className="mission-actions">
          {m.status === "queued" && (
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void act(() => api.startMission(m.id), "Mission sent to Central")}
              title="Send it to Central now, alongside the running mission"
            >
              <Play size={12} /> Start now
            </button>
          )}
          {!isClosed(m) && (
            <label className="row small muted">
              Priority
              <select
                value={m.priority}
                disabled={busy}
                onChange={(e) => void act(() => api.setMissionPriority(m.id, e.target.value as Priority), "Priority updated")}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!isClosed(m) && (
            <button className="btn btn-sm danger-ghost" disabled={busy} onClick={() => void cancel()}>
              <Ban size={12} /> Cancel
            </button>
          )}
          {isClosed(m) && (
            <button
              className="btn btn-sm ghost"
              disabled={busy}
              onClick={() => void act(() => api.archiveMission(m.id, !m.archivedAt), m.archivedAt ? "Mission restored" : "Mission archived")}
            >
              {m.archivedAt ? <ArchiveRestore size={12} /> : <Archive size={12} />} {m.archivedAt ? "Restore" : "Archive"}
            </button>
          )}
        </div>
      )}

      {!compact && (
        <>
          <div className="section-label">Objective</div>
          <div className="mission-objective prewrap">{m.prompt}</div>
        </>
      )}

      <div className="section-label">Agents and tasks</div>
      {m.status === "queued" ? (
        <div className="muted small">Waiting in the queue: Central has not received this mission yet.</div>
      ) : (
        <ul className="mission-tree" aria-label="Tasks of the mission">
          <li className="mission-tree-root">
            <button className="link-btn strong" onClick={() => openContext({ kind: "central" })}>
              Central Agent
            </button>
            {rows.length === 0 && <span className="muted small">{isRunning(m) ? "planning, no task yet" : "no task"}</span>}
          </li>
          {rows.map((r, i) => (
            <li key={r.task.id}>
              <button className="mission-tree-row" onClick={() => openTask(r.task.id)} title={`${r.task.id} · ${r.task.status}`}>
                <span className="mission-tree-branch" aria-hidden="true">
                  {i === rows.length - 1 ? "└" : "├"}
                </span>
                <span className="grow ellipsis">{r.task.title}</span>
                {!compact && r.agentName && <span className="muted small ellipsis">{r.agentName}</span>}
                {r.waitingFor.length > 0 && r.mark === "waiting" && !compact && (
                  <span className="muted tiny">after {r.waitingFor.join(", ")}</span>
                )}
                <span className={`mission-tree-mark mark-${r.mark}`} aria-label={r.task.status}>
                  {MARK_GLYPH[r.mark]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {involved.length > 0 && (
        <div className="row small">
          <span className="muted">Agents:</span>
          {involved.map((a) => (
            <button key={a.id} className="link-btn" onClick={() => openContext({ kind: "agent", agentId: a.id })}>
              {a.name}
            </button>
          ))}
          {!compact && (
            <span className="muted">· {formatCost(involved.reduce((s, a) => s + a.totalCostUsd, 0))} total for these agents (all their work, not only this mission)</span>
          )}
        </div>
      )}

      <div className="section-label">Skills · MCP · Connections</div>
      <dl className="mission-uses">
        <dt>Skills</dt>
        <dd>
          <UseList items={sel.skills} empty="none selected" />
          {usedOutside.length > 0 && (
            <span className="muted small">also invoked: {usedOutside.map((u) => `${u.name} (${u.count}×)`).join(", ")}</span>
          )}
        </dd>
        <dt>MCP</dt>
        <dd>
          <UseList items={sel.mcp} empty="none selected" />
          {activity && activity.mcpUsed.filter((u) => !m.mcp.includes(u.name)).length > 0 && (
            <span className="muted small">
              also used: {activity.mcpUsed.filter((u) => !m.mcp.includes(u.name)).map((u) => `${u.name} (${u.count}×)`).join(", ")}
            </span>
          )}
        </dd>
        <dt>Connections</dt>
        <dd>
          <UseList items={sel.connections} empty="none selected" />
        </dd>
      </dl>
      <div className="muted tiny">
        ✓ = really invoked (read from the agents' logs) or granted · ○ = not yet
        {activityError && ` · usage unavailable: ${activityError}`}
      </div>

      {m.summary && (
        <>
          <div className="section-label">Result</div>
          <div className="prewrap summary">{m.summary}</div>
        </>
      )}

      <div className="section-label">{t("usage.block.title")}</div>
      <UsageBlock missionId={m.id} />

      <div className="section-label">Recent activity</div>
      {events === null ? (
        <div className="muted small">Loading…</div>
      ) : events.length === 0 ? (
        <div className="muted small">No event recorded for this mission yet.</div>
      ) : (
        <ul className="mission-log">
          {events.map((e) => (
            <li key={e.id}>
              <time dateTime={e.ts}>{formatClock(e.ts)}</time>
              <span className="grow">{e.summary}</span>
            </li>
          ))}
        </ul>
      )}

      {!compact && m.analysis && (
        <details>
          <summary className="section-label">
            Pre-mission estimate by {m.analysis.analyzedWith}
          </summary>
          <div className="small muted">{m.analysis.summary}</div>
          {m.analysis.steps.length > 0 && <ol className="small">{m.analysis.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
        </details>
      )}
    </div>
  );
});
