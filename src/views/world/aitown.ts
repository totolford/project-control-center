// Integrated AI Town: what NEXUS does with the messages of the embedded world
// (pure, tested), and the skins it offers. Zones, presets and built-in
// characters come straight from ai-town/data so both sides agree.

import { characters as aiTownCharacters } from "../../../ai-town/data/characters";
import { BUILTIN_SKINS, NEXUS_SKIN_PREFIX, NEXUS_SKIN_PRESETS } from "../../../ai-town/data/nexusSkins";
import { NEXUS_ZONES } from "../../../ai-town/data/nexusZones";
import type { AiTownStatus, AiTownToNexus, NexusToAiTown, NexusZoneKind } from "../../lib/types";
import type { ViewName } from "../../store";

export { BUILTIN_SKINS, NEXUS_SKIN_PREFIX, NEXUS_SKIN_PRESETS, NEXUS_ZONES };

type AgentAction = Extract<AiTownToNexus, { type: "action" }>["action"];
type CameraMode = Extract<NexusToAiTown, { type: "camera" }>["mode"];

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
const CAMERA_MODES: CameraMode[] = ["free", "follow", "cinematic", "overview"];
const ZONE_IDS = NEXUS_ZONES.map((z) => z.id) as string[];

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 200;

/** Validates a message posted by the AI Town iframe; anything else is ignored. */
export function parseAiTownMessage(data: unknown): AiTownToNexus | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== "ai-town") return null;
  switch (m.type) {
    case "ready":
      return { source: "ai-town", type: "ready" };
    case "select":
      return m.nexusId === null || isId(m.nexusId) ? { source: "ai-town", type: "select", nexusId: m.nexusId as string | null } : null;
    case "talk":
    case "viewWork":
      return isId(m.nexusId) ? { source: "ai-town", type: m.type, nexusId: m.nexusId } : null;
    case "openBuilding":
      return ZONE_IDS.includes(m.zone as string) ? { source: "ai-town", type: "openBuilding", zone: m.zone as NexusZoneKind } : null;
    case "action":
      return isId(m.nexusId) && ACTIONS.includes(m.action as AgentAction)
        ? { source: "ai-town", type: "action", nexusId: m.nexusId, action: m.action as AgentAction }
        : null;
    case "camera":
      return CAMERA_MODES.includes(m.mode as CameraMode)
        ? { source: "ai-town", type: "camera", mode: m.mode as CameraMode, nexusId: isId(m.nexusId) ? m.nexusId : undefined }
        : null;
    default:
      return null;
  }
}

/** Only the embedded frontend, served by NEXUS itself, may talk to NEXUS. */
export function isTrustedEvent(e: Pick<MessageEvent, "origin" | "source">, frame: Window | null | undefined, origin: string): boolean {
  return !!frame && e.source === frame && e.origin === origin;
}

/** Where a building leads in NEXUS. */
export type BuildingTarget = { kind: "view"; view: ViewName } | { kind: "central" };

export const BUILDING_TARGET: Record<NexusZoneKind, BuildingTarget> = {
  central_hq: { kind: "central" },
  coding_office: { kind: "view", view: "swarm" },
  testing_lab: { kind: "view", view: "swarm" },
  design_studio: { kind: "view", view: "swarm" },
  roblox_studio: { kind: "view", view: "connections" },
  github_office: { kind: "view", view: "github" },
  server_room: { kind: "view", view: "connections" },
  mcp_lab: { kind: "view", view: "mcp" },
  skill_shop: { kind: "view", view: "market" },
  review_room: { kind: "view", view: "tasks" },
  archive: { kind: "view", view: "agents" },
};

export function zoneName(zone: NexusZoneKind): string {
  return NEXUS_ZONES.find((z) => z.id === zone)?.name ?? zone;
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
