import { useState } from "react";
import { ArrowLeft, Check, X } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import type { Detection, EnvironmentReport, ProjectSnapshot } from "../lib/types";
import { ClaudeStatus, useClaudeInfo } from "../components/ClaudeStatus";
import { Field, Spinner } from "../components/Common";

export interface FolderInspection {
  path: string;
  isProject: boolean;
  suggestedName: string;
  environment: EnvironmentReport;
}

function DetectionList({ title, items }: { title: string; items: Detection[] }) {
  return (
    <div className="checklist">
      <div className="section-label">{title}</div>
      {items.length === 0 && <div className="muted small">Nothing detected.</div>}
      {items.map((d) => (
        <div key={d.key} className={`check-row${d.detected ? " ok" : ""}`}>
          {d.detected ? <Check size={14} className="tone-green-fg" /> : <X size={14} className="muted" />}
          <span>{d.label}</span>
          {d.detail && <span className="muted small mono">{d.detail}</span>}
        </div>
      ))}
    </div>
  );
}

export function Setup({
  inspection,
  onCancel,
  onCreated,
}: {
  inspection: FolderInspection;
  onCancel: () => void;
  onCreated: (snap: ProjectSnapshot) => void;
}) {
  const claude = useClaudeInfo();
  const env = inspection.environment;
  const hasGit = env.project.some((d) => d.key === "git" && d.detected);
  const [name, setName] = useState(inspection.suggestedName);
  const [initGit, setInitGit] = useState(!hasGit);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const snap = await attempt(() => api.createProject(inspection.path, name.trim(), !hasGit && initGit));
    setBusy(false);
    if (snap) onCreated(snap);
  };

  return (
    <div className="welcome">
      <div className="welcome-inner setup">
        <button className="btn ghost back" onClick={onCancel} disabled={busy}>
          <ArrowLeft size={14} /> Back
        </button>
        <h1 className="setup-title">PROJECT DETECTED</h1>
        <div className="mono muted setup-path">{inspection.path}</div>

        {env.projectTypes.length > 0 && (
          <div className="chips-row">
            {env.projectTypes.map((t) => (
              <span key={t} className="chip tone-accent">
                {t}
              </span>
            ))}
          </div>
        )}

        <div className="setup-grid">
          <DetectionList title="Project" items={env.project} />
          <DetectionList title="Tools" items={env.tools} />
        </div>

        <ClaudeStatus info={claude.info} loading={claude.loading} onRecheck={() => void claude.reload()} />

        <div className="setup-form">
          <Field label="Project name">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          {!hasGit && (
            <label className="checkbox">
              <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
              Initialize a git repository
            </label>
          )}
          <p className="muted small">
            A <code>.agent-project/</code> folder will be created here to hold the project brain (memory, tasks, agents). Nothing else is
            installed or modified.
          </p>
          <div className="row-end">
            <button className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>
              {busy && <Spinner size={13} />} Create project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
