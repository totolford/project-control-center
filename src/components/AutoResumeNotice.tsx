import { useState } from "react";
import "../styles/central.css";
import { History, MessageSquare, TriangleAlert, X } from "lucide-react";
import { centralApi } from "../lib/centralApi";
import type { AutoResumeNotice as Notice } from "../lib/centralTypes";
import { formatClock } from "../lib/format";
import { toast } from "../lib/toast";
import type { RecoveryInfo } from "../lib/types";
import { useRightContext } from "../state/context";
import { useStore } from "../store";
import { useT } from "../i18n";

/**
 * With Settings → Missions → Recovery → auto-resume on, NEXUS resumed the interrupted mission at open:
 * a non-blocking notice replaces the Resume / Inspect / Abandon dialog.
 */
export function AutoResumeNotice({ notice, recovery }: { notice: Notice; recovery: RecoveryInfo }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const openCentral = () => {
    const ctx = useRightContext.getState();
    ctx.openContext({ kind: "central" });
    ctx.setRightOpen(true);
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      await centralApi.dismissAutoResume();
      const rest = (recovery.missions?.length ?? 0) > 0 || recovery.agents.length > 0;
      useStore.setState((s) => (s.project ? { project: { ...s.project, recovery: rest ? { ...recovery, autoResumed: null } : null } } : {}));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`auto-resume notice ${notice.ok ? "" : "notice-warn"}`} role="status" data-testid="auto-resume-notice">
      {notice.ok ? <History size={14} aria-hidden="true" /> : <TriangleAlert size={14} aria-hidden="true" />}
      <div className="grow">
        <strong>{notice.ok ? t("central.autoResume.ok") : t("central.autoResume.failed")}</strong>
        {notice.missionId && (
          <span className="muted small">
            {" "}
            · {notice.missionId}
            {notice.title ? ` "${notice.title}"` : ""} · {formatClock(notice.at)}
          </span>
        )}
        <div className="small">{notice.summary}</div>
        {notice.ok && <div className="muted small">{t("central.autoResume.why")}</div>}
      </div>
      <button className="btn btn-sm" onClick={openCentral}>
        <MessageSquare size={12} /> {t("central.autoResume.openChat")}
      </button>
      <button className="icon-btn" onClick={() => void dismiss()} disabled={busy} aria-label={t("central.autoResume.dismiss")} title={t("central.autoResume.dismiss")}>
        <X size={13} />
      </button>
    </div>
  );
}
