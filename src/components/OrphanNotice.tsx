import { useCallback, useEffect, useState } from "react";
import { Skull, X } from "lucide-react";
import { api, onEvent } from "../lib/api";
import { attempt } from "../lib/toast";
import type { Orphan, OrphanCleanup } from "../lib/types";
import { useStore } from "../store";
import { Spinner } from "./Common";

/**
 * Processes left running by a previous NEXUS run. Nothing is stopped automatically: the user
 * chooses, and a cleanup goes through state check, reason, saved context, modified files, soft stop.
 */
export function OrphanNotice() {
  const projectRoot = useStore((s) => s.project?.info.root ?? null);
  const recoveryOpen = useStore((s) => Boolean(s.project?.recovery));
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [last, setLast] = useState<OrphanCleanup | null>(null);

  const load = useCallback(() => {
    api.recoveryState().then(
      (s) => setOrphans(s?.project?.orphans ?? []),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    setHidden(false);
    if (projectRoot) load();
  }, [projectRoot, load]);
  useEffect(() => {
    const unlisten = onEvent((e) => {
      if (e.name === "recovery.orphansFound") {
        setHidden(false);
        load();
      }
    });
    return () => void unlisten.then((u) => u());
  }, [load]);

  if (!projectRoot || recoveryOpen || hidden || orphans.length === 0) return null;

  const cleanup = async (o: Orphan) => {
    setBusy(o.pid);
    const r = await attempt(() => api.cleanupOrphan(o.pid));
    setBusy(null);
    if (r) {
      setLast(r);
      if (r.terminated || r.alreadyGone) setOrphans((list) => list.filter((x) => x.pid !== o.pid));
    }
  };

  return (
    <div className="crash-notice orphan-notice" role="status" aria-live="polite">
      <div className="crash-notice-head">
        <Skull size={16} aria-hidden />
        <div className="crash-notice-title">
          <strong>
            {orphans.length} process{orphans.length === 1 ? "" : "es"} left by a previous NEXUS run
          </strong>
          <span className="muted small">Still running without NEXUS. Nothing is stopped unless you ask.</span>
        </div>
        <button className="icon-btn" onClick={() => setHidden(true)} aria-label="Keep them running and hide">
          <X size={14} />
        </button>
      </div>
      <ul className="plain-list small">
        {orphans.map((o) => (
          <li key={o.pid} className="orphan-row">
            <div>
              <strong>{o.label}</strong> <span className="muted">· PID {o.pid}</span>
              <div className="muted">{o.reason}</div>
            </div>
            <button className="btn btn-sm danger" onClick={() => void cleanup(o)} disabled={busy !== null}>
              {busy === o.pid ? <Spinner size={12} /> : null} Clean up
            </button>
          </li>
        ))}
      </ul>
      {last && (
        <dl className="kv crash-notice-facts small">
          {last.steps.map((s) => (
            <div key={s.step} style={{ display: "contents" }}>
              <dt>{s.step}</dt>
              <dd>{s.outcome}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
