// NEXUS addition: the API NEXUS uses to mirror its real agents in AI Town.
//
// NEXUS (the desktop app) calls these functions over Convex's HTTP API. Each
// NEXUS project gets its own AI Town world. Each real NEXUS agent is an AI
// Town "human" player (token `nexus:<agentId>`): it has no LLM behind it, it
// only moves, works and talks when the real Claude Code agent does.
import { NEXUS_BUILD } from './nexusBuild';
import { v } from 'convex/values';
import { mutation, query, MutationCtx, QueryCtx } from './_generated/server';
import { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { NEXUS_SKIN_PRESETS } from '../data/nexusSkins';
import { HqLayout, Point, generateHqMap, initialLayout } from '../data/nexusHq';
import { insertInput } from './aiTown/insertInput';
import { createEngine, startEngine } from './aiTown/main';
import { CONVERSATION_DISTANCE, ENGINE_ACTION_DURATION } from './constants';
import { NEXUS_TOKEN_PREFIX } from './aiTown/nexusInputs';
import { hqLayoutFields, nexusAgentFields } from './nexusSchema';

/** How long a speech bubble stays visible. */
const SPEECH_VISIBLE_MS = 12_000;
/** A NEXUS conversation without new real messages for this long is closed. */
const CONVERSATION_IDLE_MS = 45_000;

type SerializedPlayer = {
  id: string;
  human?: string;
  position: { x: number; y: number };
  pathfinding?: { destination: { x: number; y: number } };
};
type SerializedConversation = {
  id: string;
  creator: string;
  participants: { playerId: string; status: { kind: string } }[];
};

async function createWorld(ctx: MutationCtx) {
  const now = Date.now();
  const engineId = await createEngine(ctx);
  const engine = (await ctx.db.get(engineId))!;
  const worldId = await ctx.db.insert('worlds', {
    nextId: 0,
    agents: [],
    conversations: [],
    players: [],
  });
  await ctx.db.insert('worldStatus', {
    engineId,
    isDefault: false,
    lastViewed: now,
    status: 'running',
    worldId,
  });
  // NEXUS HQ: the building (NEXUS sends the project's rooms right after).
  const layout = initialLayout();
  const plan = generateHqMap(layout);
  await ctx.db.insert('maps', { worldId, ...plan.map });
  await ctx.db.insert('nexusLayouts', {
    worldId,
    layout,
    spots: plan.spots,
    skipped: plan.skipped,
    dropped: plan.dropped,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
    worldId,
    generationNumber: engine.generationNumber,
    maxDuration: ENGINE_ACTION_DURATION,
  });
  return worldId;
}

/** Keeps the world running while NEXUS is open (AI Town stops idle worlds). */
async function keepAlive(ctx: MutationCtx, worldId: Id<'worlds'>) {
  const status = await ctx.db
    .query('worldStatus')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .unique();
  if (!status) {
    throw new Error(`No status for world ${worldId}`);
  }
  await ctx.db.patch(status._id, { lastViewed: Date.now() });
  if (status.status === 'inactive') {
    await ctx.db.patch(status._id, { status: 'running' });
    await startEngine(ctx, worldId);
  }
  return status;
}

export const ensureWorld = mutation({
  args: { projectKey: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('nexusWorlds')
      .withIndex('projectKey', (q) => q.eq('projectKey', args.projectKey))
      .unique();
    let worldId = existing?.worldId;
    if (!worldId || !(await ctx.db.get(worldId))) {
      worldId = await createWorld(ctx);
      if (existing) {
        await ctx.db.patch(existing._id, { worldId, name: args.name });
      } else {
        await ctx.db.insert('nexusWorlds', { projectKey: args.projectKey, name: args.name, worldId });
      }
    }
    const status = await keepAlive(ctx, worldId);
    return { worldId, engineId: status.engineId };
  },
});

type Building = { layout: HqLayout; spots: Record<string, Point[]> };

async function building(ctx: MutationCtx, worldId: Id<'worlds'>): Promise<Building> {
  const row = await ctx.db
    .query('nexusLayouts')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .unique();
  if (row) return { layout: row.layout as HqLayout, spots: row.spots as Record<string, Point[]> };
  // Worlds created before NEXUS HQ: the initial building until NEXUS sends its rooms.
  const layout = initialLayout();
  return { layout, spots: generateHqMap(layout).spots };
}

/**
 * Where the n-th agent of a room stands: a free interior tile of the room
 * (never a wall, a piece of furniture or the doorway). An unknown room
 * (archived since) falls back to NEXUS HQ.
 */
function standingPoint(b: Building, room: string, index: number): Point {
  const spots = b.spots[room] ?? b.spots['central_hq'] ?? Object.values(b.spots)[0] ?? [];
  if (spots.length === 0) return { x: 2, y: 2 };
  return spots[index % spots.length];
}

export const syncAgents = mutation({
  args: {
    worldId: v.id('worlds'),
    agents: v.array(v.object(nexusAgentFields)),
  },
  handler: async (ctx, args) => {
    await keepAlive(ctx, args.worldId);
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`Invalid world ${args.worldId}`);
    }
    const now = Date.now();
    const players = world.players as SerializedPlayer[];
    const conversations = world.conversations as SerializedConversation[];
    const rows = await ctx.db
      .query('nexusAgents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const wanted = new Set(args.agents.map((a) => a.nexusId));

    // Agents that are gone from NEXUS leave the world.
    for (const row of rows) {
      if (wanted.has(row.nexusId)) continue;
      const player = players.find((p) => p.human === NEXUS_TOKEN_PREFIX + row.nexusId);
      if (player) {
        await insertInput(ctx, args.worldId, 'leave', { playerId: player.id });
      }
      await ctx.db.delete(row._id);
    }

    // Index among the agents sharing a room, to give each its own spot.
    const hq = await building(ctx, args.worldId);
    const perZone = new Map<string, number>();
    for (const agent of args.agents) {
      const token = NEXUS_TOKEN_PREFIX + agent.nexusId;
      const row = rows.find((r) => r.nexusId === agent.nexusId);
      const player = players.find((p) => p.human === token);
      const slot = perZone.get(agent.zone) ?? 0;
      perZone.set(agent.zone, slot + 1);

      if (!player) {
        // Join once; the engine assigns the player id on its next step.
        const pendingJoin = row && !row.playerId && now - row.updatedAt < 10_000;
        if (!pendingJoin) {
          await insertInput(ctx, args.worldId, 'join', {
            name: agent.name,
            character: agent.character,
            description: `${agent.name} is a real NEXUS agent (${agent.role}).`,
            tokenIdentifier: token,
          });
        }
        const fields = { ...agent, playerId: undefined, sentTo: undefined, updatedAt: now };
        if (row) {
          await ctx.db.patch(row._id, pendingJoin ? { ...agent } : fields);
        } else {
          await ctx.db.insert('nexusAgents', { worldId: args.worldId, ...fields });
        }
        continue;
      }

      const inConversation = conversations.some((c) =>
        c.participants.some((m) => m.playerId === player.id),
      );
      let sentTo = row?.sentTo;
      let movedAt = row?.movedAt ?? 0;
      if (!inConversation) {
        const target = standingPoint(hq, agent.zone, slot);
        const there =
          Math.abs(player.position.x - target.x) < 0.5 && Math.abs(player.position.y - target.y) < 0.5;
        // New room, or a path that failed / got interrupted: (re)send.
        const retry = !player.pathfinding && now - movedAt > 15_000;
        if (!there && (sentTo !== agent.zone || retry || row?.sentTo === undefined)) {
          await insertInput(ctx, args.worldId, 'moveTo', { playerId: player.id, destination: target });
          movedAt = now;
        }
        sentTo = agent.zone;
      }
      if (row?.playerId && (row.name !== agent.name || row.character !== agent.character)) {
        await insertInput(ctx, args.worldId, 'nexusDescribe', {
          playerId: player.id,
          name: agent.name,
          character: agent.character,
          description: `${agent.name} is a real NEXUS agent (${agent.role}).`,
        });
      }
      const statusChanged =
        !row || row.statusLabel !== agent.statusLabel || row.emoji !== agent.emoji || !row.playerId;
      if (statusChanged) {
        await insertInput(ctx, args.worldId, 'nexusSetActivity', {
          playerId: player.id,
          description: agent.statusLabel,
          emoji: agent.emoji,
          until: now + 24 * 60 * 60 * 1000,
        });
      }
      const fields = { ...agent, playerId: player.id, sentTo, movedAt, updatedAt: now };
      if (row) {
        await ctx.db.patch(row._id, fields);
      } else {
        await ctx.db.insert('nexusAgents', { worldId: args.worldId, ...fields });
      }
    }

    // The agent who spoke walks over to the one it addressed (AI Town only
    // moves its LLM agents by itself).
    for (const conv of conversations) {
      const speaker = players.find((p) => p.id === conv.creator);
      const other = conv.participants.find((m) => m.playerId !== conv.creator);
      const listener = other && players.find((p) => p.id === other.playerId);
      if (!speaker?.human?.startsWith(NEXUS_TOKEN_PREFIX) || !listener) continue;
      if (!conv.participants.every((m) => m.status.kind === 'walkingOver')) continue;
      const d = Math.hypot(speaker.position.x - listener.position.x, speaker.position.y - listener.position.y);
      if (d >= CONVERSATION_DISTANCE && !speaker.pathfinding) {
        await insertInput(ctx, args.worldId, 'moveTo', {
          playerId: speaker.id,
          destination: { x: Math.floor(listener.position.x), y: Math.floor(listener.position.y) },
        });
      }
    }

    await deliverSpeech(ctx, args.worldId, players, conversations, now);
    return null;
  },
});

/** Writes undelivered speech into AI Town conversations once the two characters are talking. */
async function deliverSpeech(
  ctx: MutationCtx,
  worldId: Id<'worlds'>,
  players: SerializedPlayer[],
  conversations: SerializedConversation[],
  now: number,
) {
  const recent = await ctx.db
    .query('nexusSpeech')
    .withIndex('worldId', (q) => q.eq('worldId', worldId).gt('ts', now - 5 * 60_000))
    .collect();
  const playerOf = (nexusId: string) => players.find((p) => p.human === NEXUS_TOKEN_PREFIX + nexusId);
  for (const s of recent) {
    if (s.delivered || !s.to) continue;
    const a = playerOf(s.from);
    const b = playerOf(s.to);
    if (!a || !b) continue;
    const conv = conversations.find(
      (c) =>
        c.participants.some((m) => m.playerId === a.id) &&
        c.participants.some((m) => m.playerId === b.id),
    );
    if (!conv) continue;
    if (!conv.participants.every((m) => m.status.kind === 'participating')) continue;
    await ctx.db.insert('messages', {
      conversationId: conv.id,
      author: a.id,
      messageUuid: s._id,
      text: s.text,
      worldId,
    });
    await insertInput(ctx, worldId, 'finishSendingMessage', {
      conversationId: conv.id,
      playerId: a.id,
      timestamp: now,
    });
    await ctx.db.patch(s._id, { delivered: true });
  }
  // Close NEXUS conversations that went quiet.
  for (const conv of conversations) {
    const members = conv.participants.map((m) => players.find((p) => p.id === m.playerId));
    if (!members.every((p) => p?.human?.startsWith(NEXUS_TOKEN_PREFIX))) continue;
    const ids = members.map((p) => p!.human!.slice(NEXUS_TOKEN_PREFIX.length));
    const last = recent
      .filter((s) => ids.includes(s.from) && (!s.to || ids.includes(s.to)))
      .reduce((m, s) => Math.max(m, s.ts), 0);
    if (now - last > CONVERSATION_IDLE_MS) {
      await insertInput(ctx, worldId, 'leaveConversation', {
        playerId: members[0]!.id,
        conversationId: conv.id,
      });
    }
  }
}

/** A real message between agents (or from the user). */
export const say = mutation({
  args: {
    worldId: v.id('worlds'),
    from: v.string(),
    to: v.optional(v.string()),
    text: v.string(),
    origin: v.union(v.literal('real'), v.literal('user')),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert('nexusSpeech', { ...args, ts: now, delivered: !args.to });
    if (!args.to) return null;
    const world = await ctx.db.get(args.worldId);
    if (!world) throw new Error(`Invalid world ${args.worldId}`);
    const players = world.players as SerializedPlayer[];
    const conversations = world.conversations as SerializedConversation[];
    const a = players.find((p) => p.human === NEXUS_TOKEN_PREFIX + args.from);
    const b = players.find((p) => p.human === NEXUS_TOKEN_PREFIX + args.to);
    if (!a || !b) return null;
    const busy = (id: string) => conversations.some((c) => c.participants.some((m) => m.playerId === id));
    if (!busy(a.id) && !busy(b.id)) {
      await insertInput(ctx, args.worldId, 'nexusConverse', { playerId: a.id, invitee: b.id });
    }
    return null;
  },
});

/** Status of one world (AI Town's own query only returns the default world). */
export const worldStatus = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) =>
    await ctx.db
      .query('worldStatus')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .unique(),
});

/** Lets NEXUS know the NEXUS functions are deployed. */
export const ping = query({
  args: {},
  handler: async () => ({ nexus: 1, build: NEXUS_BUILD }),
});

/** Everything the embedded AI Town frontend needs about NEXUS. */
export const state = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const agents = await ctx.db
      .query('nexusAgents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const since = Date.now() - 10 * 60_000;
    const speech = await ctx.db
      .query('nexusSpeech')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).gt('ts', since))
      .order('desc')
      .take(100);
    const skins = [];
    for (const s of await ctx.db.query('nexusSkins').collect()) {
      skins.push({
        name: s.name,
        label: s.label,
        textureUrl: await ctx.storage.getUrl(s.storageId),
        spritesheetData: s.spritesheetData,
        speed: s.speed,
      });
    }
    return {
      agents: agents.map(({ _id, _creationTime, worldId, ...a }) => a),
      speech: speech.reverse().map(({ _id, _creationTime, worldId, ...s }) => ({ id: _id, ...s })),
      speechVisibleMs: SPEECH_VISIBLE_MS,
      ...(await hqState(ctx, args.worldId)),
      skinPresets: NEXUS_SKIN_PRESETS,
      skins,
    };
  },
});

async function hqState(ctx: QueryCtx, worldId: Id<'worlds'>) {
  const row = await ctx.db
    .query('nexusLayouts')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .unique();
  const layout = (row?.layout as HqLayout | undefined) ?? initialLayout();
  return {
    rooms: layout.rooms,
    connections: layout.connections,
    building: { width: layout.width, height: layout.height, revision: layout.revision, locale: layout.locale },
    skipped: (row?.skipped as Record<string, string[]> | undefined) ?? {},
    dropped: row?.dropped ?? [],
  };
}

/**
 * NEXUS HQ changed in NEXUS (world.json): stores the building, redraws the
 * map for the frontend at once and swaps it in the engine (input
 * `nexusSetLayout`). Characters are sent again to their rooms.
 */
export const applyLayout = mutation({
  args: { worldId: v.id('worlds'), layout: v.object(hqLayoutFields) },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) throw new Error(`Invalid world ${args.worldId}`);
    const existing = await ctx.db
      .query('nexusLayouts')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .unique();
    const plan = generateHqMap(args.layout);
    const doc = {
      worldId: args.worldId,
      layout: args.layout,
      spots: plan.spots,
      skipped: plan.skipped,
      dropped: plan.dropped,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert('nexusLayouts', doc);
    const mapDoc = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .unique();
    if (mapDoc) await ctx.db.replace(mapDoc._id, { worldId: args.worldId, ...plan.map });
    else await ctx.db.insert('maps', { worldId: args.worldId, ...plan.map });
    await insertInput(ctx, args.worldId, 'nexusSetLayout', { layout: args.layout });
    // Routes were computed on the old walls: send every character again.
    const rows = await ctx.db
      .query('nexusAgents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    for (const r of rows) await ctx.db.patch(r._id, { sentTo: undefined });
    return { revision: args.layout.revision, skipped: plan.skipped, dropped: plan.dropped };
  },
});

export const generateSkinUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const saveSkin = mutation({
  args: {
    name: v.string(),
    label: v.string(),
    storageId: v.id('_storage'),
    spritesheetData: v.any(),
    speed: v.number(),
  },
  handler: async (ctx, args) => {
    if (!/^[a-z0-9-]{1,40}$/.test(args.name)) {
      throw new Error('Skin names use lowercase letters, digits and dashes');
    }
    const existing = await ctx.db
      .query('nexusSkins')
      .withIndex('name', (q) => q.eq('name', args.name))
      .unique();
    if (existing) {
      await ctx.storage.delete(existing.storageId);
      await ctx.db.replace(existing._id, args);
    } else {
      await ctx.db.insert('nexusSkins', args);
    }
    return `nexus-skin:${args.name}`;
  },
});
