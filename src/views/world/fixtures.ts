// Test-only builders for AI World entities (complete objects matching the contract).

import type { Character, Room, World } from "../../lib/types";
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
