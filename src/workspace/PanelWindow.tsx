import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorMessage } from "../lib/api";
import { APP_NAME } from "../lib/brand";
import { useStore } from "../store";
import { useLanguageSync } from "../i18n/prefs";
import { useBackendSync } from "../state/backendSync";
import { Loading } from "../components/Common";
import { Toasts } from "../components/Toasts";
import { announceRedock } from "./detachWindow";
import type { PanelSpec } from "./layout";
import { PANEL_ICON, usePanelTitle } from "./panelMeta";
import { PANELS } from "./registry";
import { useT } from "../i18n";

function useProjectSnapshot(): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .snapshot()
      .then((snap) => useStore.getState().loadSnapshot(snap))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  return error;
}

/** Host of a detached panel window: the project snapshot, live events, and that one panel. */
export function PanelWindow({ spec }: { spec: PanelSpec }) {
  const t = useT();
  const loaded = useStore((s) => s.project !== null);
  const error = useProjectSnapshot();
  const title = usePanelTitle(spec);
  const label = getCurrentWindow().label;
  useBackendSync();
  useLanguageSync();

  useEffect(() => {
    document.title = `${title} — ${APP_NAME}`;
  }, [title]);
  useEffect(() => {
    const onHide = () => announceRedock(label);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [label]);

  const Icon = PANEL_ICON[spec.type];
  const { Body } = PANELS[spec.type];
  return (
    <div className="panel-window">
      <header className="panel-head">
        <Icon size={14} className="panel-head-icon" />
        <span className="panel-head-title">{title}</span>
        <span className="muted small">{t("ws.window.dockBack")}</span>
      </header>
      <div className="tile-body">
        {error ? <div className="notice notice-error">{t("ws.window.noProject", { error })}</div> : loaded ? <Body spec={spec} panelId={label} /> : <Loading text={t("ws.window.loading")} />}
      </div>
      <Toasts />
    </div>
  );
}
