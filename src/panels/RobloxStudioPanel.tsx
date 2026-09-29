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

function toolName(text: string): string {
  return parseToolUse(text).name;
}

/** Recent tool calls an agent made through this connection's MCP server (`mcp__<connectionId>__*`). */
const AgentStudioCalls = memo(function AgentStudioCalls({ agent, connectionId }: { agent: Agent; connectionId: string }) {
  const keep = useCallback((e: LogEntry) => e.kind === "tool_use" && mcpServerOf(toolName(e.text)) === connectionId, [connectionId]);
  const calls = useFilteredLogs(agent.id, keep, 8, 500);
  return (
    <div className="studio-agent">
      <div className="small strong">{agent.name}</div>
      {calls.length === 0 ? (
        <div className="muted small">No Studio tool calls in recent logs.</div>
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
  const connections = useConnections();
  const agents = useAgents();
  const openDialog = useUi((s) => s.openDialog);
  const conn = spec.connectionId
    ? connections.find((c) => c.id === spec.connectionId)
    : connections.find((c) => c.kind === "roblox_studio");

  if (!conn) {
    return (
      <div className="empty">
        <div className="empty-title">Roblox Studio · Not configured</div>
        <div className="empty-body">Add a Roblox Studio connection (its MCP server) so agents can work in Studio.</div>
        <button className="btn btn-sm" onClick={() => openDialog({ type: "addConnection" })}>
          <Plus size={12} /> Add connection
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
        <span>Live Studio preview is unavailable (not exposed by the Studio MCP server).</span>
      </div>
      <div className="section-label">Recent Studio tool calls</div>
      {granted.length === 0 ? (
        <div className="muted small">Grant this connection to an agent to let it use Studio.</div>
      ) : (
        granted.map((a) => <AgentStudioCalls key={a.id} agent={a} connectionId={conn.id} />)
      )}
    </div>
  );
});
