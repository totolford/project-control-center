import { useCallback, useEffect, useState } from "react";
import { CircleCheck, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import type { ClaudeInfo } from "../lib/types";
import { Spinner } from "./Common";

const SETUP_URL = "https://docs.anthropic.com/en/docs/claude-code/setup";
const DOCS_URL = "https://docs.anthropic.com/en/docs/claude-code/overview";

export function useClaudeInfo() {
  const [info, setInfo] = useState<ClaudeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    const result = await attempt(() => api.detectClaude());
    setInfo(result ?? null);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { info, loading, reload };
}

/** Claude Code installation / login banner. Never asks for credentials. */
export function ClaudeStatus({ info, loading, onRecheck }: { info: ClaudeInfo | null; loading: boolean; onRecheck: () => void }) {
  if (loading && !info) {
    return (
      <div className="banner">
        <Spinner /> Detecting Claude Code…
      </div>
    );
  }
  if (!info) {
    return (
      <div className="banner banner-warn">
        <TriangleAlert size={16} />
        <div className="banner-text">Claude Code detection failed.</div>
        <button className="btn" onClick={onRecheck}>
          <RefreshCw size={13} /> Retry
        </button>
      </div>
    );
  }
  if (!info.installed) {
    return (
      <div className="banner banner-warn">
        <TriangleAlert size={16} />
        <div className="banner-text">
          <strong>Claude Code was not detected.</strong>
          <div className="muted">Agents run as real Claude Code sessions, so it must be installed on this machine.</div>
          {info.error && <div className="muted small">{info.error}</div>}
        </div>
        <div className="banner-actions">
          <button className="btn primary" onClick={() => void run(() => openUrl(SETUP_URL))}>
            <ExternalLink size={13} /> Install / Setup
          </button>
          <button className="btn" onClick={() => void run(() => openUrl(DOCS_URL))}>
            Documentation
          </button>
          <button className="btn ghost" onClick={onRecheck} disabled={loading}>
            <RefreshCw size={13} /> Re-check
          </button>
        </div>
      </div>
    );
  }
  if (info.loggedIn === false) {
    return (
      <div className="banner banner-warn">
        <TriangleAlert size={16} />
        <div className="banner-text">
          <strong>Claude Code {info.version ?? ""} is installed but not logged in.</strong>
          <div className="muted">
            Open a terminal and run <code>claude auth login</code>, then re-check. This app never asks for your credentials.
          </div>
        </div>
        <div className="banner-actions">
          <button className="btn" onClick={onRecheck} disabled={loading}>
            <RefreshCw size={13} /> Re-check
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="banner banner-ok">
      <CircleCheck size={16} />
      <div className="banner-text">
        Claude Code {info.version ?? ""} detected
        {info.loggedIn && (
          <span className="muted">
            {" "}
            · logged in{info.authMethod ? ` via ${info.authMethod}` : ""}
            {info.subscription ? ` · ${info.subscription}` : ""}
          </span>
        )}
        {info.loggedIn === null && <span className="muted"> · login status unknown</span>}
      </div>
      <button className="btn ghost" onClick={onRecheck} disabled={loading}>
        <RefreshCw size={13} />
      </button>
    </div>
  );
}
