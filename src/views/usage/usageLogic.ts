// Pure logic of the AI Usage page: periods, formatting, chart series.

import type { UsageDay, UsageSummary } from "../../lib/usageTypes";

export type Period = "today" | "week" | "month" | "all";
export const PERIODS: Period[] = ["today", "week", "month", "all"];

/** Start of the period in the viewer's local time, as an RFC 3339 UTC string (null = all time). */
export function periodSince(period: Period, now: Date = new Date()): string | null {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "all") return null;
  if (period === "week") {
    // Weeks start on Monday.
    const back = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - back);
  } else if (period === "month") {
    d.setDate(1);
  }
  return d.toISOString();
}

/** Offset of local time east of UTC, in minutes (the backend's day buckets). */
export function tzOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset();
}

/** Local calendar day `YYYY-MM-DD`. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const EMPTY_DAY = { requests: 0, claudeRequests: 0, localRequests: 0, claudeTokens: 0, localTokens: 0, costUsd: 0 };

/**
 * Continuous day series for the charts: every day from the period start (or the
 * first recorded day for "all") to today, days without requests at zero.
 * At most `maxDays` (the most recent) are kept.
 */
export function fillDays(days: UsageDay[], period: Period, now: Date = new Date(), maxDays = 62): UsageDay[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const since = periodSince(period, now);
  let start: Date;
  if (since) start = new Date(since);
  else if (days.length) {
    const [y, m, dd] = days[0].day.split("-").map(Number);
    start = new Date(y, m - 1, dd);
  } else start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out: UsageDay[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const end = localDay(now);
  for (let i = 0; i < 4000; i++) {
    const key = localDay(cur);
    out.push(byDay.get(key) ?? { day: key, ...EMPTY_DAY });
    if (key >= end) break;
    cur.setDate(cur.getDate() + 1);
  }
  return out.slice(-maxDays);
}

/** Token counts: "N/A" when the provider did not expose them. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export interface Currency {
  /** "USD" or "EUR" (EUR only with a user-set rate). */
  code: "USD" | "EUR";
  /** EUR per USD, set by the user. */
  rate: number | null;
}

export const USD: Currency = { code: "USD", rate: null };

/** Money: USD as reported; EUR only through the user's own rate (no live rate is fetched). */
export function formatMoney(usd: number | null | undefined, c: Currency = USD): string {
  if (usd === null || usd === undefined) return "N/A";
  const eur = c.code === "EUR" && c.rate !== null && c.rate > 0;
  const v = eur ? usd * (c.rate as number) : usd;
  const digits = v !== 0 && Math.abs(v) < 1 ? 4 : 2;
  return eur ? `${v.toFixed(digits)} €` : `$${v.toFixed(digits)}`;
}

/** Parses a user-typed rate ("0.92", "0,92"); null when invalid. */
export function parseRate(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
}

export function formatPercent(share: number | null | undefined): string {
  if (share === null || share === undefined) return "N/A";
  return `${Math.round(share * 1000) / 10}%`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "N/A";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Clean axis maximum (1, 2, 2.5, 5 × 10ⁿ) at or above `v`. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * exp >= v) return m * exp;
  }
  return 10 * exp;
}

/** Local share of a day's tokens (null when the day has none). */
export function dayLocalShare(d: UsageDay): number | null {
  const total = d.claudeTokens + d.localTokens;
  return total > 0 ? d.localTokens / total : null;
}

/** The summary has nothing recorded yet. */
export function isEmpty(s: UsageSummary | null | undefined): boolean {
  return !s || s.requests === 0;
}

/** Categories that exist but NEXUS cannot measure (shown as "Not measured" with the reason, never hidden). */
export const NOT_MEASURED = ["ai_town_townspeople"] as const;

/** Category rows of the page: measured categories in a fixed order. */
export const CATEGORY_ORDER = [
  "central_agent",
  "production_agent",
  "background_agent",
  "ai_world",
  "agent_conversation",
  "embedding",
] as const;
