// NEXUS addition: what the world view was doing, kept up to date while it
// renders, so a crash report says where it broke (character, room, last
// render operation, last event, appearance, sprite, asset, camera, renderer).

export type RenderTrace = {
  /** e.g. "draw character a1", "draw room server_room", "camera follow". */
  lastRenderOp: string;
  characterId: string | null;
  roomId: string | null;
  /** Last message received from NEXUS, or engine change noticed. */
  lastEvent: string;
  appearance: unknown;
  sprite: string | null;
  asset: string | null;
  camera: { mode: string; x?: number; y?: number; scale?: number } | null;
  /** WebGL / canvas, context lost... */
  renderer: string;
};

export const trace: RenderTrace = {
  lastRenderOp: 'start',
  characterId: null,
  roomId: null,
  lastEvent: 'none',
  appearance: null,
  sprite: null,
  asset: null,
  camera: null,
  renderer: 'not started',
};

export function traceCharacter(id: string, appearance: unknown, sprite: string, asset: string | null) {
  trace.lastRenderOp = `draw character ${id}`;
  trace.characterId = id;
  trace.appearance = appearance;
  trace.sprite = sprite;
  trace.asset = asset;
}

export function traceRoom(id: string) {
  trace.lastRenderOp = `draw room ${id}`;
  trace.roomId = id;
}

export function traceEvent(event: string) {
  trace.lastEvent = event;
}

/** Everything NEXUS stores with the crash report. */
export type CrashContext = RenderTrace & {
  message: string;
  stack: string;
  componentStack: string;
  world: { worldId: string | null; agents: number; rooms: number; revision: number | null };
  safeMode: boolean;
  at: string;
};

export function crashContext(
  error: unknown,
  componentStack: string,
  world: CrashContext['world'],
  safeMode: boolean,
): CrashContext {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    ...trace,
    appearance: safeJson(trace.appearance),
    message: e.message.slice(0, 500),
    stack: (e.stack ?? '').slice(0, 4000),
    componentStack: componentStack.slice(0, 4000),
    world,
    safeMode,
    at: new Date().toISOString(),
  };
}

function safeJson(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v);
  }
}
