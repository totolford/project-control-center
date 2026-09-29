import { memo } from "react";
import { formatClock } from "../lib/format";
import { MessageList } from "../components/MessageList";
import { useRecentActions } from "../workspace/hooks";
import type { PanelBodyProps } from "../workspace/registry";
import { useAgent, useStore, useTask } from "../store";

/** Compact view of one agent: what it does now, its last actions and messages. */
export const AgentActivityPanel = memo(function AgentActivityPanel({ spec }: PanelBodyProps) {
  const agent = useAgent(spec.agentId);
  const task = useTask(agent?.currentTask);
  const openTask = useStore((s) => s.openTask);
  const actions = useRecentActions(spec.agentId, 5);
  if (!agent) return <div className="muted pad">This agent no longer exists.</div>;
  return (
    <div className="panel-scroll pad-sm">
      <div className="kv-mini">
        <span className="muted">Now</span>
        <span className="mono">{agent.currentAction ?? "idle"}</span>
        <span className="muted">Task</span>
        {task ? (
          <button className="link-btn" onClick={() => openTask(task.id)}>
            {task.title}
          </button>
        ) : (
          <span className="muted">none</span>
        )}
      </div>
      <div className="section-label">Last actions</div>
      {actions.length === 0 ? (
        <div className="muted small">No tool calls yet.</div>
      ) : (
        <ul className="action-list">
          {actions.map((a) => (
            <li key={a.id}>
              <span className="muted mono">{formatClock(a.ts)}</span>
              <span className="mono">{a.action}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="section-label">Messages</div>
      <MessageList agentId={agent.id} limit={10} compact />
    </div>
  );
});
