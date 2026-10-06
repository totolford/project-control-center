import { useCallback, useEffect, useState } from "react";
import { Download, Globe2, Users, UserMinus } from "lucide-react";
import { aiApi } from "../../lib/aiApi";
import type { AiOverview, ModelAssessment, TownLocalStatus } from "../../lib/aiTypes";
import { attempt, toast } from "../../lib/toast";
import { useReadOnly, useStore } from "../../store";
import { Field, Spinner } from "../../components/Common";
import { DownloadConsent } from "./ModelsPanel";
import { PullBar, usePulls } from "./shared";

/**
 * "Townspeople (local AI)": AI Town's own LLM characters, driven by the local runtime only.
 * They are created only when the chat and embedding models are installed and answering.
 */
export function TownPanel({ data, onChanged }: { data: AiOverview; onChanged: () => void }) {
  const [status, setStatus] = useState<TownLocalStatus | null>(null);
  const [embedding, setEmbedding] = useState<ModelAssessment | null>(null);
  const [diskFree, setDiskFree] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [count, setCount] = useState(4);
  const [busy, setBusy] = useState<string | null>(null);
  const readOnly = useReadOnly();
  const navigate = useStore((s) => s.navigate);
  const load = useCallback(async () => {
    setStatus((await attempt(() => aiApi.townStatus())) ?? null);
    const rec = await attempt(() => aiApi.recommend());
    setEmbedding(rec?.models.find((m) => m.model.id === rec.embedding || m.model.embedding) ?? null);
    setDiskFree((await attempt(() => aiApi.hardware()))?.diskFreeMb ?? null);
  }, []);
  const pulls = usePulls(() => {
    onChanged();
    void load();
  });
  useEffect(() => {
    void load();
  }, [load, data]);
  if (!status) return <Spinner />;
  const r = status.readiness;
  const people = status.townspeople;
  const on = (people?.count ?? 0) > 0;
  const pulling = embedding ? pulls[embedding.model.id] : undefined;
  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-header">
          <h3>
            <Users size={14} aria-hidden="true" /> Townspeople (local AI)
          </h3>
          <span className={`chip tone-${on ? "green" : r.ready ? "blue" : "grey"}`}>{on ? `${people?.count} in town` : r.ready ? "ready" : "unavailable"}</span>
        </header>
        <div className="panel-body">
          <p className="muted small">
            AI Town's own characters walk, talk, remember and plan with the local model ({r.chatModel ?? "none selected"}) and the embedding model ({r.embeddingModel ?? "not installed"}).
            They never use Claude and never talk to the characters of NEXUS agents, which stay driven by the real agents only.
          </p>
          {r.reasons.length > 0 && (
            <div className="notice notice-warn small">
              <strong>Local AI unavailable for townspeople:</strong>
              <ul className="ai-reasons">
                {r.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {embedding && !embedding.installed && (
            <div className="row">
              {pulling ? (
                <PullBar p={pulling} />
              ) : (
                <button className="btn btn-sm" disabled={data.settings.local.runtime !== "ollama" || data.pulling.includes(embedding.model.id)} onClick={() => setConsent(true)}>
                  <Download size={12} /> Download {embedding.model.name}…
                </button>
              )}
            </div>
          )}
          {!status.aiTownRunning ? (
            <div className="row">
              <span className="muted small">AI Town is not running for this project.</span>
              <button className="btn btn-sm" disabled={!data.projectOpen} onClick={() => navigate({ name: "world" })}>
                <Globe2 size={12} /> Open AI World
              </button>
            </div>
          ) : (
            <>
              {status.error && <div className="notice notice-error small">{status.error}</div>}
              {people && (
                <p className="small">
                  {people.count} of {people.max} townspeople{people.names.length ? `: ${people.names.join(", ")}` : ""}.
                </p>
              )}
              <div className="row">
                <Field label="Add">
                  <input className="input input-sm mono ai-count" type="number" min={1} max={people ? Math.max(1, people.max - people.count) : 8} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} />
                </Field>
                <button
                  className="btn btn-sm primary"
                  disabled={!r.ready || readOnly || !!busy || (people ? people.count >= people.max : false)}
                  title={r.ready ? "" : r.reasons.join(" · ")}
                  onClick={async () => {
                    setBusy("add");
                    const res = await attempt(() => aiApi.addTownspeople(count));
                    if (res) toast.success(`${res.created} townspeople added (local AI)`);
                    setBusy(null);
                    void load();
                  }}
                >
                  {busy === "add" ? <Spinner /> : <Users size={12} />} Add townspeople
                </button>
                {on && (
                  <button
                    className="btn btn-sm danger-ghost"
                    disabled={readOnly || !!busy}
                    onClick={async () => {
                      setBusy("remove");
                      await attempt(() => aiApi.removeTownspeople(), "Townspeople removed");
                      setBusy(null);
                      void load();
                    }}
                  >
                    {busy === "remove" ? <Spinner /> : <UserMinus size={12} />} Remove all
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </section>
      {consent && embedding && <DownloadConsent a={embedding} diskFreeMb={diskFree} modelsDir={data.modelsDir} onClose={() => setConsent(false)} onStarted={onChanged} />}
    </div>
  );
}
