import { useState } from "react";
import { ExternalLink, GitCommitHorizontal, GitMerge, GitPullRequest, TriangleAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../lib/api";
import { attempt, run, toast } from "../../lib/toast";
import type { GitOverview, MergeOutcome } from "../../lib/types";
import { useAgent } from "../../store";
import { Modal } from "../../components/Modal";
import { Field, Spinner } from "../../components/Common";

type AgentBranch = GitOverview["agents"][number];
type Dialog = "commit" | "merge" | "pr" | null;

export function AgentBranchCard({ entry, baseBranch, onChanged }: { entry: AgentBranch; baseBranch: string; onChanged: () => void }) {
  const agent = useAgent(entry.agentId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const diff = entry.diff;
  const name = agent?.name ?? entry.agentId;

  const close = () => {
    setDialog(null);
    setOutcome(null);
    setPrUrl(null);
  };

  const commit = async () => {
    setBusy(true);
    const hash = await attempt(() => api.commitAgentWork(entry.agentId, message.trim()));
    setBusy(false);
    if (hash === undefined) return;
    if (hash === null) toast.info("Nothing to commit");
    else toast.success(`Committed ${hash.slice(0, 7)}`);
    setMessage("");
    close();
    onChanged();
  };

  const merge = async () => {
    setBusy(true);
    const result = await attempt(() => api.mergeAgent(entry.agentId));
    setBusy(false);
    if (result) {
      setOutcome(result);
      onChanged();
    }
  };

  const createPr = async () => {
    setBusy(true);
    const url = await attempt(() => api.createPullRequest(entry.agentId, title.trim(), body));
    setBusy(false);
    if (url) setPrUrl(url);
  };

  const additions = diff?.files.reduce((s, f) => s + (f.additions ?? 0), 0) ?? 0;
  const deletions = diff?.files.reduce((s, f) => s + (f.deletions ?? 0), 0) ?? 0;

  return (
    <div className="panel branch-card">
      <div className="row">
        <strong>{name}</strong>
        <code>{entry.branch}</code>
        {diff && (
          <span className="muted small">
            {diff.commitsAhead} ahead · {diff.commitsBehind} behind {diff.base}
          </span>
        )}
        <span className="spacer" />
        {diff && (diff.mergeable ? <span className="chip tone-green">mergeable</span> : <span className="chip tone-red">not mergeable</span>)}
      </div>
      {entry.error && <div className="notice notice-error">{entry.error}</div>}
      {diff && (
        <>
          <div className="small">
            {diff.files.length} files · <span className="tone-green-fg">+{additions}</span> <span className="tone-red-fg">−{deletions}</span>
            {diff.uncommitted.length > 0 && <span className="tone-amber-fg"> · {diff.uncommitted.length} uncommitted</span>}
          </div>
          {diff.files.length > 0 && (
            <ul className="file-list mono small">
              {diff.files.map((f) => (
                <li key={f.path}>
                  <span className="file-status">{f.status}</span> {f.path}
                  <span className="spacer" />
                  {f.additions != null && <span className="tone-green-fg">+{f.additions}</span>}{" "}
                  {f.deletions != null && <span className="tone-red-fg">−{f.deletions}</span>}
                </li>
              ))}
            </ul>
          )}
          {diff.uncommitted.length > 0 && (
            <details>
              <summary className="small">Uncommitted files</summary>
              <ul className="file-list mono small">
                {diff.uncommitted.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          )}
          {diff.conflicts.length > 0 && (
            <div className="notice notice-warn">
              <TriangleAlert size={14} /> Conflicts: {diff.conflicts.join(", ")}
            </div>
          )}
        </>
      )}
      <div className="row-end">
        <button className="btn" onClick={() => setDialog("commit")} disabled={!diff || diff.uncommitted.length === 0}>
          <GitCommitHorizontal size={13} /> Commit agent work
        </button>
        <button className="btn" onClick={() => setDialog("pr")} disabled={!diff || diff.commitsAhead === 0}>
          <GitPullRequest size={13} /> Create PR
        </button>
        <button className="btn primary" onClick={() => setDialog("merge")} disabled={!diff || diff.commitsAhead === 0}>
          <GitMerge size={13} /> Merge into {baseBranch}
        </button>
      </div>

      {dialog === "commit" && (
        <Modal
          title={`Commit ${name}'s work`}
          onClose={close}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void commit()} disabled={busy || !message.trim()}>
                {busy && <Spinner size={12} />} Commit
              </button>
            </>
          }
        >
          <Field label="Commit message">
            <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <p className="muted small">Commits the {diff?.uncommitted.length ?? 0} uncommitted files in the agent's worktree on {entry.branch}.</p>
        </Modal>
      )}

      {dialog === "merge" && (
        <Modal
          title={outcome ? (outcome.merged ? "Merged" : "Merge not completed") : `Merge ${entry.branch} into ${baseBranch}?`}
          onClose={close}
          locked={busy}
          footer={
            outcome ? (
              <button className="btn primary" onClick={close}>
                Close
              </button>
            ) : (
              <>
                <button className="btn" onClick={close} disabled={busy}>
                  Cancel
                </button>
                <button className="btn primary" onClick={() => void merge()} disabled={busy}>
                  {busy && <Spinner size={12} />} Take snapshot and merge
                </button>
              </>
            )
          }
        >
          {outcome ? (
            <>
              <p>{outcome.message}</p>
              {outcome.commit && (
                <p>
                  Merge commit <code>{outcome.commit}</code>
                </p>
              )}
              {outcome.conflicts.length > 0 && (
                <div className="notice notice-warn">
                  <TriangleAlert size={14} /> Conflicts: {outcome.conflicts.join(", ")}
                </div>
              )}
              {outcome.snapshot && (
                <p className="muted small">
                  Snapshot <code>{outcome.snapshot.branch}</code> was taken before merging — restore it from the Snapshots list to undo.
                </p>
              )}
            </>
          ) : (
            <>
              <p>
                Merges {diff?.commitsAhead ?? 0} commits from <code>{entry.branch}</code> into <code>{baseBranch}</code>.
              </p>
              <p className="muted">A snapshot of {baseBranch} is taken first so the merge can be undone from the Snapshots list.</p>
              {diff && !diff.mergeable && (
                <div className="notice notice-warn">
                  <TriangleAlert size={14} /> The branch is reported as not cleanly mergeable.
                </div>
              )}
            </>
          )}
        </Modal>
      )}

      {dialog === "pr" && (
        <Modal
          title="Create pull request"
          onClose={close}
          locked={busy}
          footer={
            prUrl ? (
              <>
                <button className="btn" onClick={() => void run(() => openUrl(prUrl))}>
                  <ExternalLink size={13} /> Open
                </button>
                <button className="btn primary" onClick={close}>
                  Close
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={close} disabled={busy}>
                  Cancel
                </button>
                <button className="btn primary" onClick={() => void createPr()} disabled={busy || !title.trim()}>
                  {busy && <Spinner size={12} />} Create PR
                </button>
              </>
            )
          }
        >
          {prUrl ? (
            <p>
              Pull request created: <code>{prUrl}</code>
            </p>
          ) : (
            <>
              <Field label="Title">
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label="Body">
                <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
              </Field>
              <p className="muted small">
                Opens a pull request from <code>{entry.branch}</code> using the GitHub CLI.
              </p>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
