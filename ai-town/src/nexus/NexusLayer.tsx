// NEXUS addition: how a real NEXUS agent is decorated on the map. Player.tsx
// asks the decorator for the skin (built-in or imported) and for what to
// draw under / above the sprite; everything comes from `nexus:state`.
import type { Viewport } from 'pixi-viewport';
import { MutableRefObject, ReactNode } from 'react';
import { AgentGround, AgentOverlay } from './AgentOverlay';
import { traceCharacter } from './trace';
import {
  CharacterLook,
  NexusRoom,
  NexusWorld,
  bubbleText,
  parentLink,
  parseTint,
  resolveCharacter,
  visibleSpeech,
} from './state';

export type NexusDecoration = {
  tint?: number;
  underlay: ReactNode;
  overlay: ReactNode;
};

export type NexusDecorator = {
  /**
   * Sprite of a player: for a NEXUS agent, the validated (repaired) row's
   * character — never undefined for an agent, so one broken appearance draws
   * the default sprite instead of nothing.
   */
  resolve: (character: string, playerId?: string) => CharacterLook | undefined;
  /** Agents the validator refused (not drawn). */
  hidden: (playerId: string) => boolean;
  /** Null for players that are not NEXUS agents. `x`/`y` = sprite center, world px. */
  decorate: (playerId: string, x: number, y: number) => NexusDecoration | null;
};

/** What PixiGame needs to draw the NEXUS layer (embedded mode only). */
export type NexusPixi = {
  decorator: NexusDecorator;
  /** Plain default sprite, no decorations: what a character that failed to render becomes. */
  fallbackDecorator: NexusDecorator;
  rooms: NexusRoom[];
  connections: { from: string; to: string }[];
  /** Real agents per room, shown on the room signs. */
  counts: Map<string, number>;
  /** Room highlighted by NEXUS (Focus Room). */
  focusedRoom: string | null;
  onOpenRoom: (roomId: string) => void;
  /** A character failed to render: reported, the fallback sprite is drawn. */
  onCharacterError: (playerId: string, error: unknown) => void;
  safeMode: boolean;
  /** A click on the ground (not a drag). */
  onMapClick: () => void;
  viewportRef: MutableRefObject<Viewport | undefined>;
};

/** Where each NEXUS agent was last drawn (world px), for the camera. */
export type Positions = Map<string, { x: number; y: number }>;

export function makeDecorator(
  world: NexusWorld,
  selectedNexusId: string | null,
  positions: Positions,
  now: number,
  safeMode = false,
): NexusDecorator {
  const state = world.state;
  // Safe Mode: no speech bubbles (text effects), no tint.
  const speech = state && !safeMode ? visibleSpeech(state.speech, state.speechVisibleMs, now) : new Map();
  const nameOf = (id: string) => world.byId.get(id)?.name ?? id;
  return {
    resolve: (character, playerId) => {
      const agent = playerId ? world.byPlayer.get(playerId) : undefined;
      const name = agent?.character ?? character;
      const look = resolveCharacter(name, state?.skins, safeMode);
      if (agent) traceCharacter(agent.nexusId, { character: agent.character, tint: agent.tint }, name, look?.textureUrl ?? null);
      return look ?? (agent ? resolveCharacter('default-agent', undefined) : undefined);
    },
    hidden: (playerId) => world.hiddenPlayers.has(playerId),
    decorate: (playerId, x, y) => {
      const agent = world.byPlayer.get(playerId);
      if (!agent) return null;
      positions.set(agent.nexusId, { x, y });
      const selected = agent.nexusId === selectedNexusId;
      const said = speech.get(agent.nexusId);
      return {
        tint: safeMode ? undefined : parseTint(agent.tint),
        underlay: (
          <AgentGround
            agent={agent}
            selected={selected}
            link={parentLink(agent, { x, y }, positions, world.byId, selectedNexusId)}
          />
        ),
        overlay: (
          <AgentOverlay
            agent={agent}
            selected={selected}
            speech={
              said && state
                ? { text: bubbleText(said, nameOf), age: said.age, visibleMs: state.speechVisibleMs }
                : undefined
            }
          />
        ),
      };
    },
  };
}

/** The default sprite for every player, nothing drawn around it. */
export const FALLBACK_DECORATOR: NexusDecorator = {
  resolve: () => resolveCharacter('default-agent', undefined),
  hidden: () => false,
  decorate: () => null,
};
