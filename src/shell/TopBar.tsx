import { Cpu, Plus, Search } from "lucide-react";
import logo from "../assets/icon.svg";
import { APP_NAME, APP_TAGLINE } from "../lib/brand";
import { AGENT_STATUS, isLive } from "../lib/labels";
import { engineLabel } from "../views/ai/aiLogic";
import { useUi } from "../state/ui";
import { useAgents, useConnections, useReadOnly, useStore } from "../store";
import { StatusDot } from "../components/StatusBadge";
import { NotificationCenter } from "./NotificationCenter";
import { ProjectBreadcrumb } from "./ProjectBreadcrumb";
import { SafetyControls } from "./SafetyControls";
import { HealthIndicator } from "./health/HealthIndicator";
import { useT } from "../i18n";

/** `● n agents  ● n MCP`: live agent sessions and connected MCP servers (NEXUS connections). */
function Indicators() {
  const agents = useAgents();
  const connections = useConnections();
  const navigate = useStore((s) => s.navigate);
  const t = useT();
  const active = agents.filter((a) => a.status !== "retired");
  const working = active.filter((a) => a.status === "working").length;
  const live = active.filter((a) => isLive(a.status)).length;
  const mcp = connections.filter((c) => c.kind === "mcp" || c.kind === "roblox_studio");
  const mcpOk = mcp.filter((c) => c.status === "connected").length;
  const mcpFailing = mcp.some((c) => c.status === "error");
  return (
    <div className="indicators">
      <button
        className="indicator"
        onClick={() => navigate({ name: "agents" })}
        title={t("shell.top.agentsTitle", { live, total: active.length, working })}
        aria-label={t("shell.top.agentsAria", { live, working })}
      >
        <StatusDot tone={working > 0 ? "green" : live > 0 ? "blue" : "grey"} pulse={working > 0} />
        <span>{t("shell.top.agents", { count: live })}</span>
      </button>
      <button
        className="indicator"
        onClick={() => navigate({ name: "mcp" })}
        title={t("shell.top.mcpTitle", { ok: mcpOk, total: mcp.length })}
        aria-label={t("shell.top.mcpAria", { ok: mcpOk })}
      >
        <StatusDot tone={mcpFailing ? "red" : mcpOk > 0 ? "green" : "grey"} />
        <span>{mcpOk} MCP</span>
      </button>
      <CentralIndicator />
    </div>
  );
}

/** Central agent's engine: provider and model (as configured; "default" = Claude Code's default model). */
function CentralIndicator() {
  const central = useAgents().find((a) => a.kind === "central");
  const openAgent = useStore((s) => s.openAgent);
  const settings = useStore((s) => s.project?.settings);
  const t = useT();
  if (!central) return null;
  // Engine as configured (AI Engines): Claude through Claude Code, or the local runtime and model.
  const engine = engineLabel(settings?.ai, "central", central.profile.engine ?? null, central.model ?? settings?.centralModel ?? null);
  const { provider, model } = engine;
  return (
    <button
      className="indicator central-indicator"
      onClick={() => openAgent(central.id)}
      title={t("shell.top.centralTitle", { engine: engine.text, status: AGENT_STATUS[central.status]?.label ?? central.status })}
      aria-label={t("shell.top.centralAria", { provider, model })}
    >
      <Cpu size={12} aria-hidden="true" />
      <span className="indicator-label">
        Central <span className="muted">·</span> {provider} <span className="muted">·</span> <span className="mono">{model}</span>
      </span>
    </button>
  );
}

/** "+ New Mission": the structured mission flow of the Missions view. */
function NewMissionButton() {
  const readOnly = useReadOnly();
  const t = useT();
  return (
    <button
      className="btn btn-sm primary topbar-mission"
      disabled={readOnly}
      onClick={() => {
        useUi.getState().setNewMission(true);
        useStore.getState().navigate({ name: "missions" });
      }}
      title={readOnly ? t("shell.top.readOnly") : t("shell.top.newMissionTitle")}
    >
      <Plus size={13} /> <span className="btn-text">{t("shell.top.newMission")}</span>
    </button>
  );
}

export function TopBar({ onCloseProject, onFolder }: { onCloseProject: () => void; onFolder: (path: string) => Promise<void> }) {
  const setCommandOpen = useUi((s) => s.setCommandOpen);
  const t = useT();
  return (
    <header className="topbar">
      <div className="brand" title={`${APP_NAME} — ${APP_TAGLINE}`}>
        <img src={logo} alt="" className="brand-logo" />
        <span className="brand-name">{APP_NAME}</span>
      </div>
      <ProjectBreadcrumb onCloseProject={onCloseProject} onFolder={onFolder} />
      <Indicators />
      <span className="spacer" />
      <HealthIndicator />
      <NewMissionButton />
      <SafetyControls />
      <button className="search-btn" onClick={() => setCommandOpen(true)} title={t("shell.top.searchTitle")}>
        <Search size={13} />
        <span className="indicator-label">{t("common.search")}</span>
        <kbd>Ctrl K</kbd>
      </button>
      <NotificationCenter />
    </header>
  );
}
