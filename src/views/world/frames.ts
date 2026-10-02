// Merging streamed WorldFrames into the world shown by the UI.

import type { World, WorldEvent, WorldFrame } from "../../lib/types";

export const EVENT_CAP = 300;

function eventKey(e: WorldEvent): string {
  return `${e.ts}|${e.character ?? ""}|${e.text}`;
}

/** Appends events not already present (a frame may repeat ones already known), keeping the newest `cap`. */
export function mergeEvents(base: WorldEvent[], incoming: WorldEvent[], cap = EVENT_CAP): WorldEvent[] {
  const seen = new Set(base.map(eventKey));
  const added = incoming.filter((e) => !seen.has(eventKey(e)));
  if (added.length === 0) return base;
  const all = [...base, ...added];
  return all.length > cap ? all.slice(all.length - cap) : all;
}

/**
 * Applies a frame. Older frames are ignored; a frame with the same tick is applied only when it
 * reports a change the tick does not capture (pause / mode / conversations sent after a control or save).
 */
export function applyFrame(world: World, frame: WorldFrame): World {
  if (frame.tick < world.tick) return world;
  const sameTick = frame.tick === world.tick;
  if (sameTick && frame.running === world.running && frame.mode === world.mode && frame.conversations === null) return world;
  return {
    ...world,
    tick: frame.tick,
    running: frame.running,
    mode: frame.mode,
    characters: frame.characters,
    events: mergeEvents(world.events, frame.events),
    conversations: frame.conversations ?? world.conversations,
  };
}

export function newestFirst<T extends { ts: string }>(items: T[], limit: number): T[] {
  return [...items].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}
