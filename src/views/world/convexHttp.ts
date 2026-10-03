// Calls to the local AI Town backend (Convex HTTP API on 127.0.0.1) for
// imported skins: upload URL → file → nexus:saveSkin.

import type { SpritesheetData } from "./spritesheet";

type Fetch = typeof fetch;

async function call<T>(base: string, kind: "query" | "mutation", path: string, args: unknown, f: Fetch = fetch): Promise<T> {
  const r = await f(`${base.replace(/\/$/, "")}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await r.json().catch(() => null)) as { status?: string; value?: T; errorMessage?: string } | null;
  if (!r.ok || body?.status !== "success") {
    throw new Error(body?.errorMessage ?? `AI Town backend: HTTP ${r.status} on ${path}`);
  }
  return body.value as T;
}

export interface ImportedSkin {
  name: string;
  label: string;
  textureUrl: string | null;
  spritesheetData: SpritesheetData;
  speed: number;
}

/** Skins already imported in this AI Town (all projects share them). */
export async function listImportedSkins(base: string, worldId: string, f: Fetch = fetch): Promise<ImportedSkin[]> {
  const state = await call<{ skins: ImportedSkin[] }>(base, "query", "nexus:state", { worldId }, f);
  return state.skins;
}

/** Uploads a PNG and registers it; returns the skin id (`nexus-skin:<name>`). */
export async function uploadSkin(
  base: string,
  file: Blob,
  skin: { name: string; label: string; spritesheetData: SpritesheetData; speed: number },
  f: Fetch = fetch,
): Promise<string> {
  const uploadUrl = await call<string>(base, "mutation", "nexus:generateSkinUploadUrl", {}, f);
  const r = await f(uploadUrl, { method: "POST", headers: { "Content-Type": file.type || "image/png" }, body: file });
  const body = (await r.json().catch(() => null)) as { storageId?: string } | null;
  if (!r.ok || !body?.storageId) throw new Error(`Upload to the AI Town backend failed (HTTP ${r.status})`);
  return call<string>(base, "mutation", "nexus:saveSkin", { ...skin, storageId: body.storageId }, f);
}
