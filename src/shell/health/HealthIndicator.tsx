import { Activity } from "lucide-react";
import { StatusDot } from "../../components/StatusBadge";
import { useStore } from "../../store";
import { useHealth } from "./health";
import type { HealthLevel } from "./monitor";

const LABEL: Record<HealthLevel, string> = { green: "Healthy", amber: "Warnings", red: "Degraded" };

/** Top-bar health light: green/amber/red from the renderer monitor and the engine heartbeat. Opens Diagnostics. */
export function HealthIndicator() {
  const signal = useHealth((s) => s.signal);
  const lastBeatAt = useHealth((s) => s.lastBeatAt);
  const navigate = useStore((s) => s.navigate);
  const waiting = lastBeatAt === null && signal.level === "green";
  const label = waiting ? "Connecting" : LABEL[signal.level];
  const title = [
    `Interface health: ${label}`,
    waiting ? "Waiting for the first answer from the engine" : signal.notes.length > 0 ? signal.notes.join("\n") : "Engine heartbeat OK, no errors or stalls",
    "Click for Diagnostics",
  ].join("\n");
  return (
    <button className={`indicator health-indicator level-${signal.level}`} onClick={() => navigate({ name: "diagnostics" })} title={title} aria-label={`Interface health: ${label}. Open Diagnostics`}>
      <StatusDot tone={waiting ? "grey" : signal.level} pulse={signal.level === "red"} />
      <Activity size={12} aria-hidden="true" />
      <span className="indicator-label">{label}</span>
    </button>
  );
}
