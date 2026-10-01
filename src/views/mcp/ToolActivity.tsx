import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { formatDateTime } from "../../lib/format";
import type { PccEvent } from "../../lib/types";
import { useAgents, useTimeline } from "../../store";
import { Spinner } from "../../components/Common";
import { toolEvents, toolPrefix } from "./mcpModel";

/** Recent calls of a NEXUS connection's tools by agents (ToolUsed events: history + live timeline). */
export function ToolActivity({ connectionId }: { connectionId: string }) {
  const timeline = useTimeline();
  const agents = useAgents();
  const [history, setHistory] = useState<PccEvent[] | null>(null);

  useEffect(() => {
    let alive = true;
    void attempt(() => api.events({ limit: 1000 })).then((e) => alive && setHistory(e ?? []));
    return () => {
      alive = false;
    };
  }, [connectionId]);

  const events = useMemo(() => toolEvents([...timeline, ...(history ?? [])], connectionId), [timeline, history, connectionId]);
  const name = (id: string | null) => agents.find((a) => a.id === id)?.name ?? id ?? "unknown agent";
  const prefix = toolPrefix(connectionId);

  if (history === null)
    return (
      <div className="muted small">
        <Spinner size={12} /> Loading tool calls…
      </div>
    );
  if (events.length === 0) return <div className="muted small">No agent has called these tools in the recent event history.</div>;
  return (
    <table className="table tools-table">
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td className="muted small tools-nowrap">{formatDateTime(e.ts)}</td>
            <td>{name(e.agentId)}</td>
            <td>
              <code>{String(e.payload.tool).slice(prefix.length)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
