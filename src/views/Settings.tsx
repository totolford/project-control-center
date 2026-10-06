import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import type { ProjectSettings } from "../lib/types";
import { useReadOnly, useStore } from "../store";
import { Field, PageHeader, Section, Spinner } from "../components/Common";
import { PermissionEditor } from "../components/PermissionEditor";
import { UpdatePanel } from "./settings/UpdatePanel";
import { WorkspaceSettings } from "./settings/WorkspaceSettings";
import { ClaudeSettings } from "./settings/ClaudeSettings";
import { SessionDefaults } from "./settings/SessionDefaults";
import { ImprovementSettings } from "./settings/ImprovementSettings";
import { CompatibilitySettings } from "./settings/CompatibilitySettings";

function numberOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || Number.isNaN(n) ? null : n;
}

/** Scrolls to the section named by the current view (e.g. navigate({ name: "settings", section: "improvement" })). */
function useScrollToSection() {
  const section = useStore((s) => s.view.section);
  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" });
  }, [section]);
}

export function Settings() {
  const settings = useStore((s) => s.project?.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [draft, setDraft] = useState<ProjectSettings | undefined>(settings);
  const [budget, setBudget] = useState(settings?.maxBudgetUsdPerSession?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const readOnly = useReadOnly();
  useScrollToSection();

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
            <button
              className="btn primary"
              onClick={() => void save()}
              disabled={!dirty || saving || readOnly}
              title={readOnly ? "Compatibility mode: this project is read-only" : undefined}
            >
              {saving ? <Spinner size={12} /> : <Save size={13} />} Save project settings
            </button>
          </>
        }
      />

      <div id="settings-claude">
        <ClaudeSettings />
      </div>

      <div id="settings-defaults">
        <SessionDefaults draft={draft} set={set} />
      </div>

      <Section title="Workers">
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
          <Field label="Permission timeout (minutes)" hint="Unanswered requests expire and the agent receives a refusal. 0 = never.">
            <input
              type="number"
              min={0}
              max={1440}
              value={draft.permissionTimeoutMinutes ?? 30}
              onChange={(e) => set("permissionTimeoutMinutes", Math.min(1440, Math.max(0, Math.floor(Number(e.target.value) || 0))))}
            />
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

      <div id="settings-improvement">
        <ImprovementSettings value={draft.improvement} onChange={(v) => set("improvement", v)} />
      </div>

      <div id="settings-compatibility">
        <CompatibilitySettings />
      </div>

      <WorkspaceSettings />

      <UpdatePanel />
    </div>
  );
}
