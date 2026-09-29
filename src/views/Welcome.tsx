import { useEffect, useState } from "react";
import logo from "../assets/icon.svg";
import { FolderOpen, FolderPlus, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import { formatRelative } from "../lib/format";
import type { ProjectSnapshot, RecentProject } from "../lib/types";
import { ClaudeStatus, useClaudeInfo } from "../components/ClaudeStatus";
import { Spinner } from "../components/Common";

export function Welcome({
  onFolder,
  onOpened,
}: {
  onFolder: (path: string) => Promise<void>;
  onOpened: (snap: ProjectSnapshot) => void;
}) {
  const claude = useClaudeInfo();
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void attempt(() => api.recentProjects()).then((r) => setRecent(r ?? []));
  }, []);

  const choose = async (title: string) => {
    const picked = await attempt(() => open({ directory: true, multiple: false, title }));
    if (typeof picked !== "string") return;
    setBusy(picked);
    await run(() => onFolder(picked));
    setBusy(null);
  };

  const openRecent = async (p: RecentProject) => {
    setBusy(p.root);
    const snap = await attempt(() => api.openProject(p.root));
    setBusy(null);
    if (snap) onOpened(snap);
  };

  const forget = async (root: string) => {
    const r = await attempt(() => api.forgetRecent(root));
    if (r) setRecent(r);
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <img className="welcome-logo" src={logo} alt="" aria-hidden="true" />
          <h1>PROJECT CONTROL CENTER</h1>
          <p className="muted">Orchestrate a team of Claude Code agents on your project.</p>
        </div>

        <ClaudeStatus info={claude.info} loading={claude.loading} onRecheck={() => void claude.reload()} />

        <div className="welcome-actions">
          <button className="big-btn" onClick={() => void choose("Choose a folder for the new project")} disabled={busy !== null}>
            <FolderPlus size={22} />
            <span>
              <strong>Create project</strong>
              <span className="muted">Pick a folder — existing code or empty</span>
            </span>
          </button>
          <button className="big-btn" onClick={() => void choose("Open an existing project")} disabled={busy !== null}>
            <FolderOpen size={22} />
            <span>
              <strong>Open existing project</strong>
              <span className="muted">A folder containing .agent-project/</span>
            </span>
          </button>
        </div>

        <div className="recent">
          <div className="section-label">Recent projects</div>
          {recent === null && (
            <div className="muted small">
              <Spinner /> Loading…
            </div>
          )}
          {recent?.length === 0 && <div className="muted small">No recent projects.</div>}
          {recent?.map((p) => (
            <div key={p.root} className={`recent-row${p.available ? "" : " unavailable"}`}>
              <button
                className="recent-open"
                disabled={!p.available || busy !== null}
                onClick={() => void openRecent(p)}
                title={p.available ? p.root : `${p.root} (folder not found)`}
              >
                <span className="recent-name">
                  {p.name}
                  {busy === p.root && <Spinner size={12} />}
                </span>
                <span className="recent-path mono">{p.root}</span>
              </button>
              <span className="muted small">{p.available ? formatRelative(p.lastOpened) : "unavailable"}</span>
              <button className="icon-btn" onClick={() => void forget(p.root)} aria-label={`Forget ${p.name}`} title="Remove from list">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
