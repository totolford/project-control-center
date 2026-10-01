import { useEffect, useState } from "react";
import { Info, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { attempt, run } from "../../lib/toast";
import { CONNECTION_STATUS } from "../../lib/labels";
import { formatRelative } from "../../lib/format";
import type { Agent, PermissionSet } from "../../lib/types";
import { useConnections, useStore } from "../../store";
import { PermissionEditor } from "../../components/PermissionEditor";
import { Section, Spinner } from "../../components/Common";

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function AgentPermissions({ agent }: { agent: Agent }) {
  const connections = useConnections();
  const maxWorker = useStore((s) => s.project?.settings.maxWorkerPermissions);
  const upsertAgent = useStore((s) => s.upsertAgent);
  const [perms, setPerms] = useState<PermissionSet>(agent.permissions);
  const [granted, setGranted] = useState<string[]>(agent.connections);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState<string[] | null>(null);

  // Agent updates arrive often while it works; only reset the form when the saved values really change.
  const savedKey = JSON.stringify([agent.permissions, agent.connections]);
  useEffect(() => {
    setPerms(agent.permissions);
    setGranted(agent.connections);
  }, [savedKey]);

  useEffect(() => {
    let cancelled = false;
    void attempt(() => api.permissionRules(agent.id)).then((r) => !cancelled && setRules(r ?? []));
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const dirty = JSON.stringify(perms) !== JSON.stringify(agent.permissions) || !sameSet(granted, agent.connections);

  const save = async () => {
    setSaving(true);
    const updated = await attempt(() => api.updateAgent(agent.id, { permissions: perms, connections: granted }), "Permissions saved");
    setSaving(false);
    if (updated) upsertAgent(updated);
  };

  const removeRule = async (rule: string) => {
    if (await run(() => api.removePermissionRule(agent.id, rule))) setRules((r) => r?.filter((x) => x !== rule) ?? null);
  };

  return (
    <div className="tab-body">
      <div className="notice">
        <Info size={14} /> Changes apply at the agent's next session start (restart it to apply now).
      </div>
      <Section
        title="Capabilities"
        actions={
          <>
            <button className="btn" onClick={() => { setPerms(agent.permissions); setGranted(agent.connections); }} disabled={!dirty || saving}>
              Reset
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving && <Spinner size={12} />} Save
            </button>
          </>
        }
      >
        <PermissionEditor value={perms} onChange={setPerms} disabled={saving} ceiling={agent.kind === "worker" ? maxWorker : undefined} />
      </Section>

      <Section title="Granted MCP servers & connections">
        {connections.length === 0 ? (
          <div className="muted small">This project has no connections. Add them on the Connections page.</div>
        ) : (
          <div className="check-grid">
            {connections.map((c) => (
              <label key={c.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={granted.includes(c.id)}
                  onChange={(e) => setGranted((g) => (e.target.checked ? [...g, c.id] : g.filter((x) => x !== c.id)))}
                  disabled={saving}
                />
                {c.name} <span className="muted small">({c.kind})</span>
                <span className={`chip tone-${c.enabled ? CONNECTION_STATUS[c.status].tone : "dim"}`}>{c.enabled ? CONNECTION_STATUS[c.status].label : "Disabled"}</span>
                <span className="muted tiny">used {formatRelative(c.lastUsed)}</span>
              </label>
            ))}
          </div>
        )}
      </Section>

      <Section title="Saved “always allow” rules">
        {rules === null ? (
          <Spinner />
        ) : rules.length === 0 ? (
          <div className="muted small">No saved rules. Choosing “Allow for this agent” on a permission prompt adds one.</div>
        ) : (
          <ul className="rule-list">
            {rules.map((r) => (
              <li key={r}>
                <code>{r}</code>
                <button className="icon-btn" onClick={() => void removeRule(r)} aria-label={`Remove rule ${r}`} title="Remove rule">
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
