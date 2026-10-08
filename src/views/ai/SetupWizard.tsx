import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CircleCheck, Cpu, Download, Gauge, Globe2, Play, Save } from "lucide-react";
import { aiApi } from "../../lib/aiApi";
import type { AiMode, AiOverview, FallbackPolicy, HardwareInfo, ModelAssessment, Recommendation, Validation } from "../../lib/aiTypes";
import { api } from "../../lib/api";
import type { AiTownStatus } from "../../lib/types";
import { attempt, toast } from "../../lib/toast";
import { useStore } from "../../store";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Common";
import { Segmented } from "../../components/Tabs";
import {
  STEP_LABELS,
  activeSteps,
  blocker,
  downloadPlan,
  formatBytes,
  formatMb,
  initialWizard,
  nextStep,
  prevStep,
  proposedSettings,
  stepPosition,
  suggestedModel,
  type WizardState,
} from "./aiLogic";
import { DownloadConsent } from "./ModelsPanel";
import { InstallConsent } from "./RuntimesPanel";
import { PullBar, saveAi, usePulls } from "./shared";
import { useAiSetup } from "./setupStore";
import { rich, useT } from "../../i18n";

const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || b === `${a}:latest`;

interface Choice {
  id: string;
  name: string;
  detail: string;
  tools: boolean | null;
  installed: boolean;
  assessment: ModelAssessment | null;
  disabled: string | null;
}

/** Chat models offered: the catalog models this PC can run, plus models already installed. */
function choices(rec: Recommendation | null, o: AiOverview | null, diskFreeMb: number | null): Choice[] {
  const installed = (o?.models ?? []).filter((m) => !(m.capabilities ?? []).includes("embedding"));
  const out: Choice[] = [];
  for (const a of rec?.models ?? []) {
    if (a.model.embedding) continue;
    const isInstalled = a.installed || installed.some((m) => sameModel(m.name, a.model.id));
    const plan = downloadPlan({ ...a, installed: isInstalled }, diskFreeMb);
    if (!isInstalled && !a.installable) continue;
    out.push({
      id: a.model.id,
      name: a.model.name,
      detail: `${formatBytes(a.model.sizeBytes)} · ${Math.round(a.model.context / 1024)}K context · ${a.model.goodFor}`,
      tools: a.model.tools,
      installed: isInstalled,
      assessment: a,
      disabled: isInstalled ? null : plan.allowed ? null : plan.reason,
    });
  }
  for (const m of installed) {
    if (out.some((c) => sameModel(c.id, m.name))) continue;
    out.push({
      id: m.name,
      name: m.name,
      detail: [formatBytes(m.sizeBytes), m.parameterSize, m.quantization].filter(Boolean).join(" · "),
      tools: m.capabilities ? m.capabilities.includes("tools") : null,
      installed: true,
      assessment: null,
      disabled: null,
    });
  }
  return out;
}

function Hardware({ hw }: { hw: HardwareInfo | null }) {
  if (!hw) return <Spinner />;
  return (
    <dl className="kv">
      <dt>CPU</dt>
      <dd>
        {hw.cpu ?? "unknown"} {hw.cpuCores && <span className="muted small">· {hw.cpuCores} cores / {hw.cpuThreads} threads</span>}
      </dd>
      <dt>RAM</dt>
      <dd>
        {formatMb(hw.ramTotalMb)} <span className="muted small">· {formatMb(hw.ramFreeMb)} free</span>
      </dd>
      <dt>GPU</dt>
      <dd>
        {hw.gpus.length === 0
          ? "none detected"
          : hw.gpus.map((g) => (
              <div key={g.name}>
                {g.name} <span className="muted small">· {g.vramMb ? `${formatMb(g.vramMb)} VRAM (${g.vramSource})` : "VRAM unknown"}</span>
              </div>
            ))}
      </dd>
      <dt>Acceleration</dt>
      <dd>
        {hw.cuda ? `CUDA ${hw.cuda}` : "no CUDA"} · {hw.vulkan ? "Vulkan" : "no Vulkan"}
      </dd>
      <dt>Models folder</dt>
      <dd>
        <span className="mono small">{hw.modelsDir}</span> <span className="muted small">· {formatMb(hw.diskFreeMb)} free</span>
      </dd>
      <dt>System</dt>
      <dd className="small">
        {hw.os} · {hw.arch}
      </dd>
      {hw.notes.map((n) => (
        <dd key={n} className="small muted">
          {n}
        </dd>
      ))}
    </dl>
  );
}

/** First-launch AI Setup: hardware → runtime → model → install/download (with consent) → validate → configure → AI Town. */
export function SetupWizard({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [ws, setWs] = useState<WizardState>(initialWizard);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [o, setO] = useState<AiOverview | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [mode, setMode] = useState<AiMode>("hybrid");
  const [centralLocal, setCentralLocal] = useState(false);
  const [fallback, setFallback] = useState<FallbackPolicy>("ask");
  const [busy, setBusy] = useState<string | null>(null);
  const [consent, setConsent] = useState<"install" | "download" | "embedding" | null>(null);
  const [town, setTown] = useState<AiTownStatus | null>(null);
  const projectOpen = useStore((s) => s.project !== null);
  const navigate = useStore((s) => s.navigate);

  const refresh = useCallback(async () => {
    const ov = await attempt(() => aiApi.overview());
    if (!ov) return;
    setO(ov);
    const rt = ov.runtimes.find((r) => r.id === "ollama");
    setWs((s) => ({
      ...s,
      runtimeInstalled: rt?.installed ?? false,
      runtimeAnswering: rt?.health.ok ?? false,
      modelInstalled: s.model !== null && ov.models.some((m) => sameModel(m.name, s.model!)),
    }));
  }, []);
  const pulls = usePulls((p) => {
    if (p.error) toast.error(`${p.model}: ${p.error}`);
    void refresh();
  });

  useEffect(() => {
    void refresh();
    void attempt(() => aiApi.hardware(true)).then((h) => h && setHw(h));
    void attempt(() => aiApi.recommend(true)).then((r) => {
      if (!r) return;
      setRec(r);
      setWs((s) => (s.model === null ? { ...s, model: suggestedModel(r) } : s));
    });
  }, [refresh]);
  useEffect(() => {
    if (ws.step === "done" && projectOpen) void attempt(() => api.aiTownStatus()).then((t) => setTown(t ?? null));
  }, [ws.step, projectOpen]);

  const list = choices(rec, o, hw?.diskFreeMb ?? null);
  const chosen = list.find((c) => ws.model !== null && sameModel(c.id, ws.model)) ?? null;
  const embedding = rec?.models.find((m) => m.model.id === rec.embedding) ?? rec?.models.find((m) => m.model.embedding) ?? null;
  const embeddingInstalled = !!embedding && (o?.models ?? []).some((m) => sameModel(m.name, embedding.model.id));
  const ollama = o?.runtimes.find((r) => r.id === "ollama") ?? null;
  const tools = validation?.tools ?? chosen?.tools ?? false;
  const agentsCanBeLocal = tools && (ollama?.anthropicApi ?? false);
  const why = blocker(ws);
  const pos = stepPosition(ws);
  const pick = (model: string | null) => {
    setWs((s) => ({ ...s, model, validated: false, configured: false, modelInstalled: model !== null && (o?.models ?? []).some((m) => sameModel(m.name, model)) }));
    setValidation(null);
  };

  const finish = async (skipped: boolean) => {
    await attempt(() => aiApi.completeSetup(skipped));
    onClose();
  };

  const next = async () => {
    // Downloads and validation go through the configured runtime: point NEXUS at Ollama first.
    if (ws.step === "runtimes" && o && ollama && o.settings.local.runtime !== "ollama") {
      const saved = await saveAi({ ...o.settings, local: { ...o.settings.local, runtime: "ollama", baseUrl: ollama.baseUrl } });
      if (!saved) return;
      await refresh();
    }
    setWs((s) => ({ ...s, step: nextStep(s) }));
  };

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    const r = await attempt(fn, ok);
    setBusy(null);
    return r;
  };

  let body;
  switch (ws.step) {
    case "welcome":
      body = (
        <div className="ai-wiz-text">
          <p>
            NEXUS agents run on <strong>Claude</strong> through Claude Code. They can also run on a <strong>local model</strong> on this PC, and AI Town's townspeople can live on
            it for free.
          </p>
          <p>This setup detects your hardware, recommends a model for it, installs what you approve and checks it with a real call. Nothing is installed or downloaded without your confirmation.</p>
          <p className="muted small">You can skip it and use Claude only; it stays available in AI Engines.</p>
        </div>
      );
      break;
    case "hardware":
      body = (
        <>
          <Hardware hw={hw} />
          {rec && <p className="small ai-wiz-summary">{rec.explanation[0]}</p>}
        </>
      );
      break;
    case "runtimes":
      body = (
        <div className="stack">
          {(o?.runtimes ?? []).map((r) => (
            <div key={r.id} className={`ai-wiz-option${r.id === "ollama" ? " active" : " disabled"}`}>
              <div>
                <strong>{r.name}</strong> {r.id === "ollama" && <span className="chip tone-accent">used by the setup</span>}
                <div className="tiny muted">{r.description}</div>
              </div>
              <span className={`chip tone-${r.health.ok ? "green" : r.installed ? "amber" : "grey"}`}>
                {r.health.ok ? `running${r.version ? ` · v${r.version}` : ""}` : r.installed ? "installed · stopped" : "not installed"}
              </span>
            </div>
          ))}
          {!o && <Spinner />}
          <p className="muted small">
            Ollama is the only runtime whose API Claude Code can use, so agents can run on it; it also downloads models. LM Studio and llama.cpp can be configured later in AI Engines.
          </p>
        </div>
      );
      break;
    case "models":
      body = (
        <div className="stack">
          {rec ? (
            <div className="ai-wiz-explain">
              {rec.explanation.map((l) => (
                <div key={l}>{l}</div>
              ))}
            </div>
          ) : (
            <Spinner />
          )}
          <div className="ai-wiz-options" role="radiogroup" aria-label="Local model">
            {list.map((c) => (
              <label key={c.id} className={`ai-wiz-option${ws.model !== null && sameModel(c.id, ws.model) ? " active" : ""}${c.disabled ? " disabled" : ""}`}>
                <input type="radio" name="model" disabled={!!c.disabled} checked={ws.model !== null && sameModel(c.id, ws.model)} onChange={() => pick(c.id)} />
                <div className="grow">
                  <strong>{c.name}</strong> {c.id === rec?.recommended && <span className="chip tone-accent">Recommended</span>}
                  {c.id === rec?.alternative && <span className="chip tone-blue">Alternative</span>}
                  <div className="tiny muted">{c.detail}</div>
                  {c.disabled && <div className="tiny ai-warn">{c.disabled}</div>}
                </div>
                <div className="chips-row">
                  {c.installed && <span className="chip tone-green">installed</span>}
                  <span className={`chip tone-${c.tools ? "green" : "dim"}`}>{c.tools === null ? "tools ?" : c.tools ? "✓ tools" : "✗ tools"}</span>
                </div>
              </label>
            ))}
            <label className={`ai-wiz-option${ws.model === null ? " active" : ""}`}>
              <input type="radio" name="model" checked={ws.model === null} onChange={() => pick(null)} />
              <div className="grow">
                <strong>Claude only</strong>
                <div className="tiny muted">No local model. Agents and NEXUS's AI work use Claude; no AI Town townspeople.</div>
              </div>
            </label>
          </div>
        </div>
      );
      break;
    case "install":
      body = (
        <div className="stack">
          <p>
            {rich(t("platform.wizard.ollamaMissing", { method: o?.installer === "winget" ? t("platform.install.method.winget") : t("platform.wizard.methodScript") }), { name: <strong>Ollama</strong> })}
          </p>
          {o && o.installer === "winget" && !o.winget && <div className="notice notice-warn">winget is not available: install Ollama from ollama.com, then click Check again.</div>}
          <div className="row">
            <button className="btn btn-sm primary" disabled={!ollama} onClick={() => setConsent("install")}>
              <Download size={12} /> Install Ollama…
            </button>
            <button className="btn btn-sm ghost" onClick={() => void refresh()}>
              Check again
            </button>
          </div>
        </div>
      );
      break;
    case "download":
      body = (
        <div className="stack">
          {!ws.runtimeAnswering && (
            <div className="row">
              <span className="small">Ollama is installed but not running.</span>
              <button className="btn btn-sm primary" disabled={!!busy} onClick={async () => (await run("start", () => aiApi.runtimeStart("ollama"), "Ollama is running")) !== undefined && void refresh()}>
                {busy === "start" ? <Spinner /> : <Play size={12} />} Start Ollama
              </button>
            </div>
          )}
          {chosen?.assessment && (
            <div className="ai-wiz-option">
              <div className="grow">
                <strong>{chosen.name}</strong> <span className="muted small">· {formatBytes(chosen.assessment.model.sizeBytes)}</span>
                <PullBar p={pulls[chosen.id]} />
              </div>
              {ws.modelInstalled ? (
                <span className="chip tone-green">
                  <CircleCheck size={11} /> installed
                </span>
              ) : (
                !pulls[chosen.id] && (
                  <button className="btn btn-sm primary" disabled={!ws.runtimeAnswering} onClick={() => setConsent("download")}>
                    <Download size={12} /> Download…
                  </button>
                )
              )}
            </div>
          )}
          {embedding && (
            <div className="ai-wiz-option">
              <div className="grow">
                <strong>{embedding.model.name}</strong> <span className="muted small">· optional · {formatBytes(embedding.model.sizeBytes)} · needed by AI Town townspeople (memories)</span>
                <PullBar p={pulls[embedding.model.id]} />
              </div>
              {embeddingInstalled ? (
                <span className="chip tone-green">
                  <CircleCheck size={11} /> installed
                </span>
              ) : (
                !pulls[embedding.model.id] && (
                  <button className="btn btn-sm" disabled={!ws.runtimeAnswering} onClick={() => setConsent("embedding")}>
                    <Download size={12} /> Download…
                  </button>
                )
              )}
            </div>
          )}
        </div>
      );
      break;
    case "validate":
      body = (
        <div className="stack">
          <p>
            One real generation with <strong className="mono">{ws.model}</strong>: checks that it answers, measures its speed and reads its capabilities.
          </p>
          {!ws.runtimeAnswering && <div className="notice notice-warn small">Ollama is not running: start it from AI Engines → Runtimes, then Check again.</div>}
          <div className="row">
            <button
              className="btn btn-sm primary"
              disabled={!!busy || !ws.model}
              onClick={async () => {
                const v = (await run("validate", () => aiApi.validate(ws.model!))) as Validation | undefined;
                if (v) {
                  setValidation(v);
                  setWs((s) => ({ ...s, validated: true }));
                }
              }}
            >
              {busy === "validate" ? <Spinner /> : <Gauge size={12} />} Validate and benchmark
            </button>
            <button className="btn btn-sm ghost" onClick={() => void refresh()}>
              Check again
            </button>
            {busy === "validate" && <span className="muted small">The first call loads the model into memory; it can take a minute.</span>}
          </div>
          {validation && (
            <dl className="kv">
              <dt>Speed</dt>
              <dd className="mono">
                {validation.benchmark.tokensPerSecond !== null ? `${validation.benchmark.tokensPerSecond} tokens/s` : "not reported"} ·{" "}
                {(validation.benchmark.totalMs / 1000).toFixed(1)} s total
              </dd>
              <dt>Answer</dt>
              <dd className="small">{validation.benchmark.sample || "—"}</dd>
              <dt>Capabilities</dt>
              <dd className="chips-row">
                {(validation.capabilities ?? ["not reported"]).map((c) => (
                  <span key={c} className="chip tone-blue">
                    {c}
                  </span>
                ))}
              </dd>
              <dt>NEXUS agents</dt>
              <dd>{validation.tools && validation.anthropicApi ? <span className="chip tone-green">can run on it</span> : <span className="chip tone-amber">cannot run on it</span>}</dd>
              {validation.notes.map((n) => (
                <dd key={n} className="small muted">
                  {n}
                </dd>
              ))}
            </dl>
          )}
        </div>
      );
      break;
    case "configure":
      body = (
        <div className="stack">
          {ws.model ? (
            <>
              <div className="field">
                <span className="field-label">AI mode</span>
                <Segmented
                  label="AI mode"
                  value={mode}
                  onChange={(m) => {
                    setMode(m);
                    setWs((s) => ({ ...s, configured: false }));
                  }}
                  options={[
                    { value: "claude", label: "Claude" },
                    { value: "hybrid", label: "Hybrid (recommended)" },
                    { value: "local", label: "Local" },
                  ]}
                />
                <span className="field-hint">Hybrid: AI Town, simulation and light work on {ws.model}; planning, architecture and reviews on Claude.</span>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={!agentsCanBeLocal}
                  checked={centralLocal && agentsCanBeLocal}
                  onChange={(e) => {
                    setCentralLocal(e.target.checked);
                    setWs((s) => ({ ...s, configured: false }));
                  }}
                />{" "}
                Run the Central Agent on {ws.model}
                {!agentsCanBeLocal && <span className="muted small"> — not possible: {!tools ? "the model has no tool calling" : "Ollama's Anthropic API is not available"}</span>}
              </label>
              <label className="field">
                <span className="field-label">When local AI is unavailable</span>
                <select
                  className="input"
                  value={fallback}
                  onChange={(e) => {
                    setFallback(e.target.value as FallbackPolicy);
                    setWs((s) => ({ ...s, configured: false }));
                  }}
                >
                  <option value="ask">Ask me (Retry / Restart / Switch to Claude)</option>
                  <option value="retry">Retry automatically</option>
                  <option value="restart">Restart the runtime automatically</option>
                  <option value="switch_to_claude">Switch to Claude automatically</option>
                </select>
              </label>
            </>
          ) : (
            <p>NEXUS will use Claude for the Central Agent, workers and its own AI work.</p>
          )}
          <div className="row">
            <button
              className="btn btn-sm primary"
              disabled={!o || !!busy}
              onClick={async () => {
                if (!o) return;
                setBusy("save");
                const s = proposedSettings(o.settings, { model: ws.model, tools, runtime: ollama, mode, centralLocal });
                const saved = await saveAi({ ...s, fallback: ws.model ? fallback : s.fallback }, "AI engines configured");
                setBusy(null);
                if (saved) setWs((x) => ({ ...x, configured: true }));
              }}
            >
              {busy === "save" ? <Spinner /> : <Save size={12} />} Save configuration
            </button>
            {ws.configured && (
              <span className="chip tone-green">
                <CircleCheck size={11} /> saved
              </span>
            )}
          </div>
        </div>
      );
      break;
    case "done":
      body = (
        <div className="stack">
          <p>
            <CircleCheck size={14} className="ai-ok" aria-hidden="true" /> Setup complete.{" "}
            {ws.model ? (
              <>
                Local model: <strong className="mono">{ws.model}</strong>.{" "}
                {embeddingInstalled ? "AI Town townspeople can run on it (AI Engines → AI Town)." : "Townspeople also need the embedding model (AI Engines → AI Town)."}
              </>
            ) : (
              "NEXUS uses Claude."
            )}
          </p>
          {!projectOpen ? (
            <p className="muted small">Open a project: its AI World starts AI Town.</p>
          ) : town === null ? (
            <Spinner />
          ) : town.running ? (
            <button className="btn btn-sm primary" onClick={() => void finish(false).then(() => navigate({ name: "world" }))}>
              <Globe2 size={12} /> Open AI Town
            </button>
          ) : town.installed ? (
            <button
              className="btn btn-sm primary"
              disabled={!!busy}
              onClick={async () => {
                if ((await run("town", () => api.aiTownStart(), "AI Town started")) !== undefined) {
                  await finish(false);
                  navigate({ name: "world" });
                }
              }}
            >
              {busy === "town" ? <Spinner /> : <Play size={12} />} Start AI Town
            </button>
          ) : (
            <button className="btn btn-sm primary" onClick={() => void finish(false).then(() => navigate({ name: "world" }))}>
              <Globe2 size={12} /> Set up AI Town in AI World
            </button>
          )}
        </div>
      );
      break;
  }

  return (
    <Modal
      title="AI Setup"
      onClose={() => void finish(true)}
      locked={!!busy}
      width={720}
      className="ai-wizard"
      footer={
        <>
          {ws.step !== "done" && (
            <button className="btn ghost" disabled={!!busy} onClick={() => void finish(true)}>
              Skip setup
            </button>
          )}
          <span className="spacer" />
          {why && <span className="muted small ai-wiz-why">{why}</span>}
          {ws.step !== "welcome" && (
            <button className="btn" disabled={!!busy} onClick={() => setWs((s) => ({ ...s, step: prevStep(s) }))}>
              <ArrowLeft size={12} /> Back
            </button>
          )}
          {ws.step === "done" ? (
            <button className="btn primary" onClick={() => void finish(false)}>
              Finish
            </button>
          ) : (
            <button className="btn primary" disabled={!!why || !!busy} onClick={() => void next()}>
              {ws.step === "welcome" ? "Start" : "Next"} <ArrowRight size={12} />
            </button>
          )}
        </>
      }
    >
      <ol className="ai-wiz-steps" aria-label={`Step ${pos.index} of ${pos.total}`}>
        {activeSteps(ws).map((st, i) => (
          <li key={st} className={st === ws.step ? "active" : i < pos.index - 1 ? "done" : ""}>
            {STEP_LABELS[st]}
          </li>
        ))}
      </ol>
      <div className="ai-wiz-body">
        <h3 className="ai-wiz-title">
          <Cpu size={14} aria-hidden="true" /> {STEP_LABELS[ws.step]}
        </h3>
        {body}
      </div>
      {consent === "install" && ollama && <InstallConsent runtime={ollama} action="install" onClose={() => setConsent(null)} onDone={() => void refresh()} />}
      {consent === "download" && chosen?.assessment && (
        <DownloadConsent a={chosen.assessment} diskFreeMb={hw?.diskFreeMb ?? null} modelsDir={o?.modelsDir ?? ""} onClose={() => setConsent(null)} onStarted={() => undefined} />
      )}
      {consent === "embedding" && embedding && (
        <DownloadConsent a={embedding} diskFreeMb={hw?.diskFreeMb ?? null} modelsDir={o?.modelsDir ?? ""} onClose={() => setConsent(null)} onStarted={() => undefined} />
      )}
    </Modal>
  );
}

/** Opens the AI Setup wizard on first launch (never finished nor skipped), and whenever it is requested. */
export function AiSetupGate() {
  const open = useAiSetup((s) => s.open);
  const setOpen = useAiSetup((s) => s.setOpen);
  useEffect(() => {
    let alive = true;
    aiApi.setupState().then(
      (s) => {
        if (alive && s && !s.setupAt) setOpen(true);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [setOpen]);
  return open ? <SetupWizard onClose={() => setOpen(false)} /> : null;
}
