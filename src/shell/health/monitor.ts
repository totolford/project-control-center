// Renderer health accounting (pure, tested): frame stalls, errors, IPC failures, memory.
// The hook in useRendererHealth.ts feeds it; the overlay and the top-bar indicator read it.

import type { RendererReport } from "../../lib/types";

export type HealthLevel = "green" | "amber" | "red";

export const HEALTH = {
  /** A gap between two animation frames longer than this (page visible) is a stall. */
  stallMs: 2000,
  /** One stall this long is enough to call the interface degraded. */
  severeStallMs: 10_000,
  /** Window over which errors and stalls are counted. */
  windowMs: 120_000,
  /** Render errors (contained by error boundaries) within the window → degraded. */
  degradedRenderErrors: 3,
  /** Stalls within the window → degraded. */
  degradedStalls: 3,
  /** Consecutive failed heartbeats → the engine connection (IPC) is lost. */
  ipcLostFailures: 3,
  /** Failed backend calls within the window before the indicator turns amber. */
  amberInvokeErrors: 5,
  /** JS heap use above this share of the limit → amber. */
  amberHeapRatio: 0.85,
} as const;

/** Benign browser noise that must not count as an interface failure. */
const IGNORED_ERRORS = [/ResizeObserver loop/i];

export function isIgnoredError(message: string): boolean {
  return IGNORED_ERRORS.some((r) => r.test(message));
}

export interface HealthSignal {
  level: HealthLevel;
  /** Why the interface is degraded (shows the Safe Recovery Overlay); null when it is not. */
  degraded: string | null;
  /** Short explanations of the amber/red state, most important first. */
  notes: string[];
}

export class RendererHealth {
  private renderErrors: number[] = [];
  private windowErrors: number[] = [];
  private rejections: number[] = [];
  private stalls: { at: number; ms: number }[] = [];
  private invokeErrorsAt: number[] = [];
  private aiWorldErrorsAt: number[] = [];
  private lastFrame: number | null = null;
  private lastFrameVisible = true;
  totals = { renderErrors: 0, windowErrors: 0, rejections: 0, stalls: 0, invokeCalls: 0, invokeErrors: 0, aiWorldErrors: 0 };
  longestStallMs = 0;
  heartbeatFailures = 0;
  lastHeartbeatOk: number | null = null;
  lastError: string | null = null;
  heap: { used: number; limit: number } | null = null;

  constructor(private readonly config = HEALTH) {}

  private recent(list: number[], now: number): number {
    const from = now - this.config.windowMs;
    while (list.length > 0 && list[0] < from) list.shift();
    return list.length;
  }

  private recentStalls(now: number) {
    const from = now - this.config.windowMs;
    while (this.stalls.length > 0 && this.stalls[0].at < from) this.stalls.shift();
    return this.stalls;
  }

  /** Call on every animation frame. Returns the stall duration when this frame ended one. */
  frame(now: number, visible: boolean): number | null {
    const prev = this.lastFrame;
    const prevVisible = this.lastFrameVisible;
    this.lastFrame = now;
    this.lastFrameVisible = visible;
    // Hidden pages get no frames: a gap across a visibility change is not a stall.
    if (prev === null || !visible || !prevVisible) return null;
    const gap = now - prev;
    if (gap < this.config.stallMs) return null;
    this.stalls.push({ at: now, ms: gap });
    this.totals.stalls += 1;
    this.longestStallMs = Math.max(this.longestStallMs, gap);
    return gap;
  }

  /** The page became hidden: the next frame starts a new measurement. */
  resetFrames(): void {
    this.lastFrame = null;
  }

  renderError(message: string, now: number): void {
    this.renderErrors.push(now);
    this.totals.renderErrors += 1;
    this.lastError = message;
  }

  windowError(message: string, now: number): boolean {
    if (isIgnoredError(message)) return false;
    this.windowErrors.push(now);
    this.totals.windowErrors += 1;
    this.lastError = message;
    return true;
  }

  rejection(message: string, now: number): boolean {
    if (isIgnoredError(message)) return false;
    this.rejections.push(now);
    this.totals.rejections += 1;
    this.lastError = message;
    return true;
  }

  invoke(ok: boolean, now: number): void {
    this.totals.invokeCalls += 1;
    if (ok) return;
    this.totals.invokeErrors += 1;
    this.invokeErrorsAt.push(now);
  }

  aiWorldError(message: string, now: number): void {
    this.aiWorldErrorsAt.push(now);
    this.totals.aiWorldErrors += 1;
    this.lastError = `AI World: ${message}`;
  }

  heartbeat(ok: boolean, now: number): void {
    if (ok) {
      this.heartbeatFailures = 0;
      this.lastHeartbeatOk = now;
    } else this.heartbeatFailures += 1;
  }

  setHeap(used: number | null, limit: number | null): void {
    this.heap = used !== null && limit !== null && limit > 0 ? { used, limit } : null;
  }

  ipcLost(): boolean {
    return this.heartbeatFailures >= this.config.ipcLostFailures;
  }

  signal(now: number): HealthSignal {
    const c = this.config;
    const renderErrors = this.recent(this.renderErrors, now);
    const windowErrors = this.recent(this.windowErrors, now) + this.recent(this.rejections, now);
    const stalls = this.recentStalls(now);
    const invokeErrors = this.recent(this.invokeErrorsAt, now);
    const aiWorld = this.recent(this.aiWorldErrorsAt, now);
    const severe = stalls.find((s) => s.ms >= c.severeStallMs);

    let degraded: string | null = null;
    if (this.ipcLost()) degraded = `Connection to the engine lost (${this.heartbeatFailures} heartbeats failed)`;
    else if (renderErrors >= c.degradedRenderErrors) degraded = `${renderErrors} views crashed in the last ${c.windowMs / 60000} minutes`;
    else if (severe) degraded = `The interface froze for ${(severe.ms / 1000).toFixed(1)} s`;
    else if (stalls.length >= c.degradedStalls) degraded = `${stalls.length} interface stalls in the last ${c.windowMs / 60000} minutes`;

    const notes: string[] = [];
    if (degraded) notes.push(degraded);
    if (!degraded && this.heartbeatFailures > 0) notes.push(`${this.heartbeatFailures} heartbeat(s) to the engine failed`);
    if (!degraded && renderErrors > 0) notes.push(`${renderErrors} view crash(es) contained`);
    if (!degraded && stalls.length > 0) notes.push(`${stalls.length} frame stall(s), longest ${(Math.max(...stalls.map((s) => s.ms)) / 1000).toFixed(1)} s`);
    if (windowErrors > 0) notes.push(`${windowErrors} script error(s)`);
    if (invokeErrors >= c.amberInvokeErrors) notes.push(`${invokeErrors} failed engine calls`);
    if (aiWorld > 0) notes.push(`${aiWorld} AI World connection error(s)`);
    if (this.heap && this.heap.used / this.heap.limit > c.amberHeapRatio)
      notes.push(`Interface memory at ${Math.round((this.heap.used / this.heap.limit) * 100)} % of its limit`);

    const level: HealthLevel = degraded ? "red" : notes.length > 0 ? "amber" : "green";
    return { level, degraded, notes };
  }

  report(now: number, visible: boolean, view: string | null): RendererReport {
    const s = this.signal(now);
    return {
      status: s.degraded ? "degraded" : "ok",
      visible,
      renderErrors: this.totals.renderErrors,
      windowErrors: this.totals.windowErrors,
      rejections: this.totals.rejections,
      stalls: this.totals.stalls,
      longestStallMs: Math.round(this.longestStallMs),
      invokeCalls: this.totals.invokeCalls,
      invokeErrors: this.totals.invokeErrors,
      heartbeatFailures: this.heartbeatFailures,
      aiWorldErrors: this.totals.aiWorldErrors,
      jsHeapUsed: this.heap?.used ?? null,
      jsHeapLimit: this.heap?.limit ?? null,
      lastError: this.lastError,
      view,
    };
  }
}

// ---------------------------------------------------------------- automatic reloads

/** Automatic reloads allowed within `windowMs` before the overlay waits for the user. */
export const AUTO_RELOAD_LIMIT = { count: 2, windowMs: 5 * 60_000 };

/** May the overlay reload the interface by itself, given the times of earlier automatic reloads? */
export function canAutoReload(history: number[], now: number, limit = AUTO_RELOAD_LIMIT): boolean {
  return history.filter((t) => now - t < limit.windowMs).length < limit.count;
}
