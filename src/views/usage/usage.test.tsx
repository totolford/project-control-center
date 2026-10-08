import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { UsageDay, UsageRecord, UsageSummary } from "../../lib/usageTypes";
import { useStore } from "../../store";
import {
  dayLocalShare,
  fillDays,
  formatMoney,
  formatPercent,
  formatTokens,
  isEmpty,
  niceMax,
  parseRate,
  periodSince,
} from "./usageLogic";
import { UsageView } from "./UsageView";
import { UsageBlock } from "./UsageBlock";

const day = (d: string, over: Partial<UsageDay> = {}): UsageDay => ({
  day: d,
  requests: 1,
  claudeRequests: 1,
  localRequests: 0,
  claudeTokens: 100,
  localTokens: 0,
  costUsd: 0.01,
  ...over,
});

const summary: UsageSummary = {
  requests: 3,
  claudeRequests: 2,
  localRequests: 1,
  claudeTokens: 1500,
  localTokens: 500,
  totalTokens: 2000,
  inputTokens: 800,
  outputTokens: 1200,
  cachedTokens: 0,
  requestsWithoutTokens: 1,
  claudeCostReportedUsd: 0.25,
  cloudCostEstimatedUsd: 0.25,
  cloudRequestsWithoutCost: 0,
  localCostUsd: 0,
  avoided: {
    label: "Estimated tokens avoided",
    tokens: 500,
    moneyUsd: 0.003,
    requests: 1,
    referenceModel: "claude-sonnet-5-5",
    method: "estimate",
    priceSource: "list prices",
  },
  avgLatencyMs: 1500,
  localShare: 0.25,
  days: [day("2026-10-07", { localTokens: 500, localRequests: 1, requests: 3, claudeRequests: 2, claudeTokens: 1500 })],
  byAgent: [{ key: "central", requests: 2, tokens: 1500, claudeTokens: 1500, localTokens: 0, costUsd: 0.25 }],
  byMission: [],
  byModel: [{ key: "claude-opus-5-5", requests: 2, tokens: 1500, claudeTokens: 1500, localTokens: 0, costUsd: 0.25 }],
  byCategory: [{ key: "central_agent", requests: 2, tokens: 1500, claudeTokens: 1500, localTokens: 0, costUsd: 0.25 }],
  priceSource: "Anthropic API list prices",
};

const record: UsageRecord = {
  id: 1,
  ts: "2026-10-07T10:00:00.000Z",
  provider: "claude",
  model: "claude-opus-5-5",
  agentId: "central",
  missionId: null,
  taskId: null,
  category: "central_agent",
  source: "session",
  inputTokens: 10,
  outputTokens: null,
  totalTokens: 10,
  cachedTokens: 3000,
  cacheCreationTokens: 0,
  reasoningTokens: null,
  costUsd: 0.25,
  costSource: "reported",
  latencyMs: 1500,
  local: false,
  routeRule: null,
};

let current: UsageSummary = summary;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(
      cmd === "usage_summary"
        ? current
        : cmd === "usage_records"
          ? [record]
          : cmd === "usage_prices"
            ? { source: "list", avoidedReferenceModel: "claude-sonnet-5-5", prices: [] }
            : null,
    ),
  ),
}));

afterEach(() => {
  cleanup();
  current = summary;
});

describe("usage logic", () => {
  it("computes period starts in local time", () => {
    // Wednesday 7 October 2026, 15:00 local.
    const now = new Date(2026, 9, 7, 15, 0);
    expect(new Date(periodSince("today", now)!).getDate()).toBe(7);
    const week = new Date(periodSince("week", now)!);
    expect(week.getDay()).toBe(1);
    expect(week.getDate()).toBe(5);
    expect(new Date(periodSince("month", now)!).getDate()).toBe(1);
    expect(periodSince("all", now)).toBeNull();
    // Sunday belongs to the week that started on Monday.
    expect(new Date(periodSince("week", new Date(2026, 9, 11, 9))!).getDate()).toBe(5);
  });

  it("fills missing days with zeros up to today", () => {
    const now = new Date(2026, 9, 7, 12);
    const days = fillDays([day("2026-10-06")], "week", now);
    expect(days.map((d) => d.day)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(days[0].requests).toBe(0);
    expect(days[1].claudeTokens).toBe(100);
    const all = fillDays([day("2026-10-01")], "all", now);
    expect(all).toHaveLength(7);
    expect(fillDays([], "all", now)).toHaveLength(1);
    expect(fillDays([day("2025-01-01")], "all", now, 30)).toHaveLength(30);
  });

  it("formats unknown values as N/A, never as zero", () => {
    expect(formatTokens(null)).toBe("N/A");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
    expect(formatPercent(null)).toBe("N/A");
    expect(formatPercent(0.255)).toBe("25.5%");
    expect(formatMoney(null)).toBe("N/A");
    expect(dayLocalShare(day("x", { claudeTokens: 0 }))).toBeNull();
    expect(dayLocalShare(day("x", { claudeTokens: 300, localTokens: 100 }))).toBe(0.25);
    expect(isEmpty({ ...summary, requests: 0 })).toBe(true);
  });

  it("converts to euros only with the user's rate", () => {
    expect(formatMoney(2, { code: "USD", rate: 0.9 })).toBe("$2.00");
    expect(formatMoney(2, { code: "EUR", rate: 0.5 })).toBe("1.00 €");
    // No rate: stays in USD rather than inventing one.
    expect(formatMoney(2, { code: "EUR", rate: null })).toBe("$2.00");
    expect(formatMoney(0.0123)).toBe("$0.0123");
    expect(parseRate("0,92")).toBe(0.92);
    expect(parseRate("abc")).toBeNull();
    expect(parseRate("-1")).toBeNull();
  });

  it("rounds axis maxima", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(1800)).toBe(2000);
    expect(niceMax(2100)).toBe(2500);
  });
});

describe("AI Usage page", () => {
  it("asks for a project when none is open", () => {
    useStore.setState({ project: null });
    render(<UsageView />);
    expect(screen.getByText("Open a project to see its AI usage.")).toBeTruthy();
  });

  it("shows real figures, labelled estimates and the unmeasured category", async () => {
    useStore.setState({ project: {} as never });
    render(<UsageView />);
    await screen.findByText("Estimated tokens avoided");
    expect(screen.getByText("Estimated money avoided")).toBeTruthy();
    expect(screen.getByText("Estimated cloud cost")).toBeTruthy();
    expect(screen.getByText("Local AI cost")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("AI Town townspeople")).toBeTruthy();
    expect(screen.getByText("Not measured")).toBeTruthy();
    expect(screen.getByText("Requests without token counts (N/A): 1")).toBeTruthy();
    // The output tokens of the record were not exposed.
    expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_summary", expect.objectContaining({ filter: expect.objectContaining({ since: expect.any(String) }) }));
    fireEvent.click(screen.getByRole("radio", { name: "All time" }));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_summary", expect.objectContaining({ filter: { since: null } })),
    );
  });

  it("explains an empty project", async () => {
    current = { ...summary, requests: 0, days: [] };
    useStore.setState({ project: {} as never });
    render(<UsageView />);
    await screen.findByText("No AI usage recorded yet");
  });

  it("mission block reads the mission's usage", async () => {
    useStore.setState({ project: {} as never });
    render(<UsageBlock missionId="M-0001" />);
    await screen.findByText("Claude tokens");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_summary", expect.objectContaining({ filter: { mission: "M-0001", agent: null } }));
  });
});
