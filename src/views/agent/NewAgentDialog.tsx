import { useState } from "react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { AgentSpec } from "../../lib/types";
import { useStore } from "../../store";
import { useProviderName } from "../../workspace/hooks";
import { addPanelToActive } from "../../workspace/layout";
import { useWorkspace } from "../../workspace/store";
import { Modal } from "../../components/Modal";
import { Field } from "../../components/Common";
import { Segmented } from "../../components/Tabs";

type IsolationChoice = NonNullable<AgentSpec["isolation"]>;

const ISOLATION: { value: IsolationChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "shared", label: "Shared folder" },
  { value: "worktree", label: "Own worktree" },
];

export function NewAgentDialog({ onClose, provider }: { onClose: () => void; provider: string }) {
  const providerName = useProviderName(provider);
  const upsertAgent = useStore((s) => s.upsertAgent);
  const update = useWorkspace((s) => s.update);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [isolation, setIsolation] = useState<IsolationChoice>("auto");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const agent = await attempt(
      () =>
        api.createAgent({
          provider,
          name: name.trim(),
          role: role.trim(),
          instructions: instructions.trim() || undefined,
          isolation,
          model: model.trim() || null,
        }),
      "Agent created",
    );
    setBusy(false);
    if (agent) {
      upsertAgent(agent);
      onClose();
      update((ws) => addPanelToActive(ws, { type: "AgentTerminal", agentId: agent.id }));
    }
  };

  return (
    <Modal
      title={`New ${providerName} agent`}
      onClose={onClose}
      locked={busy}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim() || !role.trim()}>
            Create agent
          </button>
        </>
      }
    >
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Frontend" />
      </Field>
      <Field label="Role" hint="One line describing the agent's specialty.">
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. React UI engineer" />
      </Field>
      <Field label="Instructions" hint="Optional standing instructions added to the agent's system prompt.">
        <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      <Field group label="Isolation" hint="Auto lets the project settings decide (see Settings → Use worktrees).">
        <Segmented options={ISOLATION} value={isolation} onChange={setIsolation} label="Isolation" />
      </Field>
      <Field label="Model" hint="Optional. Leave empty to use the project's worker model.">
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" className="mono" />
      </Field>
      <p className="muted small">Permissions start from the project defaults; adjust them in the agent's Permissions tab.</p>
    </Modal>
  );
}
