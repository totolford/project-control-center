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
import { DomainBar, MasterToggle, useMasterStatus } from "../views/master/MasterParts";
import { useT } from "../i18n";

function RailSection({ title, children, onClick }: { title: string; children: ReactNode; onClick?: () => void }) {
  return (
    <section className="rail-section">
      <h3>{onClick ? <button className="link-btn rail-link" onClick={onClick}>{title}</button> : title}</h3>
      {children}
    </section>
  );
}

function AgentPower() {
  const t = useT();
  const agents = useStore((s) => s.project?.agents);
  const unlocked = useStore((s) => s.project?.settings.autonomy.unlocked ?? false);
  const [picked, setPicked] = useState("");
  const active = (agents ?? []).filter((a) => a.status !== "retired");
  const agent = active.find((a) => a.id === picked) ?? active.find((a) => a.kind === "central") ?? active[0];
  if (!agent) return <div className="muted small">{t("ws.noAgent")}</div>;
  return (
    <>
      <select value={agent.id} onChange={(e) => setPicked(e.target.value)} aria-label={t("ws.agent")}>
        {active.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <PowerControl permissions={agent.permissions} onApply={(l) => void applyPower(agent, l)} compact />
      {unlocked && <div className="tiny tone-amber-fg">{t("ws.unlockedNote")}</div>}
    </>
  );
}

function MasterCard() {
  const t = useT();
  const { data, error } = useMasterStatus();
  const enabled = data?.domains.filter((d) => d.enabled) ?? [];
  return (
    <>
      <MasterToggle />
      {error && <div className="tiny tone-red-fg">{t("ws.statusUnavailable")}</div>}
      {enabled.map((d) => (
        <DomainBar key={d.key} domain={d} compact />
      ))}
    </>
  );
}

/** Right CONTROL rail of the Swarm view: models, power, MCP/skills, limits, CLAUDE UNLOCKED, MASTER CONTROL. */
export const ControlRail = memo(function ControlRail() {
  const t = useT();
  const { env, loading, error, refresh } = useClaudeEnv();
  const { skills } = useSkills();
  const connections = useConnections();
  const settings = useStore((s) => s.project?.settings);
  const navigate = useStore((s) => s.navigate);
  const mcp = mcpConnectedCount(env, connections);
  const enabledSkills = skills?.filter((s) => s.enabled).length;

  return (
    <aside className="control-rail" aria-label={t("ws.rail.aria")}>
      <div className="rail-head">
        <span className="rail-title">{t("ws.rail.title")}</span>
        <span className="spacer" />
        {env && <span className="muted tiny" title={env.capturedAt}>{formatRelative(env.capturedAt)}</span>}
        <button className="icon-btn" onClick={refresh} disabled={loading} title={t("ws.rail.refreshTitle")} aria-label={t("common.refresh")}>
          {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
        </button>
      </div>
      {error && <div className="notice notice-error small">{error}</div>}

      <RailSection title={t("ws.rail.defaultModel")} onClick={() => navigate({ name: "models" })}>
        <dl className="kv kv-tight">
          <dt>{t("ws.rail.central")}</dt>
          <dd className="mono">{settings?.centralModel ?? t("comp.model.default")}</dd>
          <dt>{t("ws.rail.workers")}</dt>
          <dd className="mono">{settings?.workerModel ?? t("comp.model.default")}</dd>
        </dl>
      </RailSection>

      <RailSection title={t("ws.rail.power")} onClick={() => navigate({ name: "capabilities" })}>
        <AgentPower />
      </RailSection>

      <RailSection title={t("ws.rail.mcpSkills")} onClick={() => navigate({ name: "mcp" })}>
        <dl className="kv kv-tight">
          <dt>{t("ws.rail.claudeMcp")}</dt>
          <dd>{mcp.claude === null ? (env ? t("common.unavailable") : "—") : t("ws.rail.connected", { count: mcp.claude, total: env?.mcpServers.length ?? 0 })}</dd>
          <dt>{t("ws.rail.nexusMcp")}</dt>
          <dd>{t("ws.rail.nConnected", { count: mcp.nexus })}</dd>
          <dt>{t("ws.rail.commands")}</dt>
          <dd>{env ? env.commands.length : "—"}</dd>
          <dt>{t("ws.rail.skillsEnabled")}</dt>
          <dd>{enabledSkills ?? "—"}</dd>
        </dl>
      </RailSection>

      <RailSection title={t("ws.rail.rateLimits")} onClick={() => navigate({ name: "claude" })}>
        <RateLimitBars env={env} />
      </RailSection>

      <RailSection title={t("ws.rail.context")}>
        <ContextBar env={env} />
      </RailSection>

      <RailSection title={t("ws.rail.autonomy")} onClick={() => navigate({ name: "autonomy" })}>
        <UnlockedToggle />
      </RailSection>

      <RailSection title={t("ws.rail.master")} onClick={() => navigate({ name: "master" })}>
        <MasterCard />
      </RailSection>
    </aside>
  );
});
