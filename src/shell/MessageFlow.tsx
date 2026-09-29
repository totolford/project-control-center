import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Message } from "../lib/types";
import { useUi } from "../state/ui";
import { useAgents, useLiveMessages } from "../store";

const VISIBLE_MS = 7000;
const MAX_CHIPS = 4;

/** Transient chips for agent-to-agent messages as they arrive (live AgentMessage events). */
export function MessageFlow() {
  const live = useLiveMessages();
  const agents = useAgents();
  const openMessage = useUi((s) => s.openMessage);
  const [chips, setChips] = useState<Message[]>([]);
  const seen = useRef<Set<string> | null>(null);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(live.map((m) => m.id));
      return;
    }
    const fresh = live.filter((m) => !seen.current!.has(m.id));
    for (const m of fresh) seen.current.add(m.id);
    const shown = fresh.filter((m) => m.from !== "user");
    if (shown.length === 0) return;
    setChips((cur) => [...cur, ...shown].slice(-MAX_CHIPS));
    for (const m of shown) {
      timers.current.set(
        m.id,
        window.setTimeout(() => {
          timers.current.delete(m.id);
          setChips((cur) => cur.filter((c) => c.id !== m.id));
        }, VISIBLE_MS),
      );
    }
  }, [live]);

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => window.clearTimeout(t));
  }, []);

  if (chips.length === 0) return null;
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <div className="msg-flow" aria-live="polite">
      {chips.map((m) => (
        <button key={m.id} className="flow-chip" onClick={() => openMessage(m)}>
          <span className="flow-route">
            <strong>{name(m.from)}</strong> <ArrowRight size={11} /> <strong>{name(m.to)}</strong>
            <span className="chip tone-blue">{m.kind}</span>
          </span>
          <span className="flow-body">{(m.subject ?? m.body).split("\n")[0]}</span>
        </button>
      ))}
    </div>
  );
}
