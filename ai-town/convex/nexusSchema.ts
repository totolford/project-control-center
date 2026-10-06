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
  /** Zone the agent is working in (data/nexusZones.ts). */
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
    /** Zone the character was last sent to. */
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
