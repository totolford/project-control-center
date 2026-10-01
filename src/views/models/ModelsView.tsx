import { memo } from "react";
import { RefreshCw } from "lucide-react";
import { effortLevels, modelField, modelFlags, modelLabel, modelValue, str } from "../../lib/claudeEnv";
import { matrixAgents } from "../../lib/matrix";
import type { ProjectSettings } from "../../lib/types";
import { saveSettingsWith, setAgentModel } from "../../state/actions";
import { useClaudeEnv } from "../../state/claude";
import { useAgents, useStore } from "../../store";
import { Loading, PageHeader, Section, Spinner } from "../../components/Common";
import { ModelSelect } from "../../components/ModelSelect";

const NOT_EXPOSED = "Not exposed by Claude Code";

function Optional({ value }: { value: string | null }) {
  return value === null ? <span className="muted tiny">{NOT_EXPOSED}</span> : <span className="mono small">{value}</span>;
}

const ModelRow = memo(function ModelRow({ m, defaults }: { m: Record<string, unknown>; defaults: string[] }) {
  const value = modelValue(m);
  const levels = effortLevels(m);
  return (
    <tr>
      <td>
        <strong>{modelLabel(m)}</strong>
        <div className="mono tiny muted">{value ?? "—"}</div>
        {value && defaults.includes(value) && <span className="chip tone-accent">Current default</span>}
      </td>
      <td className="mono small">{str(m.resolvedModel) ?? "—"}</td>
      <td className="prewrap small">{str(m.description) ?? "—"}</td>
      <td className="small">{levels === null ? "—" : levels.length === 0 ? "not supported" : levels.join(", ")}</td>
      <td>
        <div className="chips-row">
          {modelFlags(m).map((f) => (
            <span key={f.key} className={`chip tone-${f.value ? "green" : "dim"}`} title={f.key}>
              {f.value ? "✓" : "✗"} {f.label}
            </span>
          ))}
        </div>
      </td>
      <td>
        <Optional value={modelField(m, /context/i)} />
      </td>
      <td>
        <Optional value={modelField(m, /speed|latency/i)} />
      </td>
      <td>
        <Optional value={modelField(m, /cost|price/i)} />
      </td>
    </tr>
  );
});

function DefaultModel({ label, field }: { label: string; field: "centralModel" | "workerModel" }) {
  const value = useStore((s) => s.project?.settings[field] ?? null);
  return (
    <tr>
      <td>{label}</td>
      <td>
        <ModelSelect value={value} onChange={(m) => void saveSettingsWith((s: ProjectSettings) => ({ ...s, [field]: m }), `${label}: ${m ?? "default"}`)} label={label} />
      </td>
      <td className="muted small">Project setting · used when an agent has no model of its own</td>
    </tr>
  );
}

function Assignments() {
  const agents = matrixAgents(useAgents());
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Who</th>
          <th>Model</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        <DefaultModel label="Central default" field="centralModel" />
        <DefaultModel label="Worker default" field="workerModel" />
        {agents.map((a) => (
          <tr key={a.id}>
            <td>
              <strong>{a.name}</strong> <span className="muted tiny">{a.kind}</span>
            </td>
            <td>
              <ModelSelect value={a.model} onChange={(m) => void setAgentModel(a, m)} label={`Model of ${a.name}`} />
            </td>
            <td className="muted small">A running session switches live when Claude Code accepts it, otherwise at its next start</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Models reported by the installed Claude Code, and who uses which. */
export function ModelsView() {
  const { env, loading, error, refresh } = useClaudeEnv();
  const settings = useStore((s) => s.project?.settings);
  const defaults = [settings?.centralModel ?? "default", settings?.workerModel ?? "default"];
  const initFailed = env?.unavailable.find((u) => u.startsWith("initialize") || u.startsWith("control session") || u.startsWith("Claude Code is not"));
  return (
    <div className="page">
      <PageHeader
        title="Models"
        subtitle="As reported by Claude Code for your account. Fields Claude Code does not report are shown as such."
        actions={
          <button className="btn" onClick={refresh} disabled={loading}>
            {loading ? <Spinner size={12} /> : <RefreshCw size={13} />} Refresh
          </button>
        }
      />
      {error && <div className="notice notice-error">{error}</div>}
      <Section title="Available models">
        {!env ? (
          loading ? <Loading text="Asking Claude Code…" /> : <div className="muted">Unavailable</div>
        ) : env.models.length === 0 ? (
          <div className="muted">Unavailable{initFailed ? ` — ${initFailed}` : " — Claude Code reported no model list"}</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Resolved</th>
                  <th>Description</th>
                  <th>Effort levels</th>
                  <th>Capabilities</th>
                  <th>Context</th>
                  <th>Speed</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {env.models.map((m, i) => (
                  <ModelRow key={modelValue(m) ?? i} m={m} defaults={defaults} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Assignments">
        <Assignments />
      </Section>
    </div>
  );
}
