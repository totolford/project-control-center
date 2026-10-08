import { memo, useCallback } from "react";
import { MonitorOff, Plus } from "lucide-react";
import { formatClock } from "../lib/format";
import { mcpServerOf, parseToolUse } from "../lib/toolText";
import type { Agent, LogEntry } from "../lib/types";
import { useFilteredLogs } from "../workspace/hooks";
import type { PanelBodyProps } from "../workspace/registry";
import { useUi } from "../state/ui";
import { useAgents, useConnections } from "../store";
import { ConnectionStatusBlock } from "./ConnectionPanel";
import { useT } from "../i18n";

function toolName(text: string): string {
  return parseToolUse(text).name;
}

/** Recent tool calls an agent made through this connection's MCP server (`mcp__<connectionId>__*`). */
const AgentStudioCalls = memo(function AgentStudioCalls({ agent, connectionId }: { agent: Agent; connectionId: string }) {
  const keep = useCallback((e: LogEntry) => e.kind === "tool_use" && mcpServerOf(toolName(e.text)) === connectionId, [connectionId]);
  const t = useT();
  const calls = useFilteredLogs(agent.id, keep, 8, 500);
  return (
    <div className="studio-agent">
      <div className="small strong">{agent.name}</div>
      {calls.length === 0 ? (
        <div className="muted small">{t("panel.studio.noCalls")}</div>
      ) : (
        <ul className="action-list">
          {[...calls].reverse().map((c) => {
            const call = parseToolUse(c.text);
            return (
              <li key={c.id} title={c.text}>
                <span className="muted mono">{formatClock(c.ts)}</span>
                <span className="mono">{call.name.split("__").pop()}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

export const RobloxStudioPanel = memo(function RobloxStudioPanel({ spec }: PanelBodyProps) {
  const t = useT();
  const connections = useConnections();
  const agents = useAgents();
  const openDialog = useUi((s) => s.openDialog);
  const conn = spec.connectionId
    ? connections.find((c) => c.id === spec.connectionId)
    : connections.find((c) => c.kind === "roblox_studio");

  if (!conn) {
    return (
      <div className="empty">
        <div className="empty-title">{t("panel.studio.notConfigured")}</div>
        <div className="empty-body">{t("panel.studio.addHint")}</div>
        <button className="btn btn-sm" onClick={() => openDialog({ type: "addConnection" })}>
          <Plus size={12} /> {t("panel.addConnection")}
        </button>
      </div>
    );
  }
  const granted = agents.filter((a) => a.connections.includes(conn.id));
  return (
    <div className="panel-scroll pad-sm">
      <ConnectionStatusBlock conn={conn} />
      <div className="studio-preview">
        <MonitorOff size={18} />
        <span>{t("panel.studio.noPreview")}</span>
      </div>
      <div className="section-label">{t("panel.studio.recent")}</div>
      {granted.length === 0 ? (
        <div className="muted small">{t("panel.studio.grant")}</div>
      ) : (
        granted.map((a) => <AgentStudioCalls key={a.id} agent={a} connectionId={conn.id} />)
      )}
    </div>
  );
});
