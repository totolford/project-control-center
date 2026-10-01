import { useEffect, useState } from "react";
import { Brain, FolderOpen, Save } from "lucide-react";
import { api } from "../../lib/api";
import { run } from "../../lib/toast";
import type { Agent } from "../../lib/types";
import { patchAgent } from "../../state/actions";
import { useStore } from "../../store";
import { Field, Section, Spinner } from "../../components/Common";

/** Role and system instructions (editable) plus the agent's workspace (read-only). */
export function AgentIdentity({ agent }: { agent: Agent }) {
  const openAgent = useStore((s) => s.openAgent);
  const [role, setRole] = useState(agent.role);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [saving, setSaving] = useState(false);
  const savedKey = `${agent.id}\u0000${agent.role}\u0000${agent.instructions}`;
  useEffect(() => {
    setRole(agent.role);
    setInstructions(agent.instructions);
  }, [savedKey]);
  const dirty = role !== agent.role || instructions !== agent.instructions;

  const save = async () => {
    setSaving(true);
    await patchAgent(agent.id, { role, instructions }, "Role and instructions saved");
    setSaving(false);
  };

  return (
    <>
      <Section
        title="Role & instructions"
        actions={
          <button className="btn primary btn-sm" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Spinner size={11} /> : <Save size={12} />} Save
          </button>
        }
      >
        <Field label="Role">
          <input value={role} onChange={(e) => setRole(e.target.value)} disabled={saving} />
        </Field>
        <Field label="System instructions" hint="Added to the agent's system prompt at its next session start.">
          <textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={saving} />
        </Field>
      </Section>
      <Section title="Workspace">
        <dl className="kv">
          <dt>Working directory</dt>
          <dd>
            <button className="link-btn mono" onClick={() => void run(() => api.openPath(agent.workdir))} title="Open folder">
              <FolderOpen size={11} /> {agent.workdir}
            </button>
          </dd>
          <dt>Isolation</dt>
          <dd>{agent.isolation}</dd>
          <dt>Branch</dt>
          <dd className="mono">{agent.branch ?? "—"}</dd>
          <dt>Claude session</dt>
          <dd className="mono small">{agent.claudeSessionId ?? "—"}</dd>
          <dt>Memory</dt>
          <dd>
            <button className="link-btn" onClick={() => openAgent(agent.id)}>
              <Brain size={11} /> Agent memory, terminal and sessions
            </button>
          </dd>
        </dl>
      </Section>
    </>
  );
}
