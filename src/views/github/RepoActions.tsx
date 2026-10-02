import { useState } from "react";
import { CirclePlus, FolderDown, Play, ScanSearch } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { attempt, run } from "../../lib/toast";
import { cloneGithubRepo, missionForCentral, useOpenFolder } from "../../state/opsActions";
import { useReadOnly } from "../../store";
import { Field, Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";

function IssueDialog({ repo, onClose }: { repo: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const ok = await ask(`Create the issue “${title.trim()}” on ${repo}? It is public to everyone who can see the repository.`, { title: "Create issue", okLabel: "Create" });
    if (!ok) return;
    setBusy(true);
    const url = await attempt(() => api.githubCreateIssue(repo, title.trim(), body), "Issue created");
    setBusy(false);
    if (url) onClose();
  };
  return (
    <Modal
      title={`New issue · ${repo}`}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={busy || !title.trim()}>
            {busy && <Spinner size={12} />} Create issue
          </button>
        </>
      }
    >
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Body (Markdown)">
        <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
    </Modal>
  );
}

function WorkflowDialog({ repo, defaultRef, onClose }: { repo: string; defaultRef: string; onClose: () => void }) {
  const [workflow, setWorkflow] = useState("");
  const [ref, setRef] = useState(defaultRef);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    const ok = await ask(`Run workflow ${workflow.trim()} on ${repo} at ${ref.trim()}? It runs on GitHub Actions with the repository's secrets.`, { title: "Run workflow", okLabel: "Run", kind: "warning" });
    if (!ok) return;
    setBusy(true);
    const out = await attempt(() => api.githubRunWorkflow(repo, workflow.trim(), ref.trim()), "Workflow dispatched");
    setBusy(false);
    if (out !== undefined) onClose();
  };
  return (
    <Modal
      title={`Run workflow · ${repo}`}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void start()} disabled={busy || !workflow.trim() || !ref.trim()}>
            {busy && <Spinner size={12} />} Run workflow
          </button>
        </>
      }
    >
      <p className="muted small">
        Only workflows that declare a <code>workflow_dispatch</code> trigger can be started manually; GitHub refuses the others.
      </p>
      <Field label="Workflow" hint="File name (e.g. ci.yml), name or numeric id">
        <input value={workflow} onChange={(e) => setWorkflow(e.target.value)} />
      </Field>
      <Field label="Branch or tag">
        <input value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** Repository actions: clone & open, create issue, run workflow, ask Central. */
export function RepoActions({ repo, defaultBranch }: { repo: string; defaultBranch: string | null }) {
  const openFolder = useOpenFolder();
  const readOnly = useReadOnly();
  const [dialog, setDialog] = useState<"issue" | "workflow" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const cloneAndOpen = async () => {
    setBusy("clone");
    const folder = await cloneGithubRepo(repo);
    setBusy(null);
    if (folder && openFolder) await run(() => openFolder(folder));
  };
  const analyse = async () => {
    setBusy("analyse");
    await missionForCentral(
      `Inspect the GitHub repository ${repo} with gh (read only): structure, open issues and pull requests, recent workflow runs and releases. Summarise its state and the most useful next steps.`,
      `Analyse ${repo}`,
    );
    setBusy(null);
  };

  return (
    <div className="row gh-actions">
      <button className="btn btn-sm" onClick={() => void cloneAndOpen()} disabled={busy !== null || !openFolder}>
        {busy === "clone" ? <Spinner size={11} /> : <FolderDown size={12} />} Clone & open as project
      </button>
      <button className="btn btn-sm" onClick={() => setDialog("issue")} disabled={busy !== null}>
        <CirclePlus size={12} /> Create issue
      </button>
      <button className="btn btn-sm" onClick={() => setDialog("workflow")} disabled={busy !== null}>
        <Play size={12} /> Run workflow
      </button>
      <button className="btn btn-sm" onClick={() => void analyse()} disabled={busy !== null || readOnly} title={readOnly ? "Compatibility mode: this project is read-only" : undefined}>
        {busy === "analyse" ? <Spinner size={11} /> : <ScanSearch size={12} />} Ask Central to analyse
      </button>
      {dialog === "issue" && <IssueDialog repo={repo} onClose={() => setDialog(null)} />}
      {dialog === "workflow" && <WorkflowDialog repo={repo} defaultRef={defaultBranch ?? "main"} onClose={() => setDialog(null)} />}
    </div>
  );
}
