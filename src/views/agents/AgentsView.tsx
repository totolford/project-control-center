import { useState } from "react";
import { Crown, Plus, SquareTerminal } from "lucide-react";
import { POWER_LABEL, detectPower } from "../../lib/power";
import { useUi } from "../../state/ui";
import { useAgents, useStore } from "../../store";
import { EmptyState, PageHeader } from "../../components/Common";
import { StatusBadge } from "../../components/StatusBadge";
import { Tabs } from "../../components/Tabs";
import { availableProviderId, useProviders } from "../../workspace/hooks";
import { matrixAgents } from "../../lib/matrix";
import { AgentControls } from "../AgentDetail";
import { AgentPermissions } from "../agent/AgentPermissions";
import { AgentProfileEditor } from "./AgentProfileEditor";
import { AgentIdentity } from "./AgentIdentity";
import { Topology } from "./Topology";
import { HierarchyView } from "./HierarchyView";

type TabKey = "profile" | "permissions" | "identity";

const TABS: { key: TabKey; label: string }[] = [
  { key: "profile", label: "Profile" },
  { key: "permissions", label: "Permissions & connections" },
  { key: "identity", label: "Role & workspace" },
];

function AgentList({ selected, onSelect }: { selected: string | undefined; onSelect: (id: string) => void }) {
  const agents = matrixAgents(useAgents());
  return (
    <ul className="agent-pick">
      {agents.map((a) => {
        const power = detectPower(a.permissions);
        return (
          <li key={a.id}>
            <button className={`agent-pick-item${a.id === selected ? " active" : ""}`} onClick={() => onSelect(a.id)}>
              <span className="row">
                {a.kind === "central" && <Crown size={12} className="tone-accent-fg" />}
                <strong className="grow ellipsis">{a.name}</strong>
                <StatusBadge status={a.status} />
              </span>
              <span className="muted tiny ellipsis">
                {a.model ?? "default"} · {power ? POWER_LABEL[power] : "Custom"} · skills {a.profile.skillsEnabled ? "on" : "off"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Agent profiles: list, per-agent profile editor, and the relations tree. */
export function AgentsView() {
  const agents = useAgents();
  const openAgent = useStore((s) => s.openAgent);
  const openDialog = useUi((s) => s.openDialog);
  useProviders();
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("profile");
  const [view, setView] = useState<"profiles" | "hierarchy" | "relations">("profiles");
  const agent = agents.find((a) => a.id === picked) ?? agents.find((a) => a.kind === "central") ?? agents[0];
  const provider = availableProviderId();

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        subtitle="Profiles of every agent: model, power, effort, skills, connections, environment and instructions."
        actions={
          <>
            <Tabs
              tabs={[
                { key: "profiles", label: "Profiles" },
                { key: "hierarchy", label: "Hierarchy" },
                { key: "relations", label: "Relations" },
              ]}
              active={view}
              onChange={setView}
            />
            <button className="btn primary" disabled={!provider} onClick={() => provider && openDialog({ type: "newAgent", provider })}>
              <Plus size={13} /> New agent
            </button>
          </>
        }
      />
      {view === "hierarchy" ? (
        <HierarchyView />
      ) : view === "relations" ? (
        <Topology />
      ) : !agent ? (
        <EmptyState title="No agent yet" />
      ) : (
        <div className="agents-layout">
          <AgentList selected={agent.id} onSelect={setPicked} />
          <div className="agents-detail">
            <div className="row agents-detail-head">
              <h2 className="grow">{agent.name}</h2>
              <AgentControls agent={agent} />
              <button className="btn" onClick={() => openAgent(agent.id)} title="Terminal, messages, memory and sessions">
                <SquareTerminal size={13} /> Console
              </button>
            </div>
            <Tabs tabs={TABS} active={tab} onChange={setTab} />
            {tab === "profile" && <AgentProfileEditor agent={agent} />}
            {tab === "permissions" && <AgentPermissions key={agent.id} agent={agent} />}
            {tab === "identity" && <AgentIdentity agent={agent} />}
          </div>
        </div>
      )}
    </div>
  );
}
