import { useState } from "react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { Connection } from "../../lib/types";
import { useStore } from "../../store";
import { Modal } from "../../components/Modal";
import { Field, Spinner } from "../../components/Common";
import { Segmented } from "../../components/Tabs";
import { McpWizard } from "../mcp/McpWizard";
import { EMPTY_FORM, FORM_KINDS, KIND_LABEL, buildInput, formFromConnection, type ConnForm, type FormKind } from "./connectionModel";
import { KindForm } from "./KindForms";

type DialogKind = FormKind | "mcp" | "roblox_studio";

const KIND_OPTIONS: { value: DialogKind; label: string }[] = [...FORM_KINDS, "mcp" as const, "roblox_studio" as const].map((k) => ({
  value: k,
  label: KIND_LABEL[k],
}));

/** Add a connection, or edit one (MCP / Roblox Studio use the MCP wizard). */
export function AddConnectionDialog({ onClose, editing }: { onClose: () => void; editing?: Connection }) {
  const upsertConnection = useStore((s) => s.upsertConnection);
  const [kind, setKind] = useState<DialogKind>(() => (editing ? (editing.kind as DialogKind) : "ssh"));
  const [form, setForm] = useState<ConnForm>(() => (editing ? formFromConnection(editing) : EMPTY_FORM));
  const [busy, setBusy] = useState(false);

  if (kind === "mcp" || kind === "roblox_studio") return <McpWizard onClose={onClose} editing={editing} initialKind={kind} />;

  const input = buildInput(kind, form);
  const problem = typeof input === "string" ? input : null;
  const set = (patch: Partial<ConnForm>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    if (typeof input === "string") return;
    setBusy(true);
    const saved = await attempt(
      () => (editing ? api.updateConnection(editing.id, input) : api.addConnection(input)),
      editing ? "Connection updated" : "Connection added",
    );
    setBusy(false);
    if (saved) {
      upsertConnection(saved);
      onClose();
    }
  };

  return (
    <Modal
      title={editing ? `Edit ${editing.name}` : "Add connection"}
      onClose={onClose}
      locked={busy}
      width={640}
      footer={
        <>
          {problem && form.name && <span className="small tone-amber-fg grow">{problem}</span>}
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || problem !== null}>
            {busy && <Spinner size={12} />} {editing ? "Save" : "Add connection"}
          </button>
        </>
      }
    >
      {!editing && (
        <Field group label="Type" hint="Local folder and Git connections are created automatically from the project.">
          <Segmented options={KIND_OPTIONS} value={kind} onChange={setKind} label="Connection type" />
        </Field>
      )}
      <Field label="Name">
        <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. staging-server" />
      </Field>
      <KindForm kind={kind} form={form} set={set} hasStoredToken={Boolean(editing?.credentialRef)} />
      {editing && <p className="muted small">Saving resets the health status until the next test.</p>}
    </Modal>
  );
}
