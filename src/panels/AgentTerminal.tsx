import { memo, useState } from "react";
import { Send } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { normalizeProgress } from "../lib/format";
import { ProgressBar } from "../components/ProgressBar";
import { Terminal } from "../views/agent/Terminal";
import type { PanelBodyProps } from "../workspace/registry";
import { useAgent, useConnections, useStore } from "../store";
import { useT } from "../i18n";

/** One-line composer that sends a real message to an agent's session. */
export function AgentInput({ agentId, name, disabled }: { agentId: string; name: string; disabled?: boolean }) {
  const t = useT();
  const addMessage = useStore((s) => s.addMessage);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    const ok = await run(async () => addMessage(await api.sendMessage(agentId, body)));
    setBusy(false);
    if (ok) setText("");
  };
  return (
    <form
      className="agent-input"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("panel.messageTo", { name })}
        disabled={busy || disabled}
        aria-label={t("panel.messageToAria", { name })}
      />
      <button className="icon-btn" type="submit" disabled={busy || disabled || !text.trim()} aria-label={t("panel.send")}>
        <Send size={13} />
      </button>
    </form>
  );
}

function Footer({ agentId }: { agentId: string }) {
  const t = useT();
  const agent = useAgent(agentId);
  const connections = useConnections();
  if (!agent) return null;
  const progress = normalizeProgress(agent.progress);
  const granted = connections.filter((c) => agent.connections.includes(c.id));
  return (
    <div className="agent-foot">
      <div className="agent-foot-line">
        <span className="agent-foot-action mono" title={agent.currentAction ?? undefined}>
          {agent.currentAction ?? <span className="muted">{t("panel.idle")}</span>}
        </span>
        {granted.map((c) => (
          <span key={c.id} className={`chip tone-${c.status === "connected" ? "green" : c.status === "error" ? "red" : "grey"}`} title={`${c.kind} · ${c.status}`}>
            {c.name}
          </span>
        ))}
      </div>
      {progress != null && <ProgressBar value={progress} />}
    </div>
  );
}

export const AgentTerminal = memo(function AgentTerminal({ spec }: PanelBodyProps) {
  const t = useT();
  const agent = useAgent(spec.agentId);
  if (!agent) return <div className="muted pad">{t("panel.agentGone")}</div>;
  return (
    <div className="agent-term">
      <Terminal agentId={agent.id} dense />
      <Footer agentId={agent.id} />
      <AgentInput agentId={agent.id} name={agent.name} disabled={agent.status === "retired"} />
    </div>
  );
});
