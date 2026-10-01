import { useState } from "react";
import { DEFAULT_EFFORT_LEVELS, effortLevels, modelValue, str } from "../../lib/claudeEnv";
import type { Agent } from "../../lib/types";
import { applyPower, patchAgent, setAgentModel } from "../../state/actions";
import { useModels } from "../../state/claude";
import { useStore } from "../../store";
import { Field, Section } from "../../components/Common";
import { EnvEditor } from "../../components/EnvEditor";
import { ModelSelect } from "../../components/ModelSelect";
import { PowerControl } from "../../components/PowerControl";

function ModelField({ agent }: { agent: Agent }) {
  const models = useModels();
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const entry = models.find((m) => modelValue(m) === (agent.model ?? "default"));
  const description = entry ? str(entry.description) : null;
  return (
    <Field label="Model" hint={result ?? description ?? (models.length === 0 ? "Model list not loaded from Claude Code yet" : undefined)} group>
      <ModelSelect
        value={agent.model}
        disabled={busy}
        onChange={async (model) => {
          setBusy(true);
          setResult(null);
          const live = await setAgentModel(agent, model);
          setBusy(false);
          if (live !== undefined) setResult(live ? "Switched live" : "Applies at next session start");
        }}
      />
    </Field>
  );
}

function EffortField({ agent }: { agent: Agent }) {
  const models = useModels();
  const entry = models.find((m) => modelValue(m) === (agent.model ?? "default"));
  const declared = effortLevels(entry);
  const levels = declared ?? DEFAULT_EFFORT_LEVELS;
  const unsupported = declared !== null && declared.length === 0;
  const hint = unsupported
    ? "This model does not support effort levels"
    : declared
      ? "Levels declared by Claude Code for this model"
      : "Claude Code did not declare levels for this model; all levels listed";
  return (
    <Field label="Effort" hint={hint}>
      <select value={agent.profile.effort ?? ""} disabled={unsupported} onChange={(e) => void patchAgent(agent.id, { profile: { ...agent.profile, effort: e.target.value || null } }, "Effort saved")}>
        <option value="">Claude Code default</option>
        {levels.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
        {agent.profile.effort && !levels.includes(agent.profile.effort) && <option value={agent.profile.effort}>{agent.profile.effort}</option>}
      </select>
    </Field>
  );
}

/** Model, power, effort, skills and environment of one agent. */
export function AgentProfileEditor({ agent }: { agent: Agent }) {
  const unlocked = useStore((s) => s.project?.settings.autonomy.unlocked ?? false);
  return (
    <>
      <Section title="Runtime">
        <div className="form-row">
          <ModelField agent={agent} />
          <EffortField agent={agent} />
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={agent.profile.skillsEnabled} onChange={(e) => void patchAgent(agent.id, { profile: { ...agent.profile, skillsEnabled: e.target.checked } }, "Skills setting saved")} />
          <span>
            <strong>Skills & slash commands</strong>
            <span className="muted small"> — Claude Code has no per-skill switch per session; off starts the session with --disable-slash-commands. Applies at next session start.</span>
          </span>
        </label>
      </Section>
      <Section title="Power">
        <PowerControl permissions={agent.permissions} onApply={(l) => void applyPower(agent, l)} />
        {unlocked && <div className="notice notice-warn small">CLAUDE UNLOCKED is on: the unlocked permissions apply to this agent instead of its own.</div>}
      </Section>
      <Section title="Environment variables">
        <EnvEditor value={agent.profile.env} onSave={(env) => patchAgent(agent.id, { profile: { ...agent.profile, env } }, "Variables saved")} />
      </Section>
    </>
  );
}
