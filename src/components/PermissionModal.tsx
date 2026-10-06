import { useEffect, useState } from "react";
import { RotateCcw, SearchCheck, ShieldAlert } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { toast } from "../lib/toast";
import { formatClock } from "../lib/format";
import {
  appliedText,
  CHECKING_TEXT,
  expiryText,
  reportDetails,
  riskLabel,
  STALE_HEADLINE,
  STATUS_LABEL,
  STATUS_TONE,
} from "../lib/permissionState";
import type { PermissionDecision, PermissionRecord, PermissionStatusReport } from "../lib/types";
import { useAgent, usePendingPermissions, useStore } from "../store";
import { useUi } from "../state/ui";
import { Modal } from "./Modal";
import { JsonView } from "./Common";

/** A decision that arrived too late: what the backend said, then the real state it reports. */
interface Stale {
  req: PermissionRecord;
  message: string;
  report: PermissionStatusReport | null;
  /** The status lookup itself failed (backend unreachable...). */
  lookupError: string | null;
}

/** Global permission prompt. Shows the oldest pending request; the queue is fed by snapshot + events. */
export function PermissionModal() {
  const queue = usePendingPermissions();
  const req = queue[0];
  const agent = useAgent(req?.agentId);
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState<Stale | null>(null);
  const deferred = useUi((s) => s.permissionsDeferred);
  const setDeferred = useUi((s) => s.setPermissionsDeferred);
  const newestId = queue[queue.length - 1]?.id;

  // A new request brings the prompt back even if it was put aside.
  useEffect(() => {
    if (newestId) setDeferred(false);
  }, [newestId, setDeferred]);

  if (stale) return <StalePermission stale={stale} onClose={() => setStale(null)} />;
  if (!req || deferred) return null;

  const decide = async (decision: PermissionDecision) => {
    setBusy(true);
    try {
      const outcome = await api.resolvePermission(req.id, decision);
      if (outcome.applied) {
        toast.success(appliedText(outcome));
      } else {
        // Double click, stale list, ended session, restart: explain instead of failing.
        setStale({ req, message: outcome.message, report: null, lookupError: null });
        void refresh().catch(() => undefined);
        try {
          const report = await api.permissionStatus(req.id);
          setStale((s) => (s && s.req.id === req.id ? { ...s, report } : s));
        } catch (e) {
          const lookupError = errorMessage(e);
          setStale((s) => (s && s.req.id === req.id ? { ...s, lookupError } : s));
        }
      }
    } catch (e) {
      toast.error(e);
      void refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const risk = riskLabel(req.risk);
  const expiry = expiryText(req.expiresAt);

  return (
    <Modal
      className="perm-modal"
      locked
      width={620}
      onClose={() => undefined}
      title={
        <span className="perm-title">
          <ShieldAlert size={18} className="tone-amber-fg" /> Permission requested
          {queue.length > 1 && <span className="chip tone-amber">1 of {queue.length}</span>}
          {req.status === "recovered" && <span className={`chip tone-${STATUS_TONE.recovered}`}>{STATUS_LABEL.recovered}</span>}
        </span>
      }
      footer={
        <>
          <button className="btn danger" onClick={() => void decide("reject")} disabled={busy} autoFocus>
            Reject
          </button>
          <button className="btn ghost" onClick={() => setDeferred(true)} disabled={busy} title="Hide until a new request arrives (status bar shows pending count)">
            Later
          </button>
          <div className="spacer" />
          <button className="btn" onClick={() => void decide("allow_once")} disabled={busy}>
            Allow once
          </button>
          <button className="btn primary" onClick={() => void decide("allow_always")} disabled={busy}>
            Allow for this agent
          </button>
        </>
      }
    >
      <dl className="kv">
        <dt>Agent</dt>
        <dd>
          <strong>{agent?.name ?? req.agentId}</strong>
          {agent && <span className="muted"> · {agent.role}</span>}
          {req.processId != null && <span className="muted mono"> · pid {req.processId}</span>}
        </dd>
        <dt>Tool</dt>
        <dd className="mono">{req.toolName}</dd>
        <dt>Capability</dt>
        <dd>
          <span className="chip tone-amber">{req.capability}</span> <span className={`chip tone-${risk.tone}`}>{risk.text}</span>
        </dd>
        {req.resource && (
          <>
            <dt>Resource</dt>
            <dd className="mono perm-resource">{req.resource}</dd>
          </>
        )}
        {req.missionId && (
          <>
            <dt>Mission</dt>
            <dd className="mono">{req.missionId}</dd>
          </>
        )}
        <dt>Requested</dt>
        <dd>
          {formatClock(req.createdAt)}
          {expiry && <span className="muted"> · {expiry}</span>}
        </dd>
      </dl>
      {req.status === "recovered" && req.resolution && <p className="muted small">Re-linked: {req.resolution}.</p>}
      <div className="perm-summary mono">{req.summary}</div>
      {req.reason && <p className="perm-reason">{req.reason}</p>}
      <JsonView value={req.input} collapsible label="Tool input" />
      <p className="muted small">"Allow for this agent" saves the rule <code>{req.ruleKey}</code> for future requests.</p>
    </Modal>
  );
}

/** Explains a request the user acted on after it ended, from the backend's real state. */
export function StalePermission({ stale, onClose }: { stale: Stale; onClose: () => void }) {
  const { req, report, message, lookupError } = stale;
  const [asking, setAsking] = useState(false);
  const status = report?.record?.status ?? null;

  const askAgain = async () => {
    setAsking(true);
    try {
      toast.info(await api.rerequestPermission(req.id));
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setAsking(false);
    }
  };

  return (
    <Modal
      className="perm-modal perm-stale"
      width={560}
      onClose={onClose}
      title={
        <span className="perm-title">
          <SearchCheck size={18} /> Permission request
          {status && <span className={`chip tone-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>}
        </span>
      }
      footer={
        <>
          <div className="spacer" />
          {report?.canRerequest && (
            <button className="btn" onClick={() => void askAgain()} disabled={asking}>
              <RotateCcw size={14} /> Ask the agent again
            </button>
          )}
          <button className="btn primary" onClick={onClose} autoFocus>
            Close
          </button>
        </>
      }
    >
      <p className="perm-stale-head">
        <strong>{STALE_HEADLINE}</strong> {!report && !lookupError && <span className="muted">{CHECKING_TEXT}</span>}
      </p>
      <div className="perm-summary mono">{req.summary}</div>
      {!report && <p>{message}</p>}
      {lookupError && <p className="tone-red-fg small">The agent's state could not be checked: {lookupError}</p>}
      {report && (
        <>
          <p>{report.explanation}</p>
          <ul className="perm-stale-details small">
            {reportDetails(report).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <dl className="kv">
            <dt>Agent</dt>
            <dd>
              {report.agentName ?? req.agentId}
              {report.agentStatus && <span className="muted"> · {report.agentStatus}</span>}
            </dd>
            <dt>Session</dt>
            <dd>{report.sessionAlive ? `running${report.processId != null ? ` · pid ${report.processId}` : ""}` : "not running"}</dd>
          </dl>
        </>
      )}
    </Modal>
  );
}
