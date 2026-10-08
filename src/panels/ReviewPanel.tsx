import { memo, useState } from "react";
import { CircleCheck, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import type { Agent, Task } from "../lib/types";
import { useAgents, useStore, useTasks } from "../store";
import type { PanelBodyProps } from "../workspace/registry";
import { useT } from "../i18n";

const ReviewItem = memo(function ReviewItem({ task, agent }: { task: Task; agent: Agent | undefined }) {
  const t = useT();
  const upsertTask = useStore((s) => s.upsertTask);
  const openTask = useStore((s) => s.openTask);
  const [note, setNote] = useState("");
  const [changes, setChanges] = useState(false);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    const updated = await attempt(() => api.updateTask(task.id, { status: "completed" }), t("panel.taskApproved"));
    setBusy(false);
    if (updated) upsertTask(updated);
  };

  /** Sends the requested changes to the agent (if assigned) and puts the task back in the queue. */
  const requestChanges = async () => {
    setBusy(true);
    const ok = await run(async () => {
      if (task.agent && note.trim()) await api.sendMessage(task.agent, `Changes requested on task "${task.title}":\n${note.trim()}`);
      upsertTask(await api.updateTask(task.id, { status: "queued" }));
    }, t("panel.changesRequested"));
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
        <span className="muted small">{agent?.name ?? t("panel.unassigned")}</span>
      </div>
      {task.result && <div className="prewrap small review-summary">{task.result.summary}</div>}
      {task.result && task.result.filesChanged.length > 0 && <div className="muted small">{t("panel.filesChanged", { count: task.result.filesChanged.length })}</div>}
      {changes ? (
        <div className="review-changes">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("panel.whatChange")} />
          <div className="row-end">
            <button className="btn btn-sm" onClick={() => setChanges(false)} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-sm primary" onClick={() => void requestChanges()} disabled={busy}>
              {t("panel.sendBack")}
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn btn-sm primary" onClick={() => void approve()} disabled={busy}>
            <CircleCheck size={12} /> {t("panel.approve")}
          </button>
          <button className="btn btn-sm" onClick={() => setChanges(true)} disabled={busy}>
            <Undo2 size={12} /> {t("panel.requestChanges")}
          </button>
        </div>
      )}
    </div>
  );
});

export const ReviewPanel = memo(function ReviewPanel(_: PanelBodyProps) {
  const t = useT();
  const tasks = useTasks();
  const agents = useAgents();
  const review = tasks.filter((x) => x.status === "review");
  if (review.length === 0) return <div className="muted pad">{t("panel.nothingToReview")}</div>;
  return (
    <div className="panel-scroll pad-sm">
      {review.map((x) => (
        <ReviewItem key={x.id} task={x} agent={agents.find((a) => a.id === x.agent)} />
      ))}
    </div>
  );
});
