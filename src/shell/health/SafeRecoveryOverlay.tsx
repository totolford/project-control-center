import { useEffect, useRef, useState } from "react";
import { Bot, Globe2, Plug, RefreshCw, ShieldCheck, Sparkles, SquareTerminal } from "lucide-react";
import type { CoreStatus } from "../../lib/types";
import { autoReloadHistory, pushAutoReload } from "./checkpoint";
import { fetchCoreStatus, reloadInterface, useHealth, type OverlayState } from "./health";
import { canAutoReload } from "./monitor";

/** Seconds before the overlay reloads the interface by itself. */
export const AUTO_RELOAD_SECONDS = 8;

function Preserved({ core }: { core: CoreStatus | null }) {
  if (!core)
    return (
      <p className="sro-unknown">
        The engine is not answering the interface right now, so what it runs cannot be listed. Agents, missions and MCP run in the engine, not
        in this window; reloading the interface reconnects to it.
      </p>
    );
  const town = core.aiTownRunning === null ? "Unknown" : core.aiTownRunning ? "Running" : "Not running";
  const rows = [
    { icon: Bot, label: "Agents", value: core.projectOpen ? `${core.runningAgents} running · ${core.workingAgents} working` : "No project open" },
    { icon: Sparkles, label: "Mission", value: core.activeMission ? `${core.activeMission}${core.activeMissions > 1 ? ` (+${core.activeMissions - 1})` : ""}` : "None active" },
    { icon: Plug, label: "MCP", value: core.mcpTotal > 0 ? `${core.mcpConnected} of ${core.mcpTotal} connected` : "No MCP connection" },
    { icon: Globe2, label: "AI Town", value: town },
    { icon: SquareTerminal, label: "Terminals", value: String(core.terminals) },
  ];
  return (
    <dl className="sro-preserved" aria-label="Still running in the engine">
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

  useEffect(() => {
    primary.current?.focus();
    void fetchCoreStatus();
    const t = window.setInterval(() => void fetchCoreStatus(), 2000);
    // Leave a moment to read what is preserved before the page goes away.
    const now = overlay.immediate ? window.setTimeout(() => reloadRef.current(false), 1200) : undefined;
    return () => {
      window.clearInterval(t);
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
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  });

  const fresh = core !== null && coreAt !== null && Date.now() - coreAt < 10_000;
  return (
    <div className="sro-card" role="alertdialog" aria-modal="true" aria-labelledby="sro-title" aria-describedby="sro-desc">
      <div className="sro-badge">
        <ShieldCheck size={18} aria-hidden="true" />
      </div>
      <h2 id="sro-title">NEXUS is not stopped.</h2>
      <p id="sro-desc" className="sro-lead">
        {fresh ? "The application engine is still running. Recovering the interface…" : "Recovering the interface…"}
      </p>
      <p className="sro-reason">
        <span className="muted">Reason:</span> {overlay.reason}
      </p>
      <div className="section-label">Still running in the engine</div>
      <Preserved core={fresh ? core : null} />
      <p className="sro-note muted small">
        Open views, the right panel and the command-bar draft are restored after the reload. Workspace tabs are saved by the engine.
      </p>
      <div className="sro-status" aria-live="polite">
        {reloading
          ? "Reloading the interface…"
          : allowed
            ? `Reloading the interface in ${left} s`
            : overlay.auto
              ? "Automatic reload paused: the interface was already reloaded twice in the last 5 minutes."
              : null}
      </div>
      <div className="sro-actions">
        <button ref={primary} className="btn primary" onClick={() => reload(false)} disabled={reloading}>
          <RefreshCw size={13} className={reloading ? "spin" : undefined} /> Reload interface now
        </button>
        {onDismiss && !reloading && (
          <button className="btn" onClick={onDismiss}>
            Keep working
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
