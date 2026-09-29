import { memo } from "react";
import { Archive, ExternalLink, Hand, Play, RotateCw, Square } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { isLive } from "../lib/labels";
import { normalizeProgress } from "../lib/format";
import type { Agent } from "../lib/types";
import type { MenuEntry } from "../components/Menu";
import { StatusDot } from "../components/StatusBadge";
import { VISUAL_STATE } from "../workspace/agentState";
import { useProviderName, useVisualState } from "../workspace/hooks";
import { HeaderActions, type PanelHeaderProps } from "../workspace/PanelHeader";
import { useAgent, useAgentNumber, useStore, useTask } from "../store";

/** Start/stop/… actions for an agent, as menu entries. Retire asks for confirmation. */
export function agentActions(agent: Agent, openDetails: () => void): MenuEntry[] {
  const live = isLive(agent.status);
  const retired = agent.status === "retired";
  const act = (fn: () => Promise<void>, text: string) => () => void run(fn, text);
  return [
    { label: "Start", icon: <Play size={13} />, disabled: live || retired, onSelect: act(() => api.startAgent(agent.id), `Starting ${agent.name}`) },
    { label: "Stop", icon: <Square size={13} />, disabled: !live, onSelect: act(() => api.stopAgent(agent.id), `Stopping ${agent.name}`) },
    { label: "Restart", icon: <RotateCw size={13} />, disabled: retired, onSelect: act(() => api.restartAgent(agent.id), `Restarting ${agent.name}`) },
    {
      label: "Interrupt",
      icon: <Hand size={13} />,
      disabled: agent.status !== "working" && agent.status !== "awaiting_permission",
      onSelect: act(() => api.interruptAgent(agent.id), `Interrupt sent to ${agent.name}`),
    },
    {
      label: "Retire",
      icon: <Archive size={13} />,
      danger: true,
      disabled: agent.kind !== "worker" || retired,
      onSelect: () =>
        void ask(`Retire ${agent.name}? Its session stops and it no longer receives tasks. History and memory are kept.`, {
          title: "Retire agent",
          kind: "warning",
        }).then((ok) => ok && run(() => api.retireAgent(agent.id), `${agent.name} retired`)),
    },
    "separator",
    { label: "Open details", icon: <ExternalLink size={13} />, onSelect: openDetails },
  ];
}

export const AgentHeader = memo(function AgentHeader({ spec, chrome }: PanelHeaderProps) {
  const agent = useAgent(spec.agentId);
  const task = useTask(agent?.currentTask);
  const state = useVisualState(spec.agentId);
  const number = useAgentNumber(spec.agentId ?? "");
  const provider = useProviderName(agent?.provider ?? "");
  const openAgent = useStore((s) => s.openAgent);
  if (!agent || !state) {
    return (
      <header className="panel-head">
        {chrome.grip}
        <span className="panel-head-title muted">Agent not found</span>
        <HeaderActions chrome={chrome} />
      </header>
    );
  }
  const meta = VISUAL_STATE[state];
  const progress = normalizeProgress(agent.progress);
  return (
    <header className="panel-head agent-head" data-state={state}>
      {chrome.grip}
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      <div className="agent-head-main">
        <div className="agent-head-line">
          <span className="agent-head-provider">{provider}</span>
          <span className="agent-head-num">#{number}</span>
          <span className="agent-head-name" title={agent.name}>
            {agent.name}
          </span>
        </div>
        <div className="agent-head-sub" title={task?.title ?? agent.role}>
          {task ? task.title : agent.role}
        </div>
      </div>
      <span className={`chip tone-${meta.tone} state-chip`}>{meta.label}</span>
      {progress != null && <span className="agent-head-pct">{Math.round(progress * 100)}%</span>}
      <HeaderActions chrome={chrome} extra={agentActions(agent, () => openAgent(agent.id))} />
    </header>
  );
});
