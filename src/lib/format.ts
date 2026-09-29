// Pure formatting helpers shared by all views.

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "HH:MM:SS" in local time; empty string for invalid input. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local date + time, e.g. "2026-09-29 14:03". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Relative time such as "just now", "5m ago", "3h ago", "2d ago". */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.round((now - t) / 1000);
  if (s < 0) return "just now";
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return formatDateTime(iso).slice(0, 10);
}

/** Duration between two timestamps, e.g. "4m 12s". */
export function formatDuration(startIso: string, endIso: string | null, now: number = Date.now()): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  let s = Math.max(0, Math.round((end - start) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, Math.max(0, max - 1))}…` : single;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Progress ratio in [0, 1], or null when there is nothing to measure. */
export function ratio(done: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, done / total));
}

/** Agent/task progress values may be 0..1 or 0..100; normalizes to 0..1. */
export function normalizeProgress(p: number | null | undefined): number | null {
  if (p == null || Number.isNaN(p)) return null;
  const v = p > 1 ? p / 100 : p;
  return Math.min(1, Math.max(0, v));
}

/** Parses "KEY=VALUE" lines; ignores blank lines and lines without "=". */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
