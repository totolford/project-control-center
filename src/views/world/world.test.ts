import { describe, expect, it } from "vitest";
import { makeAgent } from "../../test/fixtures";
import type { WorldAnalysis } from "../../lib/types";
import { addAgentCharacter, agentsWithoutCharacter, mergeCharacters, parseCsv, removeCharacter, slugify, uniqueId, unlinkAll, updateCharacter } from "./characters";
import { makeCharacter, makeWorld } from "./fixtures";
import { applyFrame, mergeEvents, newestFirst } from "./frames";
import { avatarRadius, fitViewport, frameProgress, hitTest, interpolate, toCanvas, toPointMap, toWorld, truncate } from "./geometry";
import { characterRing, initials, isLiveMode, liveAgent, spriteFill, TONE_COLOR, CANVAS_COLORS } from "./status";
import { buildSpec, defaultInfrastructure, initialWizard, validateStep, withProvider } from "./wizard";

describe("geometry", () => {
  it("fits the world uniformly and centers it", () => {
    const v = fitViewport(42, 23, 420 + 20, 400 + 20, 10);
    expect(v.scale).toBeCloseTo(10);
    expect(v.ox).toBeCloseTo(10);
    expect(v.oy).toBeCloseTo((420 - 230) / 2);
    const [x, y] = toCanvas(v, 21, 11.5);
    expect(toWorld(v, x, y)).toEqual([21, 11.5]);
  });

  it("interpolates between frames and places new characters directly", () => {
    const prev = toPointMap([{ id: "a", x: 0, y: 0 }]);
    const out = interpolate(prev, [{ id: "a", x: 10, y: 4 }, { id: "b", x: 3, y: 3 }], 0.5);
    expect(out).toEqual([{ id: "a", x: 5, y: 2 }, { id: "b", x: 3, y: 3 }]);
  });

  it("clamps frame progress", () => {
    expect(frameProgress(1000, 1000, 500)).toBe(0);
    expect(frameProgress(1250, 1000, 500)).toBe(0.5);
    expect(frameProgress(9000, 1000, 500)).toBe(1);
    expect(frameProgress(10, 0, 0)).toBe(1);
  });

  it("hit-tests the closest character within the radius", () => {
    const pts = [{ id: "a", x: 10, y: 10 }, { id: "b", x: 16, y: 10 }];
    expect(hitTest(pts, 14, 10, 8)).toBe("b");
    expect(hitTest(pts, 50, 50, 8)).toBeNull();
  });

  it("truncates text and bounds the avatar radius", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(avatarRadius({ scale: 100, ox: 0, oy: 0 }, false)).toBe(15);
    expect(avatarRadius({ scale: 1, ox: 0, oy: 0 }, true)).toBe(6);
  });
});

describe("status", () => {
  const agents = [makeAgent("w1", { status: "working" }), makeAgent("w2", { status: "crashed" })];

  it("rings follow the real agent status only in live modes", () => {
    const c = makeCharacter("c", { nexusAgent: "w1" });
    expect(characterRing(c, "hybrid", agents)).toEqual({ color: TONE_COLOR.green, pulse: true, label: "Working", live: true });
    expect(characterRing(makeCharacter("d", { nexusAgent: "w2" }), "real_execution", agents).color).toBe(TONE_COLOR.red);
    expect(characterRing(c, "simulation", agents)).toMatchObject({ live: false, pulse: false, color: CANVAS_COLORS.neutralRing });
    expect(characterRing(makeCharacter("e"), "hybrid", agents).label).toMatch(/simulated/);
    expect(characterRing(makeCharacter("f", { nexusAgent: "gone" }), "hybrid", agents).label).toBe("Linked agent not found");
  });

  it("exposes the live agent only when linked and live", () => {
    const c = makeCharacter("c", { nexusAgent: "w1" });
    expect(liveAgent(c, "hybrid", agents)?.id).toBe("w1");
    expect(liveAgent(c, "simulation", agents)).toBeUndefined();
    expect(isLiveMode("real_execution")).toBe(true);
  });

  it("derives initials and sprite fills", () => {
    expect(initials("Central")).toBe("CE");
    expect(initials("ui-builder agent")).toBe("UB");
    expect(initials("  ")).toBe("?");
    expect(spriteFill("f9")).toBe(spriteFill("f1"));
  });
});

describe("frames", () => {
  const e = (ts: string, text: string) => ({ ts, character: null, text });

  it("merges repeated frame events once and caps the list", () => {
    const base = [e("1", "a"), e("2", "b")];
    expect(mergeEvents(base, [e("2", "b"), e("3", "c")])).toEqual([...base, e("3", "c")]);
    expect(mergeEvents(base, [e("2", "b")])).toBe(base);
    expect(mergeEvents(base, [e("3", "c")], 2)).toEqual([e("2", "b"), e("3", "c")]);
  });

  it("applies newer frames and ignores stale ones", () => {
    const w = makeWorld({ tick: 10, running: false });
    const chars = [makeCharacter("a", { x: 3 })];
    const next = applyFrame(w, { tick: 11, running: true, mode: "hybrid", characters: chars, events: [e("1", "moved"), e("2", "b"), e("3", "c"), e("4", "d"), e("5", "e"), e("6", "f")], conversations: null });
    expect(next).toMatchObject({ tick: 11, running: true, characters: chars, conversations: [] });
    expect(next.events).toHaveLength(6);
    expect(applyFrame(w, { tick: 9, running: true, mode: "simulation", characters: chars, events: [], conversations: null })).toBe(w);
    expect(applyFrame(w, { tick: 10, running: false, mode: "hybrid", characters: chars, events: [], conversations: null })).toBe(w);
  });

  it("accepts same-tick control frames (pause, mode, conversations)", () => {
    const w = makeWorld({ tick: 10, running: true, mode: "hybrid" });
    const base = { tick: 10, running: true, mode: "hybrid" as const, characters: w.characters, events: [], conversations: null };
    expect(applyFrame(w, { ...base, running: false }).running).toBe(false);
    expect(applyFrame(w, { ...base, mode: "simulation" }).mode).toBe("simulation");
    const conv = { id: "c1", participants: ["a", "b"], room: null, lines: [], origin: "real", startedAt: "1" };
    expect(applyFrame(w, { ...base, conversations: [conv] }).conversations).toEqual([conv]);
  });

  it("sorts newest first", () => {
    expect(newestFirst([e("1", "a"), e("3", "c"), e("2", "b")], 2).map((x) => x.text)).toEqual(["c", "b"]);
  });
});

describe("characters", () => {
  it("slugs and de-duplicates ids", () => {
    expect(slugify("Élise Ü-Builder!")).toBe("elise-u-builder");
    expect(slugify("!!!")).toBe("character");
    expect(uniqueId("Ann", new Set(["ann", "ann-2"]))).toBe("ann-3");
  });

  it("merges, edits, unlinks and removes characters", () => {
    const a = makeCharacter("ann", { name: "Ann", nexusAgent: "w1" });
    const b = makeCharacter("bob", { name: "Bob", relationships: [{ with: "Ann", kind: "friend" }] });
    const merged = mergeCharacters([a, b], [makeCharacter("ann", { name: "Ann" })]);
    expect(merged.map((c) => c.id)).toEqual(["ann", "bob", "ann-2"]);
    expect(updateCharacter(merged, "bob", { autonomy: "high" })[1].autonomy).toBe("high");
    expect(unlinkAll([a])[0].nexusAgent).toBeNull();
    const removed = removeCharacter([a, b], "ann");
    expect(removed).toHaveLength(1);
    expect(removed[0].relationships).toEqual([]);
  });

  it("finds agents without a character and adds one at the gate", () => {
    const agents = [makeAgent("w1"), makeAgent("w2"), makeAgent("w3", { status: "retired" })];
    const world = makeWorld({ characters: [makeCharacter("ann", { nexusAgent: "w1" })] });
    expect(agentsWithoutCharacter(agents, world.characters).map((a) => a.id)).toEqual(["w2"]);
    const mapped = [makeCharacter("w2", { nexusAgent: "w2", x: 1, y: 1, room: "lounge" })];
    const next = addAgentCharacter(world, mapped, "w2")!;
    expect(next.characters[1]).toMatchObject({ nexusAgent: "w2", x: 38, y: 19, room: null });
    expect(addAgentCharacter(world, mapped, "missing")).toBeNull();
  });

  it("parses comma lists", () => {
    expect(parseCsv(" a, b ,, c ")).toEqual(["a", "b", "c"]);
  });
});

describe("wizard", () => {
  const analysis: WorldAnalysis = {
    projectTypes: ["node"],
    agents: [],
    providers: [],
    recommendedProvider: "nexus_native",
    reason: "",
    existingWorld: false,
  };

  it("pre-fills recommended defaults", () => {
    const s = initialWizard("Drone", analysis, [makeCharacter("c", { nexusAgent: "w1" })]);
    expect(s).toMatchObject({ provider: "nexus_native", mode: "hybrid", name: "Drone Town", targetDir: "" });
    expect(s.infrastructure).toEqual(defaultInfrastructure("nexus_native"));
    // The integrated AI Town (and the removed fork / export providers) is not a wizard choice.
    expect(initialWizard("", { ...analysis, recommendedProvider: "ai_town" }).provider).toBe("nexus_native");
    expect(initialWizard("", { ...analysis, recommendedProvider: "ai_town_compatible" }).provider).toBe("nexus_native");
  });

  it("resets provider-specific fields when switching", () => {
    const s = withProvider({ ...initialWizard("P", analysis), targetDir: "D:/x" }, "custom");
    expect(s).toMatchObject({ provider: "custom", targetDir: "D:/x" });
    expect(s.infrastructure.backend).toBe("Your world project");
    expect(withProvider(s, "nexus_native")).toMatchObject({ targetDir: "" });
  });

  it("validates each step", () => {
    const s = initialWizard("P", undefined, []);
    expect(validateStep("agents", s).errors).toContain("Add at least one character.");
    expect(validateStep("world", { ...s, name: " ", speed: 9 }).errors).toHaveLength(2);
    expect(validateStep("architecture", withProvider(s, "custom")).errors).toHaveLength(1);
    const dup = { ...s, characters: [makeCharacter("a", { name: "Ann" }), makeCharacter("b", { name: "ann" })] };
    expect(validateStep("characters", dup).errors[0]).toMatch(/Two characters/);
    expect(validateStep("agents", dup).warnings[0]).toMatch(/No character is linked/);
    expect(validateStep("agents", { ...dup, mode: "simulation" }).warnings).toEqual([]);
  });

  it("builds a clean spec", () => {
    const s = {
      ...initialWizard("P", analysis, [makeCharacter("a", { name: " Ann ", goals: ["x", " "], relationships: [{ with: "", kind: "k" }] })]),
      rules: ["be nice", ""],
    };
    const spec = buildSpec(s);
    expect(spec).toMatchObject({ name: "P Town", rules: ["be nice"], targetDir: null, provider: "nexus_native" });
    expect(spec.characters[0]).toMatchObject({ name: "Ann", goals: ["x"], relationships: [] });
    expect(buildSpec({ ...withProvider(s, "custom"), targetDir: "D:/town" }).targetDir).toBe("D:/town");
    expect(buildSpec({ ...s, targetDir: "D:/town" }).targetDir).toBeNull();
  });
});
