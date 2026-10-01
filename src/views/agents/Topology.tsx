import { memo } from "react";
import { Bot, Crown, Target } from "lucide-react";
import type { Agent, Connection } from "../../lib/types";
import { patchAgent, setAgentModel } from "../../state/actions";
import { useAgents, useConnections, useMissions } from "../../store";
import { StatusBadge } from "../../components/StatusBadge";
import { ModelSelect } from "../../components/ModelSelect";
import { isRunning } from "../../panels/MissionPanel";
import { matrixAgents } from "../../lib/matrix";

const MCP_KINDS = new Set(["mcp", "roblox_studio"]);

function Grants({ agent, connections, mcp }: { agent: Agent; connections: Connection[]; mcp: boolean }) {
  const list = connections.filter((c) => MCP_KINDS.has(c.kind) === mcp);
  if (list.length === 0) return <span className="muted small">{mcp ? "no MCP connection in project" : "no connection in project"}</span>;
  return (
    <span className="topo-grants">
      {list.map((c) => (
        <label key={c.id} className="checkbox small" title={c.enabled ? c.status : "disabled connection"}>
          <input
            type="checkbox"
            checked={agent.connections.includes(c.id)}
            onChange={(e) =>
              void patchAgent(agent.id, { connections: e.target.checked ? [...agent.connections, c.id] : agent.connections.filter((x) => x !== c.id) }, `${agent.name}: connections saved`)
            }
          />
          {c.name}
        </label>
      ))}
    </span>
  );
}

const AgentNode = memo(function AgentNode({ agent, connections }: { agent: Agent; connections: Connection[] }) {
  return (
    <li className="topo-node">
      <div className="topo-head">
        {agent.kind === "central" ? <Crown size={13} className="tone-accent-fg" /> : <Bot size={13} />}
        <strong>{agent.name}</strong>
        <span className="muted small ellipsis">{agent.role}</span>
        <StatusBadge status={agent.status} />
      </div>
      <ul className="topo-leaves">
        <li>
          <span className="topo-key">Model</span>
          <ModelSelect value={agent.model} onChange={(m) => void setAgentModel(agent, m)} label={`Model of ${agent.name}`} />
        </li>
        <li>
          <span className="topo-key">Skills</span>
          <label className="checkbox small">
            <input
              type="checkbox"
              checked={agent.profile.skillsEnabled}
              onChange={(e) => void patchAgent(agent.id, { profile: { ...agent.profile, skillsEnabled: e.target.checked } }, `${agent.name}: skills ${e.target.checked ? "on" : "off"}`)}
            />
            {agent.profile.skillsEnabled ? "on" : "off"}
          </label>
        </li>
        <li>
          <span className="topo-key">MCP</span>
          <Grants agent={agent} connections={connections} mcp />
        </li>
        <li>
          <span className="topo-key">Connections</span>
          <Grants agent={agent} connections={connections} mcp={false} />
        </li>
      </ul>
    </li>
  );
});

/** MISSION → CENTRAL → agents → {model, skills, MCP, connections}, editable inline. */
export function Topology() {
  const agents = matrixAgents(useAgents());
  const connections = useConnections();
  const missions = useMissions();
  const mission = [...missions].filter(isRunning).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const central = agents.find((a) => a.kind === "central");
  const workers = agents.filter((a) => a.kind !== "central");
  return (
    <div className="topology">
      <div className="topo-root">
        <Target size={13} /> {mission ? mission.title : <span className="muted">No active mission</span>}
      </div>
      <ul className="topo-tree">
        {central && <AgentNode agent={central} connections={connections} />}
        <li>
          <ul className="topo-tree nested">
            {workers.length === 0 ? <li className="muted small">No worker</li> : workers.map((w) => <AgentNode key={w.id} agent={w} connections={connections} />)}
          </ul>
        </li>
      </ul>
    </div>
  );
}
