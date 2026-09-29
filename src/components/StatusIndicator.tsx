import { memo } from "react";
import { VISUAL_STATE, type VisualState } from "../workspace/agentState";
import { StatusDot } from "./StatusBadge";

/** Derived agent state: dot + label (or dot only). */
export const StatusIndicator = memo(function StatusIndicator({ state, dotOnly }: { state: VisualState; dotOnly?: boolean }) {
  const meta = VISUAL_STATE[state];
  return (
    <span className={`status-badge tone-${meta.tone}`} data-state={state} title={meta.label}>
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      {!dotOnly && <span className="state-label">{meta.label}</span>}
    </span>
  );
});
