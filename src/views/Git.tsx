import { useCallback, useEffect, useState } from "react";
import { Camera, GitBranch, RefreshCw, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { attempt, run, toast } from "../lib/toast";
import { formatDateTime, formatRelative } from "../lib/format";
import type { GitOverview, Snapshot } from "../lib/types";
import { useStore } from "../store";
import { EmptyState, Field, Loading, PageHeader, Section, Spinner } from "../components/Common";
import { Modal } from "../components/Modal";
import { AgentBranchCard } from "./git/AgentBranchCard";

function SnapshotsSection({ snapshots, onChanged }: { snapshots: Snapshot[]; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [restoring, setRestoring] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const ok = await run(() => api.createSnapshot(label.trim()), "Snapshot created");
    setBusy(false);
    if (ok) {
      setCreating(false);
      setLabel("");
      onChanged();
    }
  };

  const restore = async () => {
    if (!restoring) return;
    setBusy(true);
    const undo = await attempt(() => api.restoreSnapshot(restoring.branch));
    setBusy(false);
    setRestoring(null);
    if (undo) {
      toast.success(`Snapshot restored. Undo point: ${undo.branch}`);
      onChanged();
      useStore.getState().refresh().catch(() => undefined);
    }
  };

  const sorted = [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <Section
      title="Snapshots"
      actions={
        <button className="btn" onClick={() => setCreating(true)}>
          <Camera size={13} /> Create snapshot
        </button>
      }
    >
      {sorted.length === 0 ? (
        <div className="muted small">No snapshots yet. One is taken automatically before every merge.</div>
      ) : (
        <ul className="snapshot-list">
          {sorted.map((s) => (
            <li key={s.branch}>
              <div className="grow">
                <strong>{s.label || "snapshot"}</strong> <code className="small">{s.commit.slice(0, 8)}</code>
                <div className="muted small mono">{s.branch}</div>
              </div>
              <span className="muted small" title={formatDateTime(s.createdAt)}>
                {formatRelative(s.createdAt)}
              </span>
              <button className="btn" onClick={() => setRestoring(s)}>
                <Undo2 size={13} /> Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <Modal
          title="Create snapshot"
          onClose={() => setCreating(false)}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void create()} disabled={busy || !label.trim()}>
                {busy && <Spinner size={12} />} Create
              </button>
            </>
          }
        >
          <Field label="Label" hint="Saves the current commit as a restore point branch.">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="before refactor" />
          </Field>
        </Modal>
      )}
      {restoring && (
        <Modal
          title="Restore snapshot?"
          onClose={() => setRestoring(null)}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={() => setRestoring(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void restore()} disabled={busy}>
                {busy && <Spinner size={12} />} Restore
              </button>
            </>
          }
        >
          <p>
            The current branch will be moved back to <code>{restoring.commit.slice(0, 8)}</code> ({restoring.label || restoring.branch}) using{" "}
            <code>git reset --keep</code>. Uncommitted changes that conflict with the reset make it fail instead of being lost.
          </p>
          <p className="muted">An undo snapshot of the current state is created automatically first, so this can be reverted.</p>
        </Modal>
      )}
    </Section>
  );
}

export function Git() {
  const gitVersion = useStore((s) => s.project?.gitVersion ?? 0);
  const [overview, setOverview] = useState<GitOverview | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [initing, setIniting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await attempt(() => api.gitOverview());
    setLoading(false);
    if (result !== undefined) setOverview(result);
    else setOverview((cur) => (cur === undefined ? null : cur));
  }, []);

  useEffect(() => {
    void load();
  }, [load, gitVersion]);

  const init = async () => {
    setIniting(true);
    const ok = await run(() => api.gitInit(), "Git repository initialized");
    setIniting(false);
    if (ok) {
      void load();
      useStore.getState().refresh().catch(() => undefined);
    }
  };

  if (overview === undefined) return <Loading />;
  if (overview === null || !overview.status.isRepo) {
    return (
      <div className="page">
        <PageHeader title="Git" />
        <EmptyState icon={<GitBranch size={22} />} title="Not a git repository">
          <p>Agents work in isolated worktrees and branches when the project is a git repository.</p>
          <button className="btn primary" onClick={() => void init()} disabled={initing}>
            {initing && <Spinner size={12} />} Initialize git repository
          </button>
        </EmptyState>
      </div>
    );
  }

  const st = overview.status;
  const base = st.branch ?? "HEAD";
  return (
    <div className="page">
      <PageHeader
        title="Git"
        subtitle={st.remoteUrl ?? "no remote"}
        actions={
          <button className="btn ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            {loading ? <Spinner size={12} /> : <RefreshCw size={13} />}
          </button>
        }
      />
      <div className="stat-row">
        <div className="stat">
          <span className="stat-value stat-small">
            <GitBranch size={15} /> {st.branch ?? "detached"}
          </span>
          <span className="stat-label">{st.head ? `HEAD ${st.head.slice(0, 8)}` : st.hasCommits ? "" : "no commits yet"}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{st.dirtyFiles.length}</span>
          <span className="stat-label">uncommitted files</span>
        </div>
        {st.ahead != null && (
          <div className="stat">
            <span className="stat-value stat-small">
              ↑{st.ahead} ↓{st.behind ?? 0}
            </span>
            <span className="stat-label">vs upstream</span>
          </div>
        )}
      </div>

      {st.dirtyFiles.length > 0 && (
        <Section title="Uncommitted changes">
          <ul className="file-list mono small">
            {st.dirtyFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Agent branches (${overview.agents.length})`}>
        {overview.agents.length === 0 ? (
          <div className="muted small">No agent works in its own worktree yet.</div>
        ) : (
          overview.agents.map((a) => <AgentBranchCard key={a.agentId} entry={a} baseBranch={base} onChanged={() => void load()} />)
        )}
      </Section>

      <Section title="Recent commits">
        {overview.recentCommits.length === 0 ? (
          <div className="muted small">No commits yet.</div>
        ) : (
          <ul className="commit-list">
            {overview.recentCommits.map((c) => (
              <li key={c.hash}>
                <code>{c.short}</code>
                <span className="grow">{c.subject}</span>
                <span className="muted small">{c.author}</span>
                <span className="muted small" title={formatDateTime(c.date)}>
                  {formatRelative(c.date)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <SnapshotsSection snapshots={overview.snapshots} onChanged={() => void load()} />
    </div>
  );
}
