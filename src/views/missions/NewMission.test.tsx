import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { makeAgent, makeSnapshot } from "../../test/fixtures";
import { useStore } from "../../store";
import { useClaude } from "../../state/claude";
import type { MissionAnalysis, Skill } from "../../lib/types";
import { NewMission } from "./NewMission";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(() => Promise.resolve(true)) }));

const installed: Skill[] = [
  {
    id: "p:design",
    name: "design",
    description: "",
    scope: "plugin",
    source: "ui-ux-pro-max@ui-ux-pro-max-skill",
    enabled: true,
    editable: false,
    dir: "",
    frontmatter: {},
    allowedTools: [],
    files: [],
    problems: [],
  },
];

const analysis: MissionAnalysis = {
  title: "Improve Works panel",
  summary: "Polish the UI.",
  agents: [{ role: "UI Agent", reason: "panel", existing: null }],
  skills: [
    { name: "ui-ux-pro-max:design", reason: "design work", available: true, detail: null },
    { name: "magic", reason: "?", available: false, detail: "not installed" },
  ],
  mcp: [{ name: "figma", reason: "mockups", available: false, detail: "not configured in Claude Code" }],
  connections: [],
  model: null,
  modelReason: null,
  steps: ["Analyse", "Implement"],
  estimatedSteps: 2,
  analyzedWith: "haiku",
  analyzedAt: "",
  costUsd: 0.003,
};

function mockInvoke(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  vi.mocked(invoke).mockImplementation(((cmd: string, args: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) return Promise.resolve(null);
    try {
      return Promise.resolve(h(args));
    } catch (e) {
      return Promise.reject(e);
    }
  }) as typeof invoke);
}

beforeEach(() => {
  useClaude.setState({ env: null, loading: true, error: null, skills: installed });
  useStore.getState().loadSnapshot(makeSnapshot({ agents: [makeAgent("central", { kind: "central" })] }));
});
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe("New Mission", () => {
  it("shows an honest error when the analysis fails and still allows starting", async () => {
    const created: unknown[] = [];
    mockInvoke({
      list_skills: () => installed,
      analyze_mission: () => {
        throw "Claude Code was not detected";
      },
      create_mission_with: (a) => {
        created.push(a.spec);
        return { id: "M-0001", status: "planning", archivedAt: null };
      },
    });
    const onCreated = vi.fn();
    await act(async () => {
      render(<NewMission initialText="Add tests" onClose={() => undefined} onCreated={onCreated} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Analyze/ }));
    });
    expect(screen.getByRole("alert").textContent).toContain("Analysis unavailable: Claude Code was not detected");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start Mission/ }));
    });
    expect(created).toEqual([expect.objectContaining({ prompt: "Add tests", skills: [], analysis: null, startNow: false })]);
    expect(onCreated).toHaveBeenCalled();
  });

  it("uses all relevant skills, flags the missing ones and stores the analysis", async () => {
    const created: Record<string, unknown>[] = [];
    mockInvoke({
      list_skills: () => installed,
      analyze_mission: (a) => {
        expect(a.model).toBe("haiku");
        // Environment not loaded: MCP servers are reported as unknown, never as empty.
        expect((a.claude as { mcpServers: unknown }).mcpServers).toBeNull();
        return analysis;
      },
      create_mission_with: (a) => {
        created.push(a.spec as Record<string, unknown>);
        return { id: "M-0001", status: "planning", archivedAt: null };
      },
    });
    await act(async () => {
      render(<NewMission initialText="Improve the Works panel" onClose={() => undefined} onCreated={() => undefined} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Analyze/ }));
    });
    expect(screen.getByText(/Estimate by haiku/)).toBeTruthy();
    expect(screen.getByText("Recommended (not ready)")).toBeTruthy();
    expect(screen.getByText(/not configured in Claude Code/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /fix in Market/ }).length).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start Mission/ }));
    });
    expect(created[0]).toMatchObject({ title: "Improve Works panel", skills: ["ui-ux-pro-max:design"], mcp: [] });
    expect((created[0].analysis as MissionAnalysis).analyzedWith).toBe("haiku");
  });
});
