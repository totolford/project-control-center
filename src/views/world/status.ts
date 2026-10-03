// Visual meaning of world state: status rings, room floors, modes and sprites.
// Canvas needs concrete colors, so the values mirror the tokens of styles/base.css.

import { AGENT_STATUS, type Tone } from "../../lib/labels";
import type { Agent, Character, RoomKind, WorldMode } from "../../lib/types";

export const TONE_COLOR: Record<Tone, string> = {
  green: "#3fb950",
  blue: "#58a6ff",
  amber: "#d29922",
  red: "#f85149",
  grey: "#858d99",
  orange: "#e8833a",
  dim: "#59616d",
  accent: "#6f8ef0",
};

export const CANVAS_COLORS = {
  background: "#0b0d10",
  wall: "#2f3640",
  roomLabel: "#858d99",
  text: "#e7eaf0",
  bubble: "#171b21",
  bubbleBorder: "#2f3640",
  selection: "#6f8ef0",
  neutralRing: "#59616d",
};

export interface Ring {
  color: string;
  pulse: boolean;
  label: string;
  /** The ring reflects a real NEXUS agent. */
  live: boolean;
}

/** Real data drives characters only in hybrid / real execution modes. */
export function isLiveMode(mode: WorldMode): boolean {
  return mode !== "simulation";
}

/** Linked agent of a character, only when the mode makes the link real. */
export function liveAgent(c: Character, mode: WorldMode, agents: Agent[]): Agent | undefined {
  if (!isLiveMode(mode) || !c.nexusAgent) return undefined;
  return agents.find((a) => a.id === c.nexusAgent);
}

/** Status ring of a character: the real agent status when linked and live, neutral otherwise. */
export function characterRing(c: Character, mode: WorldMode, agents: Agent[]): Ring {
  if (!isLiveMode(mode)) return { color: CANVAS_COLORS.neutralRing, pulse: false, label: "Simulated", live: false };
  if (!c.nexusAgent) return { color: CANVAS_COLORS.neutralRing, pulse: false, label: "Not linked (simulated)", live: false };
  const agent = agents.find((a) => a.id === c.nexusAgent);
  if (!agent) return { color: TONE_COLOR.grey, pulse: false, label: "Linked agent not found", live: false };
  const meta = AGENT_STATUS[agent.status] ?? { label: agent.status, tone: "grey" as Tone };
  return { color: TONE_COLOR[meta.tone], pulse: Boolean(meta.pulse), label: meta.label, live: true };
}

export const ROOM_META: Record<RoomKind, { floor: string; meaning: string }> = {
  workshop: { floor: "rgba(63, 185, 80, 0.08)", meaning: "running a turn" },
  review: { floor: "rgba(111, 142, 240, 0.09)", meaning: "task in review" },
  meeting: { floor: "rgba(88, 166, 255, 0.08)", meaning: "exchanging messages" },
  library: { floor: "rgba(163, 113, 247, 0.08)", meaning: "memory work" },
  server_room: { floor: "rgba(57, 197, 207, 0.08)", meaning: "using SSH / MCP" },
  security: { floor: "rgba(210, 153, 34, 0.09)", meaning: "waiting for a permission" },
  lounge: { floor: "rgba(133, 141, 153, 0.07)", meaning: "idle" },
  infirmary: { floor: "rgba(248, 81, 73, 0.08)", meaning: "crashed" },
  gate: { floor: "rgba(89, 97, 109, 0.12)", meaning: "offline" },
};

export const MODE_META: Record<WorldMode, { label: string; explain: string }> = {
  simulation: {
    label: "Simulation",
    explain: "Simulation — not your real agents. Characters follow a generated daily routine; mood and conversations are simulated.",
  },
  hybrid: {
    label: "Hybrid",
    explain: "Linked characters mirror their real NEXUS agent (room, activity, status). Unlinked characters stay simulated.",
  },
  real_execution: {
    label: "Real execution",
    explain: "Like Hybrid, and you can send real instructions to linked agents from the world. Instructions run real Claude turns.",
  },
};

export const PROVIDER_LABEL: Record<string, string> = {
  nexus_native: "NEXUS Native",
  ai_town_compatible: "AI Town compatible (retired export)",
  ai_town: "AI Town",
  custom: "Custom world",
};

export const SPRITES = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
const SPRITE_FILL = ["#3b4a6b", "#4b3b6b", "#2f5a55", "#5a4a2f", "#5a2f3f", "#2f4f5a", "#4a5a2f", "#55405a"];

/** Avatar fill for a sprite id (f1..f8); unknown ids fall back to f1. */
export function spriteFill(sprite: string): string {
  const i = SPRITES.indexOf(sprite);
  return SPRITE_FILL[i < 0 ? 0 : i];
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
