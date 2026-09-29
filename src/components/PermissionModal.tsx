import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { formatClock } from "../lib/format";
import type { PermissionDecision } from "../lib/types";
import { useAgent, usePendingPermissions, useStore } from "../store";
import { Modal } from "./Modal";
import { JsonView } from "./Common";

/** Global permission prompt. Shows the oldest pending request; the queue is fed by snapshot + events. */
export function PermissionModal() {
  const queue = usePendingPermissions();
  const req = queue[0];
  const agent = useAgent(req?.agentId);
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  if (!req) return null;

  const decide = async (decision: PermissionDecision) => {
    setBusy(true);
    const ok = await run(() => api.resolvePermission(req.id, decision));
    setBusy(false);
    if (!ok) void refresh().catch(() => undefined);
  };

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
        </span>
      }
      footer={
        <>
          <button className="btn danger" onClick={() => void decide("reject")} disabled={busy} autoFocus>
            Reject
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
        </dd>
        <dt>Tool</dt>
        <dd className="mono">{req.toolName}</dd>
        <dt>Capability</dt>
        <dd>
          <span className="chip tone-amber">{req.capability}</span>
        </dd>
        <dt>Requested</dt>
        <dd>{formatClock(req.createdAt)}</dd>
      </dl>
      <div className="perm-summary mono">{req.summary}</div>
      {req.reason && <p className="perm-reason">{req.reason}</p>}
      <JsonView value={req.input} collapsible label="Tool input" />
      <p className="muted small">"Allow for this agent" saves the rule <code>{req.ruleKey}</code> for future requests.</p>
    </Modal>
  );
}
