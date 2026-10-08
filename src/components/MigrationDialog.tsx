import { useState } from "react";
import { ArrowRightLeft, Check, Info, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { integrityLine } from "../lib/compat";
import { formatDateTime } from "../lib/format";
import { run } from "../lib/toast";
import { rollbackAndClose } from "../state/opsActions";
import { useStore } from "../store";
import { Modal } from "./Modal";
import { useT } from "../i18n";

/** Shown once after opening a project that NEXUS migrated to the current format. */
export function MigrationDialog() {
  const t = useT();
  const report = useStore((s) => s.project?.migration ?? null);
  const root = useStore((s) => s.project?.info.root ?? "");
  const clear = useStore((s) => s.clearMigration);
  const [busy, setBusy] = useState(false);
  if (!report) return null;

  const rollback = async () => {
    const ok = await ask(t("comp.mig.rollbackText", { format: String(report.fromFormat) }), {
      title: t("comp.mig.rollbackTitle"),
      kind: "warning",
      okLabel: t("comp.mig.rollBack"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setBusy(true);
    // On success the project closes and this dialog unmounts with it.
    if (!(await rollbackAndClose(root, report.backup.id))) setBusy(false);
  };

  return (
    <Modal
      title={
        <span className="perm-title">
          <ArrowRightLeft size={17} /> {t("comp.mig.title", { from: String(report.fromFormat), to: String(report.toFormat) })}
        </span>
      }
      width={600}
      onClose={clear}
      locked={busy}
      footer={
        <>
          <button className="btn danger" onClick={() => void rollback()} disabled={busy}>
            {t("comp.mig.rollback")}
          </button>
          <div className="spacer" />
          <button className="btn primary" onClick={clear} disabled={busy}>
            {t("common.ok")}
          </button>
        </>
      }
    >
      {!report.ok && <div className="notice notice-error">{t("comp.mig.integrityErrors")}</div>}
      <dl className="kv">
        <dt>{t("comp.mig.backup")}</dt>
        <dd>
          <button className="link-btn mono" onClick={() => void run(() => api.revealPath(report.backup.path))} title={t("comp.revealPath")}>
            {report.backup.path}
          </button>
          <div className="muted small">
            {formatDateTime(report.backup.createdAt)} · {report.backup.reason}
          </div>
        </dd>
        <dt>{t("comp.mig.report")}</dt>
        <dd>
          <button className="link-btn mono" onClick={() => void run(() => api.openPath(report.reportPath))}>
            {report.reportPath}
          </button>
        </dd>
      </dl>
      <div className="section-label">{t("comp.mig.steps")}</div>
      <ol className="migration-steps">
        {report.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="section-label">{t("comp.mig.integrity")}</div>
      <ul className="integrity-list">
        {report.integrity.map((line, i) => {
          const l = integrityLine(line);
          return (
            <li key={i} className={`integrity-${l.state}`}>
              {l.state === "ok" ? <Check size={12} /> : l.state === "error" ? <X size={12} /> : <Info size={12} />}
              <span>{l.text}</span>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
