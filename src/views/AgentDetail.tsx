import { useState } from "react";
import { Archive, ArrowLeft, Crown, FolderOpen, Hand, Play, RotateCw, Square } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { isLive } from "../lib/labels";
import { formatCost, formatDateTime, normalizeProgress } from "../lib/format";
import type { Agent } from "../lib/types";
import { useAgent, useStore, useTask } from "../store";
import { EmptyState } from "../components/Common";
import { StatusBadge } from "../components/StatusBadge";
import { ProgressBar } from "../components/ProgressBar";
import { Tabs } from "../components/Tabs";
import { Modal } from "../components/Modal";
import { MemoryEditor, useMemoryFiles } from "../components/MemoryEditor";
import { Terminal } from "./agent/Terminal";
import { AgentMessages } from "./agent/AgentMessages";
import { AgentPermissions } from "./agent/AgentPermissions";
import { AgentSessions } from "./agent/AgentSessions";

type TabKey = "terminal" | "messages" | "permissions" | "memory" | "sessions";

const TABS: { key: TabKey; label: string }[] = [
  { key: "terminal", label: "Terminal" },
  { key: "messages", label: "Messages" },
  { key: "permissions", label: "Permissions / Tools" },
  { key: "memory", label: "Memory" },
  { key: "sessions", label: "Sessions" },
];

function AgentMemory({ agent }: { agent: Agent }) {
  const { files, setFiles } = useMemoryFiles();
  const key = `agent:${agent.id}`;
  if (files === null) return null;
  return (
    <div className="tab-body tab-fill">
      <MemoryEditor
        memKey={key}
        file={files.find((f) => f.key === key)}
        onSaved={(f) => setFiles((cur) => [...(cur ?? []).filter((x) => x.key !== f.key), f])}
      />
    </div>
  );
}

export function AgentControls({ agent }: { agent: Agent }) {
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = isLive(agent.status);
  const retired = agent.status === "retired";
  const act = async (fn: () => Promise<void>, text: string) => {
    setBusy(true);
    await run(fn, text);
    setBusy(false);
  };
  return (
    <div className="agent-controls">
      {!live && !retired && (
        <button className="btn primary" disabled={busy} onClick={() => void act(() => api.startAgent(agent.id), `Starting ${agent.name}`)}>
          <Play size={13} /> Start
        </button>
      )}
      {live && (
        <button className="btn" disabled={busy} onClick={() => void act(() => api.stopAgent(agent.id), `Stopping ${agent.name}`)}>
          <Square size={13} /> Stop
        </button>
      )}
      {!retired && (
        <button className="btn" disabled={busy} onClick={() => void act(() => api.restartAgent(agent.id), `Restarting ${agent.name}`)}>
          <RotateCw size={13} /> Restart
        </button>
      )}
      {(agent.status === "working" || agent.status === "awaiting_permission") && (
        <button className="btn" disabled={busy} onClick={() => void act(() => api.interruptAgent(agent.id), `Interrupt sent to ${agent.name}`)}>
          <Hand size={13} /> Interrupt
        </button>
      )}
      {agent.kind === "worker" && !retired && (
        <button className="btn danger-ghost" disabled={busy} onClick={() => setConfirmRetire(true)}>
          <Archive size={13} /> Retire
        </button>
      )}
      {confirmRetire && (
        <Modal
          title={`Retire ${agent.name}?`}
          onClose={() => setConfirmRetire(false)}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmRetire(false)} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => void act(() => api.retireAgent(agent.id), `${agent.name} retired`).then(() => setConfirmRetire(false))}
              >
                Retire agent
              </button>
            </>
          }
        >
          <p>The agent's session is stopped and it no longer receives tasks. Its history, logs and memory are kept.</p>
        </Modal>
      )}
    </div>
  );
}

export function AgentDetail({ agentId }: { agentId: string }) {
  const agent = useAgent(agentId);
  const task = useTask(agent?.currentTask);
  const navigate = useStore((s) => s.navigate);
  const openTask = useStore((s) => s.openTask);
  const [tab, setTab] = useState<TabKey>("terminal");

  if (!agent) {
    return (
      <div className="page">
        <EmptyState title="Agent not found">
          <button className="btn" onClick={() => navigate({ name: "swarm" })}>
            Back to swarm
          </button>
        </EmptyState>
      </div>
    );
  }
  const progress = normalizeProgress(agent.progress);

  return (
    <div className="page page-fill agent-detail">
      <div className="agent-header">
        <button className="icon-btn" onClick={() => navigate({ name: "swarm" })} aria-label="Back to swarm">
          <ArrowLeft size={16} />
        </button>
        <div className="grow">
          <div className="row">
            {agent.kind === "central" && <Crown size={15} className="tone-accent-fg" />}
            <h1>{agent.name}</h1>
            <StatusBadge status={agent.status} />
            <span className="chip tone-grey">{agent.kind}</span>
          </div>
          <div className="muted">{agent.role}</div>
        </div>
        <AgentControls agent={agent} />
      </div>

      <div className="agent-meta">
        <dl className="kv kv-inline">
          <dt>Model</dt>
          <dd className="mono">{agent.model ?? "default"}</dd>
          <dt>Isolation</dt>
          <dd>
            {agent.isolation}
            {agent.branch && <span className="mono"> · {agent.branch}</span>}
          </dd>
          <dt>Workdir</dt>
          <dd>
            <button className="link-btn mono" onClick={() => void run(() => api.openPath(agent.workdir))} title="Open folder">
              <FolderOpen size={11} /> {agent.workdir}
            </button>
          </dd>
          <dt>Cost</dt>
          <dd>{formatCost(agent.totalCostUsd)}</dd>
          <dt>Created</dt>
          <dd>
            {formatDateTime(agent.createdAt)} by {agent.createdBy}
          </dd>
        </dl>
        <div className="agent-now">
          <div className="row">
            <span className="section-label">Current task</span>
            {task ? (
              <button className="link-btn" onClick={() => openTask(task.id)}>
                {task.title}
              </button>
            ) : (
              <span className="muted">{agent.currentTask ?? "none"}</span>
            )}
          </div>
          {progress != null && <ProgressBar value={progress} />}
          <div className="agent-action mono" title={agent.currentAction ?? undefined}>
            {agent.currentAction ?? <span className="muted">No current action</span>}
          </div>
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <div className="tab-content">
        {tab === "terminal" && <Terminal agentId={agent.id} />}
        {tab === "messages" && <AgentMessages agent={agent} />}
        {tab === "permissions" && <AgentPermissions agent={agent} />}
        {tab === "memory" && <AgentMemory agent={agent} />}
        {tab === "sessions" && <AgentSessions agent={agent} />}
      </div>
    </div>
  );
}
