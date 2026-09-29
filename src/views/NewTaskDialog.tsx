import { useState } from "react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import { PRIORITIES } from "../lib/labels";
import type { Priority } from "../lib/types";
import { useAgents, useMissions, useStore, useTasks } from "../store";
import { Modal } from "../components/Modal";
import { Field } from "../components/Common";

export function NewTaskDialog({ onClose, missionId }: { onClose: () => void; missionId: string | null }) {
  const agents = useAgents();
  const missions = useMissions();
  const tasks = useTasks();
  const upsertTask = useStore((s) => s.upsertTask);
  const openTask = useStore((s) => s.openTask);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState("");
  const [mission, setMission] = useState(missionId ?? "");
  const [priority, setPriority] = useState<Priority>("normal");
  const [requiresReview, setRequiresReview] = useState(false);
  const [deps, setDeps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const candidates = tasks.filter((t) => !mission || t.missionId === mission);

  const create = async () => {
    setBusy(true);
    const task = await attempt(
      () =>
        api.createTask({
          title: title.trim(),
          description: description.trim() || undefined,
          agent: agent || null,
          dependencies: deps,
          priority,
          requiresReview,
          missionId: mission || null,
        }),
      "Task created",
    );
    setBusy(false);
    if (task) {
      upsertTask(task);
      onClose();
      openTask(task.id);
    }
  };

  return (
    <Modal
      title="New task"
      onClose={onClose}
      locked={busy}
      width={600}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={busy || !title.trim()}>
            Create task
          </button>
        </>
      }
    >
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="form-row">
        <Field label="Agent">
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Unassigned (Central decides)</option>
            {agents
              .filter((a) => a.status !== "retired")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Mission">
          <select value={mission} onChange={(e) => setMission(e.target.value)}>
            <option value="">None</option>
            {missions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={requiresReview} onChange={(e) => setRequiresReview(e.target.checked)} />
        Requires review before completion
      </label>
      {candidates.length > 0 && (
        <Field group label="Dependencies">
          <div className="dep-picker">
            {candidates.map((t) => (
              <label key={t.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={deps.includes(t.id)}
                  onChange={(e) => setDeps((d) => (e.target.checked ? [...d, t.id] : d.filter((x) => x !== t.id)))}
                />
                {t.title}
              </label>
            ))}
          </div>
        </Field>
      )}
    </Modal>
  );
}
