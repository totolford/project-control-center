import { useEffect, useState } from "react";
import { Crown, Play, Send } from "lucide-react";
import { api } from "../lib/api";
import { subscribeLogs } from "../lib/logBus";
import { run } from "../lib/toast";
import { isLive } from "../lib/labels";
import type { LogEntry } from "../lib/types";
import { useAgent, useStore } from "../store";
import { StatusBadge } from "../components/StatusBadge";

const CENTRAL = "central";

/** Latest assistant text of an agent: initial fetch + live log updates. */
function useLatestAssistantText(agentId: string, enabled: boolean): LogEntry | null {
  const [latest, setLatest] = useState<LogEntry | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const take = (entry: LogEntry) => {
      if (entry.kind !== "assistant_text") return;
      setLatest((cur) => (cur && cur.id > entry.id ? cur : entry));
    };
    const unsubscribe = subscribeLogs(agentId, take);
    api
      .agentLogs(agentId, null, 50)
      .then((logs) => {
        if (!cancelled) logs.forEach(take);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [agentId, enabled]);
  return latest;
}

export function CentralBar() {
  const central = useAgent(CENTRAL);
  const openAgent = useStore((s) => s.openAgent);
  const latest = useLatestAssistantText(CENTRAL, central !== undefined);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    const ok = await run(async () => useStore.getState().addMessage(await api.sendMessage(CENTRAL, body)));
    setSending(false);
    if (ok) setText("");
  };

  const live = central ? isLive(central.status) : false;

  return (
    <footer className="central-bar">
      <button className="central-id" onClick={() => central && openAgent(CENTRAL)} disabled={!central} title="Open Central agent">
        <Crown size={14} className="tone-accent-fg" />
        <span>CENTRAL AGENT</span>
        {central ? <StatusBadge status={central.status} /> : <span className="muted small">not created</span>}
      </button>
      <div className="central-text" title={latest?.text}>
        {central && latest ? (
          latest.text
        ) : (
          <span className="muted">{central && live ? "No output yet." : "Central is offline — start it or create a mission."}</span>
        )}
        {central?.currentAction && live && <div className="central-action mono">{central.currentAction}</div>}
      </div>
      <div className="central-input">
        {central && !live && central.status !== "retired" && (
          <button className="btn" onClick={() => void run(() => api.startAgent(CENTRAL))} title="Start Central">
            <Play size={13} /> Start
          </button>
        )}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Message Central…"
          disabled={sending || !central}
          aria-label="Message to Central"
        />
        <button className="btn primary" onClick={() => void send()} disabled={sending || !text.trim() || !central} aria-label="Send">
          <Send size={13} />
        </button>
      </div>
    </footer>
  );
}
