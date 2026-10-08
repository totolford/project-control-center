import { memo } from "react";
import { formatClock } from "../lib/format";
import { MessageList } from "../components/MessageList";
import { useRecentActions } from "../workspace/hooks";
import type { PanelBodyProps } from "../workspace/registry";
import { useAgent, useStore, useTask } from "../store";
import { useT } from "../i18n";

/** Compact view of one agent: what it does now, its last actions and messages. */
export const AgentActivityPanel = memo(function AgentActivityPanel({ spec }: PanelBodyProps) {
  const t = useT();
  const agent = useAgent(spec.agentId);
  const task = useTask(agent?.currentTask);
  const openTask = useStore((s) => s.openTask);
  const actions = useRecentActions(spec.agentId, 5);
  if (!agent) return <div className="muted pad">{t("panel.agentGone")}</div>;
  return (
    <div className="panel-scroll pad-sm">
      <div className="kv-mini">
        <span className="muted">{t("panel.now")}</span>
        <span className="mono">{agent.currentAction ?? t("panel.idle")}</span>
        <span className="muted">{t("panel.task")}</span>
        {task ? (
          <button className="link-btn" onClick={() => openTask(task.id)}>
            {task.title}
          </button>
        ) : (
          <span className="muted">{t("panel.none")}</span>
        )}
      </div>
      <div className="section-label">{t("panel.lastActions")}</div>
      {actions.length === 0 ? (
        <div className="muted small">{t("panel.noToolCalls")}</div>
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
      <div className="section-label">{t("panel.messages")}</div>
      <MessageList agentId={agent.id} limit={10} compact />
    </div>
  );
});
