import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { formatCost, formatDateTime, formatDuration } from "../../lib/format";
import type { Agent, SessionRecord } from "../../lib/types";
import { Loading } from "../../components/Common";

export function AgentSessions({ agent }: { agent: Agent }) {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);

  // Reload when the agent's status changes (a session started or ended).
  useEffect(() => {
    let cancelled = false;
    void attempt(() => api.agentSessions(agent.id)).then((s) => !cancelled && setSessions(s ?? []));
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.status]);

  if (sessions === null) return <Loading />;
  if (sessions.length === 0) return <div className="muted pad">This agent has not run any session yet.</div>;
  const sorted = [...sessions].sort((a, b) => b.id - a.id);
  return (
    <div className="tab-body">
      <div className="panel table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>State</th>
              <th>Started</th>
              <th>Duration</th>
              <th>PID</th>
              <th>Exit</th>
              <th>Claude session</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.id}</td>
                <td>{s.state}</td>
                <td>{formatDateTime(s.startedAt)}</td>
                <td>{s.endedAt ? formatDuration(s.startedAt, s.endedAt) : "—"}</td>
                <td className="mono">{s.pid ?? "—"}</td>
                <td className="mono">{s.exitCode ?? "—"}</td>
                <td className="mono small" title={s.claudeSessionId ?? undefined}>
                  {s.claudeSessionId ? s.claudeSessionId.slice(0, 8) : "—"}
                </td>
                <td className="num">{formatCost(s.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
