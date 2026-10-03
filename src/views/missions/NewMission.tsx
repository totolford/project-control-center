// "+ New Mission": objective → automatic analysis (one short Claude Code call,
// an estimate) → requirements and skill recommendation → Start / Queue.
// Availability is checked by NEXUS against what is really installed; the
// selection is stored on the mission and handed to Central.

import { useEffect, useMemo, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { formatCost } from "../../lib/format";
import { readPref, writePref } from "../../lib/prefs";
import { attempt } from "../../lib/toast";
import type { Mission, MissionAnalysis, MissionClaudeContext, MissionRequirement, Priority } from "../../lib/types";
import { Segmented } from "../../components/Tabs";
import { Spinner } from "../../components/Common";
import { useClaudeEnv, useSkills } from "../../state/claude";
import { useRightContext } from "../../state/context";
import { useAgents, useConnections, useMissions, useStore } from "../../store";
import {
  fixView,
  isRunning,
  modelNames,
  skillChoices,
  skillInvocationName,
  type SkillChoice,
  type SkillRecommendationInput,
} from "./logic";
import "./missions.css";

type Step = "objective" | "analyzing" | "review";
type SkillMode = "all" | "select" | "none";

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const isModel = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function toggle(list: string[], name: string, on: boolean): string[] {
  return on ? (list.includes(name) ? list : [...list, name]) : list.filter((x) => x !== name);
}

function Missing({ req, kind }: { req: { detail: string | null; marketId?: string | null }; kind: "skills" | "mcp" | "connections" }) {
  const navigate = useStore((s) => s.navigate);
  const openContext = useRightContext((s) => s.openContext);
  const marketId = req.marketId;
  if (kind === "skills" && marketId) {
    // Details and install (with the user's confirmation) in the market's skill panel.
    return (
      <span className="req-missing">
        {req.detail ?? "unavailable"} ·{" "}
        <button className="link-btn" onClick={() => openContext({ kind: "skill", marketId })}>
          view in Market
        </button>
      </span>
    );
  }
  const where = { skills: "Skills", market: "Market", mcp: "MCP", connections: "Connections" } as const;
  const view = fixView(kind, req.detail);
  return (
    <span className="req-missing">
      {req.detail ?? "unavailable"} ·{" "}
      <button className="link-btn" onClick={() => navigate({ name: view })}>
        fix in {where[view as keyof typeof where] ?? view}
      </button>
    </span>
  );
}

function RequirementRows({
  kind,
  reqs,
  selected,
  onToggle,
}: {
  kind: "mcp" | "connections";
  reqs: MissionRequirement[];
  selected: string[];
  onToggle: (name: string, on: boolean) => void;
}) {
  if (reqs.length === 0) return <div className="muted small">None needed according to the estimate.</div>;
  return (
    <ul className="req-list">
      {reqs.map((r) => (
        <li key={r.name} className="req">
          <input
            type="checkbox"
            aria-label={`Use ${r.name}`}
            checked={selected.includes(r.name)}
            disabled={!r.available}
            onChange={(e) => onToggle(r.name, e.target.checked)}
          />
          <div className="grow">
            <div className="req-name">
              {r.available ? <span className="tone-green-fg">✓ </span> : null}
              {r.name}
            </div>
            {r.reason && <div className="req-reason">{r.reason}</div>}
            {!r.available && <Missing req={r} kind={kind} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SkillRows({ items, selected, onToggle, selectable }: { items: SkillChoice[]; selected: string[]; onToggle: (n: string, on: boolean) => void; selectable: boolean }) {
  return (
    <ul className="req-list">
      {items.map((c) => (
        <li key={c.name} className="req">
          {selectable && c.usable && (
            <input type="checkbox" aria-label={`Use ${c.name}`} checked={selected.includes(c.name)} onChange={(e) => onToggle(c.name, e.target.checked)} />
          )}
          <div className="grow">
            <div className="req-name">
              {c.usable ? <span className="tone-green-fg">✓ </span> : null}
              <span className="mono">{c.name}</span>
              {c.source && <span className="muted tiny"> · {c.source}</span>}
            </div>
            {c.reason && <div className="req-reason">{c.reason}</div>}
            {!c.usable && <Missing req={c} kind="skills" />}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function NewMission({ initialText, onClose, onCreated }: { initialText: string; onClose: () => void; onCreated: (m: Mission) => void }) {
  const missions = useMissions();
  const agents = useAgents();
  const connections = useConnections();
  const { env } = useClaudeEnv();
  const { skills: installed } = useSkills();
  const models = modelNames(env?.models);

  const [step, setStep] = useState<Step>("objective");
  const [objective, setObjective] = useState(initialText);
  const [priority, setPriority] = useState<Priority>("normal");
  const [analysisModel, setAnalysisModel] = useState(() => readPref("missionAnalysisModel", "haiku", isModel));
  const [analysis, setAnalysis] = useState<MissionAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [recs, setRecs] = useState<SkillRecommendationInput[] | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [skillMode, setSkillMode] = useState<SkillMode>("all");
  const [skills, setSkills] = useState<string[]>([]);
  const [mcp, setMcp] = useState<string[]>([]);
  const [conns, setConns] = useState<string[]>([]);
  const [startNow, setStartNow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setObjective(initialText), [initialText]);

  const choices = useMemo(() => skillChoices(analysis, recs, installed), [analysis, recs, installed]);
  const running = missions.some(isRunning);
  const extraSkills = useMemo(
    () =>
      (installed ?? [])
        .filter((s) => s.enabled)
        .map(skillInvocationName)
        .filter((n) => !choices.relevant.some((c) => c.name === n))
        .sort(),
    [installed, choices],
  );

  const analyze = async (withClaude: boolean) => {
    const text = objective.trim();
    if (!text) return;
    setAnalysis(null);
    setAnalysisError(null);
    setRecs(null);
    setRecError(null);
    setStep(withClaude ? "analyzing" : "review");
    writePref("missionAnalysisModel", analysisModel);
    const recP = api.recommendSkills(text).then(setRecs, (e) => setRecError(errorMessage(e)));
    if (withClaude) {
      const claude: MissionClaudeContext = {
        mcpServers: env ? env.mcpServers.map((s) => ({ name: String(s.name ?? ""), status: typeof s.status === "string" ? s.status : null })) : null,
        models,
      };
      try {
        const a = await api.analyzeMission(text, analysisModel, claude);
        setAnalysis(a);
        setTitle(a.title);
        if (a.model && models.includes(a.model)) setModel(a.model);
        setMcp(a.mcp.filter((r) => r.available).map((r) => r.name));
        setConns(a.connections.filter((r) => r.available).map((r) => r.name));
      } catch (e) {
        setAnalysisError(errorMessage(e));
      }
    }
    await recP;
    setStep("review");
  };

  // "Use all" follows the relevant list as it arrives.
  useEffect(() => {
    if (skillMode === "all") setSkills(choices.relevant.map((c) => c.name));
    if (skillMode === "none") setSkills([]);
  }, [skillMode, choices]);

  const start = async () => {
    setBusy(true);
    const m = await attempt(
      () =>
        api.createMissionWith({
          prompt: objective.trim(),
          title: title.trim() || null,
          priority,
          model: model || null,
          skills: skillMode === "none" ? [] : skills,
          mcp,
          connections: conns,
          analysis,
          startNow: running && startNow,
        }),
      running && !startNow ? "Mission queued" : "Mission sent to Central",
    );
    setBusy(false);
    if (m) onCreated(m);
  };

  const steps: { key: Step; label: string }[] = [
    { key: "objective", label: "1 Objective" },
    { key: "analyzing", label: "2 Analysis" },
    { key: "review", label: "3 Review and start" },
  ];
  const stepIndex = steps.findIndex((s) => s.key === step);

  return (
    <section className="panel pad newm" aria-label="New mission">
      <div className="row">
        <ol className="newm-steps grow" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s.key} aria-current={i === stepIndex ? "step" : undefined} className={i < stepIndex ? "done" : undefined}>
              {s.label}
              {i < steps.length - 1 && <span aria-hidden="true"> ›</span>}
            </li>
          ))}
        </ol>
        <button className="icon-btn" onClick={onClose} aria-label="Close New Mission" title="Close">
          <X size={14} />
        </button>
      </div>

      <label className="field">
        <span className="newm-question">What do you want to accomplish?</span>
        <textarea
          value={objective}
          autoFocus
          disabled={step !== "objective"}
          placeholder="e.g. Improve the Works panel: clearer layout, loading states, tests"
          onChange={(e) => setObjective(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void analyze(true);
          }}
        />
      </label>

      {step === "objective" && (
        <>
          <div className="row">
            <span className="muted small">Priority</span>
            <Segmented options={PRIORITY_OPTIONS} value={priority} onChange={setPriority} label="Priority" />
            <span className="spacer" />
            <label className="row small muted">
              Analysis model
              <select value={analysisModel} onChange={(e) => setAnalysisModel(e.target.value)}>
                {Array.from(new Set([analysisModel, ...models])).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="newm-footer">
            <span className="muted tiny grow">
              Analysis = one short Claude Code call (tools disabled) with your agents, skills, MCP servers and connections. It costs tokens.
            </span>
            <button className="btn" disabled={!objective.trim()} onClick={() => void analyze(false)}>
              Skip analysis
            </button>
            <button className="btn primary" disabled={!objective.trim()} onClick={() => void analyze(true)}>
              <Sparkles size={13} /> Analyze
            </button>
          </div>
        </>
      )}

      {step === "analyzing" && (
        <div className="row muted" role="status">
          <Spinner /> Analyzing with {analysisModel}… (one Claude Code call, usually 5–30 s)
        </div>
      )}

      {step === "review" && (
        <>
          {analysisError && (
            <div className="newm-error" role="alert">
              <strong>Analysis unavailable:</strong> {analysisError}
              <div className="row small" style={{ marginTop: 6 }}>
                <span className="muted grow">You can start the mission anyway; Central plans it from the objective.</span>
                <button className="btn btn-sm" onClick={() => void analyze(true)}>
                  Retry
                </button>
              </div>
            </div>
          )}

          {analysis && (
            <div>
              <div className="newm-estimate">
                Estimate by {analysis.analyzedWith}
                {analysis.costUsd != null && ` · ${formatCost(analysis.costUsd)}`} — Central makes the real plan.
              </div>
              {analysis.summary && <div className="small">{analysis.summary}</div>}
            </div>
          )}

          <div className="form-row">
            <label className="field">
              <span className="field-label">Title</span>
              <input value={title} placeholder="Defaults to the first line of the objective" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div className="field">
              <span className="field-label">Priority</span>
              <Segmented options={PRIORITY_OPTIONS} value={priority} onChange={setPriority} label="Priority" />
            </div>
          </div>

          <div className="newm-grid">
            {analysis && (
              <div className="newm-box">
                <h4>Required agents</h4>
                {analysis.agents.length === 0 ? (
                  <div className="muted small">Central decides.</div>
                ) : (
                  <ul className="req-list">
                    {analysis.agents.map((a, i) => {
                      const existing = agents.find((x) => x.id === a.existing);
                      return (
                        <li key={i} className="req">
                          <div className="grow">
                            <div className="req-name">
                              {existing ? <span className="tone-green-fg">✓ </span> : null}
                              {a.role}
                            </div>
                            <div className="req-reason">
                              {existing ? `existing: ${existing.name}` : "Central will create it"}
                              {a.reason && ` · ${a.reason}`}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            {analysis && (
              <div className="newm-box">
                <h4>Estimated steps · {analysis.estimatedSteps}</h4>
                {analysis.steps.length === 0 ? (
                  <div className="muted small">No step listed.</div>
                ) : (
                  <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {analysis.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                )}
              </div>
            )}

            <div className="newm-box" style={{ gridColumn: "1 / -1" }}>
              <h4>Skills</h4>
              <div className="row" style={{ marginBottom: 6 }}>
                <Segmented
                  label="Skills"
                  value={skillMode}
                  onChange={setSkillMode}
                  options={[
                    { value: "all", label: "Use all" },
                    { value: "select", label: "Select" },
                    { value: "none", label: "Continue without" },
                  ]}
                />
                <span className="muted tiny grow">
                  Central is told to invoke the chosen skills with the Skill tool and to pass them to its workers.
                </span>
              </div>
              {choices.relevant.length === 0 && choices.recommended.length === 0 ? (
                <div className="muted small">
                  No skill suggested
                  {recError ? ` (${recError})` : ""}
                  {!analysis ? "; the analysis was skipped" : ""}.
                </div>
              ) : (
                <>
                  {choices.relevant.length > 0 && <div className="section-label" style={{ marginTop: 4 }}>Relevant</div>}
                  <SkillRows
                    items={choices.relevant}
                    selected={skills}
                    selectable={skillMode === "select"}
                    onToggle={(n, on) => setSkills((v) => toggle(v, n, on))}
                  />
                  {choices.recommended.length > 0 && <div className="section-label">Recommended (not ready)</div>}
                  <SkillRows items={choices.recommended} selected={skills} selectable={false} onToggle={() => undefined} />
                </>
              )}
              {skillMode === "select" && extraSkills.length > 0 && (
                <label className="row small muted" style={{ marginTop: 6 }}>
                  Add an installed skill
                  <select value="" onChange={(e) => e.target.value && setSkills((v) => toggle(v, e.target.value, true))}>
                    <option value="">—</option>
                    {extraSkills.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {skillMode === "select" && skills.filter((s) => !choices.relevant.some((c) => c.name === s)).length > 0 && (
                <div className="row small">
                  {skills
                    .filter((s) => !choices.relevant.some((c) => c.name === s))
                    .map((s) => (
                      <button key={s} className="chip" onClick={() => setSkills((v) => toggle(v, s, false))} title="Remove">
                        {s} ×
                      </button>
                    ))}
                </div>
              )}
            </div>

            <div className="newm-box">
              <h4>MCP servers</h4>
              {analysis ? (
                <RequirementRows kind="mcp" reqs={analysis.mcp} selected={mcp} onToggle={(n, on) => setMcp((v) => toggle(v, n, on))} />
              ) : (
                <div className="muted small">No estimate (analysis skipped or unavailable).</div>
              )}
            </div>

            <div className="newm-box">
              <h4>Connections</h4>
              {connections.length === 0 && !analysis?.connections.length ? (
                <div className="muted small">This project has no connection.</div>
              ) : (
                <>
                  {analysis && analysis.connections.some((r) => !r.available) && (
                    <RequirementRows
                      kind="connections"
                      reqs={analysis.connections.filter((r) => !r.available)}
                      selected={conns}
                      onToggle={() => undefined}
                    />
                  )}
                  <ul className="req-list">
                    {connections.map((c) => {
                      const req = analysis?.connections.find((r) => r.name === c.id);
                      return (
                        <li key={c.id} className="req">
                          <input
                            type="checkbox"
                            aria-label={`Use ${c.name}`}
                            checked={conns.includes(c.id)}
                            disabled={!c.enabled}
                            onChange={(e) => setConns((v) => toggle(v, c.id, e.target.checked))}
                          />
                          <div className="grow">
                            <div className="req-name">
                              {c.name} <span className="muted tiny">{c.kind}</span>
                            </div>
                            {req?.reason && <div className="req-reason">{req.reason}</div>}
                            {!c.enabled && <span className="req-missing">disabled</span>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>

            <div className="newm-box">
              <h4>Model for the workers</h4>
              <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model for the workers">
                <option value="">Central decides</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              {analysis?.model && (
                <div className="req-reason" style={{ marginTop: 4 }}>
                  Suggested: {analysis.model}
                  {analysis.modelReason && ` · ${analysis.modelReason}`}
                </div>
              )}
            </div>
          </div>

          <div className="newm-footer">
            {running && (
              <label className="checkbox small grow">
                <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
                Another mission is running: start this one now instead of queueing it
              </label>
            )}
            <button className="btn" disabled={busy} onClick={() => setStep("objective")}>
              Back
            </button>
            <button className="btn primary" disabled={busy || !objective.trim()} onClick={() => void start()}>
              {busy ? <Spinner /> : null} {running && !startNow ? "Queue Mission" : "Start Mission"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
