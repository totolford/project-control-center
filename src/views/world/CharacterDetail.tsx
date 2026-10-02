import { useState } from "react";
import { ExternalLink, MessagesSquare, Send } from "lucide-react";
import { Spinner } from "../../components/Common";
import { Chip, StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { TASK_STATUS } from "../../lib/labels";
import { attempt } from "../../lib/toast";
import type { Agent, Character, Conversation, World } from "../../lib/types";
import { useConnections, useStore, useTask } from "../../store";
import { characterRing, liveAgent, spriteFill, initials } from "./status";

function list(items: string[]): string {
  return items.length ? items.join(", ") : "—";
}

/** Selected character: its template, and the real agent state when linked in a live mode. */
export function CharacterDetail({ world, character: c, agents, onConversation }: {
  world: World;
  character: Character;
  agents: Agent[];
  onConversation: (conv: Conversation) => void;
}) {
  const agent = liveAgent(c, world.mode, agents);
  const ring = characterRing(c, world.mode, agents);
  const linkedAgent = c.nexusAgent ? agents.find((a) => a.id === c.nexusAgent) : undefined;
  const openAgent = useStore((s) => s.openAgent);
  const roomName = (id: string | null) => world.rooms.find((r) => r.id === id)?.name ?? "—";

  return (
    <div className="world-detail">
      <div className="row">
        <span className="world-avatar" style={{ background: spriteFill(c.sprite), borderColor: ring.color }}>
          {initials(c.name)}
        </span>
        <div className="grow">
          <div className="world-detail-name">{c.name}</div>
          <div className="tiny" style={{ color: ring.color }}>
            {ring.label}
          </div>
        </div>
      </div>

      {agent ? (
        <div className="notice world-gap">
          <span className="grow">
            Linked to{" "}
            <button className="link-btn" onClick={() => openAgent(agent.id)}>
              {agent.name}
            </button>{" "}
            — real state below.
          </span>
          <button className="btn btn-sm" onClick={() => openAgent(agent.id)}>
            <ExternalLink size={12} /> Open agent
          </button>
        </div>
      ) : (
        <div className="notice notice-warn world-gap tiny">
          {c.nexusAgent && world.mode === "simulation"
            ? `Linked to ${linkedAgent?.name ?? c.nexusAgent}, but the world is in Simulation: this character is simulated, not your real agent.`
            : c.nexusAgent
              ? "Linked agent not found in this project: simulated."
              : "Simulated character — not one of your real agents."}
        </div>
      )}

      {agent && <LiveAgent agent={agent} />}

      <dl className="kv kv-tight world-gap">
        <dt>Room</dt>
        <dd>
          {roomName(c.room)}
          {c.targetRoom && c.targetRoom !== c.room && <span className="muted"> → {roomName(c.targetRoom)}</span>}
        </dd>
        <dt>Activity</dt>
        <dd>{c.activity ?? "—"}</dd>
        <dt>Last action</dt>
        <dd>{c.lastAction ?? "—"}</dd>
        {c.mood && (
          <>
            <dt>Mood</dt>
            <dd>
              {c.mood} <span className="chip tone-grey">simulated</span>
            </dd>
          </>
        )}
        <dt>Personality</dt>
        <dd>{c.personality || "—"}</dd>
        <dt>Goals</dt>
        <dd>{list(c.goals)}</dd>
        <dt>Memory</dt>
        <dd>{list(c.memory)}</dd>
        <dt>Skills</dt>
        <dd>{list(c.skills)}</dd>
        <dt>Tools</dt>
        <dd>{list(c.tools)}</dd>
        <dt>MCP</dt>
        <dd>{list(c.mcp)}</dd>
        <dt>Model</dt>
        <dd className="mono">{c.model ?? "default"}</dd>
        <dt>Autonomy</dt>
        <dd>{c.autonomy}</dd>
        <dt>Relationships</dt>
        <dd>{c.relationships.length ? c.relationships.map((r) => `${r.kind} ${r.with}`).join(" · ") : "—"}</dd>
      </dl>

      {agent && world.mode === "real_execution" && <SendInstruction agent={agent} />}
      <TalkWith world={world} character={c} onConversation={onConversation} />
    </div>
  );
}

function LiveAgent({ agent }: { agent: Agent }) {
  const task = useTask(agent.currentTask);
  const connections = useConnections();
  const names = agent.connections.map((id) => connections.find((c) => c.id === id)?.name ?? id);
  return (
    <dl className="kv kv-tight world-gap">
      <dt>Status</dt>
      <dd>
        <StatusBadge status={agent.status} />
      </dd>
      <dt>Current task</dt>
      <dd>
        {task ? (
          <>
            {task.title} <Chip tone={TASK_STATUS[task.status].tone}>{TASK_STATUS[task.status].label}</Chip>
          </>
        ) : (
          "—"
        )}
      </dd>
      <dt>Current action</dt>
      <dd>{agent.currentAction ?? "—"}</dd>
      <dt>Model</dt>
      <dd className="mono">{agent.model ?? "default"}</dd>
      <dt>Connections</dt>
      <dd>{list(names)}</dd>
      <dt>Skills</dt>
      <dd>{agent.profile.skillsEnabled ? "enabled" : "disabled"}</dd>
    </dl>
  );
}

function SendInstruction({ agent }: { agent: Agent }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const sent = await attempt(() => api.sendMessage(agent.id, text.trim()), `Instruction sent to ${agent.name}`);
    setBusy(false);
    if (sent) setText("");
  };
  return (
    <div className="world-gap">
      <div className="section-label">Send instruction</div>
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Instruction for ${agent.name} (runs a real Claude turn)`} />
      <div className="row-end">
        <button className="btn btn-sm primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? <Spinner size={12} /> : <Send size={12} />} Send
        </button>
      </div>
    </div>
  );
}

function TalkWith({ world, character, onConversation }: { world: World; character: Character; onConversation: (c: Conversation) => void }) {
  const others = world.characters.filter((o) => o.id !== character.id);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const target = others.find((o) => o.id === other);
  const talk = async () => {
    if (!target) return;
    setBusy(true);
    const conv = await attempt(() => api.worldConverse(character.id, target.id));
    setBusy(false);
    if (conv) onConversation(conv);
  };
  if (others.length === 0) return null;
  return (
    <div className="world-gap">
      <div className="section-label">Talk with…</div>
      <div className="row">
        <select className="grow" value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="">Choose a character</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" disabled={busy || !target} onClick={() => void talk()}>
          {busy ? <Spinner size={12} /> : <MessagesSquare size={12} />} Generate conversation
        </button>
      </div>
      <div className="tiny muted">
        One real Claude call ({world.settings.conversationModel}, a few cents). The conversation is simulated — written by Claude, not said by your agents.
      </div>
    </div>
  );
}
