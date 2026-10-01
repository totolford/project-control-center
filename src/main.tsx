import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { parseDetachHash } from "./workspace/detach";
import { PanelWindow } from "./workspace/PanelWindow";
import "@xterm/xterm/css/xterm.css";
import "./styles/base.css";
import "./styles/views.css";
import "./styles/shell.css";
import "./styles/nav.css";
import "./styles/workspace.css";
import "./styles/panels.css";
import "./styles/control.css";
import "./styles/agents.css";
import "./styles/terminal.css";
import "./styles/tools.css";

// Detached panel windows load the same bundle with `#panel=<spec>`.
const detached = parseDetachHash(window.location.hash);

createRoot(document.getElementById("root")!).render(<StrictMode>{detached ? <PanelWindow spec={detached} /> : <App />}</StrictMode>);
