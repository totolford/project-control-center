import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Bot, ChevronsUp, Crown, GitFork, MessageSquare, Moon, Pause, Play, Route, Split } from "lucide-react";
import { api } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import { attempt } from "../../lib/toast";
import type { Agent, DelegationRecord, PccEvent } from "../../lib/types";
import { saveSettingsWith } from "../../state/actions";
import { useRightContext } from "../../state/context";
import { useAgents, useReadOnly, useStore, useTasks, useTimeline } from "../../store";
import { Modal } from "../../components/Modal";
import { Chip, StatusBadge } from "../../components/StatusBadge";
import { EmptyState, Section } from "../../components/Common";
import { MAX_DEPTH, MIN_DEPTH, RANK_LABEL, type TreeNode, buildTree, canDemote, canPromote, clampDepth, descendantCount, pyramidStats, rankOf } from "./hierarchy";

const SLEEP_CHOICES = [0, 5, 10, 20, 30, 60, 120];

function RankIcon({ agent }: { agent: Agent }) {
  const rank = rankOf(agent);
  const label = RANK_LABEL[rank];
  if (rank === "commander") return <Crown size={13} className="tone-accent-fg" aria-label={label} />;
  if (rank === "lieutenant") return <ChevronsUp size={13} className="tone-amber-fg" aria-label={label} />;
  return <Bot size={13} className="muted" aria-label={label} />;
}

/** Real dormancy state: paused by the user, or session stopped while idle. */
function DormancyChip({ agent }: { agent: Agent }) {
  if (!agent.pausedAt) return null;
  return (
    <span title={`Paused ${formatRelative(agent.pausedAt)}: nothing is delivered until resumed`}>
      <Chip tone="amber">Paused</Chip>
    </span>
  );
}

function NodeRow({
  node,
  maxDepth,
  readOnly,
  onDemote,
  nameOf,
}: {
  node: TreeNode;
  maxDepth: number;
  readOnly: boolean;
  onDemote: (n: TreeNode) => void;
  nameOf: (id: string) => string;
}) {
  const a = node.agent;
  const openContext = useRightContext((s) => s.openContext);
  const tasks = useTasks();
  const upsert = useStore((s) => s.upsertAgent);
  const [busy, setBusy] = useState(false);
  const task = a.currentTask ? tasks.find((t) => t.id === a.currentTask) : undefined;
  const promote = canPromote(node, maxDepth);
  const demote = canDemote(node);
  const retired = a.status === "retired";
  const central = a.kind === "central";
  const act = async (fn: () => Promise<Agent | boolean>, text: string) => {
    setBusy(true);
    const out = await attempt(fn, text);
    if (out && typeof out === "object") upsert(out);
    setBusy(false);
  };
  const sleepable = !central && !a.pausedAt && a.status === "waiting";
  return (
    <div className={`hier-row rank-${rankOf(a)}${a.pausedAt ? " is-paused" : ""}${a.status === "sleeping" ? " is-sleeping" : ""}`}>
      <div className="hier-ident">
        <RankIcon agent={a} />
        <strong className="ellipsis">{a.name}</strong>
        <span className="hier-rank">{RANK_LABEL[rankOf(a)]}</span>
        <span className="muted small ellipsis">{a.role}</span>
        {node.orphan && (
          <Chip tone="orange">
            <span title={`Recorded parent ${nameOf(a.parentAgent ?? "?")} is not active; shown under Central`}>re-parented view</span>
          </Chip>
        )}
      </div>
      <div className="hier-state">
        <StatusBadge status={a.status} />
        <DormancyChip agent={a} />
        <span className="muted tiny ellipsis" title={`Provider ${a.provider} · model ${a.model ?? "default"}`}>
          {a.provider} · {a.model ?? "default"}
        </span>
        {task && (
          <span className="tiny ellipsis hier-task" title={task.title}>
            {task.id} {task.title}
          </span>
        )}
        {node.children.length > 0 && (
          <span className="muted tiny" title={`${descendantCount(node)} agent(s) in this branch`}>
            <GitFork size={11} /> {node.children.length}
          </span>
        )}
      </div>
      <div className="hier-actions" role="group" aria-label={`Actions for ${a.name}`}>
        <button className="icon-btn" title={`Talk to ${a.name}`} aria-label={`Talk to ${a.name}`} onClick={() => openContext({ kind: "agent", agentId: a.id, tab: "chat" })}>
          <MessageSquare size={13} />
        </button>
        {!central && !retired && !readOnly && (
          <>
            {rankOf(a) === "lieutenant" ? (
              <button className="icon-btn" disabled={busy || !demote.allowed} title={demote.reason} aria-label={`Demote ${a.name}`} onClick={() => onDemote(node)}>
                <ArrowDownToLine size={13} />
              </button>
            ) : (
              <button
                className="icon-btn"
                disabled={busy || !promote.allowed}
                title={promote.reason}
                aria-label={`Promote ${a.name}`}
                onClick={() => void act(() => api.promoteAgent(a.id), `${a.name} promoted to lieutenant`)}
              >
                <ArrowUpFromLine size={13} />
              </button>
            )}
            {a.pausedAt ? (
              <button className="icon-btn" disabled={busy} title={`Resume ${a.name}: queued messages and tasks are delivered`} aria-label={`Resume ${a.name}`} onClick={() => void act(() => api.resumeAgent(a.id), `${a.name} resumed`)}>
                <Play size={13} />
              </button>
            ) : (
              <button
                className="icon-btn"
                disabled={busy}
                title={`Pause ${a.name}: its current turn is interrupted and nothing is delivered until you resume it`}
                aria-label={`Pause ${a.name}`}
                onClick={() => void act(() => api.pauseAgent(a.id), `${a.name} paused`)}
              >
                <Pause size={13} />
              </button>
            )}
            <button
              className="icon-btn"
              disabled={busy || !sleepable}
              title={sleepable ? `Put ${a.name} to sleep now: its idle session is stopped and resumed on the next message` : "Only an idle (waiting) agent can be put to sleep"}
              aria-label={`Put ${a.name} to sleep`}
              onClick={() =>
                void act(async () => {
                  const ok = await api.sleepAgent(a.id);
                  if (!ok) throw new Error(`${a.name} is not idle (turn running, permission pending or input queued)`);
                  return ok;
                }, `${a.name} is falling asleep`)
              }
            >
              <Moon size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Branch(props: { node: TreeNode; maxDepth: number; readOnly: boolean; onDemote: (n: TreeNode) => void; nameOf: (id: string) => string }) {
  const { node } = props;
  return (
    <li role="treeitem" aria-level={node.level + 1} aria-expanded={node.children.length ? true : undefined} aria-label={node.agent.name}>
      <NodeRow {...props} />
      {node.children.length > 0 && (
        <ul role="group" className="hier-children">
          {node.children.map((c) => (
            <Branch key={c.agent.id} {...props} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Confirms a demotion that moves sub-agents to the lieutenant's parent. */
export function DemoteDialog({ node, onClose }: { node: TreeNode; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const agents = useAgents();
  const nameOf = (id: string) => agents.find((x) => x.id === id)?.name ?? id;
  const upsert = useStore((s) => s.upsertAgent);
  const a = node.agent;
  const parent = nameOf(a.parentAgent ?? "central");
  const confirm = async () => {
    setBusy(true);
    const out = await attempt(() => api.demoteAgent(a.id), `${a.name} demoted to specialist`);
    if (out) upsert(out);
    setBusy(false);
    if (out) onClose();
  };
  return (
    <Modal
      title={`Demote ${a.name}?`}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void confirm()} disabled={busy}>
            Demote to specialist
          </button>
        </>
      }
    >
      <p>
        {a.name} becomes a specialist: it can no longer create agents. Its {node.children.length} sub-agent(s) move under <strong>{parent}</strong>, which
        receives their open tasks and future results.
      </p>
      <ul className="hier-moving">
        {node.children.map((c) => (
          <li key={c.agent.id}>
            <RankIcon agent={c.agent} /> {c.agent.name} <span className="muted small">{c.agent.role}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">If {a.name} is mid-turn, its session restarts (resumed, same context) after the turn so its new tools apply.</p>
    </Modal>
  );
}

function Decisions({ nameOf }: { nameOf: (id: string) => string }) {
  const timeline = useTimeline();
  const [records, setRecords] = useState<DelegationRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refetch when a new decision is journaled.
  const latest = timeline.find((e) => e.kind === "DelegationDecision")?.id ?? 0;
  useEffect(() => {
    let alive = true;
    api
      .delegationDecisions(null, 50)
      .then((r) => alive && (setRecords(r), setError(null)))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [latest]);
  if (error) return <p className="tone-red-fg small">Decisions unavailable: {error}</p>;
  if (!records) return <p className="muted small">Loading…</p>;
  if (records.length === 0) return <p className="muted small">No delegation decision recorded yet. Agents record one before creating sub-agents.</p>;
  return (
    <ul className="hier-decisions">
      {records.map((d) => (
        <li key={d.id} className={d.needsSubAgents ? "is-delegate" : "is-solo"}>
          <div className="row">
            <Split size={12} />
            <strong>{nameOf(d.agentId)}</strong>
            <span>{d.needsSubAgents ? `delegates to ${d.children.length} sub-agent(s)` : "works without sub-agents"}</span>
            <span className="grow" />
            {d.taskId && <span className="muted tiny">{d.taskId}</span>}
            <span className="muted tiny" title={d.ts}>
              {formatRelative(d.ts)}
            </span>
          </div>
          <div className="small">{d.reason}</div>
          {d.children.length > 0 && (
            <ul className="hier-planned">
              {d.children.map((c, i) => (
                <li key={i} className="tiny">
                  <strong>{c.name || "(unnamed)"}</strong> {c.rank === "lieutenant" ? "· lieutenant" : ""} {c.role && <span className="muted">· {c.role}</span>}
                  {c.reason && <span className="muted"> — {c.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Cross-branch messages NEXUS routed through a parent (journal events, newest first). */
function Routes({ nameOf }: { nameOf: (id: string) => string }) {
  const timeline = useTimeline();
  const routes = useMemo(() => timeline.filter((e: PccEvent) => e.kind === "MessageRouted").slice(0, 30), [timeline]);
  if (routes.length === 0) return <p className="muted small">No routed message in the recent journal. Agents talk directly to their parent and sub-agents.</p>;
  return (
    <ul className="hier-routes">
      {routes.map((e) => {
        const p = e.payload as { from?: string; to?: string; via?: string | null; path?: string[] };
        return (
          <li key={e.id} className="tiny">
            <Route size={11} /> {nameOf(p.from ?? "?")} → {nameOf(p.to ?? "?")}
            <span className="muted"> · {p.via ? `via ${nameOf(p.via)}` : "cross-branch"} · {(p.path ?? []).map(nameOf).join(" → ")}</span>
            <span className="muted" title={e.ts}>
              {" "}
              · {formatRelative(e.ts)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The agent pyramid: Central → lieutenants → specialists, live, with rank and dormancy controls. */
export function HierarchyView() {
  const agents = useAgents();
  const settings = useStore((s) => s.project?.settings);
  const readOnly = useReadOnly();
  const [demoting, setDemoting] = useState<TreeNode | null>(null);
  const upsert = useStore((s) => s.upsertAgent);
  // Confirm only when the demotion moves sub-agents.
  const onDemote = (n: TreeNode) => {
    if (n.children.length > 0) return setDemoting(n);
    void attempt(() => api.demoteAgent(n.agent.id), `${n.agent.name} demoted to specialist`).then((out) => out && upsert(out));
  };
  const tree = useMemo(() => buildTree(agents), [agents]);
  const stats = pyramidStats(tree);
  const maxDepth = clampDepth(settings?.maxHierarchyDepth);
  const sleepAfter = settings?.sleepAfterMinutes ?? 20;
  const nameOf = useMemo(() => {
    const names = new Map(agents.map((a) => [a.id, a.name]));
    return (id: string) => names.get(id) ?? id;
  }, [agents]);

  if (tree.length === 0) return <EmptyState title="No agent yet" />;
  return (
    <div className="hierarchy">
      <div className="hier-bar">
        <span className="hier-stat">
          <ChevronsUp size={12} /> {stats.lieutenants} lieutenant{stats.lieutenants === 1 ? "" : "s"}
        </span>
        <span className="hier-stat">
          <Bot size={12} /> {stats.specialists} specialist{stats.specialists === 1 ? "" : "s"}
        </span>
        <span className="hier-stat">
          depth {stats.depth}/{maxDepth}
        </span>
        {stats.sleeping > 0 && <span className="hier-stat">{stats.sleeping} sleeping</span>}
        {stats.paused > 0 && <span className="hier-stat tone-amber-fg">{stats.paused} paused</span>}
        <span className="grow" />
        <label className="hier-setting" title="Deepest level below Central. Agents cannot create sub-agents beyond it.">
          Max depth
          <select
            value={maxDepth}
            disabled={readOnly || !settings}
            onChange={(e) => void saveSettingsWith((s) => ({ ...s, maxHierarchyDepth: Number(e.target.value) }), `Maximum hierarchy depth: ${e.target.value}`)}
          >
            {Array.from({ length: MAX_DEPTH - MIN_DEPTH + 1 }, (_, i) => MIN_DEPTH + i).map((d) => (
              <option key={d} value={d}>
                {d}
                {d === 1 ? " (flat)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="hier-setting" title="An idle agent's Claude Code session is stopped after this delay to free resources; it resumes (same session) on its next message or task.">
          Sleep after
          <select
            value={sleepAfter}
            disabled={readOnly || !settings}
            onChange={(e) => void saveSettingsWith((s) => ({ ...s, sleepAfterMinutes: Number(e.target.value) }), "Sleep delay saved")}
          >
            {(SLEEP_CHOICES.includes(sleepAfter) ? SLEEP_CHOICES : [...SLEEP_CHOICES, sleepAfter].sort((x, y) => x - y)).map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "Never" : `${m} min idle`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul role="tree" aria-label="Agent hierarchy" className="hier-tree">
        {tree.map((n) => (
          <Branch key={n.agent.id} node={n} maxDepth={maxDepth} readOnly={readOnly} onDemote={onDemote} nameOf={nameOf} />
        ))}
      </ul>
      <div className="hier-journal">
        <Section title="Delegation decisions">
          <Decisions nameOf={nameOf} />
        </Section>
        <Section title="Routed messages">
          <Routes nameOf={nameOf} />
        </Section>
      </div>
      {demoting && <DemoteDialog node={demoting} onClose={() => setDemoting(null)} />}
    </div>
  );
}
