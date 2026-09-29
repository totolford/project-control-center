import { useState } from "react";
import { FolderOpen, GitBranch, OctagonX, ShieldAlert, X } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { isLive } from "../lib/labels";
import { useAgents, usePendingPermissions, useStore } from "../store";
import { Modal } from "../components/Modal";

export function TopBar() {
  const info = useStore((s) => s.project?.info);
  const repo = useStore((s) => s.project?.repo);
  const closeProject = useStore((s) => s.closeProject);
  const agents = useAgents();
  const pending = usePendingPermissions().length;
  const liveCount = agents.filter((a) => isLive(a.status)).length;
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = async () => {
    setBusy(true);
    const ok = await run(() => api.closeProject());
    setBusy(false);
    if (ok) closeProject();
  };

  if (!info) return null;
  return (
    <header className="topbar">
      <div className="topbar-project">
        <span className="topbar-name">{info.name}</span>
        <button className="topbar-path mono" onClick={() => void run(() => api.openPath(info.root))} title="Open folder">
          <FolderOpen size={12} /> {info.root}
        </button>
        {repo?.isRepo && repo.branch && (
          <span className="chip tone-grey" title="Current branch">
            <GitBranch size={11} /> {repo.branch}
            {repo.dirtyFiles.length > 0 && <span className="muted"> · {repo.dirtyFiles.length} changed</span>}
          </span>
        )}
      </div>
      <div className="topbar-actions">
        {pending > 0 && (
          <span className="chip tone-amber" title="Pending permission requests">
            <ShieldAlert size={11} /> {pending} pending
          </span>
        )}
        <span className="muted small">{liveCount} running</span>
        <button
          className="btn danger-ghost"
          onClick={() => void run(() => api.stopAll(), "Stop requested for all agents")}
          disabled={liveCount === 0}
          title="Stop every running agent session"
        >
          <OctagonX size={14} /> Stop all agents
        </button>
        <button className="btn ghost" onClick={() => (liveCount > 0 ? setConfirmClose(true) : void close())} disabled={busy}>
          <X size={14} /> Close project
        </button>
      </div>
      {confirmClose && (
        <Modal
          title="Close project?"
          onClose={() => setConfirmClose(false)}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmClose(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void close()} disabled={busy}>
                Close project
              </button>
            </>
          }
        >
          <p>
            {liveCount} {liveCount === 1 ? "agent is" : "agents are"} still running. Closing the project stops their sessions; they can be
            recovered next time you open it.
          </p>
        </Modal>
      )}
    </header>
  );
}
