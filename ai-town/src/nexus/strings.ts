// NEXUS addition: the few texts the embedded world draws itself. NEXUS sends
// them in the AI World language (message `strings`); English until then.
import type { CameraMode } from './protocol';

export const WORLD_STRINGS = {
  crashed: 'AI World encountered a rendering error. The engine is still running. Recovering the world view…',
  recoverView: 'Recover View',
  loading: 'Loading the world…',
  noAgents: 'No NEXUS agent in this project yet: characters appear when agents exist.',
  safeMode: 'SAFE MODE',
  nobodyOnMission: 'NO AGENT WORKING ON IT NOW',
  nothingActive: 'NOTHING ACTIVE',
  camera_free: 'FREE CAMERA',
  camera_follow: 'FOLLOWING',
  camera_cinematic: 'CINEMATIC',
  camera_overview: 'OVERVIEW',
  camera_mission: 'FOLLOWING MISSION',
};

export type WorldStringKey = keyof typeof WORLD_STRINGS;

const current: Record<WorldStringKey, string> = { ...WORLD_STRINGS };

export function text(key: WorldStringKey): string {
  return current[key];
}

export function cameraLabel(mode: CameraMode): string {
  return current[`camera_${mode}` as WorldStringKey] ?? mode.toUpperCase();
}

/** Keeps known keys with non-empty short strings; others stay as they are. */
export function setWorldStrings(strings: Record<string, unknown>): number {
  let n = 0;
  for (const key of Object.keys(WORLD_STRINGS) as WorldStringKey[]) {
    const v = strings[key];
    if (typeof v === 'string' && v.trim() && v.length <= 300) {
      current[key] = v;
      n++;
    }
  }
  return n;
}
