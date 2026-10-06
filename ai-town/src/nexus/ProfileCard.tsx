// NEXUS addition: the character profile card, a game-styled floating panel
// over the world. It only shows what the agent row says and every button
// posts a message to NEXUS, which runs the real action (or opens its UI).
import { useEffect, useRef } from 'react';
import type { SpritesheetData } from '../../data/spritesheets/types';
import { AgentAction, ToNexus } from './protocol';
import { CharacterLook, NexusAgentRow, STATE_COLOR, family as familyOf, hexColor, parseTint, rankLabel, visualState } from './state';
import { stateEmoji } from './AgentOverlay';

/** First "down" frame of a spritesheet, drawn pixelated and tinted like on the map. */
export function SpritePortrait({ look, tint, scale = 3 }: { look: CharacterLook; tint?: number; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = firstFrame(look.spritesheetData);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !frame) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, canvas.width, canvas.height);
      if (tint !== undefined) {
        // Multiply like PIXI's tint, then keep only the sprite's own pixels.
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = hexColor(tint);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
      }
    };
    img.src = look.textureUrl;
  }, [look.textureUrl, frame?.x, frame?.y, frame?.w, frame?.h, tint]);
  if (!frame) return null;
  return (
    <canvas
      ref={ref}
      width={frame.w * scale}
      height={frame.h * scale}
      style={{ imageRendering: 'pixelated', width: frame.w * scale, height: frame.h * scale }}
      aria-hidden
    />
  );
}

function firstFrame(data: SpritesheetData) {
  const name = data.animations?.down?.[0] ?? Object.keys(data.frames)[0];
  return name ? data.frames[name]?.frame : undefined;
}

const ACTIONS: { action: AgentAction; label: string; title: string }[] = [
  { action: 'assignMission', label: 'Mission', title: 'Open New Mission in NEXUS' },
  { action: 'pause', label: 'Pause', title: 'Interrupt the current turn; nothing is delivered until resumed' },
  { action: 'stop', label: 'Stop', title: 'Stop the Claude Code session' },
  { action: 'restart', label: 'Restart', title: 'Restart the session (resumes its context)' },
  { action: 'follow', label: 'Follow', title: 'Camera follows this character' },
  { action: 'inspect', label: 'Inspect', title: 'Open the agent in NEXUS' },
  { action: 'customize', label: 'Skin', title: 'Customize Character' },
  { action: 'changeModel', label: 'Model', title: 'Change the model' },
  { action: 'changeSkills', label: 'Skills', title: 'Change the skills' },
  { action: 'changeMcp', label: 'MCP', title: 'Change the MCP servers' },
  { action: 'changeConnections', label: 'Links', title: 'Change the connections' },
  { action: 'viewTasks', label: 'Tasks', title: 'Open its tasks in NEXUS' },
  { action: 'viewMemory', label: 'Memory', title: 'Open its memory in NEXUS' },
  { action: 'viewTools', label: 'Tools', title: 'Open its tools and permissions in NEXUS' },
];

export function ProfileCard({
  agent,
  look,
  following,
  family,
  onSelect,
  onClose,
  send,
}: {
  agent: NexusAgentRow;
  look: CharacterLook | undefined;
  following: boolean;
  /** Supervisor and direct reports (see `family` in state.ts). */
  family: ReturnType<typeof familyOf>;
  onSelect: (nexusId: string) => void;
  onClose: () => void;
  send: (msg: ToNexus) => void;
}) {
  const state = visualState(agent);
  const color = hexColor(STATE_COLOR[state]);
  const emoji = stateEmoji(agent, state);
  const id = agent.nexusId;
  const live = state !== 'offline' && state !== 'sleeping';
  const rank = agent.isCentral ? 'commander' : agent.rank ?? 'specialist';
  const actions = ACTIONS.map((a) =>
    a.action === 'pause' && agent.paused
      ? { action: 'resume' as AgentAction, label: 'Resume', title: 'Deliver queued messages and tasks again' }
      : a,
  );
  if (rank === 'specialist' && !agent.isCentral)
    actions.push({ action: 'promote', label: 'Promote', title: 'Make it a lieutenant: it may create and supervise specialists' });
  if (rank === 'lieutenant')
    actions.push({ action: 'demote', label: 'Demote', title: 'Make it a specialist; its sub-agents move to its parent' });
  return (
    <section
      className="nexus-card pointer-events-auto font-body text-brown-100"
      aria-label={`${agent.name} profile`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header className="flex items-start gap-3">
        <div className="nexus-portrait">
          {look ? <SpritePortrait look={look} tint={parseTint(agent.tint)} /> : <span className="text-xs">?</span>}
        </div>
        <div className="min-w-0 grow">
          <div className="flex items-center gap-2">
            {agent.badge && <span className="nexus-badge">{agent.badge}</span>}
            <h2 className="truncate font-display text-2xl leading-none tracking-wide">{agent.name}</h2>
          </div>
          <div className="truncate text-sm text-clay-100">
            <span className={`nexus-rank nexus-rank-${rank}`}>{rankLabel(agent)}</span>{' '}
            {agent.isCentral ? 'Central agent' : agent.role || 'Agent'}
          </div>
          <div className="mt-1 flex items-center gap-1 text-sm" style={{ color }}>
            <span aria-hidden>●</span>
            <span className="truncate">{agent.statusLabel}</span>
            {emoji && <span aria-hidden>{emoji}</span>}
          </div>
        </div>
        <button className="nexus-x" onClick={onClose} aria-label="Close profile" title="Close">
          ×
        </button>
      </header>

      <dl className="nexus-facts">
        <dt>Mission</dt>
        <dd className="truncate" title={agent.mission ?? undefined}>
          {agent.mission ?? 'None'}
        </dd>
        {agent.task && (
          <>
            <dt>Task</dt>
            <dd className="truncate" title={agent.task}>
              {agent.task}
            </dd>
          </>
        )}
        <dt>Model</dt>
        <dd className="truncate">
          {agent.model ?? 'Default'}
          {agent.provider ? ` · ${agent.provider}` : ''}
        </dd>
        {family.parent && (
          <>
            <dt>Reports to</dt>
            <dd className="truncate">
              <button className="nexus-link" onClick={() => onSelect(family.parent!.nexusId)}>
                {family.parent.name}
              </button>
            </dd>
          </>
        )}
        {family.children.length > 0 && (
          <>
            <dt>Team</dt>
            <dd className="nexus-team">
              {family.children.map((c) => (
                <button key={c.nexusId} className="nexus-link" title={c.rank} onClick={() => onSelect(c.nexusId)}>
                  {c.name}
                </button>
              ))}
            </dd>
          </>
        )}
      </dl>
      <div className="nexus-stats">
        <Stat label="Skills" items={agent.skills} />
        <Stat label="MCP" items={agent.mcp} />
        <Stat label="Links" items={agent.connections} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button className="nexus-btn nexus-btn-primary" onClick={() => send({ type: 'talk', nexusId: id })}>
          TALK
        </button>
        <button className="nexus-btn" onClick={() => send({ type: 'viewWork', nexusId: id })}>
          VIEW WORK
        </button>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1">
        {actions.map((a) => (
          <button
            key={a.action}
            className={`nexus-btn nexus-btn-sm${a.action === 'follow' && following ? ' nexus-btn-on' : ''}`}
            title={a.title}
            disabled={a.action === 'stop' && !live}
            onClick={() => send({ type: 'action', nexusId: id, action: a.action })}
          >
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Stat({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="nexus-stat" title={items.length ? items.join(', ') : `No ${label.toLowerCase()}`}>
      <span className="text-clay-300">{label}</span> <strong>{items.length}</strong>
    </div>
  );
}
