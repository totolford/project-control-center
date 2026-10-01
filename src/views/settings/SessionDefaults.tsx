import { DEFAULT_EFFORT_LEVELS } from "../../lib/claudeEnv";
import type { ProjectSettings } from "../../lib/types";
import { powerPreset } from "../../lib/power";
import { Field, Section } from "../../components/Common";
import { EnvEditor } from "../../components/EnvEditor";
import { ModelSelect } from "../../components/ModelSelect";
import { PowerControl } from "../../components/PowerControl";

type Set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => void;

/** Defaults applied to agent sessions (edited inside the Settings draft). */
export function SessionDefaults({ draft, set }: { draft: ProjectSettings; set: Set }) {
  return (
    <Section title="Session defaults">
      <div className="form-row">
        <Field label="Central model" hint="Used when Central has no model of its own." group>
          <ModelSelect value={draft.centralModel} onChange={(m) => set("centralModel", m)} label="Central model" />
        </Field>
        <Field label="Worker model" hint="Used by workers without a model of their own." group>
          <ModelSelect value={draft.workerModel} onChange={(m) => set("workerModel", m)} label="Worker model" />
        </Field>
        <Field label="Default effort" hint="--effort of sessions whose agent has none.">
          <select value={draft.defaultEffort ?? ""} onChange={(e) => set("defaultEffort", e.target.value || null)}>
            <option value="">Claude Code default</option>
            {DEFAULT_EFFORT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Default power for new workers" hint="Sets the default worker permissions below to the preset." group>
        <PowerControl permissions={draft.defaultWorkerPermissions} onApply={(l) => set("defaultWorkerPermissions", powerPreset(l))} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={draft.defaultSkillsEnabled} onChange={(e) => set("defaultSkillsEnabled", e.target.checked)} />
        Skills & slash commands enabled for new agents
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={draft.autoRecover} onChange={(e) => set("autoRecover", e.target.checked)} />
        Resume interrupted sessions automatically when the project opens (crash recovery without asking)
      </label>
      <p className="muted small">
        Connections are granted per agent (Agents → Permissions & connections); Central can grant the project's connections to the workers it creates.
      </p>
      <div className="section-label">Environment variables of every agent session</div>
      <EnvEditor value={draft.sessionEnv} onSave={(env) => set("sessionEnv", env)} saveLabel="Apply to draft" />
    </Section>
  );
}
