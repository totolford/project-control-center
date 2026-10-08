import { memo, useMemo } from "react";
import { Play, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { isLive } from "../lib/labels";
import { normalizeProgress } from "../lib/format";
import type { Agent } from "../lib/types";
import { MessageList } from "../components/MessageList";
import { MissionProgress, ProgressBar } from "../components/ProgressBar";
import { StatusIndicator } from "../components/StatusIndicator";
import { useLatestAssistantText, useVisualState } from "../workspace/hooks";
import type { PanelBodyProps } from "../workspace/registry";
import { useAgent, useAgents, useMissions, useStore } from "../store";
import { HeaderActions, type PanelHeaderProps } from "../workspace/PanelHeader";
import { AgentInput } from "./AgentTerminal";
import { agentActions } from "./AgentHeader";
import { useT } from "../i18n";

const WorkerRow = memo(function WorkerRow({ agent }: { agent: Agent }) {
  const state = useVisualState(agent.id);
  const openAgent = useStore((s) => s.openAgent);
  const progress = normalizeProgress(agent.progress);
  return (
    <button className="worker-row" onClick={() => openAgent(agent.id)}>
      {state && <StatusIndicator state={state} dotOnly />}
      <span className="worker-name">{agent.name}</span>
      <span className="worker-action mono">{agent.currentAction ?? ""}</span>
      <span className="worker-progress">{progress != null && <ProgressBar value={progress} />}</span>
    </button>
  );
});

export const CentralPanel = memo(function CentralPanel({ spec }: PanelBodyProps) {
  const t = useT();
  const id = spec.agentId ?? "central";
  const central = useAgent(id);
  const agents = useAgents();
  const missions = useMissions();
  const latest = useLatestAssistantText(central ? id : undefined);
  const workers = useMemo(() => agents.filter((a) => a.kind === "worker" && a.status !== "retired"), [agents]);
  const active = missions.filter((m) => m.status === "active" || m.status === "planning");

  if (!central) {
    return <div className="muted pad">{t("panel.central.offline")}</div>;
  }
  const live = isLive(central.status);
  return (
    <div className="central-panel">
      <div className="panel-scroll pad-sm">
        <div className="section-label">{t("panel.central.mission")}</div>
        {active.length === 0 ? (
          <div className="muted small">{t("shell.strip.noMission")}</div>
        ) : (
          active.map((m) => (
            <div key={m.id} className="central-mission">
              <span className="grow ellipsis">{m.title}</span>
              <MissionProgress mission={m} />
            </div>
          ))
        )}
        <div className="section-label">{t("panel.central.latest")}</div>
        <div className="central-latest">{latest ? latest.text : <span className="muted">{live ? t("panel.central.noOutput") : t("panel.central.notRunning")}</span>}</div>
        <div className="section-label">{t("panel.central.workers", { count: workers.length })}</div>
        {workers.length === 0 ? (
          <div className="muted small">{t("panel.central.noWorkers")}</div>
        ) : (
          <div className="worker-list">
            {workers.map((w) => (
              <WorkerRow key={w.id} agent={w} />
            ))}
          </div>
        )}
        <div className="section-label">{t("panel.central.recent")}</div>
        <MessageList agentId={null} limit={8} compact />
      </div>
      <AgentInput agentId={id} name="Central" disabled={central.status === "retired"} />
    </div>
  );
});

/** Header of the Central panel: identity, derived state, start button, agent + panel menus. */
export const CentralHeader = memo(function CentralHeader({ spec, chrome }: PanelHeaderProps) {
  const t = useT();
  const id = spec.agentId ?? "central";
  const central = useAgent(id);
  const state = useVisualState(id);
  const openAgent = useStore((s) => s.openAgent);
  const canStart = central && !isLive(central.status) && central.status !== "retired";
  return (
    <header className="panel-head central-head">
      {chrome.grip}
      <Sparkles size={14} className="tone-accent-fg" />
      <span className="central-title">{t("panel.central.title")}</span>
      <span className="muted small ellipsis">· {t("panel.central.sub")}</span>
      <span className="spacer" />
      {state && <StatusIndicator state={state} />}
      {canStart && (
        <button className="btn btn-sm" onClick={() => void run(() => api.startAgent(id), t("panel.central.starting"))}>
          <Play size={12} /> {t("panel.act.start")}
        </button>
      )}
      <HeaderActions chrome={chrome} extra={central ? agentActions(central, () => openAgent(id)) : undefined} />
    </header>
  );
});
