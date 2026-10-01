import { memo, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Box, Cable, ChevronDown, ChevronRight, Gamepad2, GitBranch, GitMerge, GitPullRequest, Globe, HardDrive, Pencil, Plug, RefreshCw, Server, SquareTerminal, Trash2, Users, Zap } from "lucide-react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { formatRelative } from "../../lib/format";
import type { Connection, ConnectionKind } from "../../lib/types";
import { useAgents, useStore } from "../../store";
import { Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { AgentGrants } from "../mcp/AgentGrants";
import { EnableToggle } from "../mcp/EnableToggle";
import { agentsUsing, nexusStatus } from "../mcp/mcpModel";
import { KIND_LABEL, agentCapabilities, authSummary, describeTarget } from "./connectionModel";

const KIND_ICON: Record<ConnectionKind, LucideIcon> = {
  local: HardDrive,
  git: GitBranch,
  github: GitPullRequest,
  gitlab: GitMerge,
  ssh: Server,
  sftp: Server,
  terminal: SquareTerminal,
  http: Globe,
  mcp: Plug,
  roblox_studio: Gamepad2,
  docker: Box,
};

interface Props {
  conn: Connection;
  onEdit: (c: Connection) => void;
  onDelete: (c: Connection) => void;
}

export const ConnectionCard = memo(function ConnectionCard({ conn, onEdit, onDelete }: Props) {
  const upsertConnection = useStore((s) => s.upsertConnection);
  const agents = useAgents();
  const [testing, setTesting] = useState(false);
  const [reached, setReached] = useState<string[] | null>(null);
  const [secretKeys, setSecretKeys] = useState<string[] | null>(null);
  const [showAgents, setShowAgents] = useState(false);
  const Icon = KIND_ICON[conn.kind] ?? Cable;
  const st = nexusStatus(conn);
  const granted = agentsUsing(conn, agents);
  const mcp = conn.kind === "mcp" || conn.kind === "roblox_studio";
  const editable = conn.kind !== "local" && conn.kind !== "git";

  useEffect(() => {
    if (!conn.credentialRef) return;
    let alive = true;
    void attempt(() => api.connectionSecretKeys(conn.id)).then((k) => alive && setSecretKeys(k ?? null));
    return () => {
      alive = false;
    };
  }, [conn.id, conn.credentialRef]);

  const test = async () => {
    setTesting(true);
    const updated = await attempt(() => api.checkConnection(conn.id));
    setTesting(false);
    if (updated) upsertConnection(updated);
  };

  const reconnect = async () => {
    setTesting(true);
    const ids = await attempt(() => api.reconnectMcp(conn.id));
    setTesting(false);
    if (ids) setReached(ids.map((id) => agents.find((a) => a.id === id)?.name ?? id));
  };

  return (
    <div className="tools-conn">
      <div className="conn-row">
        <div className="conn-icon">
          <Icon size={18} />
        </div>
        <div className="grow conn-main">
          <div className="row">
            <strong>{conn.name}</strong>
            <span className="muted small">{KIND_LABEL[conn.kind] ?? conn.kind}</span>
            <Chip tone={st.tone}>{st.label}</Chip>
          </div>
          {describeTarget(conn) && <div className="mono small muted conn-desc">{describeTarget(conn)}</div>}
        </div>
        <button className="btn" onClick={() => void test()} disabled={testing}>
          {testing ? <Spinner size={12} /> : <Zap size={13} />} Test
        </button>
        <EnableToggle conn={conn} />
        {mcp && (
          <button className="btn" onClick={() => void reconnect()} disabled={testing} title="Ask running agent sessions to reconnect this MCP server">
            <RefreshCw size={13} /> Reconnect
          </button>
        )}
        {editable && (
          <button className="icon-btn" onClick={() => onEdit(conn)} aria-label={`Edit ${conn.name}`} title="Edit">
            <Pencil size={14} />
          </button>
        )}
        <button className="icon-btn" onClick={() => onDelete(conn)} aria-label={`Delete ${conn.name}`} title="Delete">
          <Trash2 size={14} />
        </button>
      </div>
      <dl className="kv kv-inline tools-conn-kv">
        <dt>Health</dt>
        <dd>
          {conn.statusDetail ? <span className={conn.status === "error" ? "tone-red-fg" : conn.status === "disconnected" ? "tone-orange-fg" : ""}>{conn.statusDetail}</span> : "Not checked"}
          <span className="muted small"> · checked {formatRelative(conn.lastChecked)}</span>
        </dd>
        <dt>Authentication</dt>
        <dd>{authSummary(conn, secretKeys)}</dd>
        <dt>Agents can</dt>
        <dd>{agentCapabilities(conn)}</dd>
        <dt>Last used</dt>
        <dd>{conn.lastUsed ? formatRelative(conn.lastUsed) : "never"}</dd>
        <dt>Projects</dt>
        <dd>This project (connections are stored per project)</dd>
        <dt>Enabled</dt>
        <dd>{conn.enabled ? "yes" : "no: never given to agents"}</dd>
      </dl>
      {reached && (
        <div className="small muted tools-pad">
          {reached.length ? `Reconnect requested in: ${reached.join(", ")}` : "No running agent session to reconnect."}
        </div>
      )}
      <button className="link-btn small tools-pad" onClick={() => setShowAgents((v) => !v)} aria-expanded={showAgents}>
        {showAgents ? <ChevronDown size={13} /> : <ChevronRight size={13} />} <Users size={12} /> Agents allowed:{" "}
        {granted.length ? granted.map((a) => a.name).join(", ") : "none"}
      </button>
      {showAgents && (
        <div className="tools-conn-agents">
          <AgentGrants connectionId={conn.id} />
        </div>
      )}
    </div>
  );
});
