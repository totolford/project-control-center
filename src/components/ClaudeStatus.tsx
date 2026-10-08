import { useCallback, useEffect, useState } from "react";
import { CircleCheck, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import type { ClaudeInfo } from "../lib/types";
import { Spinner } from "./Common";
import { rich, useT } from "../i18n";

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
  const t = useT();
  if (loading && !info) {
    return (
      <div className="banner">
        <Spinner /> {t("comp.claude.detecting")}
      </div>
    );
  }
  if (!info) {
    return (
      <div className="banner banner-warn">
        <TriangleAlert size={16} />
        <div className="banner-text">{t("comp.claude.detectFailed")}</div>
        <button className="btn" onClick={onRecheck}>
          <RefreshCw size={13} /> {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!info.installed) {
    return (
      <div className="banner banner-warn">
        <TriangleAlert size={16} />
        <div className="banner-text">
          <strong>{t("comp.claude.notDetected")}</strong>
          <div className="muted">{t("comp.claude.mustInstall")}</div>
          {info.error && <div className="muted small">{info.error}</div>}
        </div>
        <div className="banner-actions">
          <button className="btn primary" onClick={() => void run(() => openUrl(SETUP_URL))}>
            <ExternalLink size={13} /> {t("comp.claude.install")}
          </button>
          <button className="btn" onClick={() => void run(() => openUrl(DOCS_URL))}>
            {t("comp.claude.docs")}
          </button>
          <button className="btn ghost" onClick={onRecheck} disabled={loading}>
            <RefreshCw size={13} /> {t("comp.claude.recheck")}
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
          <strong>{t("comp.claude.notLoggedIn", { version: info.version ?? "" })}</strong>
          <div className="muted">{rich(t("comp.claude.loginHelp"), { command: <code>claude auth login</code> })}</div>
        </div>
        <div className="banner-actions">
          <button className="btn" onClick={onRecheck} disabled={loading}>
            <RefreshCw size={13} /> {t("comp.claude.recheck")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="banner banner-ok">
      <CircleCheck size={16} />
      <div className="banner-text">
        {t("comp.claude.detected", { version: info.version ?? "" })}
        {info.loggedIn && (
          <span className="muted">
            {" "}
            · {info.authMethod ? t("comp.claude.loggedInVia", { method: info.authMethod }) : t("comp.claude.loggedIn")}
            {info.subscription ? ` · ${info.subscription}` : ""}
          </span>
        )}
        {info.loggedIn === null && <span className="muted"> · {t("comp.claude.loginUnknown")}</span>}
      </div>
      <button className="btn ghost" onClick={onRecheck} disabled={loading}>
        <RefreshCw size={13} />
      </button>
    </div>
  );
}
