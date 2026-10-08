// NEXUS addition: WorldStateValidator and RepairManager of the embedded
// world. Every NEXUS agent row is checked before it is drawn (id, name,
// appearance, sprite, position, status, room). What can be repaired is
// repaired (default appearance, HQ room...) and reported once to NEXUS, which
// journals it; what cannot (no id) is not drawn. One bad character never
// stops the world.

export type Appearance = { skin: string; sprite: string; palette: string };

/** The appearance every character falls back to. */
export const DEFAULT_APPEARANCE: Appearance = { skin: 'default', sprite: 'default-agent', palette: 'default' };
/** Built-in sprite drawn for `default-agent` (AI Town's folk character f1). */
export const DEFAULT_CHARACTER = 'f1';

export const KNOWN_STATUSES = [
  'idle',
  'waiting',
  'working',
  'awaiting_permission',
  'starting',
  'offline',
  'stopped',
  'disconnected',
  'sleeping',
  'crashed',
  'retired',
  'completed',
  'error',
] as const;

export type WarningCode =
  | 'AI_WORLD_CHARACTER_ID_INVALID'
  | 'AI_WORLD_CHARACTER_NAME_MISSING'
  | 'AI_WORLD_CHARACTER_APPEARANCE_MISSING'
  | 'AI_WORLD_CHARACTER_STATUS_UNKNOWN'
  | 'AI_WORLD_CHARACTER_ROOM_UNKNOWN'
  | 'AI_WORLD_CHARACTER_POSITION_INVALID'
  | 'AI_WORLD_CHARACTER_RENDER_FAILED';

export type WorldWarning = {
  code: WarningCode;
  nexusId: string;
  /** What was wrong. */
  detail: string;
  /** What the repair did. */
  repair: string;
};

export const REPAIR_TEXT: Record<WarningCode, string> = {
  AI_WORLD_CHARACTER_ID_INVALID: 'Character not drawn. World rendering continues.',
  AI_WORLD_CHARACTER_NAME_MISSING: 'Agent id used as name. World rendering continues.',
  AI_WORLD_CHARACTER_APPEARANCE_MISSING: 'Default appearance restored. World rendering continues.',
  AI_WORLD_CHARACTER_STATUS_UNKNOWN: 'Shown as idle. World rendering continues.',
  AI_WORLD_CHARACTER_ROOM_UNKNOWN: 'Sent to NEXUS HQ. World rendering continues.',
  AI_WORLD_CHARACTER_POSITION_INVALID: 'Character hidden until its position is valid. World rendering continues.',
  AI_WORLD_CHARACTER_RENDER_FAILED: 'Fallback sprite drawn. World rendering continues.',
};

/** What validation needs about one agent row (a subset of `nexusAgents`). */
export type RowLike = {
  nexusId: unknown;
  name: unknown;
  character: unknown;
  status: unknown;
  zone: unknown;
  tint?: unknown;
};

export type Checked<T> = { row: T; ok: boolean; warnings: WorldWarning[] };

const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Validates and repairs one agent row. `hasLook(character)` tells whether
 * the sprite can be drawn (built-in, or imported skin with its texture);
 * `rooms` are the building's room ids. `ok = false`: do not draw it.
 */
export function checkAgent<T extends RowLike>(
  row: T,
  hasLook: (character: string) => boolean,
  rooms: string[],
): Checked<T> {
  const warnings: WorldWarning[] = [];
  const id = isText(row.nexusId) ? row.nexusId : '';
  const warn = (code: WarningCode, detail: string) =>
    warnings.push({ code, nexusId: id || String(row.nexusId ?? '?'), detail, repair: REPAIR_TEXT[code] });
  if (!id) {
    warn('AI_WORLD_CHARACTER_ID_INVALID', `invalid agent id ${JSON.stringify(row.nexusId ?? null)}`);
    return { row, ok: false, warnings };
  }
  const fixed: T = { ...row };
  if (!isText(row.name, 120)) {
    warn('AI_WORLD_CHARACTER_NAME_MISSING', 'the agent has no name');
    fixed.name = id;
  }
  if (!isText(row.character, 120) || !hasLook(row.character)) {
    warn(
      'AI_WORLD_CHARACTER_APPEARANCE_MISSING',
      isText(row.character, 120) ? `sprite “${row.character}” cannot be loaded` : 'the agent has no appearance',
    );
    fixed.character = DEFAULT_CHARACTER;
    fixed.tint = undefined;
  }
  if (row.tint !== undefined && !(typeof row.tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(row.tint))) {
    fixed.tint = undefined;
  }
  if (!isText(row.status, 40) || !(KNOWN_STATUSES as readonly string[]).includes(row.status)) {
    warn('AI_WORLD_CHARACTER_STATUS_UNKNOWN', `unknown status ${JSON.stringify(row.status ?? null)}`);
    fixed.status = 'idle';
  }
  if (!isText(row.zone, 80) || (rooms.length > 0 && !rooms.includes(row.zone))) {
    warn('AI_WORLD_CHARACTER_ROOM_UNKNOWN', `room ${JSON.stringify(row.zone ?? null)} is not in the building`);
    fixed.zone = rooms.includes('central_hq') ? 'central_hq' : (rooms[0] ?? 'central_hq');
  }
  return { row: fixed, ok: true, warnings };
}

/** A position the renderer can draw: finite, inside the map. */
export function validPosition(p: { x: number; y: number } | undefined, width: number, height: number): boolean {
  return (
    !!p &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < Math.max(1, width) &&
    p.y < Math.max(1, height)
  );
}

/**
 * Validates every row. In Safe Mode only valid characters are drawn: a row
 * that needed any repair is left out instead of patched.
 */
export function validateWorld<T extends RowLike>(
  rows: T[],
  hasLook: (character: string) => boolean,
  rooms: string[],
  safeMode = false,
): { rows: T[]; warnings: WorldWarning[]; hidden: string[] } {
  const out: T[] = [];
  const warnings: WorldWarning[] = [];
  const hidden: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const c = checkAgent(row, hasLook, rooms);
    warnings.push(...c.warnings);
    const id = String(c.row.nexusId);
    if (!c.ok || seen.has(id) || (safeMode && c.warnings.length > 0)) {
      hidden.push(id);
      continue;
    }
    seen.add(id);
    out.push(c.row);
  }
  return { rows: out, warnings, hidden };
}

/** Reports each (code, agent) once per page load. */
export class WarningReporter {
  private sent = new Set<string>();
  constructor(private send: (w: WorldWarning) => void) {}
  report(list: WorldWarning[]) {
    for (const w of list) {
      const key = `${w.code}:${w.nexusId}`;
      if (this.sent.has(key)) continue;
      this.sent.add(key);
      this.send(w);
    }
  }
}
