import { describe, expect, it, vi } from "vitest";
import type { AiTownStatus } from "../../lib/types";
import {
  BUILDING_TARGET,
  NEXUS_SKIN_PRESETS,
  NEXUS_ZONES,
  builtinSkinChoices,
  hostPhase,
  isTrustedEvent,
  isValidTint,
  parseAiTownMessage,
  skinSlug,
} from "./aitown";
import { listImportedSkins, uploadSkin } from "./convexHttp";
import { buildSpritesheetData, detectLayout, frameRect, layoutErrors } from "./spritesheet";

describe("AI Town bridge messages", () => {
  it("accepts only well-formed messages from AI Town", () => {
    expect(parseAiTownMessage({ source: "ai-town", type: "ready" })).toEqual({ source: "ai-town", type: "ready" });
    expect(parseAiTownMessage({ source: "ai-town", type: "talk", nexusId: "w1" })).toEqual({ source: "ai-town", type: "talk", nexusId: "w1" });
    expect(parseAiTownMessage({ source: "ai-town", type: "select", nexusId: null })).toEqual({ source: "ai-town", type: "select", nexusId: null });
    expect(parseAiTownMessage({ source: "ai-town", type: "openBuilding", zone: "mcp_lab" })).toMatchObject({ zone: "mcp_lab" });
    expect(parseAiTownMessage({ source: "ai-town", type: "action", nexusId: "w1", action: "stop" })).toMatchObject({ action: "stop" });
    expect(parseAiTownMessage({ source: "ai-town", type: "camera", mode: "follow", nexusId: 3 })).toEqual({ source: "ai-town", type: "camera", mode: "follow", nexusId: undefined });
    // Rejected: other sources, unknown types, zones, actions, missing ids.
    expect(parseAiTownMessage({ source: "nexus", type: "ready" })).toBeNull();
    expect(parseAiTownMessage({ source: "ai-town", type: "rm -rf" })).toBeNull();
    expect(parseAiTownMessage({ source: "ai-town", type: "openBuilding", zone: "bank" })).toBeNull();
    expect(parseAiTownMessage({ source: "ai-town", type: "action", nexusId: "w1", action: "delete" })).toBeNull();
    expect(parseAiTownMessage({ source: "ai-town", type: "talk" })).toBeNull();
    expect(parseAiTownMessage("ready")).toBeNull();
  });

  it("trusts only the iframe, same origin", () => {
    const frame = {} as Window;
    expect(isTrustedEvent({ source: frame, origin: "http://tauri.localhost" }, frame, "http://tauri.localhost")).toBe(true);
    expect(isTrustedEvent({ source: frame, origin: "http://evil" }, frame, "http://tauri.localhost")).toBe(false);
    expect(isTrustedEvent({ source: {} as Window, origin: "http://tauri.localhost" }, frame, "http://tauri.localhost")).toBe(false);
    expect(isTrustedEvent({ source: frame, origin: "http://tauri.localhost" }, null, "http://tauri.localhost")).toBe(false);
  });

  it("every building leads somewhere real", () => {
    expect(Object.keys(BUILDING_TARGET).sort()).toEqual(NEXUS_ZONES.map((z) => z.id).sort());
    expect(BUILDING_TARGET.skill_shop).toEqual({ kind: "view", view: "market" });
    expect(BUILDING_TARGET.central_hq).toEqual({ kind: "central" });
    expect(BUILDING_TARGET.github_office).toEqual({ kind: "view", view: "github" });
  });

  it("derives the page phase from the runtime status", () => {
    const s: AiTownStatus = { node: "v20", npm: "10", source: "x", upstreamCommit: null, runtimeDir: "r", installed: true, needsReinstall: false, running: false, url: null, lastError: null, log: [] };
    expect(hostPhase(s)).toBe("stopped");
    expect(hostPhase({ ...s, running: true })).toBe("running");
    expect(hostPhase({ ...s, installed: false })).toBe("consent");
    expect(hostPhase({ ...s, needsReinstall: true })).toBe("consent");
    expect(hostPhase({ ...s, npm: null })).toBe("no-node");
    expect(hostPhase({ ...s, source: null })).toBe("no-source");
  });
});

describe("skins", () => {
  it("offers every preset with its real sprite, then the other villagers", () => {
    const choices = builtinSkinChoices();
    for (const p of NEXUS_SKIN_PRESETS) {
      expect(choices.find((c) => c.preset === p.id)).toMatchObject({ skin: p.character, label: p.label });
    }
    expect(choices.find((c) => c.preset === "robot")?.textureUrl).toBe("/ai-town/assets/nexus-skins/robot.png");
    expect(choices.find((c) => c.skin === "f1")?.frame).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(new Set(choices.map((c) => `${c.skin}/${c.preset ?? ""}`)).size).toBe(choices.length);
    // f3, f4, f7 are not behind a preset but stay available.
    expect(choices.some((c) => c.skin === "f3" && !c.preset)).toBe(true);
  });

  it("validates tints and names imported skins like nexus:saveSkin", () => {
    expect(isValidTint("#a0D0ff")).toBe(true);
    expect(isValidTint("a0d0ff")).toBe(false);
    expect(skinSlug("My Knight (v2).png")).toBe("my-knight-v2-png");
    expect(skinSlug("Élan")).toBe("elan");
    expect(skinSlug("!!!")).toBe("skin");
    expect(skinSlug("x".repeat(60))).toHaveLength(40);
  });
});

describe("spritesheet import", () => {
  it("detects AI Town's own layout", () => {
    const d = detectLayout(96, 128);
    expect(d.layout).toEqual({ frameW: 32, frameH: 32, originX: 0, originY: 0, framesPerDir: 3, rows: { down: 0, left: 1, right: 2, up: 3 } });
    expect(d.blocks).toHaveLength(1);
    expect(d.notes).toEqual([]);
  });

  it("finds the characters of a multi-character sheet", () => {
    const d = detectLayout(384, 256); // like 32x32folk.png: 4 x 2 characters
    expect(d.blocks).toHaveLength(8);
    expect(d.blocks[5]).toEqual({ x: 96, y: 128 });
    expect(d.notes.join(" ")).toMatch(/8 characters/);
  });

  it("guesses a grid for odd sizes and says so", () => {
    const d = detectLayout(90, 120);
    expect(d.layout.frameW).toBe(30);
    expect(d.layout.frameH).toBe(30);
    expect(d.notes.join(" ")).toMatch(/guessed 30x30/);
    // No square grid with 4 rows: 3 x 4 frames are guessed instead.
    expect(detectLayout(96, 72).layout).toMatchObject({ frameW: 32, frameH: 18, rows: { up: 3 } });
  });

  it("builds PIXI spritesheet data and catches layouts outside the image", () => {
    const l = { ...detectLayout(384, 256).layout, originX: 96, originY: 128 };
    expect(frameRect(l, "right", 2)).toEqual({ x: 160, y: 192, w: 32, h: 32 });
    const data = buildSpritesheetData(l);
    expect(data.animations.down).toEqual(["down", "down2", "down3"]);
    expect(data.frames.up3.frame).toEqual({ x: 160, y: 224, w: 32, h: 32 });
    expect(data.meta.scale).toBe("1");
    expect(layoutErrors(l, 384, 256)).toEqual([]);
    expect(layoutErrors({ ...l, originX: 320 }, 384, 256).length).toBeGreaterThan(0);
    expect(layoutErrors({ ...l, frameW: 4 }, 384, 256)).toContain("Frames must be 8 to 256 px.");
  });
});

describe("local AI Town backend", () => {
  const ok = (value: unknown) => new Response(JSON.stringify({ status: "success", value }), { status: 200 });

  it("uploads a skin: upload URL, file, saveSkin", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
      if (u.endsWith("/api/mutation") && calls.length === 1) return ok("http://127.0.0.1:3210/upload/abc");
      if (u.includes("/upload/")) return new Response(JSON.stringify({ storageId: "st1" }), { status: 200 });
      return ok("nexus-skin:knight");
    }) as unknown as typeof fetch;
    const file = new Blob([new Uint8Array([137, 80])], { type: "image/png" });
    const data = buildSpritesheetData(detectLayout(96, 128).layout);
    const id = await uploadSkin("http://127.0.0.1:3210/", file, { name: "knight", label: "Knight", spritesheetData: data, speed: 0.1 }, f);
    expect(id).toBe("nexus-skin:knight");
    expect(calls[0]).toEqual({ url: "http://127.0.0.1:3210/api/mutation", body: { path: "nexus:generateSkinUploadUrl", args: {}, format: "json" } });
    expect(calls[1].url).toBe("http://127.0.0.1:3210/upload/abc");
    expect(calls[2].body).toMatchObject({ path: "nexus:saveSkin", args: { name: "knight", label: "Knight", storageId: "st1", speed: 0.1 } });
  });

  it("reports backend errors", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ status: "error", errorMessage: "Skin names use lowercase letters" }), { status: 400 })) as unknown as typeof fetch;
    await expect(listImportedSkins("http://127.0.0.1:3210", "w1", f)).rejects.toThrow("Skin names use lowercase letters");
  });
});
