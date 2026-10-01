// Per-machine UI conveniences in localStorage. Storage may be unavailable: every access is guarded
// and callers always get the fallback instead of an exception.

const PREFIX = "nexus.";

export function readPref<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the preference simply is not remembered.
  }
}

export const isBool = (v: unknown): v is boolean => typeof v === "boolean";
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Most recent first, unique, capped. */
export function pushRecent(list: string[], item: string, max = 20): string[] {
  return [item, ...list.filter((x) => x !== item)].slice(0, max);
}
