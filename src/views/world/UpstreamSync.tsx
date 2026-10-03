import { useState } from "react";
import { GitMerge, RefreshCw, TriangleAlert } from "lucide-react";
import { Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { UpstreamApplyResult, UpstreamPlanAction, UpstreamReport } from "../../lib/types";

const ACTION_LABEL: Record<UpstreamPlanAction, string> = {
  take_upstream: "take upstream (unchanged by NEXUS)",
  add: "new upstream file",
  delete: "deleted upstream",
  merge_clean: "3-way merge, no conflict",
  conflict: "conflict: left for review",
};

/** "Sync with AI Town upstream": check (git clone of a16z-infra/ai-town), confirm, apply. */
export function UpstreamSync({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<UpstreamReport | null>(null);
  const [result, setResult] = useState<UpstreamApplyResult | null>(null);
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const check = async () => {
    setBusy("check");
    setResult(null);
    setReport((await attempt(() => api.aiTownUpstreamCheck())) ?? null);
    setBusy(null);
  };
  const apply = async () => {
    setConfirming(false);
    setBusy("apply");
    const r = await attempt(() => api.aiTownUpstreamApply(), "Upstream changes applied");
    setBusy(null);
    if (r) setResult(r);
  };

  const footer = result ? (
    <button className="btn primary" onClick={onClose}>
      Done
    </button>
  ) : confirming ? (
    <>
      <span className="tiny muted grow">A backup of the AI Town folder is made first. Conflicting files are never overwritten.</span>
      <button className="btn" onClick={() => setConfirming(false)}>
        Back
      </button>
      <button className="btn primary" onClick={() => void apply()}>
        <GitMerge size={13} /> Apply now
      </button>
    </>
  ) : (
    <>
      <button className="btn" disabled={busy !== null} onClick={() => void check()}>
        {busy === "check" ? <Spinner size={12} /> : <RefreshCw size={13} />} {report ? "Check again" : "Check upstream"}
      </button>
      {report && !report.upToDate && (
        <button className="btn primary" disabled={busy !== null || !report.writable} onClick={() => setConfirming(true)}>
          {busy === "apply" ? <Spinner size={12} /> : <GitMerge size={13} />} Apply…
        </button>
      )}
    </>
  );

  return (
    <Modal title="Sync with AI Town upstream" onClose={onClose} footer={footer} width={680} locked={busy !== null}>
      <div className="world-step">
        {!report && !busy && (
          <p className="small muted">
            Compares the AI Town inside NEXUS with the latest a16z-infra/ai-town on GitHub (NEXUS clones it with git into a temporary
            folder). Upstream changes are merged three ways with NEXUS's own changes; nothing is written before you confirm.
          </p>
        )}
        {busy === "check" && <div className="small muted">Cloning a16z-infra/ai-town and comparing…</div>}
        {report && <UpstreamReportView report={report} />}
        {result && (
          <>
            <div className="section-label">Applied</div>
            <div className="small">
              {result.applied.length} file(s) updated. Backup: <span className="mono">{result.backup}</span>
            </div>
            {result.leftForReview.length > 0 && (
              <div className="notice notice-warn world-gap">
                <TriangleAlert size={14} />
                <div>
                  {result.leftForReview.length} conflicting file(s) kept as they were; the upstream version is next to each as
                  <span className="mono"> &lt;file&gt;.upstream</span>:
                  <ul className="bullet-list mono tiny">
                    {result.leftForReview.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <div className="small world-gap">
              {result.newBase ? (
                <>
                  Now based on upstream <span className="mono">{result.newBase.slice(0, 7)}</span>.
                </>
              ) : (
                "The base commit stays the same until the conflicts are resolved."
              )}{" "}
              Rebuild the AI Town frontend and restart it to use the changes.
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function UpstreamReportView({ report }: { report: UpstreamReport }) {
  return (
    <>
      <dl className="kv">
        <dt>Base</dt>
        <dd className="mono">{report.base.slice(0, 7)}</dd>
        <dt>Upstream</dt>
        <dd className="mono">{report.head.slice(0, 7)}</dd>
        <dt>State</dt>
        <dd>{report.upToDate ? "Up to date" : `${report.upstreamCommits.length} new upstream commit(s)`}</dd>
        <dt>Changes</dt>
        <dd>
          {report.upstreamChanges.length} upstream · {report.localChanges.length} by NEXUS · {report.conflicts} conflict(s)
        </dd>
      </dl>
      {!report.writable && (
        <div className="notice notice-warn">
          <TriangleAlert size={14} /> This AI Town copy is read-only (installed NEXUS): apply the sync in a NEXUS source checkout.
        </div>
      )}
      {report.upstreamCommits.length > 0 && (
        <>
          <div className="section-label">Upstream commits</div>
          <ul className="bullet-list small aitown-list">
            {report.upstreamCommits.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      )}
      {report.plan.length > 0 && (
        <>
          <div className="section-label">Plan</div>
          <ul className="aitown-plan small aitown-list">
            {report.plan.map((p) => (
              <li key={p.path} className={p.action === "conflict" ? "tone-amber-fg" : undefined}>
                <span className="mono">{p.path}</span> — {ACTION_LABEL[p.action]}
                {p.conflicts ? ` (${p.conflicts})` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
