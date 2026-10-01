import { describe, expect, it } from "vitest";
import { contextUsage, currentOptionValue, effortLevels, humanize, maskAccount, mcpConnectedCount, modelField, modelFlags, percentRatio, rateLimits } from "./claudeEnv";
import type { ClaudeEnvironment, Connection } from "./types";

describe("usage readers", () => {
  it("reads documented rate-limit windows only, 5h and 7d first", () => {
    const limits = rateLimits({
      rate_limits: {
        seven_day_opus: { utilization: 3, resets_at: null },
        seven_day: { utilization: 40.5, resets_at: "2026-10-05T00:00:00Z" },
        five_hour: { utilization: 12, resets_at: "2026-10-01T15:00:00Z" },
        extra: { other: 1 },
        iguana_necktie: { utilization: 0, resets_at: null },
      },
    });
    expect(limits.map((l) => l.key)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(limits[0]).toMatchObject({ label: "5-hour window", percent: 12, resetsAt: "2026-10-01T15:00:00Z" });
    expect(limits[2].label).toBe("7-day window · Opus");
    expect(rateLimits(null)).toEqual([]);
  });

  it("reads context usage and derives the percentage only from real totals", () => {
    const c = contextUsage({ totalTokens: 50, maxTokens: 200, categories: [{ name: "System prompt", tokens: 30, kind: "system" }] });
    expect(c?.percent).toBe(25);
    expect(c?.categories[0]).toEqual({ name: "System prompt", tokens: 30, kind: "system" });
    expect(contextUsage({ categories: [] })?.percent).toBeNull();
    expect(contextUsage(null)).toBeNull();
    expect(percentRatio(150)).toBe(1);
  });
});

describe("model readers", () => {
  it("returns declared effort levels, [] when unsupported, null when unknown", () => {
    expect(effortLevels({ supportsEffort: true, supportedEffortLevels: ["low", "high"] })).toEqual(["low", "high"]);
    expect(effortLevels({ supportsEffort: false })).toEqual([]);
    expect(effortLevels({ value: "x" })).toBeNull();
  });

  it("lists unknown boolean fields as flags and finds optional fields", () => {
    expect(modelFlags({ value: "x", supportsEffort: true, supportsFastMode: false, supportsAdaptiveThinking: true })).toEqual([
      { key: "supportsFastMode", label: "Fast mode", value: false },
      { key: "supportsAdaptiveThinking", label: "Adaptive thinking", value: true },
    ]);
    expect(modelField({ contextWindow: 200000 }, /context/i)).toBe("200000");
    expect(modelField({ value: "x" }, /cost|price/i)).toBeNull();
    expect(humanize("five_hour")).toBe("Five hour");
  });
});

describe("MCP and settings", () => {
  it("counts connected servers, or null when MCP status is unavailable", () => {
    const env = { mcpServers: [{ status: "connected" }, { status: "failed" }], unavailable: [] } as unknown as ClaudeEnvironment;
    const conns = [
      { kind: "mcp", enabled: true, status: "connected" },
      { kind: "mcp", enabled: false, status: "connected" },
      { kind: "ssh", enabled: true, status: "connected" },
    ] as Connection[];
    expect(mcpConnectedCount(env, conns)).toEqual({ claude: 1, nexus: 1 });
    expect(mcpConnectedCount({ ...env, unavailable: ["MCP status: timeout"] }, conns).claude).toBeNull();
    expect(mcpConnectedCount(null, []).claude).toBeNull();
  });

  it("derives current option values from effective settings", () => {
    const settings = { effective: { model: "opus", effortLevel: "high", permissions: { defaultMode: "plan" } } };
    expect(currentOptionValue({ long: "--model" }, settings)).toBe("opus");
    expect(currentOptionValue({ long: "--effort" }, settings)).toBe("high");
    expect(currentOptionValue({ long: "--permission-mode" }, settings)).toBe("plan");
    expect(currentOptionValue({ long: "--verbose" }, settings)).toBeNull();
    expect(currentOptionValue({ long: "--model" }, null)).toBeNull();
  });
});

describe("account masking", () => {
  it("hides e-mail addresses everywhere but keeps other fields", () => {
    const m = maskAccount({ email: "someone@example.com", organization: "someone@example.com's Organization", subscriptionType: "Claude Pro" });
    expect(m).toEqual({ email: "s••••@example.com", organization: "s••••@example.com's Organization", subscriptionType: "Claude Pro" });
    expect(maskAccount(null)).toBeNull();
  });
});
