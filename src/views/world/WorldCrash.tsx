import { Activity, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { useT } from "../../i18n";

export interface WorldCrashInfo {
  message: string;
  /** Crash report id, null when it could not be saved (`saveError` says why). */
  reportId: string | null;
  saveError: string | null;
}

/** The world view crashed; the AI Town engine and every agent keep running. */
export function WorldCrash({ crash, safeMode, onRecover, onReload, onSafeMode, onDiagnostics }: {
  crash: WorldCrashInfo;
  safeMode: boolean;
  onRecover: () => void;
  onReload: () => void;
  onSafeMode: () => void;
  onDiagnostics: () => void;
}) {
  const t = useT();
  return (
    <div className="hq-crash" role="alertdialog" aria-label={t("worldhq.crash.title")}>
      <ShieldAlert size={22} />
      <p>{t("worldhq.crash.title")}</p>
      {crash.message && <div className="mono tiny muted">{t("worldhq.crash.error", { message: crash.message })}</div>}
      <div className="tiny muted">
        {crash.reportId ? t("worldhq.crash.saved", { id: crash.reportId }) : crash.saveError ? t("worldhq.crash.notSaved", { error: crash.saveError }) : null}
      </div>
      <div className="row hq-gap">
        <button className="btn btn-sm primary" onClick={onRecover}>
          <RotateCcw size={12} /> {t("worldhq.crash.recover")}
        </button>
        <button className="btn btn-sm" onClick={onReload}>
          <RefreshCw size={12} /> {t("worldhq.crash.reload")}
        </button>
        {!safeMode && (
          <button className="btn btn-sm" onClick={onSafeMode}>
            <ShieldAlert size={12} /> {t("worldhq.crash.safe")}
          </button>
        )}
        <button className="btn btn-sm" onClick={onDiagnostics}>
          <Activity size={12} /> {t("worldhq.crash.diagnostics")}
        </button>
      </div>
    </div>
  );
}
