import { useEffect, useState } from "react";
import { Save, TriangleAlert } from "lucide-react";
import type { AiEngineSettings, AiOverview, EngineProvider, FallbackPolicy } from "../../lib/aiTypes";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { useAgents, useReadOnly, useStore } from "../../store";
import { Field, Spinner } from "../../components/Common";
import { Segmented } from "../../components/Tabs";
import { engineLabel, engineWarnings, runtimeName } from "./aiLogic";
import { saveAi } from "./shared";

const PROVIDERS: { value: EngineProvider; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "local", label: "Local AI" },
  { value: "hybrid", label: "Hybrid" },
];

const FALLBACKS: { value: FallbackPolicy; label: string; hint: string }[] = [
  { value: "ask", label: "Ask me", hint: "Stop and show “Local AI unavailable” with Retry / Restart / Switch to Claude" },
  { value: "retry", label: "Retry", hint: "Retry the health check for a few seconds, then ask" },
  { value: "restart", label: "Restart runtime", hint: "Restart the local runtime once (also after a crash), then ask" },
  { value: "switch_to_claude", label: "Switch to Claude", hint: "Run on Claude instead; every switch is journaled" },
];

const RUNTIMES = ["ollama", "lmstudio", "llamacpp", "openai"];

/** Per-agent engine override (agent profile), else the project default. */
function AgentEngines({ ai }: { ai: AiEngineSettings }) {
  const agents = useAgents().filter((a) => a.status !== "retired");
  const readOnly = useReadOnly();
  const settings = useStore((s) => s.project?.settings);
  const [busy, setBusy] = useState<string | null>(null);
  if (!agents.length) return <p className="muted small">No agent in this project yet.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Engine</th>
          <th>Resolves to</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => {
          const kind = a.kind === "central" ? "central" : "worker";
          const claudeModel = a.model ?? (kind === "central" ? settings?.centralModel : settings?.workerModel) ?? null;
          const label = engineLabel(ai, kind, a.profile.engine ?? null, claudeModel);
          return (
            <tr key={a.id}>
              <td>
                <strong>{a.name}</strong>
                <div className="tiny muted">{a.role}</div>
              </td>
              <td>
                <select
                  className="input input-sm"
                  aria-label={`Engine of ${a.name}`}
                  value={a.profile.engine ?? ""}
                  disabled={readOnly || !!busy}
                  onChange={async (e) => {
                    const engine = (e.target.value || null) as EngineProvider | null;
                    setBusy(a.id);
                    const r = await attempt(() => api.updateAgent(a.id, { profile: { ...a.profile, engine } }), `${a.name}: engine applies at its next session start`);
                    setBusy(null);
                    if (r) void useStore.getState().refresh().catch(() => undefined);
                  }}
                >
                  <option value="">Project default ({kind === "central" ? ai.central : ai.workers})</option>
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="small">
                {busy === a.id ? <Spinner /> : <span className={label.local ? "ai-engine-local" : ""}>{label.text}</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function EnginesPanel({ data, onChanged }: { data: AiOverview; onChanged: () => void }) {
  const [draft, setDraft] = useState<AiEngineSettings>(data.settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(data.settings), [data.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const warnings = engineWarnings(draft, data.capacity, data.runtimes);
  const chatModels = data.models.filter((m) => !(m.capabilities ?? []).includes("embedding"));
  const set = (patch: Partial<AiEngineSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const setLocal = (patch: Partial<AiEngineSettings["local"]>) => setDraft((d) => ({ ...d, local: { ...d.local, ...patch } }));
  const cap = data.capacity;
  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-header">
          <h3>Engines</h3>
          <span className="muted small">{data.projectOpen ? "Saved for this project and as the default for new projects" : "Application default (no project open)"}</span>
        </header>
        <div className="panel-body ai-form">
          <Field label="AI mode" hint="NEXUS's own AI work (AI World conversations, summaries). Hybrid: light work local, planning, architecture and reviews on Claude." group>
            <Segmented
              label="AI mode"
              value={draft.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: "claude", label: "Claude" },
                { value: "local", label: "Local" },
                { value: "hybrid", label: "Hybrid" },
              ]}
            />
          </Field>
          <Field label="Central Agent provider" hint="Local AI = Claude Code running against the local runtime's Anthropic-compatible API with the local model." group>
            <Segmented label="Central Agent provider" value={draft.central} onChange={(central) => set({ central })} options={PROVIDERS} />
          </Field>
          <Field label="Workers (default)" hint="Hybrid: ordinary roles run locally when possible; reviewers, architects and leads stay on Claude. Each agent can override it below." group>
            <Segmented label="Workers provider" value={draft.workers} onChange={(workers) => set({ workers })} options={PROVIDERS} />
          </Field>
          <div className="ai-form-row">
            <Field label="Local runtime">
              <select className="input" value={draft.local.runtime} onChange={(e) => setLocal({ runtime: e.target.value, baseUrl: data.runtimes.find((r) => r.id === e.target.value)?.baseUrl ?? draft.local.baseUrl })}>
                {RUNTIMES.map((r) => (
                  <option key={r} value={r}>
                    {runtimeName(r)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Address">
              <input className="input mono" value={draft.local.baseUrl} onChange={(e) => setLocal({ baseUrl: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="Local model" hint={data.modelsError ? `Model list unavailable: ${data.modelsError}` : undefined}>
              <select className="input mono" value={draft.local.model ?? ""} onChange={(e) => setLocal({ model: e.target.value || null })}>
                <option value="">— none —</option>
                {draft.local.model && !chatModels.some((m) => m.name === draft.local.model) && <option value={draft.local.model}>{draft.local.model} (not installed)</option>}
                {chatModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                    {m.capabilities ? (m.capabilities.includes("tools") ? " · tools" : " · no tools") : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="When local AI is unavailable" hint={FALLBACKS.find((f) => f.value === draft.fallback)?.hint}>
            <select className="input" value={draft.fallback} onChange={(e) => set({ fallback: e.target.value as FallbackPolicy })}>
              {FALLBACKS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          {warnings.map((w) => (
            <div key={w} className="notice notice-warn small">
              <TriangleAlert size={12} aria-hidden="true" /> {w}
            </div>
          ))}
          <div className="row">
            <button
              className="btn btn-sm primary"
              disabled={!dirty || saving}
              onClick={async () => {
                setSaving(true);
                if (await saveAi(draft, "AI engines saved")) onChanged();
                setSaving(false);
              }}
            >
              {saving ? <Spinner /> : <Save size={12} />} Save
            </button>
            {dirty && (
              <button className="btn btn-sm ghost" onClick={() => setDraft(data.settings)}>
                Discard
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>Local AI now</h3>
          <span className={`chip tone-${cap.available ? "green" : "grey"}`}>{cap.available ? "available" : "unavailable"}</span>
        </header>
        <div className="panel-body">
          <dl className="kv">
            <dt>Runtime</dt>
            <dd>
              {runtimeName(data.settings.local.runtime)} <span className="mono muted small">{data.settings.local.baseUrl}</span>
            </dd>
            <dt>Model</dt>
            <dd className="mono">{cap.model ?? "—"}</dd>
            <dt>Tool calling</dt>
            <dd>{cap.available ? (cap.tools ? <span className="chip tone-green">yes · agents can run on it</span> : <span className="chip tone-amber">no · AI Town dialogue only</span>) : "—"}</dd>
            <dt>Context</dt>
            <dd className="mono small">{cap.available ? `${Math.round(cap.context / 1024)}K tokens` : "—"}</dd>
            <dt>Embeddings</dt>
            <dd className="mono small">{cap.embeddingModel ?? "no embedding model installed"}</dd>
            {!cap.available && cap.reason && (
              <>
                <dt>Why</dt>
                <dd className="small">{cap.reason}</dd>
              </>
            )}
          </dl>
        </div>
      </section>

      {data.projectOpen && (
        <section className="panel">
          <header className="panel-header">
            <h3>Agents</h3>
            <span className="muted small">Applies at each agent's next session start</span>
          </header>
          <div className="panel-body">
            <AgentEngines ai={data.settings} />
          </div>
        </section>
      )}
    </div>
  );
}
