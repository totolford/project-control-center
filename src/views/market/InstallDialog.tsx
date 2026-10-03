// Install (or update) after showing the real files and their security analysis.
// Sensitive or not fully inspected packages need an explicit "Install anyway".

import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { attempt, toast } from "../../lib/toast";
import type { MarketAction, MarketDetails, MarketEntry } from "../../lib/types";
import { Loading, Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { CliRunOutput } from "../mcp/CliRunOutput";
import { AnalysisView } from "./AnalysisView";
import { installScopes, OFFICIAL_LABEL } from "./marketModel";
import { useMarket } from "./marketStore";

interface Props {
  entry: MarketEntry;
  mode: "install" | "update";
  onClose: () => void;
  onDone: () => void;
}

export function InstallDialog({ entry, mode, onClose, onDone }: Props) {
  const status = useMarket((s) => s.status);
  const [details, setDetails] = useState<MarketDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("user");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MarketAction | null>(null);

  useEffect(() => {
    api.marketDetails(entry.id).then(setDetails, (e) => setError(errorMessage(e)));
  }, [entry.id]);

  // Updating a standalone skill installs the newer GitHub version: that is what is analyzed.
  const skillUpdate = mode === "update" && entry.installMethod === "github-skill";
  const analysis = (skillUpdate ? details?.updateAnalysis : details?.analysis) ?? null;
  const sensitive = !analysis || analysis.security.needsConfirmation || analysis.truncated;
  const scopes = installScopes(entry, status);
  const isPlugin = entry.installMethod === "plugin";
  const verb = mode === "install" ? "Install" : "Update";

  const run = async () => {
    setBusy(true);
    const options = { scope, reference: analysis?.reference ?? null, confirmed: sensitive && confirmed };
    const r = await attempt(() => (mode === "install" ? api.marketInstall(entry.id, options) : api.marketUpdate(entry.id, options)));
    setBusy(false);
    if (!r) return;
    setResult(r);
    if (r.ok) {
      toast.success(r.message);
      onDone();
    }
  };

  return (
    <Modal
      title={`${verb} ${entry.name}`}
      onClose={onClose}
      locked={busy}
      width={720}
      footer={
        result ? (
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className={`btn ${sensitive ? "danger" : "primary"}`} onClick={() => void run()} disabled={busy || !details || (sensitive && !confirmed)}>
              {busy ? <Spinner size={12} /> : mode === "install" ? <Download size={14} /> : <RefreshCw size={14} />}{" "}
              {sensitive ? `${verb} anyway` : verb}
            </button>
          </>
        )
      }
    >
      <div className="mk-dialog">
        <div className="mk-dialog-what">
          <strong>{entry.name}</strong>
          <span className="muted"> · {entry.official ? OFFICIAL_LABEL : `Third-party${entry.author ? ` by ${entry.author}` : ""}`}</span>
          {!entry.official && <div className="muted small">Not reviewed or endorsed by Anthropic or NEXUS. Only install what you trust.</div>}
        </div>

        {isPlugin ? (
          <div className="notice">
            <div>
              Installed by Claude Code itself:
              {!entry.marketplaceConfigured && entry.marketplaceRepo && (
                <>
                  {" "}
                  first <code>claude plugin marketplace add {entry.marketplaceRepo}</code> (adds that marketplace as a source), then
                </>
              )}{" "}
              <code>
                claude plugin {mode} {entry.pluginId}
                {mode === "install" ? ` --scope ${scope}` : entry.installedScope ? ` --scope ${entry.installedScope}` : ""}
              </code>
              . A plugin can also bring commands, agents, hooks and MCP servers.
            </div>
          </div>
        ) : (
          <div className="notice">
            <div>
              {mode === "install" ? (
                <>
                  Downloads the files below from <code>{entry.repository}</code> at the analyzed commit into a skills folder, with a <code>.nexus-source.json</code> recording their origin.
                </>
              ) : (
                <>Downloads the latest version from <code>{entry.repository}</code>; the current folder goes to skills-trash (recoverable).</>
              )}
            </div>
          </div>
        )}

        {mode === "install" && (
          <fieldset className="mk-scopes">
            <legend className="field-label">Install for</legend>
            {scopes.map((s) => (
              <label key={s.value} className={`mk-scope${s.available ? "" : " is-off"}`}>
                <input type="radio" name="scope" value={s.value} checked={scope === s.value} disabled={!s.available || busy} onChange={() => setScope(s.value)} />
                <span>
                  <strong>{s.label}</strong> <span className="muted small">{s.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {mode === "update" && details?.updateAvailable === false && <div className="notice">No newer commit touches this skill's folder: it is up to date.</div>}

        {error && <div className="notice notice-error">Analysis unavailable: {error}</div>}
        {!details && !error && <Loading text="Reading and analyzing the files…" />}
        {details && !analysis && !(skillUpdate && details.updateAvailable === false) && (
          <div className="notice notice-warn">
            Files could not be inspected{skillUpdate ? "" : `: ${details.analysisError ?? "unknown reason"}`}. Nothing is verified.
          </div>
        )}
        {analysis && <AnalysisView analysis={analysis} filesTitle={mode === "install" || skillUpdate ? "Files to be installed" : "Files"} />}

        {sensitive && !result && (
          <label className="mk-confirm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
            <span>
              {analysis
                ? "I reviewed the findings above and want to install anyway."
                : "The files could not all be verified. I want to continue anyway."}
            </span>
          </label>
        )}

        {result && (
          <>
            <div className={`notice ${result.ok ? "" : "notice-error"}`}>
              {result.message}
              {result.dir && <code className="tools-path">{result.dir}</code>}
            </div>
            {result.runs.map((r, i) => (
              <CliRunOutput key={i} run={r} />
            ))}
            {result.ok && <div className="muted small">Running agent sessions load new skills after "Reload in sessions" (Skills view) or when they restart.</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
