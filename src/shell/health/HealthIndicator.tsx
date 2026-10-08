import { Activity } from "lucide-react";
import { StatusDot } from "../../components/StatusBadge";
import { useStore } from "../../store";
import { useHealth } from "./health";
import type { HealthLevel } from "./monitor";
import { useT, type MessageKey } from "../../i18n";

const LABEL: Record<HealthLevel, MessageKey> = { green: "health.level.green", amber: "health.level.amber", red: "health.level.red" };

/** Top-bar health light: green/amber/red from the renderer monitor and the engine heartbeat. Opens Diagnostics. */
export function HealthIndicator() {
  const signal = useHealth((s) => s.signal);
  const lastBeatAt = useHealth((s) => s.lastBeatAt);
  const navigate = useStore((s) => s.navigate);
  const t = useT();
  const waiting = lastBeatAt === null && signal.level === "green";
  const label = waiting ? t("health.connecting") : t(LABEL[signal.level]);
  const title = [
    t("health.title", { label }),
    waiting ? t("health.waiting") : signal.notes.length > 0 ? signal.notes.join("\n") : t("health.ok"),
    t("health.click"),
  ].join("\n");
  return (
    <button className={`indicator health-indicator level-${signal.level}`} onClick={() => navigate({ name: "diagnostics" })} title={title} aria-label={t("health.aria", { label })}>
      <StatusDot tone={waiting ? "grey" : signal.level} pulse={signal.level === "red"} />
      <Activity size={12} aria-hidden="true" />
      <span className="indicator-label">{label}</span>
    </button>
  );
}
