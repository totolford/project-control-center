import { useEffect, useRef, useState } from "react";
import { Bot, Globe2, Plug, RefreshCw, ShieldCheck, Sparkles, SquareTerminal } from "lucide-react";
import type { CoreStatus } from "../../lib/types";
import { autoReloadHistory, pushAutoReload } from "./checkpoint";
import { fetchCoreStatus, reloadInterface, useHealth, type OverlayState } from "./health";
import { canAutoReload } from "./monitor";
import { useT } from "../../i18n";

/** Seconds before the overlay reloads the interface by itself. */
export const AUTO_RELOAD_SECONDS = 8;

function Preserved({ core }: { core: CoreStatus | null }) {
  const t = useT();
  if (!core) return <p className="sro-unknown">{t("health.engineSilent")}</p>;
  const town = core.aiTownRunning === null ? t("health.unknown") : core.aiTownRunning ? t("health.running") : t("health.notRunning");
  const rows = [
    { icon: Bot, label: t("health.agents"), value: core.projectOpen ? t("health.agentsValue", { running: core.runningAgents, working: core.workingAgents }) : t("health.noProject") },
    { icon: Sparkles, label: t("health.mission"), value: core.activeMission ? `${core.activeMission}${core.activeMissions > 1 ? ` (+${core.activeMissions - 1})` : ""}` : t("health.noneActive") },
    { icon: Plug, label: "MCP", value: core.mcpTotal > 0 ? t("health.mcpValue", { connected: core.mcpConnected, total: core.mcpTotal }) : t("health.noMcp") },
    { icon: Globe2, label: "AI Town", value: town },
    { icon: SquareTerminal, label: t("health.terminals"), value: String(core.terminals) },
  ];
  return (
    <dl className="sro-preserved" aria-label={t("health.stillRunning")}>
      {rows.map((r) => (
        <div key={r.label} className="sro-row">
          <dt>
            <r.icon size={13} aria-hidden="true" /> {r.label}
          </dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SafeRecoveryPanel({ overlay, onDismiss }: { overlay: OverlayState; onDismiss?: () => void }) {
  const core = useHealth((s) => s.core);
  const coreAt = useHealth((s) => s.coreAt);
  const [allowed] = useState(() => overlay.auto && canAutoReload(autoReloadHistory(), Date.now()));
  const [left, setLeft] = useState(AUTO_RELOAD_SECONDS);
  const [reloading, setReloading] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const t = useT();

  useEffect(() => {
    primary.current?.focus();
    void fetchCoreStatus();
    const timer = window.setInterval(() => void fetchCoreStatus(), 2000);
    // Leave a moment to read what is preserved before the page goes away.
    const now = overlay.immediate ? window.setTimeout(() => reloadRef.current(false), 1200) : undefined;
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(now);
    };
  }, [overlay.immediate]);

  const reload = (auto: boolean) => {
    if (reloading) return;
    setReloading(true);
    if (auto) pushAutoReload();
    void reloadInterface(overlay.forced ? "manual" : "degraded", overlay.reason);
  };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!allowed || reloading) return;
    if (left <= 0) {
      reload(true);
      return;
    }
    const timer = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  });

  const fresh = core !== null && coreAt !== null && Date.now() - coreAt < 10_000;
  return (
    <div className="sro-card" role="alertdialog" aria-modal="true" aria-labelledby="sro-title" aria-describedby="sro-desc">
      <div className="sro-badge">
        <ShieldCheck size={18} aria-hidden="true" />
      </div>
      <h2 id="sro-title">{t("health.notStopped")}</h2>
      <p id="sro-desc" className="sro-lead">
        {fresh ? t("health.engineRunning") : t("health.recovering")}
      </p>
      <p className="sro-reason">
        <span className="muted">{t("health.reason")}</span> {overlay.reason}
      </p>
      <div className="section-label">{t("health.stillRunning")}</div>
      <Preserved core={fresh ? core : null} />
      <p className="sro-note muted small">
        {t("health.restoredNote")}
      </p>
      <div className="sro-status" aria-live="polite">
        {reloading
          ? t("health.reloading")
          : allowed
            ? t("health.reloadingIn", { seconds: left })
            : overlay.auto
              ? t("health.autoPaused")
              : null}
      </div>
      <div className="sro-actions">
        <button ref={primary} className="btn primary" onClick={() => reload(false)} disabled={reloading}>
          <RefreshCw size={13} className={reloading ? "spin" : undefined} /> {t("health.reloadNow")}
        </button>
        {onDismiss && !reloading && (
          <button className="btn" onClick={onDismiss}>
            {t("health.keepWorking")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Full-window overlay shown when the interface is degraded (or on "Reload interface"). */
export function SafeRecoveryOverlay() {
  const overlay = useHealth((s) => s.overlay);
  const dismiss = useHealth((s) => s.dismissOverlay);
  if (!overlay) return null;
  return (
    <div className="sro-backdrop">
      <SafeRecoveryPanel overlay={overlay} onDismiss={dismiss} />
    </div>
  );
}
