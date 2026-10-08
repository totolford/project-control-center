// NEXUS addition: tables linking AI Town worlds to NEXUS projects and agents.
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const nexusAgentFields = {
  nexusId: v.string(),
  name: v.string(),
  role: v.string(),
  /** AI Town character name (f1..f8) or `nexus-skin:<name>`. */
  character: v.string(),
  isCentral: v.boolean(),
  /** NEXUS agent status: idle, running, waiting, error, completed, offline... */
  status: v.string(),
  /** Human readable status, e.g. "Running Bash". */
  statusLabel: v.string(),
  /** Room of NEXUS HQ the agent is in (resolved by NEXUS from its real activity). */
  zone: v.string(),
  emoji: v.optional(v.string()),
  mission: v.optional(v.string()),
  task: v.optional(v.string()),
  model: v.optional(v.string()),
  skills: v.array(v.string()),
  mcp: v.array(v.string()),
  connections: v.array(v.string()),
  /** NEXUS: "#rrggbb" tint and short badge from "Customize Character". */
  tint: v.optional(v.string()),
  badge: v.optional(v.string()),
  /** NEXUS 0.4 hierarchy: commander | lieutenant | specialist, supervising agent, runtime. */
  rank: v.optional(v.string()),
  parentId: v.optional(v.string()),
  provider: v.optional(v.string()),
  paused: v.optional(v.boolean()),
};

/** NEXUS HQ: the building NEXUS sends (data/nexusHq.ts `HqLayout`). */
export const hqRoomFields = {
  id: v.string(),
  name: v.string(),
  kind: v.string(),
  purpose: v.string(),
  x: v.number(),
  y: v.number(),
  w: v.number(),
  h: v.number(),
  door: v.object({
    x: v.number(),
    y: v.number(),
    side: v.union(v.literal('bottom'), v.literal('top'), v.literal('left'), v.literal('right')),
  }),
  decor: v.array(v.string()),
  floor: v.optional(v.string()),
  wall: v.optional(v.string()),
  temporary: v.optional(v.boolean()),
  createdAt: v.optional(v.string()),
};

export const hqLayoutFields = {
  version: v.number(),
  revision: v.number(),
  locale: v.string(),
  width: v.number(),
  height: v.number(),
  rooms: v.array(v.object(hqRoomFields)),
  connections: v.array(v.object({ from: v.string(), to: v.string() })),
};

export const nexusTables = {
  nexusWorlds: defineTable({
    projectKey: v.string(),
    name: v.string(),
    worldId: v.id('worlds'),
  }).index('projectKey', ['projectKey']),

  nexusAgents: defineTable({
    worldId: v.id('worlds'),
    ...nexusAgentFields,
    playerId: v.optional(v.string()),
    /** Room the character was last sent to. */
    sentTo: v.optional(v.string()),
    movedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index('worldId', ['worldId', 'nexusId']),

  // What real agents (or the user) said: shown as speech bubbles and, when the
  // two characters are in an AI Town conversation, written to `messages`.
  nexusSpeech: defineTable({
    worldId: v.id('worlds'),
    from: v.string(),
    to: v.optional(v.string()),
    text: v.string(),
    origin: v.union(v.literal('real'), v.literal('user')),
    ts: v.number(),
    delivered: v.boolean(),
  }).index('worldId', ['worldId', 'ts']),

  // NEXUS HQ: the project's building and where characters stand in each room.
  nexusLayouts: defineTable({
    worldId: v.id('worlds'),
    layout: v.object(hqLayoutFields),
    /** Room id → standing tiles (data/nexusHq.ts `generateHqMap`). */
    spots: v.any(),
    /** Furniture that did not fit, rooms that could not be drawn. */
    skipped: v.any(),
    dropped: v.array(v.string()),
    updatedAt: v.number(),
  }).index('worldId', ['worldId']),

  // Spritesheets imported in NEXUS ("Customize Character").
  nexusSkins: defineTable({
    name: v.string(),
    label: v.string(),
    storageId: v.id('_storage'),
    /** PIXI spritesheet data (frames + animations), same shape as data/spritesheets/*.ts. */
    spritesheetData: v.any(),
    speed: v.number(),
  }).index('name', ['name']),
};
