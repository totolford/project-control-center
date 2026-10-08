import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { parseDetachHash } from "./workspace/detach";
import { PanelWindow } from "./workspace/PanelWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { restoreRememberedLocale } from "./i18n/prefs";
import { t } from "./i18n";
import "@xterm/xterm/css/xterm.css";
import "./styles/base.css";
import "./styles/views.css";
import "./styles/shell.css";
import "./styles/nav.css";
import "./styles/workspace.css";
import "./styles/panels.css";
import "./styles/control.css";
import "./styles/recovery.css";
import "./styles/agents.css";
import "./styles/terminal.css";
import "./styles/tools.css";
import "./styles/ops.css";
import "./styles/ops-views.css";
import "./styles/world.css";
import "./styles/health.css";
import "./styles/ai.css";

// Detached panel windows load the same bundle with `#panel=<spec>`.
const detached = parseDetachHash(window.location.hash);
restoreRememberedLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {detached ? (
      <ErrorBoundary label={t("comp.boundary.detached")}>
        <PanelWindow spec={detached} />
      </ErrorBoundary>
    ) : (
      <App />
    )}
  </StrictMode>,
);
