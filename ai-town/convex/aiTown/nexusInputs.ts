// NEXUS addition: engine inputs used by NEXUS to drive the characters of its
// real agents. These players are "human" players (no LLM behind them): what
// they do mirrors what the real Claude Code agents do in NEXUS.
import { v } from 'convex/values';
import { inputHandler } from './inputHandler';
import { parseGameId, playerId } from './ids';
import { Conversation } from './conversation';

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
};
