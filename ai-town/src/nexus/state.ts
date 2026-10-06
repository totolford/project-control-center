// NEXUS addition: what the embedded world knows about the real NEXUS agents
// (query `nexus:state`) and how each character looks because of it.
import { useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useMemo } from 'react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { characters } from '../../data/characters';
import { NEXUS_SKIN_PREFIX } from '../../data/nexusSkins';
import { NEXUS_TOKEN_PREFIX } from '../../convex/aiTown/nexusInputs';
import type { SpritesheetData } from '../../data/spritesheets/types';

export type NexusState = FunctionReturnType<typeof api.nexus.state>;
export type NexusAgentRow = NexusState['agents'][number];
export type NexusSpeech = NexusState['speech'][number];
export type NexusSkin = NexusState['skins'][number];

/** Visual state of a character, derived only from the real agent row. */
export type VisualState =
  | 'idle'
  | 'offline'
  | 'starting'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'error'
  | 'review'
  | 'finished'
  | 'sleeping'
  | 'paused';

/**
 * The bridge (crates/pcc-world/src/aitown/bridge.rs `label_for`) already
 * turned what NEXUS observed into status + label + emoji; this only picks the
 * animation. It never adds activity the agent row does not report.
 */
export function visualState(
  a: Pick<NexusAgentRow, 'status' | 'emoji' | 'statusLabel'> & { paused?: boolean },
): VisualState {
  if (a.paused && a.status !== 'working' && a.status !== 'retired') return 'paused';
  switch (a.status) {
    case 'sleeping':
      return 'sleeping';
    case 'awaiting_permission':
      return 'waiting';
    case 'crashed':
      return 'error';
    case 'starting':
      return 'starting';
    case 'offline':
    case 'stopped':
    case 'disconnected':
    case 'retired':
      return 'offline';
    case 'working':
      return a.emoji === '⚙️' ? 'working' : 'thinking';
  }
  if (a.emoji === '❗') return 'error';
  if (a.emoji === '✅') return 'finished';
  if (a.emoji === '🔎') return 'review';
  return 'idle';
}

/** Human status for the profile card: the bridge's own label. */
export const STATE_COLOR: Record<VisualState, number> = {
  idle: 0x8b9bb4,
  offline: 0x5a6988,
  starting: 0xfec742,
  thinking: 0x9ad0ff,
  working: 0x4ade80,
  waiting: 0xfec742,
  error: 0xff4d4d,
  review: 0xc084fc,
  finished: 0x4ade80,
  sleeping: 0x6c7fb8,
  paused: 0xf59e0b,
};

/** Gold pips drawn on the name plate: Central 3, lieutenants 2, specialists none. */
export function rankPips(rank: string | undefined): number {
  if (rank === 'commander') return 3;
  if (rank === 'lieutenant') return 2;
  return 0;
}

export function rankLabel(a: Pick<NexusAgentRow, 'isCentral'> & { rank?: string }): string {
  if (a.isCentral || a.rank === 'commander') return 'Commander';
  return a.rank === 'lieutenant' ? 'Lieutenant' : 'Specialist';
}

/**
 * Thin line from an agent to its supervisor (vector in world px, relative to
 * the agent). Links to Central are only drawn when one end is selected, so
 * the map is not covered with lines; lieutenant links are always visible.
 */
export function parentLink(
  agent: Pick<NexusAgentRow, 'nexusId'> & { parentId?: string },
  at: { x: number; y: number },
  positions: Map<string, { x: number; y: number }>,
  byId: Map<string, Pick<NexusAgentRow, 'isCentral'> & { rank?: string }>,
  selectedId: string | null,
): { dx: number; dy: number; strong: boolean } | null {
  const pid = agent.parentId;
  if (!pid) return null;
  const parent = byId.get(pid);
  const p = positions.get(pid);
  if (!parent || !p) return null;
  const strong = selectedId === agent.nexusId || selectedId === pid;
  if (parent.isCentral && !strong) return null;
  const dx = p.x - at.x;
  const dy = p.y - at.y;
  if (Math.hypot(dx, dy) < 8) return null;
  return { dx, dy, strong };
}

/** Supervisor and direct reports of an agent, from the rows the bridge sent. */
export function family(
  agent: Pick<NexusAgentRow, 'nexusId' | 'isCentral'> & { parentId?: string },
  agents: (Pick<NexusAgentRow, 'nexusId' | 'name' | 'isCentral' | 'status'> & { parentId?: string; rank?: string })[],
): { parent: { nexusId: string; name: string } | null; children: { nexusId: string; name: string; rank: string }[] } {
  const parent = agent.isCentral ? undefined : agents.find((a) => a.nexusId === agent.parentId);
  const children = agents
    .filter((a) => a.status !== 'retired' && !a.isCentral && a.nexusId !== agent.nexusId)
    .filter((a) => {
      const pid = a.parentId ?? agents.find((c) => c.isCentral)?.nexusId;
      return pid === agent.nexusId;
    })
    .map((a) => ({ nexusId: a.nexusId, name: a.name, rank: a.rank ?? 'specialist' }));
  return { parent: parent ? { nexusId: parent.nexusId, name: parent.name } : null, children };
}

export function hexColor(n: number) {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** "#rrggbb" → 0xrrggbb, or undefined when not a valid tint. */
export function parseTint(tint: string | undefined | null): number | undefined {
  if (!tint || !/^#[0-9a-fA-F]{6}$/.test(tint)) return undefined;
  return parseInt(tint.slice(1), 16);
}

export type CharacterLook = {
  textureUrl: string;
  spritesheetData: SpritesheetData;
  speed: number;
};

/** Built-in character (folk or NEXUS sprite) or a skin imported in NEXUS. */
export function resolveCharacter(name: string, skins: NexusSkin[] | undefined): CharacterLook | undefined {
  const builtin = characters.find((c) => c.name === name);
  if (builtin) return builtin;
  if (!name.startsWith(NEXUS_SKIN_PREFIX)) return undefined;
  const skin = skins?.find((s) => s.name === name.slice(NEXUS_SKIN_PREFIX.length));
  if (!skin?.textureUrl) return undefined;
  return {
    textureUrl: skin.textureUrl,
    spritesheetData: skin.spritesheetData as SpritesheetData,
    speed: skin.speed,
  };
}

export type NexusWorld = {
  state: NexusState | undefined;
  /** AI Town player id → NEXUS agent. */
  byPlayer: Map<string, NexusAgentRow>;
  byId: Map<string, NexusAgentRow>;
  /** Player of a NEXUS agent, from the row or the `nexus:<id>` token. */
  playerOf: (nexusId: string) => string | undefined;
};

export function useNexusWorld(
  worldId: Id<'worlds'> | undefined,
  players: { id: string; human?: string }[],
): NexusWorld {
  const state = useQuery(api.nexus.state, worldId ? { worldId } : 'skip');
  return useMemo(() => indexAgents(state, players), [state, players]);
}

export function indexAgents(
  state: NexusState | undefined,
  players: { id: string; human?: string }[],
): NexusWorld {
  const byPlayer = new Map<string, NexusAgentRow>();
  const byId = new Map<string, NexusAgentRow>();
  const tokenPlayer = new Map<string, string>();
  for (const p of players) {
    if (p.human?.startsWith(NEXUS_TOKEN_PREFIX)) {
      tokenPlayer.set(p.human.slice(NEXUS_TOKEN_PREFIX.length), p.id);
    }
  }
  for (const a of state?.agents ?? []) {
    byId.set(a.nexusId, a);
    const pid = tokenPlayer.get(a.nexusId) ?? a.playerId;
    if (pid) byPlayer.set(pid, a);
  }
  return {
    state,
    byPlayer,
    byId,
    playerOf: (nexusId) => tokenPlayer.get(nexusId) ?? byId.get(nexusId)?.playerId,
  };
}

/** The latest visible line of speech of each agent (bubble above it). */
export function visibleSpeech(
  speech: NexusSpeech[],
  visibleMs: number,
  now: number,
): Map<string, NexusSpeech & { age: number }> {
  const out = new Map<string, NexusSpeech & { age: number }>();
  for (const s of speech) {
    const age = now - s.ts;
    if (age < 0 - 5_000 || age > visibleMs) continue;
    const prev = out.get(s.from);
    if (!prev || prev.ts <= s.ts) out.set(s.from, { ...s, age: Math.max(0, age) });
  }
  return out;
}

/** Text of a bubble: "You: …" for what the user said, "→ Name …" when addressed. */
export function bubbleText(s: Pick<NexusSpeech, 'text' | 'origin' | 'to'>, nameOf: (id: string) => string) {
  if (s.origin === 'user') return `You: ${s.text}`;
  return s.to ? `→ ${nameOf(s.to)}: ${s.text}` : s.text;
}
