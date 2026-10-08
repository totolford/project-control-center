import { useRef } from "react";
import { ArrowLeft, Hand, Maximize2, MessageSquare, PanelRightClose, Play, Sparkles, Square, UserPen } from "lucide-react";
import { api } from "../lib/api";
import { formatClock, formatCost, normalizeProgress } from "../lib/format";
import { AGENT_STATUS, CONNECTION_STATUS, TASK_STATUS, isLive } from "../lib/labels";
import { run } from "../lib/toast";
import type { Agent } from "../lib/types";
import { RIGHT_MAX_WIDTH, RIGHT_MIN_WIDTH, useRightContext, type RightContext } from "../state/context";
import { setAgentModel } from "../state/actions";
import { useSkills } from "../state/claude";
import { useAgent, useConnections, useReadOnly, useStore, useTask } from "../store";
import { ModelSelect } from "../components/ModelSelect";
import { ProgressBar } from "../components/ProgressBar";
import { StatusDot } from "../components/StatusBadge";
import { Tabs } from "../components/Tabs";
import { Terminal } from "../views/agent/Terminal";
import { AgentChat } from "../views/central/AgentChat";
import { AutonomyChip, LimitedToolChip } from "../views/central/CentralCards";
import { MissionPanel } from "../views/missions/MissionPanel";
import { SkillPanel } from "../views/market/SkillPanel";
import { useRecentActions } from "../workspace/hooks";
import { engineLabel } from "../views/ai/aiLogic";
import { useT } from "../i18n";

type AgentTab = "chat" | "work" | "profile";

/** Drag handle on the panel's left edge; arrow keys resize too. */
function Resizer() {
  const t = useT();
  const width = useRightContext((s) => s.rightWidth);
  const setWidth = useRightContext((s) => s.setRightWidth);
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="right-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("right.resize")}
      aria-valuemin={RIGHT_MIN_WIDTH}
      aria-valuemax={RIGHT_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
        document.body.classList.add("resizing-x");
      }}
      onPointerMove={(e) => {
        if (start.current) setWidth(start.current.w + (start.current.x - e.clientX));
      }}
      onPointerUp={() => {
        start.current = null;
        document.body.classList.remove("resizing-x");
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setWidth(width + 24);
        else if (e.key === "ArrowRight") setWidth(width - 24);
        else return;
        e.preventDefault();
      }}
    />
  );
}

function Avatar({ agent }: { agent: Agent }) {
  const tint = agent.profile?.appearance?.tint ?? undefined;
  return (
    <span className={`chat-avatar${agent.kind === "central" ? " is-central" : ""}`} style={tint ? { borderColor: tint } : undefined} aria-hidden="true">
      {agent.kind === "central" ? <Sparkles size={14} /> : agent.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Identity and real session state of the agent the panel talks to, with its session controls. */
/** " · Ollama · qwen3:8b" or " · Claude · opus": the engine the agent is configured for (AI Engines). */
function EngineTag({ agent }: { agent: Agent }) {
  const settings = useStore((s) => s.project?.settings);
  const kind = agent.kind === "central" ? "central" : "worker";
  const fallback = kind === "central" ? settings?.centralModel : settings?.workerModel;
  const e = engineLabel(settings?.ai, kind, agent.profile.engine ?? null, agent.model ?? fallback ?? null);
  if (!e.local && !agent.model) return null;
  return (
    <span className="mono" title={e.text}>
      {" "}
      · {e.local ? `${e.provider} · ${e.model}` : e.model}
    </span>
  );
}

function AgentPanelHeader({ agent, onBack }: { agent: Agent; onBack?: () => void }) {
  const t = useT();
  const readOnly = useReadOnly();
  const navigate = useStore((s) => s.navigate);
  const setOpen = useRightContext((s) => s.setRightOpen);
  const status = AGENT_STATUS[agent.status];
  const name = agent.name;
  const live = isLive(agent.status);
  const central = agent.kind === "central";
  return (
    <header className="right-head">
      {onBack && (
        <button className="icon-btn" onClick={onBack} aria-label={t("right.back")} title={t("right.back")}>
          <ArrowLeft size={14} />
        </button>
      )}
      <Avatar agent={agent} />
      <div className="right-title">
        <span className="right-name">{central ? t("panel.central.title") : agent.name}</span>
        <span className="right-sub">
          <StatusDot tone={status.tone} pulse={status.pulse} /> {status.label}
          <EngineTag agent={agent} />
          {agent.totalCostUsd > 0 && <span> · {formatCost(agent.totalCostUsd)}</span>}
          {central && <AutonomyChip />}
          {central && <LimitedToolChip />}
        </span>
      </div>
      <span className="spacer" />
      {!live && agent.status !== "retired" && (
        <button className="icon-btn" disabled={readOnly} onClick={() => void run(() => api.startAgent(agent.id), t("panel.act.starting", { name }))} aria-label={t("right.startAria", { name })} title={t("right.startTitle")}>
          <Play size={14} />
        </button>
      )}
      {(agent.status === "working" || agent.status === "awaiting_permission") && (
        <button className="icon-btn" onClick={() => void run(() => api.interruptAgent(agent.id), t("panel.act.interrupted", { name }))} aria-label={t("right.interruptAria", { name })} title={t("right.interruptTitle")}>
          <Hand size={14} />
        </button>
      )}
      {live && (
        <button className="icon-btn" onClick={() => void run(() => api.stopAgent(agent.id), t("panel.act.stopping", { name }))} aria-label={t("right.stopAria", { name })} title={t("right.stopTitle")}>
          <Square size={13} />
        </button>
      )}
      <button className="icon-btn" onClick={() => navigate({ name: "agent", agentId: agent.id })} aria-label={t("right.openCenterAria", { name })} title={t("right.openCenter")}>
        <Maximize2 size={13} />
      </button>
      <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t("right.collapseAria")} title={t("right.collapse")}>
        <PanelRightClose size={14} />
      </button>
    </header>
  );
}

function SimpleHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const t = useT();
  const setOpen = useRightContext((s) => s.setRightOpen);
  return (
    <header className="right-head">
      <button className="icon-btn" onClick={onBack} aria-label={t("right.back")} title={t("right.back")}>
        <ArrowLeft size={14} />
      </button>
      <span className="right-name">{title}</span>
      <span className="spacer" />
      <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t("right.collapseAria")} title={t("right.collapse")}>
        <PanelRightClose size={14} />
      </button>
    </header>
  );
}

/** What the agent is doing right now: action, task, last tool calls and the raw transcript. */
function WorkTab({ agent }: { agent: Agent }) {
  const t = useT();
  const task = useTask(agent.currentTask);
  const openTask = useStore((s) => s.openTask);
  const actions = useRecentActions(agent.id, 6);
  const progress = normalizeProgress(agent.progress);
  return (
    <div className="right-work">
      <div className="right-work-head">
        <dl className="kv kv-tight">
          <div className="kv-pair">
            <dt>{t("panel.now")}</dt>
            <dd className="mono">{agent.currentAction ?? <span className="muted">{t("panel.idle")}</span>}</dd>
          </div>
          <div className="kv-pair">
            <dt>{t("panel.task")}</dt>
            <dd>
              {task ? (
                <button className="link-btn" onClick={() => openTask(task.id)}>
                  {task.title} · {TASK_STATUS[task.status].label}
                </button>
              ) : (
                <span className="muted">{t("panel.none")}</span>
              )}
            </dd>
          </div>
        </dl>
        {progress != null && <ProgressBar value={progress} />}
        {actions.length > 0 && (
          <ul className="action-list">
            {actions.map((a) => (
              <li key={a.id}>
                <span className="muted mono">{formatClock(a.ts)}</span>
                <span className="mono ellipsis">{a.action}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="right-work-log">
        <Terminal agentId={agent.id} dense />
      </div>
    </div>
  );
}

function ProfileTab({ agent }: { agent: Agent }) {
  const t = useT();
  const readOnly = useReadOnly();
  const navigate = useStore((s) => s.navigate);
  const connections = useConnections();
  const { skills } = useSkills();
  const granted = connections.filter((c) => agent.connections.includes(c.id));
  const mcp = granted.filter((c) => c.kind === "mcp" || c.kind === "roblox_studio");
  const other = granted.filter((c) => c.kind !== "mcp" && c.kind !== "roblox_studio");
  const enabledSkills = (skills ?? []).filter((s) => s.enabled);
  return (
    <div className="right-scroll pad-sm">
      <div className="muted small">{agent.role}</div>
      <dl className="kv kv-tight right-profile">
        <div className="kv-pair">
          <dt>{t("comp.model")}</dt>
          <dd>
            <ModelSelect value={agent.model} onChange={(m) => void setAgentModel(agent, m)} disabled={readOnly || agent.status === "retired"} label={t("right.modelOf", { name: agent.name })} />
          </dd>
        </div>
        <div className="kv-pair">
          <dt>{t("right.effort")}</dt>
          <dd className="mono">{agent.profile.effort ?? t("comp.model.default")}</dd>
        </div>
        <div className="kv-pair">
          <dt>{t("right.skills")}</dt>
          <dd>
            {agent.profile.skillsEnabled ? (
              skills === null ? (
                <span className="muted">{t("common.loading")}</span>
              ) : (
                <span title={enabledSkills.map((s) => s.name).join("\n")}>{t("right.skillsCount", { count: enabledSkills.length })}</span>
              )
            ) : (
              <span className="muted">{t("right.skillsDisabled")}</span>
            )}
          </dd>
        </div>
        <div className="kv-pair">
          <dt>MCP</dt>
          <dd>{mcp.length ? mcp.map((c) => c.name).join(", ") : <span className="muted">{t("right.noMcp")}</span>}</dd>
        </div>
        <div className="kv-pair">
          <dt>{t("right.connections")}</dt>
          <dd>{other.length ? other.map((c) => `${c.name} (${CONNECTION_STATUS[c.status].label})`).join(", ") : <span className="muted">{t("panel.none")}</span>}</dd>
        </div>
        <div className="kv-pair">
          <dt>{t("right.workdir")}</dt>
          <dd className="mono ellipsis" title={agent.workdir}>
            {agent.workdir}
            {agent.branch && ` · ${agent.branch}`}
          </dd>
        </div>
        <div className="kv-pair">
          <dt>{t("right.cost")}</dt>
          <dd>{formatCost(agent.totalCostUsd)}</dd>
        </div>
      </dl>
      <div className="row right-profile-actions">
        <button className="btn btn-sm" onClick={() => navigate({ name: "agent", agentId: agent.id })}>
          <UserPen size={12} /> {t("right.customize")}
        </button>
      </div>
    </div>
  );
}

function AgentContext({ agentId, tab, onBack }: { agentId: string; tab: AgentTab; onBack: () => void }) {
  const t = useT();
  const agent = useAgent(agentId);
  const openContext = useRightContext((s) => s.openContext);
  if (!agent) return <SimpleHeader title={t("panel.agentNotFound")} onBack={onBack} />;
  return (
    <>
      <AgentPanelHeader agent={agent} onBack={onBack} />
      <Tabs<AgentTab>
        tabs={[
          { key: "chat", label: t("right.tab.chat") },
          { key: "work", label: t("right.tab.work") },
          { key: "profile", label: t("right.tab.profile") },
        ]}
        active={tab}
        onChange={(next) => openContext({ kind: "agent", agentId, tab: next })}
      />
      <div className="right-body">
        {tab === "chat" && <AgentChat agentId={agent.id} placeholder={t("right.talkTo", { name: agent.name })} />}
        {tab === "work" && <WorkTab agent={agent} />}
        {tab === "profile" && <ProfileTab agent={agent} />}
      </div>
    </>
  );
}

function CentralContext() {
  const t = useT();
  const central = useAgent("central");
  const setOpen = useRightContext((s) => s.setRightOpen);
  if (!central) {
    return (
      <>
        <header className="right-head">
          <span className="right-name">{t("panel.central.title")}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t("right.collapseAria")}>
            <PanelRightClose size={14} />
          </button>
        </header>
        <div className="muted pad">{t("right.noCentral")}</div>
      </>
    );
  }
  return (
    <>
      <AgentPanelHeader agent={central} />
      <div className="right-body">
        <AgentChat agentId="central" placeholder={t("right.askCentral")} />
      </div>
    </>
  );
}

function ContextBody({ right, back }: { right: RightContext; back: () => void }) {
  const t = useT();
  switch (right.kind) {
    case "central":
      return <CentralContext />;
    case "agent":
      return right.agentId === "central" && !right.tab ? <CentralContext /> : <AgentContext agentId={right.agentId} tab={right.tab ?? "chat"} onBack={back} />;
    case "mission":
      return (
        <>
          <SimpleHeader title={t("right.mission")} onBack={back} />
          <div className="right-body right-scroll">
            <MissionPanel missionId={right.missionId} />
          </div>
        </>
      );
    case "skill":
      return (
        <>
          <SimpleHeader title={t("right.skill")} onBack={back} />
          <div className="right-body right-scroll">
            <SkillPanel skillId={right.skillId} marketId={right.marketId} />
          </div>
        </>
      );
  }
}

/** Right side of the shell: the Central chat by default, or the selected agent / mission / skill. */
export function RightPanel() {
  const t = useT();
  const right = useRightContext((s) => s.right);
  const open = useRightContext((s) => s.rightOpen);
  const width = useRightContext((s) => s.rightWidth);
  const setOpen = useRightContext((s) => s.setRightOpen);
  const reset = useRightContext((s) => s.resetContext);
  const centralStatus = useStore((s) => s.project?.agents.find((a) => a.id === "central")?.status);
  if (!open) {
    const tone = centralStatus ? AGENT_STATUS[centralStatus] : null;
    return (
      <aside className="right-rail" aria-label={t("right.collapsedAria")}>
        <button className="right-rail-btn" onClick={() => setOpen(true)} title={t("right.openChat")} aria-label={t("right.openChat")}>
          <MessageSquare size={15} />
          {tone && <StatusDot tone={tone.tone} pulse={tone.pulse} />}
          <span className="right-rail-label">{t("right.rail")}</span>
        </button>
      </aside>
    );
  }
  return (
    <aside className="right-panel" style={{ width }} aria-label={t("right.panelAria")}>
      <Resizer />
      <ContextBody right={right} back={reset} />
    </aside>
  );
}
