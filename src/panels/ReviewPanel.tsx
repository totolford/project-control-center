import { memo, useState } from "react";
import { CircleCheck, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import type { Agent, Task } from "../lib/types";
import { useAgents, useStore, useTasks } from "../store";
import type { PanelBodyProps } from "../workspace/registry";

const ReviewItem = memo(function ReviewItem({ task, agent }: { task: Task; agent: Agent | undefined }) {
  const upsertTask = useStore((s) => s.upsertTask);
  const openTask = useStore((s) => s.openTask);
  const [note, setNote] = useState("");
  const [changes, setChanges] = useState(false);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    const t = await attempt(() => api.updateTask(task.id, { status: "completed" }), "Task approved");
    setBusy(false);
    if (t) upsertTask(t);
  };

  /** Sends the requested changes to the agent (if assigned) and puts the task back in the queue. */
  const requestChanges = async () => {
    setBusy(true);
    const ok = await run(async () => {
      if (task.agent && note.trim()) await api.sendMessage(task.agent, `Changes requested on task "${task.title}":\n${note.trim()}`);
      upsertTask(await api.updateTask(task.id, { status: "queued" }));
    }, "Changes requested");
    setBusy(false);
    if (ok) {
      setNote("");
      setChanges(false);
    }
  };

  return (
    <div className="review-item">
      <div className="row">
        <button className="link-btn strong grow ellipsis" onClick={() => openTask(task.id)}>
          {task.title}
        </button>
        <span className="muted small">{agent?.name ?? "unassigned"}</span>
      </div>
      {task.result && <div className="prewrap small review-summary">{task.result.summary}</div>}
      {task.result && task.result.filesChanged.length > 0 && <div className="muted small">{task.result.filesChanged.length} files changed</div>}
      {changes ? (
        <div className="review-changes">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? (sent to the agent)" />
          <div className="row-end">
            <button className="btn btn-sm" onClick={() => setChanges(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-sm primary" onClick={() => void requestChanges()} disabled={busy}>
              Send back
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn btn-sm primary" onClick={() => void approve()} disabled={busy}>
            <CircleCheck size={12} /> Approve
          </button>
          <button className="btn btn-sm" onClick={() => setChanges(true)} disabled={busy}>
            <Undo2 size={12} /> Request changes
          </button>
        </div>
      )}
    </div>
  );
});

export const ReviewPanel = memo(function ReviewPanel(_: PanelBodyProps) {
  const tasks = useTasks();
  const agents = useAgents();
  const review = tasks.filter((t) => t.status === "review");
  if (review.length === 0) return <div className="muted pad">Nothing to review.</div>;
  return (
    <div className="panel-scroll pad-sm">
      {review.map((t) => (
        <ReviewItem key={t.id} task={t} agent={agents.find((a) => a.id === t.agent)} />
      ))}
    </div>
  );
});
