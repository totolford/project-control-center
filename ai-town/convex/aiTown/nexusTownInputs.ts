// NEXUS addition: AI Town's own LLM townspeople, driven by the local AI
// runtime configured in NEXUS. They are ordinary AI Town agents; NEXUS only
// creates them when a local chat model and embedding model are installed, and
// removes them on request. NEXUS agent characters are never touched here.
import { inputHandler } from './inputHandler';

export const nexusTownInputs = {
  // Removes every LLM townsperson (AI Town agent) and its player.
  nexusRemoveTownspeople: inputHandler({
    args: {},
    handler: (game, now) => {
      let removed = 0;
      for (const [agentId, agent] of [...game.world.agents.entries()]) {
        const player = game.world.players.get(agent.playerId);
        if (player) {
          player.leave(game, now);
        }
        game.world.agents.delete(agentId);
        game.agentDescriptions.delete(agentId);
        removed += 1;
      }
      if (removed > 0) {
        game.descriptionsModified = true;
      }
      return { removed };
    },
  }),
};
