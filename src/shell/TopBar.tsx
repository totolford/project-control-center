import { Search } from "lucide-react";
import logo from "../assets/icon.svg";
import { APP_NAME, APP_TAGLINE } from "../lib/brand";
import { isLive } from "../lib/labels";
import { useUi } from "../state/ui";
import { useAgents, useConnections, useMissions, useStore } from "../store";
import { StatusDot } from "../components/StatusBadge";
import { NotificationCenter } from "./NotificationCenter";
import { ProjectBreadcrumb } from "./ProjectBreadcrumb";

function Indicators() {
  const agents = useAgents();
  const connections = useConnections();
  const missions = useMissions();
  const navigate = useStore((s) => s.navigate);
  const active = agents.filter((a) => a.status !== "retired");
  const working = active.filter((a) => a.status === "working").length;
  const live = active.filter((a) => isLive(a.status)).length;
  const ok = connections.filter((c) => c.status === "connected").length;
  const failing = connections.some((c) => c.status === "error");
  const mission = missions.find((m) => m.status === "active" || m.status === "planning");
  return (
    <div className="indicators">
      <button className="indicator" onClick={() => navigate({ name: "swarm" })} title={`${live} agent sessions running`}>
        <StatusDot tone={working > 0 ? "green" : "grey"} pulse={working > 0} />
        <span className="indicator-label">
          {working}/{active.length} agents working
        </span>
      </button>
      <button className="indicator" onClick={() => navigate({ name: "connections" })} title="Connections connected / total">
        <StatusDot tone={failing ? "red" : connections.length > 0 && ok === connections.length ? "green" : "grey"} />
        <span className="indicator-label">
          {ok}/{connections.length} connections ok
        </span>
      </button>
      <button className="indicator" onClick={() => navigate({ name: "missions" })} title={mission?.title ?? "No active mission"}>
        <StatusDot tone={mission ? "accent" : "grey"} />
        <span className="indicator-label">{mission ? "Mission active" : "No mission"}</span>
      </button>
    </div>
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
      <button className="search-btn" onClick={() => setCommandOpen(true)} title="Search and commands (Ctrl+K)">
        <Search size={13} />
        <span className="indicator-label">Search</span>
        <kbd>Ctrl K</kbd>
      </button>
      <NotificationCenter />
    </header>
  );
}
