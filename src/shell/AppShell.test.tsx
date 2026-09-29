import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Agent, PermissionSet, ProjectSnapshot } from "../lib/types";
import { useStore, type ViewName } from "../store";
import { useWorkspace } from "../workspace/store";
import { listPanels, getActiveTab } from "../workspace/layout";
import { AppShell } from "./AppShell";

// Backend responses for the commands the shell calls on mount (tests only).
const responses: Record<string, unknown> = {
  agent_logs: [],
  list_messages: [],
  list_events: [],
  memory_files: [],
  git_overview: null,
  load_workspace: null,
  save_workspace: null,
  recent_projects: [],
  list_agent_providers: [
    { id: "claude-code", name: "Claude Code", description: "CLI", available: true, installed: true, detail: "Claude Code 2.0" },
    { id: "codex", name: "Codex", description: "CLI", available: false, installed: true, detail: "Codex CLI detected · adapter not available yet" },
  ],
  detect_claude: { installed: true, path: null, version: "2.0.0", loggedIn: true, authMethod: null, subscription: null, error: null },
  app_info: { version: "0.1.0", dataDir: "C:/data", logDir: "C:/logs" },
  permission_rules: [],
  agent_sessions: [],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => Promise.resolve(responses[cmd] ?? null)),
}));
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

const perms = { fs_read: "allow" } as PermissionSet;
function agent(id: string, patch: Partial<Agent>): Agent {
  return {
    id,
    name: id,
    kind: "worker",
    provider: "claude-code",
    role: "Role",
    instructions: "",
    status: "waiting",
    model: null,
    permissions: perms,
    connections: [],
    isolation: "shared",
    workdir: "C:/proj",
    branch: null,
    currentTask: null,
    currentAction: null,
    progress: null,
    claudeSessionId: null,
    totalCostUsd: 0,
    createdBy: "central",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

const snap: ProjectSnapshot = {
  info: { id: "p1", name: "Demo", root: "C:/proj", createdAt: "2026-01-01T00:00:00Z", formatVersion: 1 },
  settings: {
    centralModel: null,
    workerModel: null,
    maxParallelWorkers: 3,
    useWorktrees: true,
    inheritUserSettings: false,
    defaultWorkerPermissions: perms,
    maxWorkerPermissions: perms,
    maxBudgetUsdPerSession: null,
    allowDirectWorkerMessages: false,
  },
  agents: [
    agent("central", { name: "Central", kind: "central", status: "working", currentAction: "Planning mission", createdAt: "2025-12-31T00:00:00Z" }),
    agent("w1", { name: "Movement", status: "working", currentAction: "Reading Formation.luau" }),
  ],
  tasks: [],
  missions: [],
  connections: [],
  pendingPermissions: [],
  repo: null,
  recovery: null,
};

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

    const views: ViewName[] = ["missions", "memory", "connections", "activity", "tasks", "git", "settings", "swarm"];
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
