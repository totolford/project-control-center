import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, TriangleAlert } from "lucide-react";
import { Loading, Spinner } from "../../../components/Common";
import { Modal } from "../../../components/Modal";
import { api, errorMessage } from "../../../lib/api";
import { attempt } from "../../../lib/toast";
import type { ConversionReport, World, WorldAnalysis } from "../../../lib/types";
import { useAgents, useStore } from "../../../store";
import { CharacterEditor } from "../CharacterEditor";
import { STEPS, initialWizard, buildSpec, validateStep, type StepId, type WizardState } from "../wizard";
import { StepAgents } from "./StepAgents";
import { StepArchitecture } from "./StepArchitecture";
import { StepInfrastructure } from "./StepInfrastructure";
import { ConversionResult, StepReview } from "./StepReview";
import { StepWorld } from "./StepWorld";

interface Props {
  /** "Make this project an AI Town": recommended defaults, straight to the review. */
  oneClick: boolean;
  onClose: () => void;
  onOpenWorld: (w: World) => void;
}

/** Convert → AI World: analysis, 5 steps and a review, then api.worldCreate. */
export function ConversionWizard({ oneClick, onClose, onOpenWorld }: Props) {
  const projectName = useStore((s) => s.project?.info.name ?? "");
  const agents = useAgents();
  const [analysis, setAnalysis] = useState<WorldAnalysis | null>(null);
  const [state, setState] = useState<WizardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<StepId>(oneClick ? "review" : "architecture");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ConversionReport | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.worldAnalyze(), api.worldCharactersFromAgents()])
      .then(([a, chars]) => {
        if (!live) return;
        setAnalysis(a);
        setState(initialWizard(projectName, a, chars));
      })
      .catch((e) => live && setLoadError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [projectName]);

  const validation = useMemo(() => (state ? validateStep(step, state) : { errors: [], warnings: [] }), [state, step]);
  const index = STEPS.findIndex((s) => s.id === step);

  const create = async () => {
    if (!state) return;
    setBusy(true);
    const r = await attempt(() => api.worldCreate(buildSpec(state)), "AI World created");
    setBusy(false);
    if (r) setReport(r);
  };

  const title = report ? "AI World created" : oneClick && step === "review" ? "Make this project an AI Town" : "Convert → AI World";

  let body: React.ReactNode;
  if (loadError) body = <div className="notice notice-error">Cannot analyse the project: {loadError}</div>;
  else if (!state) body = <Loading text="Analysing the project, its agents and the world providers…" />;
  else if (report) body = <ConversionResult report={report} />;
  else {
    body = (
      <>
        <ol className="world-steps">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button type="button" className={`world-step-tab${s.id === step ? " active" : ""}${i < index ? " done" : ""}`} disabled={busy} onClick={() => setStep(s.id)}>
                {i + 1}. {s.label}
              </button>
            </li>
          ))}
        </ol>
        {analysis?.existingWorld && (
          <div className="notice notice-warn">
            <TriangleAlert size={14} /> This project already has an AI World: creating a new one replaces it (a backup is made first).
          </div>
        )}
        {step === "architecture" && <StepArchitecture state={state} set={setState} analysis={analysis} providers={analysis?.providers ?? []} />}
        {step === "world" && <StepWorld state={state} set={setState} />}
        {step === "agents" && <StepAgents state={state} set={setState} />}
        {step === "characters" && <CharacterEditor characters={state.characters} onChange={(characters) => setState({ ...state, characters })} agents={agents} />}
        {step === "infrastructure" && <StepInfrastructure state={state} set={setState} />}
        {step === "review" && <StepReview state={state} agents={agents} validation={validation} />}
        {step !== "review" && validation.errors.length > 0 && <div className="tiny tone-red-fg world-gap">{validation.errors.join(" ")}</div>}
      </>
    );
  }

  let footer: React.ReactNode;
  if (report) {
    footer = (
      <button className="btn primary" onClick={() => (onOpenWorld(report.world), onClose())}>
        Open the world
      </button>
    );
  } else if (state) {
    footer = (
      <>
        {step === "review" && oneClick && <span className="tiny muted grow">Recommended defaults — use the steps above to change anything.</span>}
        <button className="btn" disabled={busy || index === 0} onClick={() => setStep(STEPS[index - 1].id)}>
          <ArrowLeft size={13} /> Back
        </button>
        {step === "review" ? (
          <button className="btn primary" disabled={busy || validation.errors.length > 0} onClick={() => void create()}>
            {busy ? <Spinner size={12} /> : <Check size={13} />} Create
          </button>
        ) : (
          <button className="btn primary" disabled={validation.errors.length > 0} onClick={() => setStep(STEPS[index + 1].id)}>
            Next <ArrowRight size={13} />
          </button>
        )}
      </>
    );
  }

  return (
    <Modal title={title} onClose={onClose} footer={footer} width={step === "characters" && !report ? 860 : 720} locked={busy} className="world-modal">
      {body}
    </Modal>
  );
}
