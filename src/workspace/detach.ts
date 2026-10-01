// Encoding of a panel spec into a detached window's URL hash (pure, tested).

import { PANEL_TYPES, type PanelSpec, type PanelType } from "./layout";

const HASH_PREFIX = "#panel=";

export function detachUrl(spec: PanelSpec): string {
  return `index.html${HASH_PREFIX}${encodeURIComponent(JSON.stringify(spec))}`;
}

/** Window labels may only contain alphanumerics, '-', '/', ':' and '_'. */
export function detachLabel(panelId: string): string {
  return `panel-${panelId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Spec from `location.hash`, or null when the hash is not a valid panel spec. */
export function parseDetachHash(hash: string): PanelSpec | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(hash.slice(HASH_PREFIX.length)));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!PANEL_TYPES.includes(r.type as PanelType)) return null;
  const spec: PanelSpec = { type: r.type as PanelType };
  for (const k of ["agentId", "connectionId", "missionId", "taskId"] as const) {
    if (typeof r[k] === "string" && r[k]) spec[k] = r[k] as string;
  }
  return spec;
}
