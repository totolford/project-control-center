// NEXUS addition: the postMessage protocol between the embedded AI Town and
// NEXUS. Mirrors `AiTownToNexus` / `NexusToAiTown` in NEXUS's src/lib/types.ts.
import { EMBEDDED } from './embed';
import type { CrashContext } from './trace';
import type { WorldWarning } from './validate';

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
  | 'changeConnections'
  | 'resume'
  | 'restart'
  | 'promote'
  | 'demote'
  | 'viewMemory'
  | 'viewTasks'
  | 'viewTools';

export type ToNexus =
  | { type: 'ready'; safeMode: boolean }
  | { type: 'select'; nexusId: string | null }
  | { type: 'talk'; nexusId: string }
  | { type: 'viewWork'; nexusId: string }
  /** A click on a room of NEXUS HQ (its sign or its floor). */
  | { type: 'openRoom'; roomId: string }
  | { type: 'action'; nexusId: string; action: AgentAction }
  /** The camera mode changed inside the world (e.g. a drag ends Follow). */
  | { type: 'camera'; mode: CameraMode; nexusId?: string }
  /** The validator repaired or hid a character (journaled by NEXUS). */
  | { type: 'warning'; warning: WorldWarning }
  /** The world view crashed; the engine keeps running. */
  | { type: 'crash'; context: CrashContext };

/** `mission`: the camera follows the agents really working on one mission. */
export type CameraMode = 'free' | 'follow' | 'cinematic' | 'overview' | 'mission';

export type FromNexus =
  | { source: 'nexus'; type: 'select'; nexusId: string | null }
  | { source: 'nexus'; type: 'focus'; nexusId: string }
  | { source: 'nexus'; type: 'focusRoom'; roomId: string }
  | { source: 'nexus'; type: 'camera'; mode: CameraMode; nexusId?: string }
  /** Follow Mission: the agents NEXUS knows are working on it (may be empty). */
  | { source: 'nexus'; type: 'followMission'; missionId: string; label: string; nexusIds: string[] }
  | { source: 'nexus'; type: 'zoom'; delta: number }
  /** Texts of the world UI in the AI World language. */
  | { source: 'nexus'; type: 'strings'; strings: Record<string, string> };

/** Sends a message to NEXUS (same origin only). No-op outside NEXUS. */
export function postToNexus(msg: ToNexus) {
  if (!EMBEDDED || window.parent === window) return;
  window.parent.postMessage({ source: 'ai-town', ...msg }, window.location.origin);
}

const CAMERA_MODES: CameraMode[] = ['free', 'follow', 'cinematic', 'overview', 'mission'];

/** Room ids of NEXUS HQ (crates/pcc-world/src/hq/validate.rs `valid_id`). */
export function isRoomId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9_-]{1,48}$/.test(v);
}

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
    case 'focusRoom':
      return isRoomId(m.roomId) ? { source: 'nexus', type: 'focusRoom', roomId: m.roomId } : null;
    case 'followMission': {
      const ids = Array.isArray(m.nexusIds) ? m.nexusIds.filter(isId).slice(0, 100) : null;
      return isId(m.missionId) && ids
        ? {
            source: 'nexus',
            type: 'followMission',
            missionId: m.missionId as string,
            label: typeof m.label === 'string' ? m.label.slice(0, 120) : '',
            nexusIds: ids as string[],
          }
        : null;
    }
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
    case 'strings': {
      if (!m.strings || typeof m.strings !== 'object' || Array.isArray(m.strings)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.strings as Record<string, unknown>).slice(0, 50)) {
        if (typeof v === 'string' && k.length < 40) out[k] = v.slice(0, 300);
      }
      return { source: 'nexus', type: 'strings', strings: out };
    }
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
