// NEXUS addition: what is drawn above a character that is a real NEXUS
// agent: name label with badge, status emoji (animated by state) and speech
// bubble, rank pips and the link to its supervisor. Everything comes from the
// agent row and `nexusSpeech`.
import * as PIXI from 'pixi.js';
import { Container, Graphics, Text } from '@pixi/react';
import { useCallback, useMemo } from 'react';
import { SIGN_FONT } from './Buildings';
import { NexusAgentRow, STATE_COLOR, VisualState, rankPips, visualState } from './state';

export const REDUCED_MOTION =
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const labelStyle = new PIXI.TextStyle({ fontFamily: SIGN_FONT, fontSize: 9, fill: 0xffffff });
const bubbleStyle = new PIXI.TextStyle({
  fontFamily: SIGN_FONT,
  fontSize: 9,
  fill: 0x181425,
  wordWrap: true,
  wordWrapWidth: 132,
  breakWords: true,
  lineHeight: 11,
});
const emojiStyle = new PIXI.TextStyle({ fontSize: 14 });

const EMOJI: Partial<Record<VisualState, string>> = {
  thinking: '💭',
  working: '⚙️',
  waiting: '✋',
  error: '❗',
  finished: '✅',
  review: '🔎',
  offline: '💤',
  starting: '⏳',
  sleeping: '😴',
  paused: '⏸️',
};

/** Emoji of the state: the bridge's own emoji when it sent one. */
export function stateEmoji(agent: NexusAgentRow, state: VisualState): string | undefined {
  return agent.emoji || EMOJI[state];
}

function Label({
  text,
  color,
  selected,
  dim,
  pips,
}: {
  text: string;
  color: number;
  selected: boolean;
  dim: boolean;
  pips: number;
}) {
  const width = Math.max(24, text.length * 5.6 + 14);
  const draw = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      g.beginFill(selected ? 0xfec742 : 0x181425, 0.9);
      g.drawRect(-width / 2 - 1, -7, width + 2, 14);
      g.endFill();
      g.beginFill(0x262b44, 0.92);
      g.drawRect(-width / 2, -6, width, 12);
      g.endFill();
      // Status dot.
      g.beginFill(color);
      g.drawRect(-width / 2 + 3, -2, 4, 4);
      g.endFill();
      // Rank insignia: gold pips on top of the plate.
      for (let i = 0; i < pips; i++) {
        const x = -((pips - 1) * 5) / 2 + i * 5;
        g.beginFill(0x181425);
        g.drawRect(x - 2, -11, 5, 5);
        g.endFill();
        g.beginFill(0xfec742);
        g.drawRect(x - 1, -10, 3, 3);
        g.endFill();
      }
    },
    [width, color, selected, pips],
  );
  return (
    <Container y={-27} alpha={dim ? 0.65 : 1}>
      <Graphics draw={draw} />
      <Text text={text} x={5} anchor={{ x: 0.5, y: 0.5 }} resolution={4} style={labelStyle} />
    </Container>
  );
}

/** Bubbles stay small: the full text is in NEXUS (chat / work view). */
export const BUBBLE_MAX_CHARS = 140;

function Bubble({ text: full, alpha, y }: { text: string; alpha: number; y: number }) {
  const text = full.length > BUBBLE_MAX_CHARS ? `${full.slice(0, BUBBLE_MAX_CHARS - 1)}…` : full;
  const { w, h } = useMemo(() => {
    const measured = PIXI.TextMetrics.measureText(text, bubbleStyle);
    return { w: Math.ceil(measured.width) + 10, h: Math.ceil(measured.height) + 8 };
  }, [text]);
  const draw = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      // Pixel bubble: dark rim, white body, stepped tail pointing down.
      g.beginFill(0x181425);
      g.drawRect(-w / 2 - 2, -h - 2, w + 4, h + 4);
      g.drawRect(-4, 2, 8, 2);
      g.drawRect(-2, 4, 4, 2);
      g.endFill();
      g.beginFill(0xffffff);
      g.drawRect(-w / 2, -h, w, h);
      g.drawRect(-2, 0, 4, 2);
      g.endFill();
    },
    [w, h],
  );
  return (
    <Container y={y} alpha={alpha}>
      <Graphics draw={draw} />
      <Text text={text} x={-w / 2 + 5} y={-h + 4} resolution={4} style={bubbleStyle} />
    </Container>
  );
}

export function AgentOverlay({
  agent,
  selected,
  speech,
}: {
  agent: NexusAgentRow;
  selected: boolean;
  /** Bubble text and its age / lifetime in ms, when the agent spoke recently. */
  speech?: { text: string; age: number; visibleMs: number };
}) {
  const state = visualState(agent);
  const now = Date.now();
  const color = STATE_COLOR[state];
  const emoji = stateEmoji(agent, state);
  const name = agent.badge ? `${agent.badge} ${agent.name}` : agent.name;

  // State animations (still when the OS asks for reduced motion).
  let emojiY = -44;
  let emojiAlpha = 1;
  let emojiRotation = 0;
  if (!REDUCED_MOTION) {
    if (state === 'thinking') emojiY += Math.sin(now / 300) * 2;
    if (state === 'working') emojiRotation = (now / 400) % (Math.PI * 2);
    if (state === 'waiting') emojiAlpha = Math.floor(now / 500) % 2 === 0 ? 1 : 0.35;
  }

  let bubble: JSX.Element | null = null;
  if (speech) {
    const left = speech.visibleMs - speech.age;
    const alpha = Math.max(0, Math.min(1, left / 2000));
    bubble = <Bubble text={speech.text} alpha={alpha} y={emoji ? -58 : -38} />;
  }

  return (
    <>
      <Label
        text={name}
        color={color}
        selected={selected}
        dim={state === 'offline' || state === 'sleeping'}
        pips={rankPips(agent.isCentral ? 'commander' : agent.rank)}
      />
      {emoji && (
        <Text
          text={emoji}
          x={0}
          y={emojiY}
          alpha={emojiAlpha}
          rotation={emojiRotation}
          anchor={{ x: 0.5, y: 0.5 }}
          resolution={2}
          style={emojiStyle}
        />
      )}
      {bubble}
    </>
  );
}

/** Drawn under the sprite: link to the supervisor, selection ring, error pulse. */
export function AgentGround({
  agent,
  selected,
  link,
}: {
  agent: NexusAgentRow;
  selected: boolean;
  link?: { dx: number; dy: number; strong: boolean } | null;
}) {
  const state = visualState(agent);
  const pulse =
    state === 'error' ? (REDUCED_MOTION ? 0.5 : 0.35 + 0.35 * Math.abs(Math.sin(Date.now() / 250))) : 0;
  return (
    <>
      {link && <ParentLink dx={link.dx} dy={link.dy} strong={link.strong} />}
      {pulse > 0 && <ErrorRing alpha={pulse} />}
      {selected && <SelectedRing />}
    </>
  );
}

function ParentLink({ dx, dy, strong }: { dx: number; dy: number; strong: boolean }) {
  const draw = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      g.lineStyle(strong ? 1.5 : 1, strong ? 0xfec742 : 0x9ad0ff, strong ? 0.9 : 0.35);
      g.moveTo(0, 14);
      g.lineTo(dx, dy + 14);
    },
    [dx, dy, strong],
  );
  return <Graphics draw={draw} />;
}

function ErrorRing({ alpha }: { alpha: number }) {
  const draw = useCallback((g: PIXI.Graphics) => {
    g.clear();
    g.beginFill(0xff3b3b);
    g.drawEllipse(0, 14, 14, 6);
    g.endFill();
  }, []);
  return <Graphics draw={draw} alpha={alpha} />;
}

function SelectedRing() {
  const draw = useCallback((g: PIXI.Graphics) => {
    g.clear();
    g.lineStyle(2, 0xfec742, 1);
    g.drawEllipse(0, 14, 13, 5);
  }, []);
  return <Graphics draw={draw} />;
}
