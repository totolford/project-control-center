// Integrated AI Town: what NEXUS does with the messages of the embedded world
// (pure, tested), and the skins it offers. Presets and built-in characters
// come straight from ai-town/data so both sides agree; NEXUS HQ's rooms are
// in ./hq.ts.

import { characters as aiTownCharacters } from "../../../ai-town/data/characters";
import { BUILTIN_SKINS, NEXUS_SKIN_PREFIX, NEXUS_SKIN_PRESETS } from "../../../ai-town/data/nexusSkins";
import type { AiTownCameraMode, AiTownStatus, AiTownToNexus, AiWorldWarning } from "../../lib/types";
import { isRoomId } from "./hq";

export { BUILTIN_SKINS, NEXUS_SKIN_PREFIX, NEXUS_SKIN_PRESETS };

type AgentAction = Extract<AiTownToNexus, { type: "action" }>["action"];

const ACTIONS: AgentAction[] = [
  "assignMission",
  "pause",
  "stop",
  "follow",
  "inspect",
  "customize",
  "changeModel",
  "changeSkills",
  "changeMcp",
  "changeConnections",
  "resume",
  "restart",
  "promote",
  "demote",
  "viewMemory",
  "viewTasks",
  "viewTools",
];
const CAMERA_MODES: AiTownCameraMode[] = ["free", "follow", "cinematic", "overview", "mission"];

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 200;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** A repair warning of the world validator (journaled as is, so clipped and checked). */
function parseWarning(v: unknown): AiWorldWarning | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  if (typeof w.code !== "string" || !/^AI_WORLD_[A-Z_]{1,60}$/.test(w.code)) return null;
  return { code: w.code, nexusId: str(w.nexusId, 200), detail: str(w.detail, 300), repair: str(w.repair, 200) };
}

/** Validates a message posted by the AI Town iframe; anything else is ignored. */
export function parseAiTownMessage(data: unknown): AiTownToNexus | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== "ai-town") return null;
  switch (m.type) {
    case "ready":
      return { source: "ai-town", type: "ready", safeMode: m.safeMode === true };
    case "select":
      return m.nexusId === null || isId(m.nexusId) ? { source: "ai-town", type: "select", nexusId: m.nexusId as string | null } : null;
    case "talk":
    case "viewWork":
      return isId(m.nexusId) ? { source: "ai-town", type: m.type, nexusId: m.nexusId } : null;
    case "openRoom":
      return isRoomId(m.roomId) ? { source: "ai-town", type: "openRoom", roomId: m.roomId } : null;
    case "action":
      return isId(m.nexusId) && ACTIONS.includes(m.action as AgentAction)
        ? { source: "ai-town", type: "action", nexusId: m.nexusId, action: m.action as AgentAction }
        : null;
    case "camera":
      return CAMERA_MODES.includes(m.mode as AiTownCameraMode)
        ? { source: "ai-town", type: "camera", mode: m.mode as AiTownCameraMode, nexusId: isId(m.nexusId) ? m.nexusId : undefined }
        : null;
    case "warning": {
      const warning = parseWarning(m.warning);
      return warning ? { source: "ai-town", type: "warning", warning } : null;
    }
    case "crash": {
      if (!m.context || typeof m.context !== "object" || Array.isArray(m.context)) return null;
      const context = m.context as Record<string, unknown>;
      // Size-bounded: the context becomes a crash report.
      if (JSON.stringify(context).length > 20_000) return null;
      return { source: "ai-town", type: "crash", context: { ...context, message: str(context.message, 500) } };
    }
    default:
      return null;
  }
}

/** Only the embedded frontend, served by NEXUS itself, may talk to NEXUS. */
export function isTrustedEvent(e: Pick<MessageEvent, "origin" | "source">, frame: Window | null | undefined, origin: string): boolean {
  return !!frame && e.source === frame && e.origin === origin;
}

/** What the AI World page should show for a runtime status. */
export type HostPhase = "no-node" | "no-source" | "consent" | "stopped" | "running";

export function hostPhase(s: AiTownStatus): HostPhase {
  if (!s.node || !s.npm) return "no-node";
  if (!s.source) return "no-source";
  if (!s.installed || s.needsReinstall) return "consent";
  return s.running ? "running" : "stopped";
}

// ---------------------------------------------------------------- skins

export interface SkinChoice {
  /** Value stored in AgentAppearance.skin. */
  skin: string;
  label: string;
  /** What it really looks like. */
  look: string;
  textureUrl: string;
  /** Down-facing frame shown as preview. */
  frame: { x: number; y: number; w: number; h: number };
  preset?: string;
}

function downFrame(name: string) {
  const c = aiTownCharacters.find((ch) => ch.name === name);
  if (!c) return null;
  const sheet = c.spritesheetData;
  const first = sheet.animations?.down?.[0] ?? "down";
  const f = sheet.frames[first]?.frame;
  return f ? { textureUrl: c.textureUrl, frame: f } : null;
}

/** Presets (each looks like its label) then the other built-in characters. */
export function builtinSkinChoices(): SkinChoice[] {
  const out: SkinChoice[] = [];
  for (const p of NEXUS_SKIN_PRESETS) {
    const d = downFrame(p.character);
    if (d) out.push({ skin: p.character, label: p.label, look: p.look, preset: p.id, ...d });
  }
  for (const name of BUILTIN_SKINS) {
    if (out.some((c) => c.skin === name)) continue;
    const d = downFrame(name);
    if (d) out.push({ skin: name, label: `Villager ${name.toUpperCase()}`, look: "AI Town villager", ...d });
  }
  return out;
}

export function isValidTint(t: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(t);
}

/** Skin name for an imported spritesheet: lowercase letters, digits, dashes (nexus:saveSkin rule). */
export function skinSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "skin"
  );
}
