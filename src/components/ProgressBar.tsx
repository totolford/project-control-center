import { memo } from "react";
import { ratio } from "../lib/format";
import type { Mission } from "../lib/types";

/** `value` in [0, 1]; null renders an empty track with no percentage. */
export const ProgressBar = memo(function ProgressBar({
  value,
  failed,
  label,
}: {
  value: number | null;
  /** Share of failures in [0, 1], drawn in red after the done part. */
  failed?: number;
  label?: string;
}) {
  const pct = value == null ? 0 : Math.round(value * 100);
  const failPct = failed ? Math.round(failed * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : pct}>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        {failPct > 0 && <div className="progress-fail" style={{ width: `${failPct}%` }} />}
      </div>
      {(label || value != null) && <span className="progress-label">{label ?? `${pct}%`}</span>}
    </div>
  );
});

/** Mission progress = taskDone / taskTotal, failures shown in red. */
export function MissionProgress({ mission }: { mission: Mission }) {
  const done = ratio(mission.taskDone, mission.taskTotal);
  const failed = ratio(mission.taskFailed, mission.taskTotal);
  return (
    <ProgressBar
      value={done}
      failed={failed ?? undefined}
      label={mission.taskTotal > 0 ? `${mission.taskDone}/${mission.taskTotal} tasks` : "no tasks yet"}
    />
  );
}
