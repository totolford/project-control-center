import { useEffect, useState } from "react";
import "../../styles/central.css";
import { CircleCheck, CircleHelp, CircleX, Gauge, History, Hand, ShieldAlert } from "lucide-react";
import { formatClock } from "../../lib/format";
import { useAgent } from "../../store";
import { useT } from "../../i18n";
import type { MissionBlock } from "../../lib/centralTypes";
import type { ParsedResumeReport } from "./chatModel";
import { AUTONOMY_TONE, autonomyOf } from "./centralLogic";
import { subscribeCentral, useCentral } from "./centralState";

/** The verified recovery report NEXUS gave Central, as a card: headline, progress, MCP, facts. */
export function ResumeCard({ report, ts }: { report: ParsedResumeReport; ts: string }) {
  const t = useT();
  const [showInstruction, setShowInstruction] = useState(false);
  const title = report.nothing
    ? t("central.resume.nothing")
    : report.recovered
      ? t("central.resume.recovered")
      : report.headline.startsWith("Resume report requested")
        ? t("central.resume.requested")
        : t("central.resume.resumed");
  const pct = report.progress && report.progress.total > 0 ? Math.round((report.progress.verified / report.progress.total) * 100) : null;
  const facts = report.facts.filter((f) => f.label !== "MCP" || report.mcp.length === 0);
  return (
    <div className={`chat-card resume-card${report.recovered ? " is-recovered" : ""}${report.nothing ? " is-nothing" : ""}`} data-testid="resume-card">
      <div className="chat-meta">
        <History size={11} aria-hidden="true" /> {t("central.resume.from")} <span className="chat-time">{formatClock(ts)}</span>
      </div>
      <div className="resume-title">{title}</div>
      {report.progress && (
        <div className="resume-progress" title={facts.find((f) => f.label === "Verified progress")?.value}>
          <span className="small">{t("central.resume.progress", { verified: report.progress.verified, total: report.progress.total })}</span>
          <div className="resume-bar" role="progressbar" aria-valuemin={0} aria-valuemax={report.progress.total} aria-valuenow={report.progress.verified}>
            <div style={{ width: `${pct ?? 0}%` }} />
          </div>
        </div>
      )}
      {report.mcp.length > 0 && (
        <ul className="resume-mcp">
          {report.mcp.map((m) => {
            const Icon = m.state === "ok" ? CircleCheck : m.state === "failed" ? CircleX : CircleHelp;
            return (
              <li key={m.server} className={`tone-${m.state === "ok" ? "green" : m.state === "failed" ? "red" : "grey"}-fg`} title={m.detail}>
                <Icon size={11} aria-hidden="true" /> <span className="mono">MCP {m.server}</span> <span className="muted small">{t.dynamic(`central.mcp.${m.state}`, undefined, m.state)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <dl className="kv resume-facts">
        {facts.map((f) => (
          <div key={f.label} className="resume-fact">
            <dt>{t.dynamic(`central.fact.${f.label}`, undefined, f.label)}</dt>
            <dd className={f.label === "Next action" ? "is-next" : undefined}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {report.instruction && (
        <>
          <button className="link-btn small" onClick={() => setShowInstruction(!showInstruction)} aria-expanded={showInstruction}>
            {t("central.resume.instruction")}
          </button>
          {showInstruction && <div className="chat-text muted small">{report.instruction}</div>}
        </>
      )}
    </div>
  );
}

/** A supervisor reminder (AgentExecutionLoop): collapsed, it is NEXUS talking to Central. */
export function SupervisorNote({ text, ts }: { text: string; ts: string }) {
  const t = useT();
  return (
    <details className="chat-details chat-supervisor">
      <summary title={t("central.supervisor.hint")}>
        <Gauge size={11} aria-hidden="true" /> {t("central.supervisor.title")} · {formatClock(ts)}
      </summary>
      <div className="chat-text">{text}</div>
    </details>
  );
}

/** Keeps central_state fresh while mounted. */
export function useCentralState() {
  useEffect(() => subscribeCentral(), []);
  return useCentral((s) => s.state);
}

/** "Mission M-0003 waits for you: <reason>" above the Central composer. */
export function MissionBlocks({ blocks }: { blocks: MissionBlock[] }) {
  const t = useT();
  if (blocks.length === 0) return null;
  return (
    <div className="mission-blocks" role="status">
      {blocks.map((b) => (
        <div key={b.missionId} className="mission-block">
          <Hand size={12} aria-hidden="true" />
          <div className="grow">
            <div>
              <strong>{t("central.blocked.title", { id: b.missionId })}</strong> <span className="chip tone-amber">{t.dynamic(`central.blocked.needs.${b.needs}`, undefined, b.needs)}</span>
            </div>
            <div className="small">{b.reason}</div>
            <div className="muted small">{t("central.blocked.hint")}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Central's autonomy level (its power preset) as a chip for the panel header. */
export function AutonomyChip() {
  const t = useT();
  const central = useAgent("central");
  if (!central) return null;
  const a = autonomyOf(central.permissions);
  return (
    <span className={`chip tone-${AUTONOMY_TONE[a.label]} autonomy-chip`} title={t("central.autonomy.chipTitle")}>
      {t("central.autonomy.chip", { level: a.label })}
    </span>
  );
}

/** "Limited Tool Mode" chip when Central is configured on a local model that cannot call tools. */
export function LimitedToolChip() {
  const t = useT();
  const state = useCentralState();
  const cap = state?.localCapability;
  if (!state || state.engine === "claude" || !cap || cap.centralMode === "full") return null;
  return (
    <span className="chip tone-amber autonomy-chip" title={`${t.dynamic(`central.cap.mode.${cap.centralMode}`)} — ${t("central.cap.mode.limitedHint")}`}>
      <ShieldAlert size={10} aria-hidden="true" /> {t("central.cap.chipLimited")}
    </span>
  );
}
