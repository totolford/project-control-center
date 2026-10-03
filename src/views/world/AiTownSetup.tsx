import { useState } from "react";
import { Download, Info, Map as MapIcon, Play, RefreshCw, TriangleAlert, Wand2 } from "lucide-react";
import { Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import type { AiTownStatus } from "../../lib/types";
import { hostPhase } from "./aitown";
import type { AiTownBusy } from "./aiTownStore";

/** What "Install" really does, said before anything is downloaded. */
export function InstallConsent({ status, onConfirm, onClose }: { status: AiTownStatus; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      title="Install AI Town on this PC?"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={onConfirm}>
            <Download size={13} /> Install and start
          </button>
        </>
      }
    >
      <div className="aitown-consent">
        <p>NEXUS will:</p>
        <ol>
          <li>
            Copy the AI Town bundled with NEXUS to <span className="mono">{status.runtimeDir}</span>.
          </li>
          <li>
            Run <span className="mono">npm ci</span> there: it downloads AI Town's npm packages from the npm registry (a few
            hundred MB).
          </li>
          <li>
            On first start, the Convex CLI downloads the Convex local backend binary, then runs it on 127.0.0.1 only.
          </li>
        </ol>
        <ul className="bullet-list">
          <li>The world's data stays on this PC. No Convex account, no cloud deployment.</li>
          <li>Nothing in your project files changes.</li>
          <li>AI Town's own LLM agents are not used: characters only move and talk when your real NEXUS agents do.</li>
        </ul>
        {status.needsReinstall && (
          <div className="notice notice-warn">
            <TriangleAlert size={14} /> The bundled AI Town changed since the last install: its packages are installed again.
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Not running yet: prerequisites, state and the one-click path in. */
export function AiTownSetup({
  status,
  busy,
  progress,
  error,
  frontendBuilt,
  onOneClick,
  onRefresh,
  onUseNative,
  onAbout,
}: {
  status: AiTownStatus;
  busy: AiTownBusy;
  progress: string[];
  error: string | null;
  frontendBuilt: boolean | null;
  onOneClick: () => void;
  onRefresh: () => void;
  onUseNative: () => void;
  onAbout: () => void;
}) {
  const phase = hostPhase(status);
  const [showLog, setShowLog] = useState(false);
  const lastError = error ?? status.lastError;
  const lines = progress.length > 0 ? progress : status.log;
  const blocked = phase === "no-node" || phase === "no-source";

  return (
    <div className="aitown-setup">
      <div className="aitown-setup-head">
        <MapIcon size={28} className="tone-accent-fg" />
        <h1>AI Town</h1>
        <p className="muted">
          Your project as a living pixel-art town, on the real AI Town engine (a16z-infra/ai-town). Every NEXUS agent is a
          character: it walks to the building of what it is really doing, talks when it really sends a message, and
          raises its hand (✋) when it needs your approval. Nothing is animated that did not happen.
        </p>
        <div className="row">
          <button className="btn primary world-hero-cta" disabled={blocked || busy !== null} onClick={onOneClick}>
            {busy ? <Spinner size={13} /> : phase === "stopped" ? <Play size={15} /> : <Wand2 size={15} />}
            {busy === "install" ? " Installing…" : busy === "start" ? " Starting…" : phase === "stopped" ? " START AI TOWN" : " MAKE THIS PROJECT AN AI TOWN"}
          </button>
          <button className="btn" onClick={onRefresh} disabled={busy !== null}>
            <RefreshCw size={13} /> Check again
          </button>
          <button className="btn" onClick={onAbout}>
            <Info size={13} /> About AI Town
          </button>
        </div>
        {phase === "consent" && !busy && (
          <div className="tiny muted">One click: you confirm the install once, then NEXUS installs, starts and opens your town.</div>
        )}
      </div>

      {phase === "no-node" && (
        <div className="notice notice-warn">
          <TriangleAlert size={14} />
          <div>
            AI Town runs on Node.js: install Node.js 18 or newer (with npm) from nodejs.org, then “Check again”. Until then the
            NEXUS native 2D world works without it.
            <div className="world-gap">
              <button className="btn btn-sm" onClick={onUseNative}>
                Open the native 2D world
              </button>
            </div>
          </div>
        </div>
      )}
      {phase === "no-source" && (
        <div className="notice notice-error">The AI Town folder bundled with NEXUS was not found: this NEXUS build is incomplete.</div>
      )}
      {frontendBuilt === false && (
        <div className="notice notice-warn">
          <TriangleAlert size={14} /> The AI Town frontend is not built into this NEXUS (<span className="mono">npm run build:ai-town</span>
          ): the world cannot be displayed.
        </div>
      )}
      {lastError && <div className="notice notice-error">Last error: {lastError}</div>}

      <dl className="kv aitown-kv">
        <dt>Node.js</dt>
        <dd className={status.node ? "" : "tone-red-fg"}>{status.node ?? "not found"}</dd>
        <dt>npm</dt>
        <dd className={status.npm ? "" : "tone-red-fg"}>{status.npm ?? "not found"}</dd>
        <dt>AI Town</dt>
        <dd>
          {status.upstreamCommit ? (
            <>
              a16z-infra/ai-town <span className="mono">{status.upstreamCommit.slice(0, 7)}</span> + NEXUS layer
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>Runtime folder</dt>
        <dd className="mono">{status.runtimeDir}</dd>
        <dt>Packages</dt>
        <dd>{status.installed ? (status.needsReinstall ? "installed (outdated: reinstall needed)" : "installed") : "not installed"}</dd>
        <dt>Backend</dt>
        <dd>{status.running ? `running at ${status.url}` : "stopped"}</dd>
      </dl>

      {lines.length > 0 && (
        <div>
          <button className="link-btn tiny" onClick={() => setShowLog(!showLog)} aria-expanded={showLog || busy !== null}>
            {showLog || busy ? "Hide log" : `Show log (${lines.length} lines)`}
          </button>
          {(showLog || busy) && <pre className="aitown-log mono">{lines.slice(-40).join("\n")}</pre>}
        </div>
      )}
    </div>
  );
}
