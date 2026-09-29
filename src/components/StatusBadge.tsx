import { memo } from "react";
import { AGENT_STATUS, type Tone } from "../lib/labels";
import type { AgentStatus } from "../lib/types";

export const StatusDot = memo(function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={`dot tone-${tone}${pulse ? " pulse" : ""}`} aria-hidden="true" />;
});

/** Coloured chip with a label, used for task/mission/connection statuses and event kinds. */
export const Chip = memo(function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`chip tone-${tone}`}>
      {children}
    </span>
  );
});

/** Agent status: dot + label, exactly mirroring `agent.status`. */
export const StatusBadge = memo(function StatusBadge({ status }: { status: AgentStatus }) {
  const meta = AGENT_STATUS[status] ?? { label: status, tone: "grey" as Tone };
  return (
    <span className={`status-badge tone-${meta.tone}`} data-status={status} title={meta.label}>
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      <span>{meta.label}</span>
    </span>
  );
});
