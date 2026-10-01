import { useEffect } from "react";
import { isObj, str } from "../../lib/claudeEnv";
import { isLive } from "../../lib/labels";
import { formatRelative } from "../../lib/format";
import type { ClaudeEnvironment } from "../../lib/types";
import { usePty } from "../../terminal/ptyStore";
import { useAgents, useStore } from "../../store";
import { JsonView, Section } from "../../components/Common";
import { StatusBadge } from "../../components/StatusBadge";

function primitive(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Primitive fields as a key/value list, nested ones as collapsible JSON. Nothing is added. */
export function Fields({ value, empty }: { value: unknown; empty: string }) {
  if (!isObj(value) || Object.keys(value).length === 0) return <div className="muted small">{empty}</div>;
  const entries = Object.entries(value);
  const flat = entries.filter(([, v]) => primitive(v) !== null);
  const nested = entries.filter(([, v]) => v !== null && typeof v === "object");
  return (
    <>
      <dl className="kv">
        {flat.map(([k, v]) => (
          <div key={k} className="kv-pair">
            <dt>{k}</dt>
            <dd className="mono small">{primitive(v)}</dd>
          </div>
        ))}
      </dl>
      {nested.map(([k, v]) => (
        <JsonView key={k} value={v} collapsible label={k} />
      ))}
    </>
  );
}

export function SessionSection({ env }: { env: ClaudeEnvironment }) {
  const fast = env.fastMode;
  return (
    <Section title="Session defaults">
      <dl className="kv">
        <dt>Permission mode</dt>
        <dd className="mono">{env.permissionMode ?? "—"}</dd>
        <dt>Output style</dt>
        <dd className="mono">
          {env.outputStyle ?? "—"} <span className="muted small">({env.outputStyles.length} available)</span>
        </dd>
        <dt>Fast mode</dt>
        <dd className="mono">
          {primitive(fast.state) ?? "—"}
          {primitive(fast.disabledReason) && <span className="muted small"> · {primitive(fast.disabledReason)}</span>}
        </dd>
      </dl>
    </Section>
  );
}

export function ProcessesSection() {
  const agents = useAgents().filter((a) => isLive(a.status));
  const sessions = usePty((s) => s.sessions);
  const refresh = usePty((s) => s.refresh);
  const openAgent = useStore((s) => s.openAgent);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <Section title="Claude processes managed by NEXUS">
      <div className="section-label">Agent sessions ({agents.length})</div>
      {agents.length === 0 ? (
        <div className="muted small">No agent session running.</div>
      ) : (
        <ul className="plain-list">
          {agents.map((a) => (
            <li key={a.id} className="row">
              <button className="link-btn" onClick={() => openAgent(a.id)}>
                {a.name}
              </button>
              <StatusBadge status={a.status} />
              <span className="mono tiny muted">{a.claudeSessionId ?? "no session id yet"}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="section-label">Raw Terminal sessions ({sessions.length})</div>
      {sessions.length === 0 ? (
        <div className="muted small">None.</div>
      ) : (
        <ul className="plain-list">
          {sessions.map((s) => (
            <li key={s.id} className="row">
              <span>{s.title}</span>
              <span className="mono tiny">pid {s.pid ?? "—"}</span>
              <span className="muted tiny">{s.running ? `started ${formatRelative(s.startedAt)}` : `exited (${s.exitCode ?? "?"})`}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function InventorySection({ env }: { env: ClaudeEnvironment }) {
  const navigate = useStore((s) => s.navigate);
  const byStatus = new Map<string, number>();
  for (const s of env.mcpServers) {
    const k = str(s.status) ?? "unknown";
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  const pluginsOn = env.plugins.filter((p) => p.enabled === true).length;
  return (
    <Section title="MCP, skills, plugins, sub-agents">
      <dl className="kv">
        <dt>MCP servers</dt>
        <dd>
          <button className="link-btn" onClick={() => navigate({ name: "mcp" })}>
            {env.mcpServers.length} configured
          </button>
          {[...byStatus].map(([k, n]) => (
            <span key={k} className="muted small"> · {n} {k}</span>
          ))}
        </dd>
        <dt>Slash commands & skills</dt>
        <dd>
          <button className="link-btn" onClick={() => navigate({ name: "skills" })}>
            {env.commands.length}
          </button>
        </dd>
        <dt>Plugins</dt>
        <dd>
          {env.plugins.length} installed · {pluginsOn} enabled
        </dd>
        <dt>Sub-agents</dt>
        <dd>{env.agents.length === 0 ? "none" : env.agents.map((a) => str(a.name) ?? "?").join(", ")}</dd>
      </dl>
    </Section>
  );
}
