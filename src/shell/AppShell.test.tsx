import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("opens on the AI World with the Central chat on the right, and renders every view", async () => {
    useStore.getState().loadSnapshot(snap);
    await act(async () => {
      render(<AppShell onCloseProject={() => undefined} onFolder={async () => undefined} />);
    });
    const ws = useWorkspace.getState().ws!;
    expect(getActiveTab(ws).view).toEqual({ name: "world" });
    expect(useStore.getState().view.name).toBe("world");
    expect(listPanels(ws.tabs[1].root).map((p) => p.panel.type)).toEqual(["CentralAgent", "AgentTerminal"]);
    expect(screen.getByText("CENTRAL AGENT")).toBeTruthy();
    expect(screen.getByRole("log", { name: "Conversation with Central" })).toBeTruthy();
    expect(screen.getByText("2 agents")).toBeTruthy();
    expect(screen.getByRole("button", { name: /New Mission/ })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Ask Central Agent/ })).toBeTruthy();

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
    // The Terminal window tab of the center plus the Terminal tab of the agent view.
    expect(screen.getAllByRole("tab", { name: /Terminal/ })).toHaveLength(2);
  });

  it("gives each view its own center tab and restores it when the tab is clicked", async () => {
    useStore.getState().loadSnapshot(snap);
    await act(async () => {
      render(<AppShell onCloseProject={() => undefined} onFolder={async () => undefined} />);
    });
    await act(async () => useStore.getState().navigate({ name: "github" }));
    await act(async () => useStore.getState().openAgent("w1"));
    const titles = () => useWorkspace.getState().ws!.tabs.map((t) => t.view?.name ?? "swarm");
    expect(titles()).toEqual(["world", "github", "agent", "swarm"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /GitHub/ }));
    });
    expect(useStore.getState().view.name).toBe("github");
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /Movement/ }));
    });
    expect(useStore.getState().view).toEqual({ name: "agent", agentId: "w1" });
    await act(async () => useStore.getState().navigate({ name: "swarm" }));
    expect(getActiveTab(useWorkspace.getState().ws!).view).toBeUndefined();
  });

  it("auto-adds a terminal panel when a new agent appears", async () => {
    useStore.getState().loadSnapshot(snap);
    await act(async () => {
      render(<AppShell onCloseProject={() => undefined} onFolder={async () => undefined} />);
    });
    await act(async () => useStore.getState().upsertAgent(agent("w2", { name: "Combat", createdAt: "2026-01-02T00:00:00Z" })));
    const ws = useWorkspace.getState().ws!;
    const swarm = ws.tabs.find((t) => !t.view)!;
    expect(listPanels(swarm.root).some((p) => p.panel.agentId === "w2")).toBe(true);
    expect(getActiveTab(ws).view).toEqual({ name: "world" });
  });
});
