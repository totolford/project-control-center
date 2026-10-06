import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CoreStatus } from "../../lib/types";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { AUTO_RELOAD_LIMIT, HEALTH, RendererHealth, canAutoReload, isIgnoredError } from "./monitor";
import { CHECKPOINT_MAX_AGE_MS, loadCheckpoint, parseCheckpoint, saveCheckpoint } from "./checkpoint";
import { rendererHealth, shouldOpenOverlay, useHealth } from "./health";
import { SafeRecoveryPanel } from "./SafeRecoveryOverlay";

const invoke = vi.fn((cmd: string, _args?: unknown) => Promise.resolve(cmd === "core_status" ? core : null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const core: CoreStatus = {
  projectOpen: true,
  projectName: "Test",
  runningAgents: 3,
  workingAgents: 2,
  activeMission: "Fix login",
  activeMissions: 2,
  mcpConnected: 1,
  mcpTotal: 2,
  aiTownRunning: true,
  terminals: 1,
};

afterEach(() => {
  cleanup();
  invoke.mockClear();
});

describe("RendererHealth", () => {
  it("detects frame stalls only while the page is visible", () => {
    const h = new RendererHealth();
    expect(h.frame(0, true)).toBeNull();
    expect(h.frame(16, true)).toBeNull();
    expect(h.frame(16 + HEALTH.stallMs + 500, true)).toBe(HEALTH.stallMs + 500);
    expect(h.totals.stalls).toBe(1);
    // Hidden pages get no frames: the gap across the visibility change is not a stall.
    expect(h.frame(10_000, false)).toBeNull();
    expect(h.frame(60_000, true)).toBeNull();
    h.resetFrames();
    expect(h.frame(200_000, true)).toBeNull();
    expect(h.totals.stalls).toBe(1);
  });

  it("is green, then amber on a single problem, then red when degraded", () => {
    const h = new RendererHealth();
    expect(h.signal(0)).toEqual({ level: "green", degraded: null, notes: [] });
    h.renderError("Missions view: boom", 1000);
    expect(h.signal(1000).level).toBe("amber");
    h.renderError("Missions view: boom", 2000);
    h.renderError("Right panel: boom", 3000);
    const s = h.signal(3000);
    expect(s.level).toBe("red");
    expect(s.degraded).toMatch(/3 views crashed/);
    // Errors age out of the window.
    expect(h.signal(3000 + HEALTH.windowMs + 1).level).toBe("green");
  });

  it("calls one long freeze degraded, and several short stalls too", () => {
    const h = new RendererHealth();
    h.frame(0, true);
    h.frame(HEALTH.severeStallMs + 1, true);
    expect(h.signal(HEALTH.severeStallMs + 1).degraded).toMatch(/froze/);

    const k = new RendererHealth();
    let t = 0;
    k.frame(t, true);
    for (let i = 0; i < HEALTH.degradedStalls; i++) k.frame((t += HEALTH.stallMs + 1), true);
    expect(k.signal(t).degraded).toMatch(/stalls/);
  });

  it("loses IPC after consecutive failed heartbeats, and recovers on one success", () => {
    const h = new RendererHealth();
    for (let i = 0; i < HEALTH.ipcLostFailures - 1; i++) h.heartbeat(false, i);
    expect(h.ipcLost()).toBe(false);
    expect(h.signal(10).level).toBe("amber");
    h.heartbeat(false, 10);
    expect(h.ipcLost()).toBe(true);
    expect(h.signal(10).degraded).toMatch(/Connection to the engine lost/);
    h.heartbeat(true, 20);
    expect(h.signal(20).level).toBe("green");
  });

  it("counts engine calls, ignores benign browser noise, and reports memory pressure", () => {
    const h = new RendererHealth();
    expect(h.windowError("ResizeObserver loop completed with undelivered notifications.", 0)).toBe(false);
    expect(isIgnoredError("ResizeObserver loop limit exceeded")).toBe(true);
    expect(h.windowError("TypeError: x is undefined", 0)).toBe(true);
    for (let i = 0; i < 6; i++) h.invoke(i % 2 === 0, i);
    expect(h.totals).toMatchObject({ invokeCalls: 6, invokeErrors: 3, windowErrors: 1 });
    h.setHeap(90, 100);
    const notes = h.signal(10).notes.join(" | ");
    expect(notes).toMatch(/1 script error/);
    expect(notes).toMatch(/90 %/);
    h.setHeap(null, 100);
    expect(h.heap).toBeNull();
    const r = h.report(10, true, "missions");
    expect(r).toMatchObject({ status: "ok", windowErrors: 1, invokeErrors: 3, view: "missions", lastError: "TypeError: x is undefined" });
  });

  it("limits automatic reloads to avoid reload loops", () => {
    const now = 1_000_000;
    expect(canAutoReload([], now)).toBe(true);
    expect(canAutoReload([now - 1000], now)).toBe(true);
    expect(canAutoReload([now - 2000, now - 1000], now)).toBe(false);
    expect(canAutoReload([now - AUTO_RELOAD_LIMIT.windowMs - 1, now - 1000], now)).toBe(true);
  });
});

describe("overlay decision", () => {
  const degraded = { level: "red" as const, degraded: "froze", notes: ["froze"] };
  it("opens on a degraded signal unless already open or dismissed", () => {
    expect(shouldOpenOverlay(degraded, false, 0, 10)).toBe(true);
    expect(shouldOpenOverlay(degraded, true, 0, 10)).toBe(false);
    expect(shouldOpenOverlay(degraded, false, 100, 10)).toBe(false);
    expect(shouldOpenOverlay({ level: "amber", degraded: null, notes: ["x"] }, false, 0, 10)).toBe(false);
  });
});

describe("UI checkpoint", () => {
  const base = { projectId: "p1", view: { name: "missions" }, right: { kind: "central" }, barText: "draft" };
  it("parses only a recent checkpoint of the same project", () => {
    const raw = JSON.stringify({ v: 1, savedAt: 1000, ...base });
    expect(parseCheckpoint(raw, "p1", 2000)?.barText).toBe("draft");
    expect(parseCheckpoint(raw, "p2", 2000)).toBeNull();
    expect(parseCheckpoint(raw, "p1", 1000 + CHECKPOINT_MAX_AGE_MS + 1)).toBeNull();
    expect(parseCheckpoint("{not json", "p1", 2000)).toBeNull();
    expect(parseCheckpoint(JSON.stringify({ v: 1, savedAt: 1000, ...base, right: { kind: "bogus" } }), "p1", 2000)).toBeNull();
    expect(parseCheckpoint(null, "p1", 2000)).toBeNull();
  });

  it("round-trips through storage and survives storage failures", () => {
    saveCheckpoint(base as never, 5000);
    expect(loadCheckpoint("p1", 6000)?.view).toEqual({ name: "missions" });
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveCheckpoint(base as never)).not.toThrow();
    spy.mockRestore();
  });
});

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error("kaboom");
  return <div>fine</div>;
}

describe("ErrorBoundary", () => {
  it("contains a crash in an inline card, reports it, and clears on retry or resetKey change", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = rendererHealth.totals.renderErrors;
    const { rerender } = render(
      <ErrorBoundary label="Missions view" resetKey="missions">
        <Bomb explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/Missions view crashed/);
    expect(screen.getByText(/NEXUS is not stopped/)).toBeTruthy();
    expect(rendererHealth.totals.renderErrors).toBe(before + 1);
    expect(invoke).toHaveBeenCalledWith("record_renderer_incident", expect.objectContaining({ kind: "viewCrash" }));

    rerender(
      <ErrorBoundary label="Agents view" resetKey="agents">
        <Bomb explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();

    rerender(
      <ErrorBoundary label="Agents view" resetKey="agents">
        <Bomb explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    err.mockRestore();
  });

  it("uses a custom fallback when given", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary label="Interface" fallback={(e) => <p>custom {e.message}</p>}>
        <Bomb explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText("custom kaboom")).toBeTruthy();
    err.mockRestore();
  });
});

describe("Safe Recovery Overlay", () => {
  it("says NEXUS is not stopped and lists what the engine still runs", async () => {
    useHealth.setState({ core: null, coreAt: null });
    await act(async () => {
      render(<SafeRecoveryPanel overlay={{ reason: "The interface froze for 12.0 s", auto: false, forced: false }} onDismiss={() => undefined} />);
    });
    expect(screen.getByText("NEXUS is not stopped.")).toBeTruthy();
    expect(screen.getByText(/The application engine is still running/)).toBeTruthy();
    expect(screen.getByText("3 running · 2 working")).toBeTruthy();
    expect(screen.getByText("Fix login (+1)")).toBeTruthy();
    expect(screen.getByText("1 of 2 connected")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep working" })).toBeTruthy();
  });

  it("does not claim the engine runs when it does not answer, and pauses auto reloads after repeats", async () => {
    invoke.mockImplementation((cmd: string) => (cmd === "core_status" ? Promise.reject(new Error("ipc down")) : Promise.resolve(null)));
    const now = Date.now();
    sessionStorage.setItem("nexus.autoReloads", JSON.stringify([now - 1000, now - 500]));
    useHealth.setState({ core: null, coreAt: null });
    await act(async () => {
      render(<SafeRecoveryPanel overlay={{ reason: "Connection to the engine lost", auto: true, forced: false }} />);
    });
    expect(screen.queryByText(/The application engine is still running/)).toBeNull();
    expect(screen.getByText(/not answering the interface/)).toBeTruthy();
    expect(screen.getByText(/Automatic reload paused/)).toBeTruthy();
    sessionStorage.removeItem("nexus.autoReloads");
    localStorage.removeItem("nexus.autoReloads");

    // "Reload interface now" asks the backend to reload this window.
    invoke.mockImplementation(() => Promise.resolve(null));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Reload interface now/ }));
    });
    expect(invoke).toHaveBeenCalledWith("renderer_reload", expect.objectContaining({ kind: "degraded", reason: "Connection to the engine lost" }));
  });
});
