import { CircleAlert, ShieldAlert } from "lucide-react";
import { isLive } from "../lib/labels";
import { useUi } from "../state/ui";
import { useAgents, useMissions, usePendingPermissions, useStore } from "../store";
import { MissionProgress } from "../components/ProgressBar";

/** One-line global status: mission progress, running agents, pending permissions, errors. */
export function StatusStrip() {
  const missions = useMissions();
  const agents = useAgents();
  const pending = usePendingPermissions().length;
  const turnErrors = useStore((s) => s.turnErrors);
  const navigate = useStore((s) => s.navigate);
  const setDeferred = useUi((s) => s.setPermissionsDeferred);
  const mission = [...missions].filter((m) => m.status === "active" || m.status === "planning").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const running = agents.filter((a) => isLive(a.status)).length;
  const errors = agents.filter((a) => a.status === "crashed" || turnErrors[a.id]).length;
  return (
    <div className="status-strip">
      <button className="strip-mission" onClick={() => navigate({ name: "missions" })} title={mission?.title}>
        {mission ? (
          <>
            <span className="ellipsis strip-title">{mission.title}</span>
            <MissionProgress mission={mission} />
          </>
        ) : (
          <span className="muted">No active mission</span>
        )}
      </button>
      <span className="strip-item">
        <span className={`dot tone-${running > 0 ? "green" : "grey"}`} /> {running} running
      </span>
      <button className={`strip-item${pending > 0 ? " warn" : ""}`} onClick={() => setDeferred(false)} disabled={pending === 0} title="Pending permission requests">
        <ShieldAlert size={12} /> {pending} pending
      </button>
      <span className={`strip-item${errors > 0 ? " error" : ""}`} title="Agents crashed or whose last turn failed">
        <CircleAlert size={12} /> {errors} {errors === 1 ? "error" : "errors"}
      </span>
    </div>
  );
}
