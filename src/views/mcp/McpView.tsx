import { useMemo, useState } from "react";
import { Info, Plug, Plus, RefreshCw } from "lucide-react";
import { formatClock } from "../../lib/format";
import { useConnections } from "../../store";
import { EmptyState, PageHeader, Spinner } from "../../components/Common";
import { asClaudeServer, isMcpConnection } from "./mcpModel";
import { useClaudeEnvironment } from "./useClaudeEnvironment";
import { McpList, selectionKey, type Selection } from "./McpList";
import { NexusServerDetail } from "./NexusServerDetail";
import { ClaudeServerDetail } from "./ClaudeServerDetail";
import { McpWizard } from "./McpWizard";
import type { ProbeRecord } from "./ProbeView";

export function McpView() {
  const connections = useConnections();
  const { env, loading, error, refresh } = useClaudeEnvironment();
  const [selected, setSelected] = useState<Selection | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeRecord>>({});
  const [adding, setAdding] = useState(false);

  const nexus = useMemo(() => connections.filter(isMcpConnection), [connections]);
  const claude = useMemo(() => (env ? env.mcpServers.map(asClaudeServer) : null), [env]);
  const unavailable = env?.unavailable.filter((u) => /mcp/i.test(u)) ?? [];

  const nexusCurrent = selected?.type === "nexus" ? nexus.find((c) => c.id === selected.id) : undefined;
  const claudeCurrent = selected?.type === "claude" ? claude?.find((s) => s.name === selected.name && String(s.scope) === selected.scope) : undefined;
  const key = selected ? selectionKey(selected) : "";
  const setProbe = (r: ProbeRecord) => setProbes((p) => ({ ...p, [key]: r }));

  return (
    <div className="page page-fill">
      <PageHeader
        title="MCP servers"
        subtitle={
          <>
            NEXUS agents run with <code>--strict-mcp-config</code>: they only get the NEXUS connections granted to them. Claude Code's own servers apply
            when you run <code>claude</code> yourself.
          </>
        }
        actions={
          <>
            {env && <span className="muted small">Claude Code read at {formatClock(env.capturedAt)}</span>}
            <button className="btn" onClick={() => void refresh()} disabled={loading} title="Ask Claude Code again (takes a few seconds)">
              {loading ? <Spinner size={12} /> : <RefreshCw size={14} />} Refresh
            </button>
            <button className="btn primary" onClick={() => setAdding(true)}>
              <Plus size={14} /> Add MCP server
            </button>
          </>
        }
      />
      <div className="split">
        <McpList
          nexus={nexus}
          claude={claude}
          claudeLoading={loading}
          claudeError={error}
          claudeUnavailable={unavailable}
          selected={selected}
          onSelect={setSelected}
        />
        <div className="split-main scroll">
          {nexusCurrent && (
            <NexusServerDetail key={key} conn={nexusCurrent} probe={probes[key] ?? null} onProbe={setProbe} />
          )}
          {claudeCurrent && (
            <ClaudeServerDetail
              key={key}
              server={claudeCurrent}
              probe={probes[key] ?? null}
              onProbe={setProbe}
              onChanged={() => void refresh()}
              onImported={(id) => setSelected({ type: "nexus", id })}
            />
          )}
          {!nexusCurrent && !claudeCurrent && (
            <EmptyState icon={<Plug size={22} />} title={selected ? "Server no longer listed" : "Select a server"}>
              <Info size={12} /> Pick a NEXUS connection to manage agent access, or a Claude Code server to test it, toggle it for this project or
              copy it into NEXUS.
            </EmptyState>
          )}
        </div>
      </div>
      {adding && (
        <McpWizard
          onClose={() => setAdding(false)}
          onSaved={({ connectionId, claudeName }) => {
            if (connectionId) setSelected({ type: "nexus", id: connectionId });
            if (claudeName) void refresh();
          }}
        />
      )}
    </div>
  );
}
