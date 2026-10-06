import { useCallback, useEffect, useState } from "react";
import { Route as RouteIcon, RefreshCw } from "lucide-react";
import { aiApi } from "../../lib/aiApi";
import type { AiOverview, Level, RouteDecision, RouteRequest, RoutingJournalEntry, TaskKind } from "../../lib/aiTypes";
import { formatDateTime } from "../../lib/format";
import { attempt } from "../../lib/toast";
import { Field, Spinner } from "../../components/Common";

const TASKS: { value: TaskKind; label: string }[] = [
  { value: "npc_dialogue", label: "AI Town / NPC dialogue" },
  { value: "simulation", label: "World simulation" },
  { value: "summary", label: "Summary" },
  { value: "classification", label: "Classification" },
  { value: "simple_analysis", label: "Simple analysis" },
  { value: "code_edit", label: "Code edit" },
  { value: "mission_planning", label: "Mission planning" },
  { value: "architecture", label: "Architecture" },
  { value: "final_review", label: "Final review" },
  { value: "embedding", label: "Embedding" },
  { value: "agent_session", label: "Agent session" },
  { value: "other", label: "Other" },
];

const LEVELS: Level[] = ["low", "medium", "high"];

const PROVIDER_TONE: Record<RouteDecision["provider"], string> = { claude: "accent", local: "green", unavailable: "red" };

function Decision({ d }: { d: RouteDecision }) {
  return (
    <span className="ai-decision">
      <span className={`chip tone-${PROVIDER_TONE[d.provider]}`}>{d.provider === "local" ? `local · ${d.model ?? "?"}` : d.provider}</span>
      <span className="small">{d.reason}</span>
      <span className="mono tiny muted">{d.rule}</span>
    </span>
  );
}

const EMPTY: RouteRequest = {
  task: "npc_dialogue",
  complexity: "low",
  contextTokens: 0,
  requiredTools: false,
  private: false,
  latency: "low",
  cost: "low",
  agentRole: null,
  agentKind: null,
};

export function RouterPanel({ data }: { data: AiOverview }) {
  const [req, setReq] = useState<RouteRequest>(EMPTY);
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [journal, setJournal] = useState<RoutingJournalEntry[] | null>(null);
  const loadJournal = useCallback(async () => setJournal((await attempt(() => aiApi.routingJournal(200))) ?? []), []);
  useEffect(() => {
    void loadJournal();
  }, [loadJournal]);
  const set = (p: Partial<RouteRequest>) => {
    setReq((r) => ({ ...r, ...p }));
    setDecision(null);
  };
  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-header">
          <h3>ModelRouter</h3>
          <span className="muted small">
            Mode <strong>{data.settings.mode}</strong> · fixed rules · every real decision is journaled
          </span>
        </header>
        <div className="panel-body ai-form">
          <p className="muted small">
            Claude mode: everything on Claude. Local mode: everything on the local model, or unavailable. Hybrid: AI Town, simulation, summaries, classification and simple
            analysis run locally; mission planning, architecture, final reviews, high complexity, Central and lead roles stay on Claude. Private data never leaves the PC;
            embeddings exist only locally.
          </p>
          <div className="ai-form-row">
            <Field label="Task">
              <select className="input" value={req.task} onChange={(e) => set({ task: e.target.value as TaskKind })}>
                {TASKS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Complexity">
              <select className="input" value={req.complexity} onChange={(e) => set({ complexity: e.target.value as Level })}>
                {LEVELS.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </Field>
            <Field label="Context (tokens)">
              <input className="input mono" type="number" min={0} value={req.contextTokens} onChange={(e) => set({ contextTokens: Math.max(0, Number(e.target.value) || 0) })} />
            </Field>
            <Field label="Agent role">
              <input className="input" value={req.agentRole ?? ""} placeholder="e.g. Code reviewer" onChange={(e) => set({ agentRole: e.target.value || null })} />
            </Field>
          </div>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={req.requiredTools} onChange={(e) => set({ requiredTools: e.target.checked })} /> Needs tools
            </label>
            <label className="check">
              <input type="checkbox" checked={req.private} onChange={(e) => set({ private: e.target.checked })} /> Private data
            </label>
            <label className="check">
              <input type="checkbox" checked={req.cost === "high"} onChange={(e) => set({ cost: e.target.checked ? "high" : "low" })} /> Save Claude usage
            </label>
            <span className="spacer" />
            <button
              className="btn btn-sm primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setDecision((await attempt(() => aiApi.routePreview(req))) ?? null);
                setBusy(false);
              }}
            >
              {busy ? <Spinner /> : <RouteIcon size={12} />} Preview route
            </button>
          </div>
          {decision && (
            <div className="ai-preview">
              <Decision d={decision} /> <span className="tiny muted">(preview, not journaled)</span>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>Routing journal</h3>
          <button className="btn btn-sm ghost" onClick={() => void loadJournal()}>
            <RefreshCw size={12} /> Refresh
          </button>
        </header>
        <div className="panel-body">
          {journal === null ? (
            <Spinner />
          ) : journal.length === 0 ? (
            <p className="muted small">No routing decision yet. Agents on Local/Hybrid engines, AI World conversations and townspeople record theirs here.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th>Task</th>
                  <th>Mode</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {journal.map((j, i) => (
                  <tr key={`${j.ts}-${i}`}>
                    <td className="mono tiny">{formatDateTime(j.ts)}</td>
                    <td className="mono small">{j.source}</td>
                    <td className="small">{TASKS.find((t) => t.value === j.request.task)?.label ?? j.request.task}</td>
                    <td className="small">{j.mode}</td>
                    <td>
                      <Decision d={j.decision} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
