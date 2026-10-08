import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, LifeBuoy, X } from "lucide-react";
import { api, onEvent } from "../lib/api";
import { formatClock } from "../lib/format";
import type { CrashReport } from "../lib/types";
import { useStore } from "../store";
import { Chip } from "./StatusBadge";
import { useT } from "../i18n";

/** Reports still to show: not acknowledged, engine or application side (the interface shows its own). */
export function pendingReports(reports: CrashReport[]): CrashReport[] {
  return reports.filter((r) => !r.acknowledged && r.source !== "interface");
}

const SEVERITY_TONE = { info: "blue", warning: "amber", error: "red" } as const;

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <ul className="plain-list">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </dd>
    </>
  );
}

/**
 * "NEXUS recovered from an unexpected failure": each crash report is shown once, docked bottom-right
 * (never over the recovery dialog), and acknowledged when dismissed. History stays on the Diagnostics page.
 */
export function CrashReportNotice() {
  const t = useT();
  const recoveryOpen = useStore((s) => Boolean(s.project?.recovery));
  const projectRoot = useStore((s) => s.project?.info.root ?? null);
  const [reports, setReports] = useState<CrashReport[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api.crashReports().then(
      (all) => setReports(pendingReports(all ?? [])),
      () => undefined,
    );
  }, []);

  useEffect(load, [load, projectRoot]);
  useEffect(() => {
    const unlisten = onEvent((e) => {
      if (e.name === "recovery.report" || e.name === "recovery.reportUpdated") load();
    });
    return () => void unlisten.then((u) => u());
  }, [load]);

  if (recoveryOpen || reports.length === 0) return null;
  const r = reports[0];
  const dismiss = () => {
    setReports((list) => list.slice(1));
    setOpen(false);
    void api.acknowledgeCrashReport(r.id).catch(() => undefined);
  };

  return (
    <div className={`crash-notice sev-${r.severity}`} role="status" aria-live="polite">
      <div className="crash-notice-head">
        <LifeBuoy size={16} aria-hidden />
        <div className="crash-notice-title">
          <strong>{r.title}</strong>
          <span className="muted small">
            {r.component} · {formatClock(r.at)}
            {reports.length > 1 ? ` · ${t("comp.crash.more", { count: reports.length - 1 })}` : ""}
          </span>
        </div>
        <Chip tone={SEVERITY_TONE[r.severity] ?? "grey"}>{t.dynamic(`comp.severity.${r.severity}`, undefined, r.severity)}</Chip>
        <button className="icon-btn" onClick={() => setOpen(!open)} aria-label={open ? t("comp.hideDetails") : t("comp.showDetails")} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <button className="icon-btn" onClick={dismiss} aria-label={t("comp.crash.dismiss")}>
          <X size={14} />
        </button>
      </div>
      <div className="crash-notice-body small">{r.whatHappened}</div>
      {open && (
        <dl className="kv crash-notice-facts small">
          {r.possibleCause && (
            <>
              <dt>{t("comp.crash.cause")}</dt>
              <dd>{r.possibleCause}</dd>
            </>
          )}
          <List label={t("comp.crash.preserved")} items={r.preserved} />
          <List label={t("comp.crash.restarted")} items={r.restarted} />
          <List label={t("comp.crash.lost")} items={r.lost} />
          <List label={t("comp.details")} items={r.details} />
        </dl>
      )}
    </div>
  );
}
