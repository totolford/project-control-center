import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import type { ProjectSettings } from "../lib/types";
import { useStore } from "../store";
import { Field, PageHeader, Section, Spinner } from "../components/Common";
import { PermissionEditor } from "../components/PermissionEditor";
import { ClaudeStatus, useClaudeInfo } from "../components/ClaudeStatus";
import { UpdatePanel } from "./settings/UpdatePanel";
import { WorkspaceSettings } from "./settings/WorkspaceSettings";

function numberOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || Number.isNaN(n) ? null : n;
}

export function Settings() {
  const settings = useStore((s) => s.project?.settings);
  const setSettings = useStore((s) => s.setSettings);
  const claude = useClaudeInfo();
  const [draft, setDraft] = useState<ProjectSettings | undefined>(settings);
  const [budget, setBudget] = useState(settings?.maxBudgetUsdPerSession?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  // Snapshot refreshes replace the object; only reset the form when the saved values really change.
  const savedKey = JSON.stringify(settings);
  useEffect(() => {
    setDraft(settings);
    setBudget(settings?.maxBudgetUsdPerSession?.toString() ?? "");
  }, [savedKey]);

  if (!settings || !draft) return null;
  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => setDraft({ ...draft, [k]: v });
  const next: ProjectSettings = { ...draft, maxBudgetUsdPerSession: numberOrNull(budget) };
  const dirty = JSON.stringify(next) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    const saved = await attempt(() => api.saveSettings(next), "Settings saved");
    setSaving(false);
    if (saved) setSettings(saved);
  };

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        actions={
          <>
            <button className="btn" onClick={() => { setDraft(settings); setBudget(settings.maxBudgetUsdPerSession?.toString() ?? ""); }} disabled={!dirty || saving}>
              Reset
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <Spinner size={12} /> : <Save size={13} />} Save project settings
            </button>
          </>
        }
      />

      <Section title="Agents">
        <div className="form-row">
          <Field label="Central model" hint="Empty = Claude Code default.">
            <input className="mono" value={draft.centralModel ?? ""} onChange={(e) => set("centralModel", e.target.value.trim() || null)} placeholder="default" />
          </Field>
          <Field label="Worker model" hint="Empty = Claude Code default.">
            <input className="mono" value={draft.workerModel ?? ""} onChange={(e) => set("workerModel", e.target.value.trim() || null)} placeholder="default" />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Max parallel workers">
            <input
              type="number"
              min={1}
              max={64}
              value={draft.maxParallelWorkers}
              onChange={(e) => set("maxParallelWorkers", Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </Field>
          <Field label="Max budget per session (USD)" hint="Empty = no limit.">
            <input type="number" min={0} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="no limit" />
          </Field>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={draft.useWorktrees} onChange={(e) => set("useWorktrees", e.target.checked)} />
          Use git worktrees to isolate workers
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={draft.inheritUserSettings} onChange={(e) => set("inheritUserSettings", e.target.checked)} />
          Inherit my Claude Code user settings (~/.claude)
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={draft.allowDirectWorkerMessages} onChange={(e) => set("allowDirectWorkerMessages", e.target.checked)} />
          Allow workers to message each other directly (otherwise everything goes through Central)
        </label>
      </Section>

      <div className="grid-2">
        <Section title="Default worker permissions">
          <p className="muted small">Applied to newly created workers.</p>
          <PermissionEditor value={draft.defaultWorkerPermissions} onChange={(v) => set("defaultWorkerPermissions", v)} ceiling={draft.maxWorkerPermissions} />
        </Section>
        <Section title="Maximum worker permissions">
          <p className="muted small">Upper bound no worker can exceed, even when Central requests more.</p>
          <PermissionEditor value={draft.maxWorkerPermissions} onChange={(v) => set("maxWorkerPermissions", v)} />
        </Section>
      </div>

      <Section title="Claude Code">
        <ClaudeStatus info={claude.info} loading={claude.loading} onRecheck={() => void claude.reload()} />
        {claude.info?.path && (
          <dl className="kv">
            <dt>Path</dt>
            <dd className="mono small">{claude.info.path}</dd>
          </dl>
        )}
      </Section>

      <WorkspaceSettings />

      <UpdatePanel />
    </div>
  );
}
