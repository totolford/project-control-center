import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { attempt } from "../../../lib/toast";
import type { WorldAnalysis, WorldProviderInfo } from "../../../lib/types";
import { withProvider, type ProviderId, type WizardState } from "../wizard";
import { Prerequisites } from "../Prerequisites";

const CHOICES: { id: ProviderId; title: string; summary: string }[] = [
  {
    id: "nexus_native",
    title: "NEXUS Native AI World",
    summary: "Runs inside NEXUS with no extra infrastructure; linked characters mirror your real agents.",
  },
  {
    id: "custom",
    title: "Custom world project",
    summary: "Links an existing world project folder of yours to this world.",
  },
];

export function StepArchitecture({ state, set, analysis, providers }: {
  state: WizardState;
  set: (s: WizardState) => void;
  analysis: WorldAnalysis | null;
  providers: WorldProviderInfo[];
}) {
  const pickFolder = async () => {
    const dir = await attempt(() => open({ directory: true, multiple: false, title: "Folder of the custom world" }));
    if (typeof dir === "string") set({ ...state, targetDir: dir });
  };

  return (
    <div className="world-step">
      {analysis && (
        <div className="notice">
          <div>
            <div>
              Recommended: <strong>{CHOICES.find((c) => c.id === analysis.recommendedProvider)?.title ?? analysis.recommendedProvider}</strong>
              {" — "}
              {analysis.reason}
            </div>
            <div className="tiny muted">
              Project types detected: {analysis.projectTypes.length ? analysis.projectTypes.join(", ") : "none"}
            </div>
          </div>
        </div>
      )}
      <div className="tiny muted">
        This wizard creates the NEXUS native 2D world (the fallback). The integrated AI Town is installed and started from the
        AI Town tab of the AI World page.
      </div>
      <div className="world-choices" role="radiogroup" aria-label="World architecture">
        {CHOICES.map((c) => {
          const info = providers.find((p) => p.id === c.id);
          const checked = state.provider === c.id;
          return (
            <label key={c.id} className={`world-choice${checked ? " active" : ""}`}>
              <input type="radio" name="provider" checked={checked} onChange={() => set(withProvider(state, c.id))} />
              <div className="grow">
                <div className="row">
                  <strong>{c.title}</strong>
                  {analysis?.recommendedProvider === c.id && <span className="chip tone-accent">recommended</span>}
                  {info && <span className={`chip tone-${info.ready ? "green" : "amber"}`}>{info.ready ? "ready" : "prerequisites missing"}</span>}
                </div>
                <div className="small muted">{info?.description || c.summary}</div>
                {info && info.prerequisites.length > 0 && <Prerequisites items={info.prerequisites} />}
                {c.id === "custom" && checked && (
                  <div className="row world-gap">
                    <input className="grow mono" value={state.targetDir} placeholder="Choose a folder…" readOnly />
                    <button type="button" className="btn btn-sm" onClick={() => void pickFolder()}>
                      <FolderOpen size={13} /> Browse
                    </button>
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
