// NEXUS addition: the postMessage protocol between the embedded AI Town and
// NEXUS. Mirrors `AiTownToNexus` / `NexusToAiTown` in NEXUS's src/lib/types.ts.
import type { NexusZoneKind } from '../../data/nexusZones';
import { NEXUS_ZONES } from '../../data/nexusZones';
import { EMBEDDED } from './embed';

export type AgentAction =
  | 'assignMission'
  | 'pause'
  | 'stop'
  | 'follow'
  | 'inspect'
  | 'customize'
  | 'changeModel'
  | 'changeSkills'
  | 'changeMcp'
  | 'changeConnections';

export type ToNexus =
  | { type: 'ready' }
  | { type: 'select'; nexusId: string | null }
  | { type: 'talk'; nexusId: string }
  | { type: 'viewWork'; nexusId: string }
  | { type: 'openBuilding'; zone: NexusZoneKind }
  | { type: 'action'; nexusId: string; action: AgentAction }
  /** The camera mode changed inside the world (e.g. a drag ends Follow). */
  | { type: 'camera'; mode: CameraMode; nexusId?: string };

export type CameraMode = 'free' | 'follow' | 'cinematic' | 'overview';

export type FromNexus =
  | { source: 'nexus'; type: 'select'; nexusId: string | null }
  | { source: 'nexus'; type: 'focus'; nexusId: string }
  | { source: 'nexus'; type: 'focusZone'; zone: NexusZoneKind }
  | { source: 'nexus'; type: 'camera'; mode: CameraMode; nexusId?: string }
  | { source: 'nexus'; type: 'zoom'; delta: number };

/** Sends a message to NEXUS (same origin only). No-op outside NEXUS. */
export function postToNexus(msg: ToNexus) {
  if (!EMBEDDED || window.parent === window) return;
  window.parent.postMessage({ source: 'ai-town', ...msg }, window.location.origin);
}

const CAMERA_MODES: CameraMode[] = ['free', 'follow', 'cinematic', 'overview'];

/** Validates a message received from NEXUS; anything else is ignored. */
export function parseFromNexus(data: unknown): FromNexus | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.source !== 'nexus') return null;
  const isId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 200;
  switch (m.type) {
    case 'select':
      return m.nexusId === null || isId(m.nexusId)
        ? { source: 'nexus', type: 'select', nexusId: m.nexusId as string | null }
        : null;
    case 'focus':
      return isId(m.nexusId) ? { source: 'nexus', type: 'focus', nexusId: m.nexusId as string } : null;
    case 'focusZone':
      return NEXUS_ZONES.some((z) => z.id === m.zone)
        ? { source: 'nexus', type: 'focusZone', zone: m.zone as NexusZoneKind }
        : null;
    case 'camera':
      if (!CAMERA_MODES.includes(m.mode as CameraMode)) return null;
      return {
        source: 'nexus',
        type: 'camera',
        mode: m.mode as CameraMode,
        nexusId: isId(m.nexusId) ? (m.nexusId as string) : undefined,
      };
    case 'zoom':
      return typeof m.delta === 'number' && Number.isFinite(m.delta)
        ? { source: 'nexus', type: 'zoom', delta: Math.max(-2, Math.min(2, m.delta)) }
        : null;
    default:
      return null;
  }
}

/** Listens to NEXUS. Only messages from the parent window, same origin. */
export function listenToNexus(cb: (msg: FromNexus) => void): () => void {
  const onMessage = (e: MessageEvent) => {
    if (e.source !== window.parent || e.origin !== window.location.origin) return;
    const msg = parseFromNexus(e.data);
    if (msg) cb(msg);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
