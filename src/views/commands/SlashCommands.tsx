import { useMemo, useState } from "react";
import { Send } from "lucide-react";
import { api } from "../../lib/api";
import { isObj, str } from "../../lib/claudeEnv";
import { isLive } from "../../lib/labels";
import { run } from "../../lib/toast";
import type { ClaudeEnvironment } from "../../lib/types";
import { useAgents } from "../../store";
import { Modal } from "../../components/Modal";

interface Slash {
  name: string;
  description: string | null;
  argumentHint: string | null;
}

function RunInAgent({ cmd, onClose }: { cmd: Slash; onClose: () => void }) {
  const agents = useAgents().filter((a) => a.status !== "retired");
  const [agentId, setAgentId] = useState(agents.find((a) => isLive(a.status))?.id ?? agents[0]?.id ?? "");
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);
  const agent = agents.find((a) => a.id === agentId);
  const text = `/${cmd.name}${args.trim() ? ` ${args.trim()}` : ""}`;
  const send = async () => {
    setBusy(true);
    const ok = await run(() => api.sendMessage(agentId, text), `Sent ${text} to ${agent?.name ?? agentId}`);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title={`Run /${cmd.name} in an agent session`}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void send()} disabled={busy || !agentId}>
            <Send size={13} /> Send
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Agent</span>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.status})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Arguments</span>
        <input className="mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder={cmd.argumentHint ?? ""} />
      </label>
      {agent && !agent.profile.skillsEnabled && <div className="notice notice-warn small">This agent runs with skills & slash commands disabled.</div>}
      <div className="cli-preview mono small">{text}</div>
    </Modal>
  );
}

/** Slash commands and skills Claude Code reports, runnable in an agent's real session. */
export function SlashCommands({ env }: { env: ClaudeEnvironment | null }) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Slash | null>(null);
  const list = useMemo<Slash[]>(
    () =>
      (env?.commands ?? [])
        .filter(isObj)
        .map((c) => ({ name: str(c.name) ?? "", description: str(c.description), argumentHint: str(c.argumentHint) }))
        .filter((c) => c.name),
    [env],
  );
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q)) : list;
  if (!env) return <div className="muted">Unavailable until Claude Code answers (Refresh).</div>;
  if (list.length === 0) return <div className="muted">Unavailable — Claude Code reported no slash command or skill.</div>;
  return (
    <>
      <div className="filters">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter slash commands" />
        <span className="muted small">{shown.length} of {list.length}</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Command</th>
              <th>Description</th>
              <th>Arguments</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.name}>
                <td className="mono">/{c.name}</td>
                <td>{c.description ?? "—"}</td>
                <td className="mono small">{c.argumentHint ?? "—"}</td>
                <td>
                  <button className="btn btn-sm" onClick={() => setTarget(c)}>
                    Run in agent session
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {target && <RunInAgent cmd={target} onClose={() => setTarget(null)} />}
    </>
  );
}
