import { TriangleAlert } from "lucide-react";
import type { Agent, ConversionReport } from "../../../lib/types";
import { useStore } from "../../../store";
import { MODE_META, PROVIDER_LABEL } from "../status";
import type { Validation, WizardState } from "../wizard";

export function StepReview({ state, agents, validation }: { state: WizardState; agents: Agent[]; validation: Validation }) {
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const linked = state.characters.filter((c) => c.nexusAgent);
  return (
    <div className="world-step">
      <dl className="kv">
        <dt>Architecture</dt>
        <dd>{PROVIDER_LABEL[state.provider] ?? state.provider}</dd>
        <dt>World</dt>
        <dd>
          <strong>{state.name || "—"}</strong> {state.description && <span className="muted">— {state.description}</span>}
        </dd>
        <dt>Map</dt>
        <dd>Campus map (9 rooms) · {state.environment || "default environment"}</dd>
        <dt>Mode</dt>
        <dd>
          {MODE_META[state.mode].label} <span className="tiny muted">— {MODE_META[state.mode].explain}</span>
        </dd>
        <dt>Speed</dt>
        <dd>{state.speed} ticks/s</dd>
        <dt>Rules</dt>
        <dd>{state.rules.filter((r) => r.trim()).join(" · ") || "none"}</dd>
        <dt>Characters</dt>
        <dd>
          {state.characters.length} ({linked.length} linked to NEXUS agents, {state.characters.length - linked.length} simulated)
          <div className="tiny muted">
            {state.characters.map((c) => (c.nexusAgent ? `${c.name} → ${agentName(c.nexusAgent)}` : c.name)).join(", ")}
          </div>
        </dd>
        {(state.provider === "ai_town" || state.provider === "custom") && (
          <>
            <dt>Folder</dt>
            <dd className="mono">{state.targetDir || "—"}</dd>
          </>
        )}
        {state.provider === "ai_town" && (
          <>
            <dt>Setup mission</dt>
            <dd>{state.letCentralFinish ? "Central finishes the setup (real Claude turns)" : "No — you finish the setup"}</dd>
          </>
        )}
      </dl>
      <div className="tiny muted">
        Before anything is written, NEXUS backs up .agent-project and takes a git snapshot. Project files are not modified.
      </div>
      {validation.errors.map((e) => (
        <div key={e} className="notice notice-error world-gap">
          {e}
        </div>
      ))}
      {validation.warnings.map((w) => (
        <div key={w} className="notice notice-warn world-gap">
          <TriangleAlert size={14} /> {w}
        </div>
      ))}
    </div>
  );
}

export function ConversionResult({ report }: { report: ConversionReport }) {
  const navigate = useStore((s) => s.navigate);
  return (
    <div className="world-step">
      <div className="section-label">Steps</div>
      <ul className="bullet-list">
        {report.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      {report.warnings.length > 0 && (
        <>
          <div className="section-label">Warnings</div>
          {report.warnings.map((w, i) => (
            <div key={i} className="notice notice-warn">
              <TriangleAlert size={14} /> {w}
            </div>
          ))}
        </>
      )}
      {report.backup && (
        <div className="small">
          Backup: <span className="mono">{report.backup.path}</span>
        </div>
      )}
      {report.missionId && (
        <div className="small world-gap">
          Setup mission <span className="mono">{report.missionId}</span> created.{" "}
          <button type="button" className="link-btn" onClick={() => navigate({ name: "missions" })}>
            Open missions
          </button>
        </div>
      )}
    </div>
  );
}
