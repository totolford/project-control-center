// NEXUS addition: engine inputs used by NEXUS to drive the characters of its
// real agents. These players are "human" players (no LLM behind them): what
// they do mirrors what the real Claude Code agents do in NEXUS.
import { v } from 'convex/values';
import { inputHandler } from './inputHandler';
import { parseGameId, playerId } from './ids';
import { Conversation } from './conversation';
import { WorldMap } from './worldMap';
import { hqLayoutFields } from '../nexusSchema';
import { generateHqMap, nearestWalkable, walkable } from '../../data/nexusHq';

export const NEXUS_TOKEN_PREFIX = 'nexus:';

export function isNexusPlayer(human: string | undefined): boolean {
  return !!human && human.startsWith(NEXUS_TOKEN_PREFIX);
}

export const nexusInputs = {
  // Shows what the real agent is doing above its character.
  nexusSetActivity: inputHandler({
    args: {
      playerId,
      description: v.string(),
      emoji: v.optional(v.string()),
      until: v.number(),
    },
    handler: (game, now, args) => {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      if (!player) {
        throw new Error(`Invalid player ID ${args.playerId}`);
      }
      player.activity = args.description
        ? { description: args.description, emoji: args.emoji, until: args.until }
        : undefined;
      player.lastInput = now;
      return null;
    },
  }),

  // Name or skin changed in NEXUS.
  nexusDescribe: inputHandler({
    args: {
      playerId,
      name: v.string(),
      character: v.string(),
      description: v.string(),
    },
    handler: (game, now, args) => {
      const id = parseGameId('players', args.playerId);
      const description = game.playerDescriptions.get(id);
      if (!description) {
        throw new Error(`Invalid player ID ${args.playerId}`);
      }
      description.name = args.name;
      description.character = args.character;
      description.description = args.description;
      game.descriptionsModified = true;
      return null;
    },
  }),

  // Two NEXUS characters meet because their agents really exchanged a message:
  // the conversation starts already accepted on both sides.
  nexusConverse: inputHandler({
    args: {
      playerId,
      invitee: playerId,
    },
    handler: (game, now, args) => {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      const invitee = game.world.players.get(parseGameId('players', args.invitee));
      if (!player || !invitee) {
        throw new Error(`Invalid player ID`);
      }
      const { conversationId, error } = Conversation.start(game, now, player, invitee);
      if (!conversationId) {
        throw new Error(error);
      }
      game.world.conversations.get(conversationId)!.acceptInvite(game, invitee);
      player.lastInput = now;
      invitee.lastInput = now;
      return conversationId;
    },
  }),

  // NEXUS HQ changed (room created, moved, archived...): the engine swaps its
  // map in the same step it moves characters, so no step runs on a stale map.
  // Characters left inside a new wall or piece of furniture step out to the
  // nearest walkable tile; every route is recomputed against the new walls.
  nexusSetLayout: inputHandler({
    args: { layout: v.object(hqLayoutFields) },
    handler: (game, now, args) => {
      const plan = generateHqMap(args.layout);
      game.worldMap = new WorldMap(plan.map);
      game.descriptionsModified = true;
      let moved = 0;
      for (const player of game.world.players.values()) {
        const x = Math.floor(player.position.x);
        const y = Math.floor(player.position.y);
        if (!walkable(plan.map, x, y)) {
          const p = nearestWalkable(plan.map, player.position);
          if (p) {
            player.position = p;
            moved += 1;
          }
        }
        if (player.pathfinding) {
          player.pathfinding = { ...player.pathfinding, state: { kind: 'needsPath' } };
        }
      }
      return { moved, dropped: plan.dropped };
    },
  }),
};
