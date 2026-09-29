import { useState } from "react";
import { History } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { useStore } from "../store";
import { Modal } from "./Modal";

/** Offered once after opening a project whose sessions were running when the app last closed. */
export function RecoveryDialog() {
  const recovery = useStore((s) => s.project?.recovery);
  const tasks = useStore((s) => s.project?.tasks);
  const clearRecovery = useStore((s) => s.clearRecovery);
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  if (!recovery || recovery.agents.length === 0) return null;

  const act = async (fn: () => Promise<void>, text: string) => {
    setBusy(true);
    const ok = await run(fn, text);
    setBusy(false);
    if (ok) {
      clearRecovery();
      void refresh().catch(() => undefined);
    }
  };

  const n = recovery.agents.length;
  return (
    <Modal
      locked
      onClose={clearRecovery}
      title={
        <span className="perm-title">
          <History size={18} /> Recover previous project state?
        </span>
      }
      footer={
        <>
          <button className="btn" onClick={() => void act(() => api.discardRecovery(), "Previous sessions discarded")} disabled={busy}>
            Discard sessions
          </button>
          <button className="btn primary" onClick={() => void act(() => api.recover(), "Resuming sessions")} disabled={busy}>
            Recover
          </button>
        </>
      }
    >
      <p>
        {n} {n === 1 ? "agent was" : "agents were"} running when the app last closed. Recovering resumes their Claude Code sessions.
      </p>
      <ul className="plain-list">
        {recovery.agents.map((a) => {
          const task = a.taskId ? tasks?.find((t) => t.id === a.taskId) : undefined;
          return (
            <li key={a.agentId}>
              <strong>{a.name}</strong>
              {task && <span className="muted"> · {task.title}</span>}
              {!a.claudeSessionId && <span className="muted small"> (no session id — will start fresh)</span>}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
