// NEXUS addition: AI Town's LLM townspeople in a NEXUS world. NEXUS calls
// these only when its local AI runtime has a chat model and the embedding
// model installed, after setting OLLAMA_HOST / OLLAMA_MODEL /
// OLLAMA_EMBEDDING_MODEL on this deployment. Townspeople never talk to the
// characters of real NEXUS agents (see aiTown/agent.ts).
import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { Descriptions } from '../data/characters';
import { insertInput } from './aiTown/insertInput';

type SerializedAgent = { id: string; playerId: string };

export const status = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) throw new Error(`Invalid world ${args.worldId}`);
    const agents = world.agents as SerializedAgent[];
    const names = [];
    for (const a of agents) {
      const d = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', a.playerId))
        .unique();
      names.push(d?.name ?? a.playerId);
    }
    return { count: agents.length, max: Descriptions.length, names };
  },
});

export const add = mutation({
  args: { worldId: v.id('worlds'), count: v.number() },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) throw new Error(`Invalid world ${args.worldId}`);
    const existing = (world.agents as SerializedAgent[]).length;
    const toCreate = Math.max(0, Math.min(Math.floor(args.count), Descriptions.length - existing));
    for (let i = 0; i < toCreate; i++) {
      await insertInput(ctx, args.worldId, 'createAgent', { descriptionIndex: existing + i });
    }
    return { created: toCreate };
  },
});

export const remove = mutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    await insertInput(ctx, args.worldId, 'nexusRemoveTownspeople', {});
    return null;
  },
});
