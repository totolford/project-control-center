import { useState } from "react";
import { Send } from "lucide-react";
import { api } from "../../lib/api";
import { run } from "../../lib/toast";
import type { Agent } from "../../lib/types";
import { useStore } from "../../store";
import { MessageList } from "../../components/MessageList";

export function AgentMessages({ agent }: { agent: Agent }) {
  const addMessage = useStore((s) => s.addMessage);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    const ok = await run(async () => addMessage(await api.sendMessage(agent.id, body)));
    setBusy(false);
    if (ok) setText("");
  };

  return (
    <div className="tab-body">
      <div className="composer-inline">
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Message ${agent.name}… (Ctrl+Enter to send)`}
          disabled={busy || agent.status === "retired"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
          }}
          aria-label={`Message to ${agent.name}`}
        />
        <button className="btn primary" onClick={() => void send()} disabled={busy || !text.trim() || agent.status === "retired"}>
          <Send size={13} /> Send
        </button>
      </div>
      <MessageList agentId={agent.id} limit={200} />
    </div>
  );
}
