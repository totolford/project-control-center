import { AlertTriangle } from "lucide-react";
import type { Connection } from "../../lib/types";
import { Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { asMcpConfig, claudeStatus, claudeTarget, groupByScope, nexusStatus, type ClaudeServer } from "./mcpModel";

export type Selection = { type: "nexus"; id: string } | { type: "claude"; name: string; scope: string };

export function selectionKey(s: Selection): string {
  return s.type === "nexus" ? `nexus:${s.id}` : `claude:${s.scope}:${s.name}`;
}

interface Props {
  nexus: Connection[];
  claude: ClaudeServer[] | null;
  claudeLoading: boolean;
  claudeError: string | null;
  claudeUnavailable: string[];
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}

export function McpList({ nexus, claude, claudeLoading, claudeError, claudeUnavailable, selected, onSelect }: Props) {
  const key = selected ? selectionKey(selected) : "";
  return (
    <div className="split-list tools-list">
      <div className="section-label">NEXUS (agents)</div>
      {nexus.length === 0 && <div className="muted small tools-pad">No MCP connection. Agents have no MCP server.</div>}
      {nexus.map((c) => {
        const st = nexusStatus(c);
        return (
          <button key={c.id} className={`list-item${key === `nexus:${c.id}` ? " active" : ""}`} onClick={() => onSelect({ type: "nexus", id: c.id })}>
            <span className="tools-item-main">
              <span className="ellipsis">{c.name}</span>
              <span className="muted small">{c.kind === "roblox_studio" ? "Roblox Studio" : asMcpConfig(c.config).transport}</span>
            </span>
            <Chip tone={st.tone}>{st.label}</Chip>
          </button>
        );
      })}

      <div className="section-label tools-gap">Claude Code configuration</div>
      {claudeLoading && !claude && (
        <div className="muted small tools-pad">
          <Spinner size={12} /> Asking Claude Code…
        </div>
      )}
      {claudeError && (
        <div className="small tone-red-fg tools-pad">
          <AlertTriangle size={12} /> Unavailable: {claudeError}
        </div>
      )}
      {claudeUnavailable.map((u) => (
        <div key={u} className="muted small tools-pad">
          Unavailable: {u}
        </div>
      ))}
      {claude && claude.length === 0 && <div className="muted small tools-pad">Claude Code reports no MCP server.</div>}
      {claude &&
        groupByScope(claude).map(({ group, servers }) => (
          <div key={group.key}>
            <div className="tools-scope" title={group.hint}>
              {group.label}
            </div>
            {servers.map((s) => {
              const st = claudeStatus(s.status);
              const k = `claude:${String(s.scope)}:${s.name}`;
              return (
                <button key={k} className={`list-item${key === k ? " active" : ""}`} onClick={() => onSelect({ type: "claude", name: s.name, scope: String(s.scope) })}>
                  <span className="tools-item-main">
                    <span className="ellipsis">{s.name}</span>
                    <span className="muted small">{claudeTarget(s.config).transport}</span>
                  </span>
                  <Chip tone={st.tone}>{st.label}</Chip>
                </button>
              );
            })}
          </div>
        ))}
    </div>
  );
}
