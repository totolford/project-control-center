// Test-only builders for AI World entities (complete objects matching the contract).

import type { Character, HqConfig, HqRoom, HqView, Room, World } from "../../lib/types";
import { blankCharacter } from "./characters";

export function makeCharacter(id: string, patch: Partial<Character> = {}): Character {
  return { ...blankCharacter(id, new Set(), 0), id, name: id, ...patch };
}

export const ROOMS: Room[] = [
  { id: "workshop", name: "Workshop", kind: "workshop", x: 2, y: 2, w: 16, h: 9 },
  { id: "lounge", name: "Lounge", kind: "lounge", x: 2, y: 13, w: 16, h: 8 },
  { id: "gate", name: "Gate", kind: "gate", x: 36, y: 17, w: 4, h: 4 },
];

export function makeWorld(patch: Partial<World> = {}): World {
  return {
    format: 1,
    name: "Test Town",
    description: "",
    provider: "nexus_native",
    mode: "hybrid",
    running: false,
    tick: 10,
    width: 42,
    height: 23,
    rooms: ROOMS,
    characters: [],
    conversations: [],
    events: [],
    settings: { speed: 2, llmConversations: false, conversationModel: "haiku", maxConversationsPerHour: 6, rules: [], environment: "Agent campus" },
    providerState: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

export function makeHqRoom(id: string, type: string, patch: Partial<HqRoom> = {}): HqRoom {
  return {
    id,
    name: id,
    type,
    position: { x: 1, y: 1 },
    size: { w: 10, h: 7 },
    purpose: "",
    requiredConnections: [],
    agents: [],
    persistent: false,
    temporary: false,
    archived: false,
    decor: [],
    customName: false,
    createdBy: "nexus",
    createdAt: "2026-01-01T00:00:00Z",
    unplaced: false,
    ...patch,
  };
}

/** NEXUS HQ as `ai_world_hq` returns it; every active room is drawn. */
export function makeHqView(rooms: HqRoom[], occupancy: HqView["occupancy"] = [], patch: Partial<HqConfig> = {}): HqView {
  const config: HqConfig = {
    version: 1,
    language: "auto",
    locale: "en",
    layout: "auto",
    rooms,
    connections: [],
    theme: "default",
    rules: { askBeforeDeletingTemporary: true, maxRooms: 24 },
    revision: 3,
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch,
  };
  return {
    config,
    layout: {
      version: 1,
      revision: config.revision,
      locale: config.locale,
      width: 40,
      height: 30,
      rooms: rooms
        .filter((r) => !r.archived && !r.unplaced)
        .map((r) => ({ id: r.id, name: r.name, kind: r.type, purpose: r.purpose, x: r.position.x, y: r.position.y, w: r.size.w, h: r.size.h, door: { x: r.position.x + 2, y: r.position.y + r.size.h - 1, side: "bottom" as const }, decor: r.decor, floor: "wood", wall: "plaster", temporary: r.temporary, createdAt: r.createdAt })),
      connections: [],
    },
    issues: [],
    suggestions: { domains: [], suggestions: [] },
    snapshots: [],
    occupancy,
  };
}
