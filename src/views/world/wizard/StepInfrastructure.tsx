import { Field } from "../../../components/Common";
import { INFRA_KEYS, infraOptions, type WizardState } from "../wizard";

const LABEL: Record<(typeof INFRA_KEYS)[number], string> = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  llm: "LLM",
  authentication: "Authentication",
  deployment: "Deployment",
};

export function StepInfrastructure({ state, set }: { state: WizardState; set: (s: WizardState) => void }) {
  const options = infraOptions(state.provider);

  return (
    <div className="world-step">
      <div className="notice">
        {state.provider === "custom"
          ? "Your world project runs on its own: NEXUS only keeps the characters. The choices below are recorded with the world for reference."
          : "This world runs inside NEXUS: nothing to install. The choices below are recorded with the world for reference."}
      </div>
      <div className="grid-2">
        {INFRA_KEYS.map((k) => (
          <Field key={k} label={LABEL[k]}>
            <select
              value={state.infrastructure[k] ?? options[k][0]}
              disabled={options[k].length < 2}
              onChange={(e) => set({ ...state, infrastructure: { ...state.infrastructure, [k]: e.target.value } })}
            >
              {options[k].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
    </div>
  );
}
