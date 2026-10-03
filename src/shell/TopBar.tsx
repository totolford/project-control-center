import { Plus, Search } from "lucide-react";
import logo from "../assets/icon.svg";
import { APP_NAME, APP_TAGLINE } from "../lib/brand";
import { isLive } from "../lib/labels";
import { useUi } from "../state/ui";
import { useAgents, useConnections, useReadOnly, useStore } from "../store";
import { StatusDot } from "../components/StatusBadge";
import { NotificationCenter } from "./NotificationCenter";
import { ProjectBreadcrumb } from "./ProjectBreadcrumb";
import { SafetyControls } from "./SafetyControls";

/** `● n agents  ● n MCP`: live agent sessions and connected MCP servers (NEXUS connections). */
function Indicators() {
  const agents = useAgents();
  const connections = useConnections();
  const navigate = useStore((s) => s.navigate);
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
        title={`${live} of ${active.length} agent sessions running · ${working} working`}
        aria-label={`${live} agents running, ${working} working`}
      >
        <StatusDot tone={working > 0 ? "green" : live > 0 ? "blue" : "grey"} pulse={working > 0} />
        <span>
          {live} {live === 1 ? "agent" : "agents"}
        </span>
      </button>
      <button
        className="indicator"
        onClick={() => navigate({ name: "mcp" })}
        title={`${mcpOk} of ${mcp.length} MCP connections connected`}
        aria-label={`${mcpOk} MCP servers connected`}
      >
        <StatusDot tone={mcpFailing ? "red" : mcpOk > 0 ? "green" : "grey"} />
        <span>{mcpOk} MCP</span>
      </button>
    </div>
  );
}

/** "+ New Mission": the structured mission flow of the Missions view. */
function NewMissionButton() {
  const readOnly = useReadOnly();
  return (
    <button
      className="btn btn-sm primary topbar-mission"
      disabled={readOnly}
      onClick={() => {
        useUi.getState().setNewMission(true);
        useStore.getState().navigate({ name: "missions" });
      }}
      title={readOnly ? "Compatibility mode: read-only" : "Start a structured mission (or type /mission in the command bar)"}
    >
      <Plus size={13} /> <span className="btn-text">New Mission</span>
    </button>
  );
}

export function TopBar({ onCloseProject, onFolder }: { onCloseProject: () => void; onFolder: (path: string) => Promise<void> }) {
  const setCommandOpen = useUi((s) => s.setCommandOpen);
  return (
    <header className="topbar">
      <div className="brand" title={`${APP_NAME} — ${APP_TAGLINE}`}>
        <img src={logo} alt="" className="brand-logo" />
        <span className="brand-name">{APP_NAME}</span>
      </div>
      <ProjectBreadcrumb onCloseProject={onCloseProject} onFolder={onFolder} />
      <Indicators />
      <span className="spacer" />
      <NewMissionButton />
      <SafetyControls />
      <button className="search-btn" onClick={() => setCommandOpen(true)} title="Search and commands (Ctrl+K)">
        <Search size={13} />
        <span className="indicator-label">Search</span>
        <kbd>Ctrl K</kbd>
      </button>
      <NotificationCenter />
    </header>
  );
}
