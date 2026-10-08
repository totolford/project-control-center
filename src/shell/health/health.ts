// Renderer health monitor (main window): heartbeat to the backend watchdog, frame-stall
// detection, script errors, contained view crashes, IPC failures, memory, AI World errors.
// A crash of the interface never stops the engine; this only decides when to reload it.

import { useEffect } from "react";
import { create } from "zustand";
import { api, errorMessage } from "../../lib/api";
import { toast } from "../../lib/toast";
import type { CoreStatus, RendererIncident } from "../../lib/types";
import { useRightContext } from "../../state/context";
import { useStore } from "../../store";
import { getBarText, setBarText } from "../UniversalBar";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint";
import { RendererHealth, type HealthSignal } from "./monitor";
import { t } from "../../i18n";

export const HEARTBEAT_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 8000;
/** "Keep working" in the overlay: no automatic overlay for this long. */
export const DISMISS_MS = 2 * 60_000;

/** The monitor of this window (one per page load). */
export const rendererHealth = new RendererHealth();

export interface OverlayState {
  reason: string;
  /** Reload by itself after a short countdown (false after repeated reloads). */
  auto: boolean;
  /** Opened by the user ("Reload interface") or by the root error boundary. */
  forced: boolean;
  /** Reload right away (the overlay only says what is preserved). */
  immediate?: boolean;
}

interface HealthState {
  signal: HealthSignal;
  overlay: OverlayState | null;
  dismissedUntil: number;
  /** Watchdog present in the backend (null until the first heartbeat answers). */
  watchdog: boolean | null;
  lastBeatAt: number | null;
  core: CoreStatus | null;
  coreAt: number | null;
  /** Last recovery reported by the backend (shown once as a toast). */
  recovered: RendererIncident | null;
  refreshSignal: () => void;
  openOverlay: (o: OverlayState) => void;
  dismissOverlay: () => void;
  setCore: (core: CoreStatus | null) => void;
}

export const useHealth = create<HealthState>((set) => ({
  signal: { level: "green", degraded: null, notes: [] },
  overlay: null,
  dismissedUntil: 0,
  watchdog: null,
  lastBeatAt: null,
  core: null,
  coreAt: null,
  recovered: null,
  refreshSignal: () => set({ signal: rendererHealth.signal(Date.now()) }),
  openOverlay: (overlay) => set({ overlay }),
  dismissOverlay: () => set({ overlay: null, dismissedUntil: Date.now() + DISMISS_MS }),
  setCore: (core) => set(core ? { core, coreAt: Date.now() } : { core: null }),
}));

/** Should the overlay open by itself now? */
export function shouldOpenOverlay(signal: HealthSignal, overlayOpen: boolean, dismissedUntil: number, now: number): boolean {
  return Boolean(signal.degraded) && !overlayOpen && now >= dismissedUntil;
}

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function currentReport() {
  return rendererHealth.report(Date.now(), visible(), useStore.getState().view.name);
}

// ---------------------------------------------------------------- checkpoint

export function saveUiCheckpoint(): void {
  const project = useStore.getState().project;
  if (!project) return;
  saveCheckpoint({ projectId: project.info.id, view: useStore.getState().view, right: useRightContext.getState().right, barText: getBarText() });
}

/** After a reload resynced the project from the backend: puts back what the user had open. */
export function restoreUiCheckpoint(): boolean {
  const project = useStore.getState().project;
  if (!project) return false;
  const cp = loadCheckpoint(project.info.id);
  if (!cp) return false;
  const agentGone = (id: string | undefined) => Boolean(id) && !project.agents.some((a) => a.id === id);
  if (cp.view.name !== "agent" || !agentGone(cp.view.agentId)) useStore.getState().navigate(cp.view);
  const right = cp.right;
  if (right.kind === "agent" && agentGone(right.agentId)) useRightContext.getState().resetContext();
  else if (right.kind === "mission" && !project.missions.some((m) => m.id === right.missionId)) useRightContext.getState().resetContext();
  else useRightContext.setState({ right });
  if (cp.barText && !getBarText()) setBarText(cp.barText);
  return true;
}

// ---------------------------------------------------------------- reload

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reloads the interface (never the engine): saves the UI checkpoint, asks the backend to reload
 * this window (so the incident is recorded), or reloads the page directly if the backend does not answer.
 */
export async function reloadInterface(kind: "manual" | "degraded", reason: string): Promise<void> {
  saveUiCheckpoint();
  try {
    await withTimeout(api.rendererReload(kind, reason, currentReport()), 3000);
  } catch {
    window.location.reload();
  }
}

/** Reports a crash contained by an error boundary (history + journal, best effort). */
export function reportRenderError(where: string, error: unknown): void {
  const message = `${where}: ${errorMessage(error)}`;
  rendererHealth.renderError(message, Date.now());
  useHealth.getState().refreshSignal();
  const stack = error instanceof Error && error.stack ? `\n${error.stack.split("\n").slice(0, 8).join("\n")}` : "";
  api.recordRendererIncident("viewCrash", message + stack, currentReport()).catch(() => undefined);
}

export async function fetchCoreStatus(): Promise<CoreStatus | null> {
  try {
    const core = await withTimeout(api.coreStatus(), 4000);
    useHealth.getState().setCore(core ?? null);
    return core ?? null;
  } catch {
    useHealth.getState().setCore(null);
    return null;
  }
}

// ---------------------------------------------------------------- probes

interface TauriInternals {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  __nexusHealth?: boolean;
}

/** Counts every backend call and its failures (Tauri's invoke entry point is wrapped once). */
function watchInvoke(): void {
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function" || internals.__nexusHealth) return;
    const original = internals.invoke.bind(internals);
    internals.invoke = (cmd, args, options) => {
      const p = original(cmd, args, options);
      p.then(
        () => rendererHealth.invoke(true, Date.now()),
        () => rendererHealth.invoke(false, Date.now()),
      );
      return p;
    };
    internals.__nexusHealth = true;
  } catch {
    // Not running in Tauri, or the object is sealed: IPC is then judged by heartbeats only.
  }
}

const watchedFrames = new WeakSet<Window>();
const CONNECTION_ERROR = /websocket|convex|connection (lost|closed)|failed to fetch/i;

/** Errors and connection failures (Convex WebSocket) inside the embedded AI World (same origin). */
function watchFrames(onError: (message: string) => void): void {
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try {
      const w = frame.contentWindow;
      if (!w || watchedFrames.has(w) || !w.document) continue;
      watchedFrames.add(w);
      w.addEventListener("error", (e) => onError(e.message || "script error"));
      w.addEventListener("unhandledrejection", (e) => onError(errorMessage(e.reason)));
      const con = (w as Window & typeof globalThis).console;
      for (const level of ["error", "warn"] as const) {
        const original = con[level].bind(con);
        con[level] = (...args: unknown[]) => {
          const text = args.map((a) => (typeof a === "string" ? a : errorMessage(a))).join(" ");
          if (CONNECTION_ERROR.test(text)) onError(text.slice(0, 300));
          original(...args);
        };
      }
    } catch {
      // Cross-origin or not loaded yet: nothing to watch.
    }
  }
}

function sampleHeap(): void {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  rendererHealth.setHeap(m?.usedJSHeapSize ?? null, m?.jsHeapSizeLimit ?? null);
}

/** Installs the monitor in the main window (once). */
export function useRendererHealth(): void {
  useEffect(() => {
    const health = useHealth.getState();
    const refresh = () => {
      health.refreshSignal();
      const s = useHealth.getState();
      if (shouldOpenOverlay(s.signal, s.overlay !== null, s.dismissedUntil, Date.now()))
        s.openOverlay({ reason: s.signal.degraded!, auto: true, forced: false });
    };
    watchInvoke();

    const onError = (e: ErrorEvent) => {
      if (rendererHealth.windowError(e.message || errorMessage(e.error), Date.now())) refresh();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (rendererHealth.rejection(errorMessage(e.reason), Date.now())) refresh();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    let raf = 0;
    const frame = (t: number) => {
      if (rendererHealth.frame(t, visible()) !== null) refresh();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onVisibility = () => {
      rendererHealth.resetFrames();
      if (!visible()) saveUiCheckpoint();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", saveUiCheckpoint);

    let stopped = false;
    const beat = async () => {
      sampleHeap();
      watchFrames((message) => {
        rendererHealth.aiWorldError(message, Date.now());
        refresh();
      });
      try {
        const ack = await withTimeout(api.rendererHeartbeat(currentReport()), HEARTBEAT_TIMEOUT_MS);
        if (stopped) return;
        rendererHealth.heartbeat(true, Date.now());
        useHealth.setState({ watchdog: ack?.watchdog ?? null, lastBeatAt: Date.now() });
        if (ack?.recovered) {
          useHealth.setState({ recovered: ack.recovered });
          toast.info(t("health.recoveredToast"));
        }
      } catch {
        if (stopped) return;
        rendererHealth.heartbeat(false, Date.now());
      }
      saveUiCheckpoint();
      refresh();
    };
    void beat();
    const timer = window.setInterval(() => void beat(), HEARTBEAT_MS);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", saveUiCheckpoint);
    };
  }, []);
}
