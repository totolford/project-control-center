import { useEffect, useMemo, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import { formatClock, formatDateTime } from "../lib/format";
import type { Message } from "../lib/types";
import { useUi } from "../state/ui";
import { useAgents, useLiveMessages, useMissions, useStore, useTask } from "../store";
import { Loading } from "../components/Common";
import { useT } from "../i18n";

/** The conversation between the two parties of a message (history + live). */
function useConversation(msg: Message): Message[] | null {
  const live = useLiveMessages();
  const [history, setHistory] = useState<Message[] | null>(null);
  const agentId = msg.from === "user" ? msg.to : msg.from;
  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    void attempt(() => api.messages(agentId, 200)).then((m) => !cancelled && setHistory(m ?? []));
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return useMemo(() => {
    if (!history) return null;
    const pair = (m: Message) => (m.from === msg.from && m.to === msg.to) || (m.from === msg.to && m.to === msg.from);
    const byId = new Map<string, Message>();
    for (const m of [...history, ...live]) if (pair(m)) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [history, live, msg.from, msg.to]);
}

export function MessageDetail() {
  const msg = useUi((s) => s.messageDetail);
  const close = useUi((s) => s.openMessage);
  useEffect(() => {
    if (!msg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        close(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [msg, close]);
  if (!msg) return null;
  return <MessageDrawer key={msg.id} msg={msg} onClose={() => close(null)} />;
}

function MessageDrawer({ msg, onClose }: { msg: Message; onClose: () => void }) {
  const agents = useAgents();
  const missions = useMissions();
  const task = useTask(msg.taskId);
  const openTask = useStore((s) => s.openTask);
  const openMessage = useUi((s) => s.openMessage);
  const conversation = useConversation(msg);
  const t = useT();
  const name = (id: string) => (id === "user" ? t("bar.notif.you") : (agents.find((a) => a.id === id)?.name ?? id));
  const mission = msg.missionId ? missions.find((m) => m.id === msg.missionId) : undefined;
  const current = conversation?.find((m) => m.id === msg.id) ?? msg;

  return (
    <aside className="overlay-drawer" aria-label={t("msg.detail")}>
      <div className="drawer-header">
        <strong>{name(msg.from)}</strong>
        <ArrowRight size={13} className="muted" />
        <strong className="grow">{name(msg.to)}</strong>
        <span className="chip tone-blue">{msg.kind}</span>
        <button className="icon-btn" onClick={onClose} aria-label={t("msg.close")}>
          <X size={15} />
        </button>
      </div>
      <div className="drawer-body">
        <div className="muted small">
          {formatDateTime(msg.createdAt)} · {current.deliveredAt ? t("msg.delivered", { time: formatClock(current.deliveredAt) }) : t("msg.queued")}
          {mission && t("msg.mission", { title: mission.title })}
        </div>
        {task && (
          <button className="link-btn small" onClick={() => openTask(task.id)}>
            {t("msg.task", { title: task.title })}
          </button>
        )}
        {msg.subject && <div className="strong msg-detail-subject">{msg.subject}</div>}
        <div className="prewrap summary">{msg.body}</div>
        <div className="section-label">
          {t("msg.conversation", { a: name(msg.from), b: name(msg.to) })}
        </div>
        {conversation === null ? (
          <Loading />
        ) : (
          <div className="convo">
            {conversation.map((m) => (
              <button key={m.id} className={`convo-item${m.id === msg.id ? " current" : ""}${m.from === msg.from ? " left" : " right"}`} onClick={() => openMessage(m)}>
                <span className="muted small">
                  {name(m.from)} · {formatClock(m.createdAt)} · {m.kind}
                  {!m.deliveredAt && ` · ${t("msg.queued")}`}
                </span>
                <span className="convo-body">{m.subject ?? m.body}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
