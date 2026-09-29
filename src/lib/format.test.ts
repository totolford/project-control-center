import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatClock,
  formatCost,
  formatDuration,
  formatRelative,
  normalizeProgress,
  parseKeyValueLines,
  parseLines,
  ratio,
  truncate,
} from "./format";
import { mergeLogs } from "./logBus";
import type { LogEntry } from "./types";

describe("format helpers", () => {
  it("formats clock time in local time", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    expect(formatClock(d.toISOString())).toBe("03:04:05");
    expect(formatClock(null)).toBe("");
    expect(formatClock("garbage")).toBe("");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(formatRelative("2026-01-01T11:59:58Z", now)).toBe("just now");
    expect(formatRelative("2026-01-01T11:59:15Z", now)).toBe("45s ago");
    expect(formatRelative("2026-01-01T11:55:00Z", now)).toBe("5m ago");
    expect(formatRelative("2026-01-01T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelative("2025-12-30T12:00:00Z", now)).toBe("2d ago");
    expect(formatRelative(null, now)).toBe("never");
  });

  it("formats durations", () => {
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:42Z")).toBe("42s");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:04:12Z")).toBe("4m 12s");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T02:05:00Z")).toBe("2h 5m");
  });

  it("truncates and collapses whitespace", () => {
    expect(truncate("hello   world", 50)).toBe("hello world");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate(null, 5)).toBe("");
  });

  it("formats costs and sizes", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("computes ratios and normalizes progress", () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(0, 0)).toBeNull();
    expect(normalizeProgress(0.5)).toBe(0.5);
    expect(normalizeProgress(40)).toBe(0.4);
    expect(normalizeProgress(null)).toBeNull();
  });

  it("parses KEY=VALUE and line lists", () => {
    expect(parseKeyValueLines("A=1\n\nB = two=2\r\ninvalid\n=x")).toEqual({ A: "1", B: "two=2" });
    expect(parseLines(" --stdio \n\n--port\n 3000")).toEqual(["--stdio", "--port", "3000"]);
  });
});

describe("mergeLogs", () => {
  const log = (id: number): LogEntry => ({ id, agentId: "a", sessionId: 1, ts: "", kind: "system", text: String(id) });
  it("merges sorted lists and removes duplicates", () => {
    expect(mergeLogs([log(1), log(3)], [log(2), log(3), log(4)]).map((l) => l.id)).toEqual([1, 2, 3, 4]);
    const a = [log(1)];
    expect(mergeLogs(a, [])).toBe(a);
  });
});
