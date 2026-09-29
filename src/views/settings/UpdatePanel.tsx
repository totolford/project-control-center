import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, errorMessage } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { formatBytes } from "../../lib/format";
import type { AppInfo } from "../../lib/types";
import { Section, Spinner } from "../../components/Common";

type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "none" }
  | { phase: "available"; update: Update }
  | { phase: "installing"; update: Update; downloaded: number; total: number | null }
  | { phase: "error"; message: string };

export function UpdatePanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [state, setState] = useState<CheckState>({ phase: "idle" });

  useEffect(() => {
    void attempt(() => api.appInfo()).then((i) => setInfo(i ?? null));
  }, []);

  const runCheck = async () => {
    setState({ phase: "checking" });
    try {
      const update = await check();
      setState(update ? { phase: "available", update } : { phase: "none" });
    } catch (e) {
      setState({ phase: "error", message: errorMessage(e) });
    }
  };

  const install = async (update: Update) => {
    setState({ phase: "installing", update, downloaded: 0, total: null });
    try {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? null;
        else if (ev.event === "Progress") downloaded += ev.data.chunkLength;
        setState({ phase: "installing", update, downloaded, total });
      });
      await relaunch();
    } catch (e) {
      setState({ phase: "error", message: errorMessage(e) });
    }
  };

  return (
    <Section title="Application">
      <dl className="kv">
        <dt>Version</dt>
        <dd>{info?.version ?? "—"}</dd>
        <dt>Data folder</dt>
        <dd className="mono small">{info?.dataDir ?? "—"}</dd>
        <dt>Logs</dt>
        <dd className="mono small">{info?.logDir ?? "—"}</dd>
      </dl>
      <div className="row">
        <button className="btn" onClick={() => void runCheck()} disabled={state.phase === "checking" || state.phase === "installing"}>
          {state.phase === "checking" ? <Spinner size={12} /> : <RefreshCw size={13} />} Check for updates
        </button>
        {state.phase === "none" && <span className="muted">You are on the latest version.</span>}
        {state.phase === "error" && (
          <span className="muted" title={state.message}>
            Could not check for updates (no release may be published yet). {state.message}
          </span>
        )}
      </div>
      {(state.phase === "available" || state.phase === "installing") && (
        <div className="update-box">
          <div>
            <strong>Version {state.update.version}</strong> is available
            {state.update.date && <span className="muted"> · {state.update.date.slice(0, 10)}</span>}
          </div>
          {state.update.body && <div className="prewrap small">{state.update.body}</div>}
          {state.phase === "installing" ? (
            <div className="muted small">
              <Spinner size={12} /> Downloading {formatBytes(state.downloaded)}
              {state.total ? ` of ${formatBytes(state.total)}` : ""}…
            </div>
          ) : (
            <button className="btn primary" onClick={() => void install(state.update)}>
              <Download size={13} /> Install and restart
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
