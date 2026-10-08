import { useEffect, useRef, useState } from "react";
import "../../styles/central.css";
import { FlaskConical, ShieldAlert } from "lucide-react";
import type { AiOverview } from "../../lib/aiTypes";
import { centralApi, onCapability } from "../../lib/centralApi";
import type { CapabilityReport, CapabilityResult, CapabilityStatus, CapabilityTest } from "../../lib/centralTypes";
import { formatDateTime } from "../../lib/format";
import { Spinner } from "../../components/Common";
import { useT } from "../../i18n";
import { runtimeName } from "./aiLogic";

export const CAPABILITY_TESTS: CapabilityTest[] = ["chat", "structured_output", "tool_call", "multi_step", "context", "recovery"];

const STATUS_TONE: Record<CapabilityStatus, string> = { pass: "green", limited: "amber", fail: "red", skipped: "grey" };

const norm = (m: string) => m.replace(/:latest$/, "");

/** The stored report for this runtime + model (`llama3` and `llama3:latest` are the same model). */
export function findReport(reports: CapabilityReport[], runtime: string, model: string | null): CapabilityReport | null {
  if (!model) return null;
  return reports.find((r) => r.runtime === runtime && norm(r.model) === norm(model)) ?? null;
}

/**
 * AI Runtime capability test of the configured local model: six real requests (chat, structured output,
 * tool call, multi-step, long context, tool error recovery), ✓ / ⚠ Limited / ✗ each. A model that cannot
 * call tools is shown as "Central Agent: Limited Tool Mode". Runs once by itself for an untested model.
 */
export function CapabilityPanel({ data, onTested }: { data: AiOverview; onTested: () => void }) {
  const t = useT();
  const { runtime } = data.settings.local;
  const model = data.settings.local.model;
  const ready = data.capacity.available && Boolean(model);
  const [reports, setReports] = useState<CapabilityReport[] | null>(null);
  const [live, setLive] = useState<CapabilityResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoRan = useRef<string | null>(null);

  useEffect(() => {
    centralApi.capabilityReports().then(setReports, () => setReports([]));
  }, []);

  const report = reports ? findReport(reports, runtime, model) : null;

  const runTest = async () => {
    if (!model || live) return;
    setError(null);
    setLive([]);
    const unlisten = await onCapability((p) => {
      if (norm(p.model) === norm(model)) setLive((l) => [...(l ?? []), p.result]);
    });
    try {
      const r = await centralApi.capabilityTest(model);
      setReports((all) => [...(all ?? []).filter((x) => !(x.runtime === r.runtime && norm(x.model) === norm(r.model))), r]);
      onTested();
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setLive(null);
    }
  };

  // A newly selected, installed and never tested model is tested once by itself.
  useEffect(() => {
    if (!ready || !model || reports === null || report || autoRan.current === `${runtime}/${model}`) return;
    autoRan.current = `${runtime}/${model}`;
    void runTest();
  }, [ready, model, runtime, reports, report]);

  const rows: CapabilityResult[] = live ?? report?.results ?? [];
  const mode = live ? null : report?.centralMode;
  return (
    <section className="panel capability-panel">
      <header className="panel-header">
        <h3>{t("central.cap.title")}</h3>
        {mode && (
          <span className={`chip tone-${mode === "full" ? "green" : mode === "limited_tools" ? "amber" : "red"}`} data-testid="central-mode">
            {t.dynamic(`central.cap.mode.${mode}`)}
          </span>
        )}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => void runTest()} disabled={!ready || Boolean(live)}>
          {live ? <Spinner size={11} /> : <FlaskConical size={12} />} {live ? t("central.cap.running", { done: live.length }) : report ? t("central.cap.rerun") : t("central.cap.run")}
        </button>
      </header>
      <div className="panel-body">
        {!model ? (
          <div className="muted small">{t("central.cap.noModel")}</div>
        ) : (
          <p className="muted small">{t("central.cap.subtitle", { runtime: runtimeName(runtime), model })}</p>
        )}
        {model && !ready && <div className="muted small">{data.capacity.reason ?? t("central.cap.unavailable")}</div>}
        {error && <div className="notice notice-error small">{t("central.cap.failed", { error })}</div>}
        {mode && mode !== "full" && (
          <div className="notice notice-warn small" data-testid="limited-tool-mode">
            <ShieldAlert size={12} aria-hidden="true" /> <strong>{t.dynamic(`central.cap.mode.${mode}`)}</strong> — {t("central.cap.mode.limitedHint")}
          </div>
        )}
        {(rows.length > 0 || live) && (
          <table className="table capability-table">
            <tbody>
              {CAPABILITY_TESTS.map((test, i) => {
                const r = rows.find((x) => x.test === test);
                return (
                  <tr key={test}>
                    <td className="capability-name">
                      {i + 1}. {t.dynamic(`central.cap.test.${test}`)}
                    </td>
                    <td>
                      {r ? (
                        <span className={`chip tone-${STATUS_TONE[r.status]}`}>{t.dynamic(`central.cap.status.${r.status}`)}</span>
                      ) : live ? (
                        <Spinner size={10} />
                      ) : null}
                    </td>
                    <td className="small">{r?.detail}</td>
                    <td className="mono small muted">{r && r.ms > 0 ? `${(r.ms / 1000).toFixed(1)} s` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {model && !live && (report ? <div className="muted small">{t("central.cap.testedAt", { when: formatDateTime(report.at) })}</div> : ready && <div className="muted small">{t("central.cap.never")}</div>)}
      </div>
    </section>
  );
}
