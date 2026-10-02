import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Field } from "../../../components/Common";
import { attempt } from "../../../lib/toast";
import { DEFAULT_TARGET, INFRA_KEYS, infraOptions, type WizardState } from "../wizard";

const LABEL: Record<(typeof INFRA_KEYS)[number], string> = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  llm: "LLM",
  authentication: "Authentication",
  deployment: "Deployment",
};

export function StepInfrastructure({ state, set }: { state: WizardState; set: (s: WizardState) => void }) {
  const fork = state.provider === "ai_town";
  const options = infraOptions(state.provider);

  const pickFolder = async () => {
    const dir = await attempt(() => open({ directory: true, multiple: false, title: "Folder for the AI Town fork" }));
    if (typeof dir === "string") set({ ...state, targetDir: dir });
  };

  return (
    <div className="world-step">
      {!fork && (
        <div className="notice">
          This world runs inside NEXUS: nothing to install. The choices below are recorded with the world for reference.
        </div>
      )}
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
      {fork && (
        <>
          <Field label="Target folder of the fork" hint={`Default: ${DEFAULT_TARGET} inside the project.`} group>
            <div className="row">
              <input className="grow mono" value={state.targetDir} onChange={(e) => set({ ...state, targetDir: e.target.value })} />
              <button type="button" className="btn btn-sm" onClick={() => void pickFolder()}>
                <FolderOpen size={13} /> Browse
              </button>
            </div>
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={state.letCentralFinish} onChange={(e) => set({ ...state, letCentralFinish: e.target.checked })} />
            Let Central finish the setup (npm install, Convex, LLM, tests) as a mission
          </label>
          <div className="tiny muted">The mission runs real Claude turns; Central asks you for any login or key it needs.</div>
        </>
      )}
    </div>
  );
}
