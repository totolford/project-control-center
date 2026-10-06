// MCP supervision: per server, what Claude Code reports inside each agent session
// (mcp_status) and what NEXUS's own probes found. Claude Code owns the MCP processes of
// its sessions, so "Restart" asks that session to reconnect the server (mcp_reconnect).

import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, RotateCcw, ScrollText } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import type { Tone } from "../../lib/labels";
import type { Connection, McpHealth, McpProbeRecord, McpSupervision as Supervision } from "../../lib/types";
import { attempt } from "../../lib/toast";
import { useAgents, useConnections, useStore } from "../../store";
import { Spinner } from "../../components/Common";
import { Chip, StatusDot } from "../../components/StatusBadge";
import { isMcpConnection } from "./mcpModel";

const POLL_MS = 10_000;

/** A server as one card: Claude Code sessions that have it + the latest NEXUS probe. */
export interface ServerCard {
  key: string;
  name: string;
  connection: Connection | null;
  sessions: McpHealth[];
  probe: McpProbeRecord | null;
}

export type CardState = { label: string; tone: Tone; cause: string | null };

/** Groups session reports and probes by server name (case-insensitive), project connections first. */
export function serverCards(sup: Supervision, connections: Connection[]): ServerCard[] {
  const cards = new Map<string, ServerCard>();
  const card = (name: string): ServerCard => {
    const key = name.toLowerCase();
    let c = cards.get(key);
    if (!c) {
      c = { key, name, connection: null, sessions: [], probe: null };
      cards.set(key, c);
    }
    return c;
  };
  for (const c of connections.filter(isMcpConnection)) card(c.name).connection = c;
  for (const s of sup.sessions) card(s.server).sessions.push(s);
  for (const p of sup.probes) {
    const conn = connections.find((c) => c.id === p.connectionId);
    card(conn?.name ?? p.name).probe = p;
  }
  return [...cards.values()];
}

/** Overall state: live session reports win over probes; nothing reported is said plainly. */
export function cardState(c: ServerCard): CardState {
  const live = c.sessions.filter((s) => s.status !== "session ended");
  if (live.some((s) => s.reconnecting)) return { label: "Reconnecting", tone: "amber", cause: null };
  const failed = live.find((s) => s.status === "failed");
  if (failed) return { label: "MCP unavailable", tone: "red", cause: failed.cause ?? failed.error };
  if (live.some((s) => s.status === "connected")) return { label: "Connected", tone: "green", cause: null };
  if (live.length > 0) return { label: live[0].status, tone: "amber", cause: live[0].error };
  if (c.probe) return c.probe.ok ? { label: "Test passed", tone: "green", cause: null } : { label: "Test failed", tone: "red", cause: c.probe.error };
  return { label: "Not running in any session", tone: "grey", cause: null };
}

function latestResponse(c: ServerCard): string | null {
  const times = [...c.sessions.map((s) => s.lastResponseAt), c.probe?.ok ? c.probe.at : null].filter((x): x is string => Boolean(x));
  return times.sort().at(-1) ?? null;
}

function Card({ card, sessionChildren, agentName, onChanged }: { card: ServerCard; sessionChildren: Supervision["sessionChildren"]; agentName: (id: string) => string; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState(false);
  const st = cardState(card);
  const live = card.sessions.filter((s) => s.status !== "session ended");
  const tools = live.find((s) => s.tools !== null)?.tools ?? card.probe?.tools ?? null;
  const transport = live.find((s) => s.transport)?.transport ?? card.probe?.transport ?? (card.connection ? String((card.connection.config as Record<string, unknown>).transport ?? "stdio") : null);
  const restarts = card.sessions.reduce((n, s) => n + s.restarts.length, 0);
  const last = latestResponse(card);
  // Claude Code starts stdio servers as children of the session: the PIDs below are those children.
  const pids = live.flatMap((s) => sessionChildren.filter((c) => c.agentId === s.agentId && c.parentPid === s.sessionPid).map((c) => c.pid));

  const restart = async () => {
    setBusy("restart");
    await attempt(() => api.restartMcp(card.name), `Reconnect of ${card.name} requested`);
    setBusy(null);
    onChanged();
  };
  const test = async () => {
    if (!card.connection) return;
    setBusy("test");
    await attempt(() => api.probeConnection(card.connection!.id), `${card.name} answered`);
    setBusy(null);
    onChanged();
  };

  return (
    <div className={`sup-card tone-${st.tone}`}>
      <div className="sup-card-head">
        <span className="sup-card-name">{card.name}</span>
        <span className="sup-state">
          <StatusDot tone={st.tone} pulse={st.label === "Reconnecting"} /> {st.label}
        </span>
      </div>
      <div className="sup-meta small">
        {[
          pids.length ? `PID ${pids.join(", ")}` : null,
          transport,
          tools !== null ? `Tools ${tools}` : null,
          card.probe?.resources != null ? `Resources ${card.probe.resources}` : null,
          card.probe?.prompts != null ? `Prompts ${card.probe.prompts}` : null,
          last ? `Last response ${formatRelative(last)}` : "No response recorded",
          `Restarts ${restarts}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {st.cause && (
        <div className="sup-cause small">
          Cause: <strong>{st.cause}</strong>
        </div>
      )}
      {live.length > 0 && (
        <ul className="sup-sessions small">
          {live.map((s) => (
            <li key={s.agentId}>
              <span className="muted">{agentName(s.agentId)}</span> · {s.status}
              {s.tools !== null ? ` · ${s.tools} tools` : ""}
              {s.sessionPid ? <span className="muted"> · session PID {s.sessionPid}</span> : null}
              <span className="muted"> · checked {formatRelative(s.lastCheckedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="sup-actions">
        <button className="btn btn-sm" onClick={() => void restart()} disabled={busy !== null || live.length === 0} title={live.length === 0 ? "No running agent session has this server" : "Ask Claude Code to reconnect it (mcp_reconnect)"}>
          {busy === "restart" ? <Spinner size={12} /> : <RotateCcw size={12} />} Restart
        </button>
        <button className="btn btn-sm" onClick={() => setLogs(!logs)} aria-expanded={logs}>
          <ScrollText size={12} /> View logs
        </button>
        <button className="btn btn-sm" onClick={() => void test()} disabled={busy !== null || !card.connection} title={card.connection ? "Start the server from NEXUS and list its tools" : "Only NEXUS connections can be tested from here"}>
          {busy === "test" ? <Spinner size={12} /> : <Activity size={12} />} Test connection
        </button>
      </div>
      {logs && (
        <div className="sup-logs small">
          <div className="section-label">Restart history</div>
          {restarts === 0 ? (
            <div className="muted">No restart.</div>
          ) : (
            <ul className="plain-list">
              {card.sessions.flatMap((s) =>
                s.restarts.map((r, i) => (
                  <li key={`${s.agentId}-${i}`}>
                    <span className="muted">{formatRelative(r.at)}</span> · {agentName(s.agentId)} · {r.reason} → {r.outcome}
                  </li>
                )),
              )}
            </ul>
          )}
          {live.some((s) => s.error) && (
            <>
              <div className="section-label">Errors reported by Claude Code</div>
              <pre className="json">{live.filter((s) => s.error).map((s) => `${agentName(s.agentId)}: ${s.error}`).join("\n")}</pre>
            </>
          )}
          <div className="section-label">Last NEXUS test{card.probe ? ` (${formatRelative(card.probe.at)}, ${card.probe.probes} this session)` : ""}</div>
          {!card.probe ? (
            <div className="muted">Not tested since NEXUS started.</div>
          ) : (
            <>
              <div>
                {card.probe.ok
                  ? `${card.probe.serverName ?? card.name}${card.probe.serverVersion ? ` ${card.probe.serverVersion}` : ""} answered in ${card.probe.latencyMs} ms`
                  : `Failed: ${card.probe.error}`}
              </div>
              {card.probe.stderrTail.length > 0 ? <pre className="json">{card.probe.stderrTail.join("\n")}</pre> : <div className="muted">The server wrote nothing to stderr.</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Live health of every MCP server of the project. */
export function McpSupervisionPanel() {
  const connections = useConnections();
  const agents = useAgents();
  const hasProject = useStore((s) => s.project !== null);
  const [sup, setSup] = useState<Supervision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(() => {
    api.mcpSupervision().then(
      (s) => {
        setSup(s);
        setError(null);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  }, []);

  useEffect(() => {
    if (!hasProject) return;
    load();
    const t = window.setInterval(() => document.visibilityState !== "hidden" && load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [hasProject, load]);

  const askNow = async () => {
    setAsking(true);
    await attempt(() => api.refreshMcpStatus());
    // Claude Code answers asynchronously.
    window.setTimeout(() => {
      load();
      setAsking(false);
    }, 1500);
  };

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const cards = sup ? serverCards(sup, connections) : [];

  return (
    <div className="sup-panel">
      <div className="sup-panel-head">
        <div className="section-label">Supervision</div>
        <span className="muted small">
          Sessions report through Claude Code (<code>mcp_status</code>, every minute); tests are NEXUS's own handshakes.
        </span>
        <button className="btn btn-sm" onClick={() => void askNow()} disabled={asking || !sup}>
          {asking ? <Spinner size={12} /> : <RefreshCw size={12} />} Check now
        </button>
      </div>
      {error && (
        <div className="diag-unavailable">
          <Chip tone="grey">Unavailable</Chip> <span className="muted small">{error}</span>
        </div>
      )}
      {!sup && !error && <div className="muted small">Loading…</div>}
      {sup && cards.length === 0 && <div className="muted small">No MCP server in this project and none reported by a running agent session.</div>}
      <div className="sup-grid">
        {cards.map((c) => (
          <Card key={c.key} card={c} sessionChildren={sup?.sessionChildren ?? []} agentName={agentName} onChanged={load} />
        ))}
      </div>
    </div>
  );
}
