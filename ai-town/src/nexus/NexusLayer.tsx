// NEXUS addition: how a real NEXUS agent is decorated on the map. Player.tsx
// asks the decorator for the skin (built-in or imported) and for what to
// draw under / above the sprite; everything comes from `nexus:state`.
import type { Viewport } from 'pixi-viewport';
import { MutableRefObject, ReactNode } from 'react';
import type { NexusZone, NexusZoneKind } from '../../data/nexusZones';
import { AgentGround, AgentOverlay } from './AgentOverlay';
import {
  CharacterLook,
  NexusWorld,
  bubbleText,
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
  resolve: (character: string) => CharacterLook | undefined;
  /** Null for players that are not NEXUS agents. `x`/`y` = sprite center, world px. */
  decorate: (playerId: string, x: number, y: number) => NexusDecoration | null;
};

/** What PixiGame needs to draw the NEXUS layer (embedded mode only). */
export type NexusPixi = {
  decorator: NexusDecorator;
  zones: NexusZone[];
  /** Real agents per zone, shown on the building signs. */
  counts: Map<string, number>;
  onOpenBuilding: (zone: NexusZoneKind) => void;
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
): NexusDecorator {
  const state = world.state;
  const speech = state ? visibleSpeech(state.speech, state.speechVisibleMs, now) : new Map();
  const nameOf = (id: string) => world.byId.get(id)?.name ?? id;
  return {
    resolve: (character) => resolveCharacter(character, state?.skins),
    decorate: (playerId, x, y) => {
      const agent = world.byPlayer.get(playerId);
      if (!agent) return null;
      positions.set(agent.nexusId, { x, y });
      const selected = agent.nexusId === selectedNexusId;
      const said = speech.get(agent.nexusId);
      return {
        tint: parseTint(agent.tint),
        underlay: <AgentGround agent={agent} selected={selected} />,
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
