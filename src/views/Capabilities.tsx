import { memo } from "react";
import { LockOpen } from "lucide-react";
import { ACCESS_MARK, POWER_LABEL, accessOf, detectPower } from "../lib/power";
import { effectivePermissions } from "../lib/autonomy";
import { MATRIX_COLUMNS, cyclePermission, grantedOfKinds, matrixAgents, toggleGrants, toggleSkills, type MatrixColumn } from "../lib/matrix";
import type { Agent, AutonomySettings, Connection } from "../lib/types";
import { patchAgent, setAgentModel } from "../state/actions";
import { useAgents, useConnections, useStore } from "../store";
import { PageHeader } from "../components/Common";
import { ModelSelect } from "../components/ModelSelect";

function Cell({ agent, col, connections, autonomy }: { agent: Agent; col: MatrixColumn; connections: Connection[]; autonomy: AutonomySettings }) {
  if (col.type === "skills") {
    const on = agent.profile.skillsEnabled;
    return (
      <button className={`cap-cell tone-${on ? "green" : "dim"}`} onClick={() => void patchAgent(agent.id, { profile: toggleSkills(agent.profile) })} title="Toggle skills & slash commands">
        {on ? "✓" : "–"}
      </button>
    );
  }
  if (col.type === "grant") {
    const ofKind = connections.filter((c) => col.kinds.includes(c.kind));
    const granted = grantedOfKinds(agent.connections, connections, col.kinds);
    if (ofKind.length === 0) return <span className="cap-cell muted" title="No such connection in this project">n/a</span>;
    return (
      <button
        className={`cap-cell tone-${granted.length > 0 ? "green" : "dim"}`}
        onClick={() => void patchAgent(agent.id, { connections: toggleGrants(agent.connections, connections, col.kinds) })}
        title={granted.length > 0 ? `Granted: ${granted.map((c) => c.name).join(", ")} — click to revoke` : "Click to grant the enabled connections"}
      >
        {granted.length > 0 ? `✓ ${granted.length}` : "–"}
      </button>
    );
  }
  const own = accessOf(agent.permissions, col.cap);
  const effective = accessOf(effectivePermissions(agent.permissions, autonomy), col.cap);
  const m = ACCESS_MARK[own];
  const grants = col.grantKinds ? grantedOfKinds(agent.connections, connections, col.grantKinds).length : null;
  return (
    <button
      className={`cap-cell tone-${m.tone}`}
      onClick={() => void patchAgent(agent.id, { permissions: cyclePermission(agent.permissions, col.cap) })}
      title={`${col.cap}: ${own} (click: deny → ask → allow)${autonomy.unlocked ? ` · effective while UNLOCKED: ${effective}` : ""}`}
    >
      {m.mark} {own}
      {grants !== null && <span className="muted tiny"> · {grants}</span>}
      {autonomy.unlocked && effective !== own && <span className="cap-effective">→{ACCESS_MARK[effective].mark}</span>}
    </button>
  );
}

const MatrixRow = memo(function MatrixRow({ agent, connections, autonomy }: { agent: Agent; connections: Connection[]; autonomy: AutonomySettings }) {
  const power = detectPower(agent.permissions);
  return (
    <tr>
      <td>
        <strong>{agent.name}</strong>
        <div className="muted tiny">{agent.kind}</div>
      </td>
      <td>
        <ModelSelect value={agent.model} onChange={(m) => void setAgentModel(agent, m)} label={`Model of ${agent.name}`} />
      </td>
      <td>
        <span className={`chip tone-${power ? "grey" : "amber"}`}>{power ? POWER_LABEL[power] : "Custom"}</span>
      </td>
      {MATRIX_COLUMNS.map((col) => (
        <td key={col.key}>
          <Cell agent={agent} col={col} connections={connections} autonomy={autonomy} />
        </td>
      ))}
    </tr>
  );
});

/** Agents × capabilities: click a cell to cycle a permission or toggle a grant. */
export function Capabilities() {
  const agents = matrixAgents(useAgents());
  const connections = useConnections();
  const autonomy = useStore((s) => s.project?.settings.autonomy);
  const navigate = useStore((s) => s.navigate);
  if (!autonomy) return null;
  const unlockedPower = detectPower(autonomy.unlockedPermissions);
  return (
    <div className="page">
      <PageHeader
        title="Capabilities"
        subtitle="Each agent's own permissions. Click a capability to cycle deny → ask → allow; grants and skills toggle. Changes apply at the next session start."
        actions={
          autonomy.unlocked && (
            <button className="unlocked-badge" onClick={() => navigate({ name: "autonomy" })}>
              <LockOpen size={12} /> UNLOCKED: {unlockedPower ? POWER_LABEL[unlockedPower].toLowerCase() : "custom rules"} applies
            </button>
          )
        }
      />
      <div className="table-wrap">
        <table className="table matrix">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Model</th>
              <th>Power</th>
              {MATRIX_COLUMNS.map((c) => (
                <th key={c.key} title={c.type === "cap" ? c.cap : c.type === "grant" ? c.kinds.join(", ") : "profile.skillsEnabled"}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <MatrixRow key={a.id} agent={a} connections={connections} autonomy={autonomy} />
            ))}
          </tbody>
        </table>
      </div>
      {autonomy.unlocked && <p className="muted small">“→” shows what applies while CLAUDE UNLOCKED is on, when it differs from the agent's own permission.</p>}
    </div>
  );
}
