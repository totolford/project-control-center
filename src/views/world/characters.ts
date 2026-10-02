// Character editing helpers (pure).

import type { Agent, Character, World } from "../../lib/types";
import { SPRITES } from "./status";

export const AUTONOMY_LEVELS = ["low", "normal", "high", "maximum"];

/** Where new characters enter the campus map (the Gate). */
const ENTRY = { x: 38, y: 19 };

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "character";
}

/** Id derived from the name, suffixed until it is not in `taken`. */
export function uniqueId(name: string, taken: Set<string>): string {
  const base = slugify(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function blankCharacter(name: string, taken: Set<string>, index: number): Character {
  return {
    id: uniqueId(name, taken),
    name,
    nexusAgent: null,
    personality: "",
    goals: [],
    memory: [],
    skills: [],
    tools: [],
    mcp: [],
    model: null,
    autonomy: "normal",
    relationships: [],
    sprite: SPRITES[index % SPRITES.length],
    x: ENTRY.x,
    y: ENTRY.y,
    room: null,
    targetRoom: null,
    activity: null,
    mood: null,
    lastAction: null,
  };
}

/** Same characters as plain simulation characters (project roles without the live link). */
export function unlinkAll(chars: Character[]): Character[] {
  return chars.map((c) => ({ ...c, nexusAgent: null }));
}

/** Appends `incoming`, re-identifying characters whose id is already used. */
export function mergeCharacters(existing: Character[], incoming: Character[]): Character[] {
  const taken = new Set(existing.map((c) => c.id));
  const out = [...existing];
  for (const c of incoming) {
    const id = taken.has(c.id) ? uniqueId(c.name || c.id, taken) : c.id;
    taken.add(id);
    out.push({ ...c, id });
  }
  return out;
}

export function updateCharacter(chars: Character[], id: string, patch: Partial<Character>): Character[] {
  return chars.map((c) => (c.id === id ? { ...c, ...patch } : c));
}

/** Removes a character and the relationships other characters had with it. */
export function removeCharacter(chars: Character[], id: string): Character[] {
  const gone = chars.find((c) => c.id === id);
  return chars
    .filter((c) => c.id !== id)
    .map((c) => (gone ? { ...c, relationships: c.relationships.filter((r) => r.with !== gone.name && r.with !== gone.id) } : c));
}

/** Active agents that no character of the world is linked to yet. */
export function agentsWithoutCharacter(agents: Agent[], characters: Character[]): Agent[] {
  const linked = new Set(characters.map((c) => c.nexusAgent).filter(Boolean));
  return agents.filter((a) => a.status !== "retired" && !linked.has(a.id));
}

/** Adds the character mapped from one agent (from worldCharactersFromAgents) to the world. */
export function addAgentCharacter(world: World, fromAgents: Character[], agentId: string): World | null {
  const c = fromAgents.find((ch) => ch.nexusAgent === agentId);
  if (!c) return null;
  return { ...world, characters: mergeCharacters(world.characters, [{ ...c, x: ENTRY.x, y: ENTRY.y, room: null, targetRoom: null }]) };
}

/** "a, b , c" → ["a", "b", "c"] */
export function parseCsv(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function replaceAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((it, i) => (i === index ? value : it));
}

export function removeAt<T>(items: T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}
