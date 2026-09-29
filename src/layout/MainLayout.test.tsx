import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Agent, PermissionSet, ProjectSnapshot } from "../lib/types";
import { useStore, type ViewName } from "../store";
import { MainLayout } from "./MainLayout";

// Backend responses for the commands the views call on mount.
const responses: Record<string, unknown> = {
  agent_logs: [],
  list_messages: [],
  list_events: [],
  memory_files: [],
  git_overview: null,
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
const central: Agent = {
  id: "central",
  name: "Central",
  kind: "central",
  role: "Planner",
  instructions: "",
  status: "working",
  model: null,
  permissions: perms,
  connections: [],
  isolation: "shared",
  workdir: "C:/proj",
  branch: null,
  currentTask: null,
  currentAction: "Planning mission",
  progress: null,
  claudeSessionId: null,
  totalCostUsd: 0.42,
  createdBy: "system",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

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
  agents: [central],
  tasks: [],
  missions: [],
  connections: [],
  pendingPermissions: [],
  repo: null,
  recovery: null,
};

describe("MainLayout", () => {
  it("renders every view from a real-shaped snapshot without crashing", async () => {
    useStore.getState().loadSnapshot(snap);
    render(<MainLayout />);
    expect(screen.getByText("CENTRAL AGENT")).toBeTruthy();
    expect(screen.getAllByText("Planning mission").length).toBeGreaterThan(0);

    const views: ViewName[] = ["overview", "missions", "agents", "tasks", "connections", "memory", "activity", "git", "settings"];
    for (const name of views) {
      await act(async () => useStore.getState().navigate({ name }));
    }
    await act(async () => useStore.getState().openAgent("central"));
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeTruthy();
  });
});
