import { useCallback, useEffect, useState } from "react";
import { CircleCheck, Download, Gauge, Trash2, X } from "lucide-react";
import { aiApi } from "../../lib/aiApi";
import type { AiOverview, Benchmark, HardwareInfo, LocalModel, ModelAssessment, Recommendation } from "../../lib/aiTypes";
import { attempt, toast } from "../../lib/toast";
import { Spinner } from "../../components/Common";
import { downloadPlan, formatBytes, formatMb, runtimeName } from "./aiLogic";
import { ConsentModal, PullBar, saveAi, usePulls } from "./shared";

const FIT_LABEL: Record<string, { text: string; tone: string }> = {
  gpu: { text: "fits in VRAM", tone: "green" },
  partial: { text: "partly on CPU", tone: "amber" },
  too_large: { text: "too large", tone: "red" },
  unknown: { text: "hardware unknown", tone: "dim" },
};

/** Download consent: model, verified size, disk space, where it goes. */
export function DownloadConsent({
  a,
  diskFreeMb,
  modelsDir,
  onClose,
  onStarted,
}: {
  a: ModelAssessment;
  diskFreeMb: number | null;
  modelsDir: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const plan = downloadPlan(a, diskFreeMb);
  return (
    <ConsentModal
      title={`Download ${a.model.name}`}
      confirmLabel={`Download ${plan.size}`}
      onClose={onClose}
      onConfirm={() => {
        if (!plan.allowed) return;
        onStarted();
        // The command resolves when the download ends; progress arrives as events.
        aiApi.pullModel(a.model.id).then(
          () => toast.success(`${a.model.name} installed`),
          (e) => toast.error(e),
        );
      }}
    >
      <dl className="kv">
        <dt>Model</dt>
        <dd className="mono">{a.model.id}</dd>
        <dt>Download</dt>
        <dd>{plan.size} from the Ollama library (registry.ollama.ai)</dd>
        <dt>Stored in</dt>
        <dd className="mono small">{modelsDir}</dd>
        <dt>Free disk</dt>
        <dd>{formatMb(diskFreeMb)}</dd>
        <dt>Memory</dt>
        <dd>
          ~{formatMb(a.memoryNeededMb)} once loaded · {FIT_LABEL[a.fit].text}
        </dd>
      </dl>
      {!plan.allowed && <div className="notice notice-error">Cannot download: {plan.reason}.</div>}
      <p className="muted small">Nothing is downloaded until you confirm. You can cancel during the download.</p>
    </ConsentModal>
  );
}

function CatalogTable({
  rec,
  data,
  pulls,
  diskFreeMb,
  onChanged,
}: {
  rec: Recommendation;
  data: AiOverview;
  pulls: ReturnType<typeof usePulls>;
  diskFreeMb: number | null;
  onChanged: () => void;
}) {
  const [consent, setConsent] = useState<ModelAssessment | null>(null);
  const isOllama = data.settings.local.runtime === "ollama";
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Size</th>
            <th>Context</th>
            <th>Capabilities</th>
            <th>This PC</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rec.models.map((a) => {
            const fit = FIT_LABEL[a.fit];
            const pulling = pulls[a.model.id] ?? (data.pulling.includes(a.model.id) ? undefined : null);
            const tag = a.model.id === rec.recommended ? "Recommended" : a.model.id === rec.alternative ? "Alternative" : a.model.id === rec.embedding ? "AI Town embeddings" : null;
            return (
              <tr key={a.model.id}>
                <td>
                  <strong>{a.model.name}</strong> {tag && <span className="chip tone-accent">{tag}</span>}
                  <div className="mono tiny muted">{a.model.id}</div>
                  <div className="tiny muted">{a.model.goodFor}</div>
                </td>
                <td className="mono small">{formatBytes(a.model.sizeBytes)}</td>
                <td className="mono small">{Math.round(a.model.context / 1024)}K</td>
                <td>
                  <div className="chips-row">
                    {a.model.embedding ? <span className="chip tone-blue">embedding</span> : <span className={`chip tone-${a.model.tools ? "green" : "dim"}`}>{a.model.tools ? "✓" : "✗"} tools</span>}
                    {a.model.vision && <span className="chip tone-blue">vision</span>}
                    {a.model.thinking && <span className="chip tone-blue">thinking</span>}
                  </div>
                </td>
                <td>
                  <span className={`chip tone-${fit.tone}`}>{fit.text}</span>
                  {a.notes
                    .filter((n) => !/^Fits in GPU|^Needs ~/.test(n))
                    .map((n) => (
                      <div key={n} className="tiny muted">
                        {n}
                      </div>
                    ))}
                </td>
                <td className="ai-cell-actions">
                  {a.installed ? (
                    <span className="chip tone-green">
                      <CircleCheck size={11} /> installed
                    </span>
                  ) : pulling !== null ? (
                    <div className="ai-pull-cell">
                      <PullBar p={pulling ?? { model: a.model.id, status: "downloading", completed: null, total: null, percent: null, done: false, error: null }} />
                      <button className="icon-btn" aria-label={`Cancel download of ${a.model.id}`} onClick={() => void aiApi.cancelPull(a.model.id)}>
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn btn-sm"
                      disabled={!a.installable || !isOllama}
                      title={!isOllama ? "Downloads go through Ollama" : a.installable ? "" : a.notes.join(" · ")}
                      onClick={() => setConsent(a)}
                    >
                      <Download size={12} /> Download…
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {consent && (
        <DownloadConsent
          a={consent}
          diskFreeMb={diskFreeMb}
          modelsDir={data.modelsDir}
          onClose={() => setConsent(null)}
          onStarted={onChanged}
        />
      )}
    </>
  );
}

function InstalledTable({ data, onChanged }: { data: AiOverview; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [bench, setBench] = useState<Record<string, Benchmark>>({});
  const [del, setDel] = useState<LocalModel | null>(null);
  const current = data.settings.local.model;
  if (data.modelsError)
    return (
      <div className="notice notice-warn">
        {runtimeName(data.settings.local.runtime)} does not answer on {data.settings.local.baseUrl}: {data.modelsError}
      </div>
    );
  if (!data.models.length) return <p className="muted">No model installed in {runtimeName(data.settings.local.runtime)}.</p>;
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    const r = await attempt(fn, ok);
    setBusy(null);
    return r;
  };
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Installed model</th>
            <th>Size</th>
            <th>Capabilities</th>
            <th>State</th>
            <th>Speed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.models.map((m) => {
            const embedding = m.capabilities?.includes("embedding") ?? false;
            const b = bench[m.name];
            return (
              <tr key={m.name}>
                <td>
                  <strong className="mono">{m.name}</strong> {m.name === current && <span className="chip tone-accent">used by NEXUS</span>}
                  <div className="tiny muted">{[m.family, m.parameterSize, m.quantization].filter(Boolean).join(" · ")}</div>
                </td>
                <td className="mono small">{formatBytes(m.sizeBytes)}</td>
                <td>
                  <div className="chips-row">
                    {m.capabilities === null ? (
                      <span className="chip tone-dim">not reported</span>
                    ) : (
                      m.capabilities.map((c) => (
                        <span key={c} className={`chip tone-${c === "tools" ? "green" : "blue"}`}>
                          {c}
                        </span>
                      ))
                    )}
                  </div>
                </td>
                <td>{m.loaded ? <span className="chip tone-green">loaded</span> : <span className="chip tone-dim">on disk</span>}</td>
                <td className="mono small">{b ? (b.tokensPerSecond !== null ? `${b.tokensPerSecond} tok/s` : "—") : ""}</td>
                <td className="ai-cell-actions">
                  {!embedding && m.name !== current && (
                    <button
                      className="btn btn-sm"
                      disabled={!!busy}
                      onClick={async () => {
                        if (await saveAi({ ...data.settings, local: { ...data.settings.local, model: m.name } }, `NEXUS now uses ${m.name} locally`)) onChanged();
                      }}
                    >
                      Use
                    </button>
                  )}
                  {!embedding && (
                    <button
                      className="btn btn-sm ghost"
                      disabled={!!busy}
                      title="Tokens per second on a tiny prompt (the first run includes loading the model)"
                      onClick={async () => {
                        const r = await run(`bench:${m.name}`, () => aiApi.benchmark(m.name));
                        if (r) setBench((s) => ({ ...s, [m.name]: r as Benchmark }));
                      }}
                    >
                      {busy === `bench:${m.name}` ? <Spinner /> : <Gauge size={12} />} Benchmark
                    </button>
                  )}
                  {!embedding && (
                    <button
                      className="btn btn-sm ghost"
                      disabled={!!busy}
                      onClick={async () => {
                        if ((await run(`load:${m.name}`, () => aiApi.loadModel(m.name, !m.loaded), m.loaded ? `${m.name} unloaded` : `${m.name} loaded`)) !== undefined) onChanged();
                      }}
                    >
                      {busy === `load:${m.name}` && <Spinner />} {m.loaded ? "Unload" : "Load"}
                    </button>
                  )}
                  {data.settings.local.runtime === "ollama" && (
                    <button className="icon-btn" aria-label={`Delete ${m.name}`} title="Delete" disabled={!!busy} onClick={() => setDel(m)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {del && (
        <ConsentModal
          title={`Delete ${del.name}`}
          confirmLabel="Delete model"
          danger
          onClose={() => setDel(null)}
          onConfirm={async () => {
            if ((await attempt(() => aiApi.deleteModel(del.name), `${del.name} deleted`)) !== undefined) onChanged();
          }}
        >
          <p>
            Removes <strong className="mono">{del.name}</strong> ({formatBytes(del.sizeBytes)}) from Ollama's models folder. Downloading it again costs the full size.
          </p>
          {del.name === current && <div className="notice notice-warn">NEXUS is configured to use this model: local AI will be unavailable until you choose another one.</div>}
        </ConsentModal>
      )}
    </>
  );
}

export function ModelsPanel({ data, onChanged }: { data: AiOverview; onChanged: () => void }) {
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const loadRec = useCallback(async (refresh = false) => {
    // `refresh` re-detects the hardware: free disk space changes with every download.
    setRec((await attempt(() => aiApi.recommend(refresh))) ?? null);
    setHw((await attempt(() => aiApi.hardware())) ?? null);
  }, []);
  const pulls = usePulls(() => {
    onChanged();
    void loadRec(true);
  });
  useEffect(() => {
    void loadRec();
  }, [loadRec, data]);
  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-header">
          <h3>Installed in {runtimeName(data.settings.local.runtime)}</h3>
        </header>
        <div className="panel-body">
          <InstalledTable data={data} onChanged={onChanged} />
        </div>
      </section>
      <section className="panel">
        <header className="panel-header">
          <h3>Catalog</h3>
          <span className="muted small">Sizes from the Ollama registry manifests · fit computed from this PC's hardware</span>
        </header>
        <div className="panel-body">{rec ? <CatalogTable rec={rec} data={data} pulls={pulls} diskFreeMb={hw?.diskFreeMb ?? null} onChanged={onChanged} /> : <Spinner />}</div>
      </section>
    </div>
  );
}
