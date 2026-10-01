import { memo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { mcpConnectedCount } from "../lib/claudeEnv";
import { formatRelative } from "../lib/format";
import { applyPower } from "../state/actions";
import { useClaudeEnv, useSkills } from "../state/claude";
import { useConnections, useStore } from "../store";
import { Spinner } from "../components/Common";
import { PowerControl } from "../components/PowerControl";
import { ContextBar, RateLimitBars } from "../components/UsageBars";
import { UnlockedToggle } from "../components/UnlockedToggle";

function RailSection({ title, children, onClick }: { title: string; children: ReactNode; onClick?: () => void }) {
  return (
    <section className="rail-section">
      <h3>{onClick ? <button className="link-btn rail-link" onClick={onClick}>{title}</button> : title}</h3>
      {children}
    </section>
  );
}

function AgentPower() {
  const agents = useStore((s) => s.project?.agents);
  const unlocked = useStore((s) => s.project?.settings.autonomy.unlocked ?? false);
  const [picked, setPicked] = useState("");
  const active = (agents ?? []).filter((a) => a.status !== "retired");
  const agent = active.find((a) => a.id === picked) ?? active.find((a) => a.kind === "central") ?? active[0];
  if (!agent) return <div className="muted small">No agent</div>;
  return (
    <>
      <select value={agent.id} onChange={(e) => setPicked(e.target.value)} aria-label="Agent">
        {active.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <PowerControl permissions={agent.permissions} onApply={(l) => void applyPower(agent, l)} compact />
      {unlocked && <div className="tiny tone-amber-fg">UNLOCKED: the unlocked rules apply to every agent</div>}
    </>
  );
}

/** Right CONTROL rail of the Swarm view: models, power, MCP/skills, limits, CLAUDE UNLOCKED. */
export const ControlRail = memo(function ControlRail() {
  const { env, loading, error, refresh } = useClaudeEnv();
  const { skills } = useSkills();
  const connections = useConnections();
  const settings = useStore((s) => s.project?.settings);
  const navigate = useStore((s) => s.navigate);
  const mcp = mcpConnectedCount(env, connections);
  const enabledSkills = skills?.filter((s) => s.enabled).length;

  return (
    <aside className="control-rail" aria-label="Control">
      <div className="rail-head">
        <span className="rail-title">CONTROL</span>
        <span className="spacer" />
        {env && <span className="muted tiny" title={env.capturedAt}>{formatRelative(env.capturedAt)}</span>}
        <button className="icon-btn" onClick={refresh} disabled={loading} title="Refresh what Claude Code reports (takes a few seconds)" aria-label="Refresh">
          {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
        </button>
      </div>
      {error && <div className="notice notice-error small">{error}</div>}

      <RailSection title="Default model" onClick={() => navigate({ name: "models" })}>
        <dl className="kv kv-tight">
          <dt>Central</dt>
          <dd className="mono">{settings?.centralModel ?? "default"}</dd>
          <dt>Workers</dt>
          <dd className="mono">{settings?.workerModel ?? "default"}</dd>
        </dl>
      </RailSection>

      <RailSection title="Power" onClick={() => navigate({ name: "capabilities" })}>
        <AgentPower />
      </RailSection>

      <RailSection title="MCP & skills" onClick={() => navigate({ name: "mcp" })}>
        <dl className="kv kv-tight">
          <dt>Claude Code MCP</dt>
          <dd>{mcp.claude === null ? (env ? "Unavailable" : "—") : `${mcp.claude}/${env?.mcpServers.length ?? 0} connected`}</dd>
          <dt>NEXUS MCP</dt>
          <dd>{mcp.nexus} connected</dd>
          <dt>Commands & skills</dt>
          <dd>{env ? env.commands.length : "—"}</dd>
          <dt>Skills enabled</dt>
          <dd>{enabledSkills ?? "—"}</dd>
        </dl>
      </RailSection>

      <RailSection title="Rate limits" onClick={() => navigate({ name: "claude" })}>
        <RateLimitBars env={env} />
      </RailSection>

      <RailSection title="Context">
        <ContextBar env={env} />
      </RailSection>

      <RailSection title="Autonomy" onClick={() => navigate({ name: "autonomy" })}>
        <UnlockedToggle />
      </RailSection>
    </aside>
  );
});
