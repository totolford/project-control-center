import { memo, useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import { formatClock } from "../lib/format";
import type { Agent, Message } from "../lib/types";
import { useAgents, useLiveMessages, useStore } from "../store";
import { useUi } from "../state/ui";
import { Loading } from "./Common";

/** Message history for one agent (or all when null), merged with live AgentMessage events. Newest first. */
export function useMessages(agentId: string | null, limit: number): { messages: Message[]; loading: boolean } {
  const [history, setHistory] = useState<Message[] | null>(null);
  const live = useLiveMessages();
  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    void attempt(() => api.messages(agentId, limit)).then((m) => {
      if (!cancelled) setHistory(m ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, limit]);
  const messages = useMemo(() => {
    const byId = new Map<string, Message>();
    for (const m of history ?? []) byId.set(m.id, m);
    for (const m of live) if (agentId === null || m.from === agentId || m.to === agentId) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }, [history, live, agentId, limit]);
  return { messages, loading: history === null };
}

function nameOf(agents: Agent[], id: string): string {
  if (id === "user") return "You";
  return agents.find((a) => a.id === id)?.name ?? id;
}

const Party = memo(function Party({ id, agents }: { id: string; agents: Agent[] }) {
  const openAgent = useStore((s) => s.openAgent);
  const known = agents.some((a) => a.id === id);
  if (!known) return <span className="msg-party">{nameOf(agents, id)}</span>;
  return (
    <button
      className="msg-party link-btn"
      onClick={(e) => {
        e.stopPropagation();
        openAgent(id);
      }}
    >
      {nameOf(agents, id)}
    </button>
  );
});

export const MessageRow = memo(function MessageRow({ msg, agents, compact }: { msg: Message; agents: Agent[]; compact?: boolean }) {
  const openTask = useStore((s) => s.openTask);
  const openMessage = useUi((s) => s.openMessage);
  return (
    <div
      className={`msg${compact ? " compact" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => openMessage(msg)}
      onKeyDown={(e) => e.key === "Enter" && openMessage(msg)}
    >
      <div className="msg-head">
        <span className="muted mono small">{formatClock(msg.createdAt)}</span>
        <Party id={msg.from} agents={agents} />
        <ArrowRight size={12} className="muted" />
        <Party id={msg.to} agents={agents} />
        <span className={`chip tone-${msg.kind === "request" ? "accent" : msg.kind === "response" ? "green" : "grey"}`}>{msg.kind}</span>
        {msg.subject && <span className="msg-subject">{msg.subject}</span>}
        <span className="spacer" />
        {msg.taskId && (
          <button
            className="link-btn small"
            onClick={(e) => {
              e.stopPropagation();
              openTask(msg.taskId!);
            }}
          >
            task
          </button>
        )}
        {msg.deliveredAt ? (
          <span className="muted small" title={`Delivered ${formatClock(msg.deliveredAt)}`}>
            delivered
          </span>
        ) : (
          <span className="chip tone-amber">queued</span>
        )}
      </div>
      <div className={`msg-body${compact ? " clamp" : ""}`}>{msg.body}</div>
    </div>
  );
});

export function MessageList({ agentId, limit, compact }: { agentId: string | null; limit: number; compact?: boolean }) {
  const { messages, loading } = useMessages(agentId, limit);
  const agents = useAgents();
  if (loading) return <Loading />;
  if (messages.length === 0) return <div className="muted small pad">No messages yet.</div>;
  return (
    <div className="msg-list">
      {messages.map((m) => (
        <MessageRow key={m.id} msg={m} agents={agents} compact={compact} />
      ))}
    </div>
  );
}
