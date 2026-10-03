// NEXUS addition: the observer camera of the embedded world (pixi-viewport).
// Modes: free (drag / wheel), follow one agent, cinematic (cycles through the
// agents and buildings where something real is happening) and overview.
import type { Viewport } from 'pixi-viewport';
import type { NexusZone } from '../../data/nexusZones';
import type { CameraMode } from './protocol';
import { NexusAgentRow, visualState } from './state';

const T = 32;
export const MAX_SCALE = 3;
/** How long the cinematic camera stays on one subject. */
export const CINEMATIC_MS = 7_000;

export type Shot =
  | { kind: 'agent'; nexusId: string; x: number; y: number }
  | { kind: 'zone'; zone: string; x: number; y: number };

export type Size = { width: number; height: number; worldWidth: number; worldHeight: number };

/**
 * Smallest zoom: the whole town fits on screen. Embedded, NEXUS replaces
 * AI Town's own bound (half the map) with this one so Overview shows it all.
 */
export function minScale(s: Size) {
  if (!s.worldWidth || !s.worldHeight) return 1;
  return Math.min(s.width / s.worldWidth, s.height / s.worldHeight);
}

export function clampScale(scale: number, s: Size) {
  return Math.max(minScale(s), Math.min(MAX_SCALE, scale));
}

export function zoneCenter(z: NexusZone) {
  return { x: (z.x + z.w / 2) * T, y: (z.y + z.h / 2) * T };
}

/** An agent is "active" when its row reports real work, a request or an error. */
export function isActive(a: Pick<NexusAgentRow, 'status' | 'emoji' | 'statusLabel'>) {
  const s = visualState(a);
  return s === 'thinking' || s === 'working' || s === 'waiting' || s === 'error' || s === 'starting';
}

/**
 * Subjects of the cinematic camera: active agents (where they are drawn),
 * then the buildings they work in. Empty when nothing real is happening.
 */
export function cinematicShots(
  agents: NexusAgentRow[],
  positions: Map<string, { x: number; y: number }>,
  zones: NexusZone[],
): Shot[] {
  const shots: Shot[] = [];
  const busyZones = new Set<string>();
  for (const a of agents) {
    if (!isActive(a)) continue;
    busyZones.add(a.zone);
    const p = positions.get(a.nexusId);
    if (p) shots.push({ kind: 'agent', nexusId: a.nexusId, x: p.x, y: p.y });
  }
  for (const z of zones) {
    if (busyZones.has(z.id)) shots.push({ kind: 'zone', zone: z.id, ...zoneCenter(z) });
  }
  return shots;
}

export function flyTo(viewport: Viewport, x: number, y: number, scale?: number, time = 700) {
  viewport.plugins.remove('animate');
  viewport.animate({
    position: { x, y },
    scale,
    time,
    ease: 'easeInOutSine',
    removeOnInterrupt: true,
  });
}

/** Keeps a followed agent in the center, smoothly. */
export function followStep(viewport: Viewport, x: number, y: number) {
  if (viewport.plugins.get('animate')) return;
  const c = viewport.center;
  const dx = x - c.x;
  const dy = y - c.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  viewport.moveCenter(c.x + dx * 0.12, c.y + dy * 0.12);
}

export function zoomBy(viewport: Viewport, delta: number, s: Size) {
  const scale = clampScale(viewport.scale.x * Math.pow(1.5, delta), s);
  viewport.plugins.remove('animate');
  viewport.animate({ scale, time: 250, ease: 'easeOutSine', removeOnInterrupt: true });
}

export function overview(viewport: Viewport, s: Size) {
  flyTo(viewport, s.worldWidth / 2, s.worldHeight / 2, minScale(s), 900);
}

export const CAMERA_LABEL: Record<CameraMode, string> = {
  free: 'FREE CAMERA',
  follow: 'FOLLOWING',
  cinematic: 'CINEMATIC',
  overview: 'OVERVIEW',
};
