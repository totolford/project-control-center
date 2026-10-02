import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Agent, ProjectSnapshot } from "../lib/types";
import { makeAgent, makeSnapshot } from "../test/fixtures";
import { useStore, type ViewName } from "../store";
import { useWorkspace } from "../workspace/store";
import { listPanels, getActiveTab } from "../workspace/layout";
import { AppShell } from "./AppShell";

vi.mock("@tauri-apps/api/core", async () => {
  const { responses } = await import("../test/responses");
  return { invoke: vi.fn((cmd: string) => Promise.resolve(responses[cmd] ?? null)) };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

function agent(id: string, patch: Partial<Agent>): Agent {
  return makeAgent(id, { status: "waiting", createdBy: "central", ...patch });
}

const snap: ProjectSnapshot = makeSnapshot({
  agents: [
    agent("central", { name: "Central", kind: "central", status: "working", currentAction: "Planning mission", createdAt: "2025-12-31T00:00:00Z" }),
    agent("w1", { name: "Movement", status: "working", currentAction: "Reading Formation.luau" }),
  ],
});

describe("AppShell", () => {
  it("builds the default swarm layout and renders every view", async () => {
    useStore.getState().loadSnapshot(snap);
    await act(async () => {
      render(<AppShell onCloseProject={() => undefined} onFolder={async () => undefined} />);
    });
    const ws = useWorkspace.getState().ws!;
    expect(listPanels(getActiveTab(ws).root).map((p) => p.panel.type)).toEqual(["CentralAgent", "AgentTerminal"]);
    expect(screen.getByText("CENTRAL AGENT")).toBeTruthy();
    expect(screen.getAllByText("Movement").length).toBeGreaterThan(0);
    expect(screen.getByText("2/2 agents working")).toBeTruthy();

    const views: ViewName[] = [
      "missions",
      "agents",
      "models",
      "mcp",
      "skills",
      "connections",
      "commands",
      "memory",
      "activity",
      "environment",
      "claude",
      "autonomy",
      "capabilities",
      "terminal",
      "tasks",
      "git",
      "github",
      "master",
      "world",
      "settings",
      "swarm",
    ];
    for (const name of views) {
      await act(async () => useStore.getState().navigate({ name }));
    }
    await act(async () => useStore.getState().openAgent("w1"));
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeTruthy();
  });

  it("auto-adds a terminal panel when a new agent appears", async () => {
    useStore.getState().loadSnapshot(snap);
    await act(async () => {
      render(<AppShell onCloseProject={() => undefined} onFolder={async () => undefined} />);
    });
    await act(async () => useStore.getState().upsertAgent(agent("w2", { name: "Combat", createdAt: "2026-01-02T00:00:00Z" })));
    const ws = useWorkspace.getState().ws!;
    expect(listPanels(getActiveTab(ws).root).some((p) => p.panel.agentId === "w2")).toBe(true);
  });
});
