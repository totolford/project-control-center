import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { makeAgent, makeSnapshot } from "../../test/fixtures";
import { useStore } from "../../store";
import { useUi } from "../../state/ui";
import type { World } from "../../lib/types";
import { makeCharacter, makeWorld } from "./fixtures";
import { AiWorldPanel, AiWorldView } from "./index";
import { CharacterDetail } from "./CharacterDetail";
import { WorldFeed } from "./WorldFeed";
import { EditWorldDialog } from "./EditWorldDialog";

let world: World | null = null;
const linked = makeCharacter("builder", { name: "Builder", nexusAgent: "w1", activity: "Editing app.ts", room: "workshop" });

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(() => Promise.resolve(true)), open: vi.fn() }));

function respond(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "world_get":
      return world;
    case "world_providers":
      return [{ id: "nexus_native", name: "NEXUS Native", description: "Inside NEXUS", prerequisites: [], ready: true }, { id: "ai_town", name: "AI Town fork", description: "Fork", prerequisites: [{ name: "Convex", met: false, detail: "not logged in", required: true }], ready: false }];
    case "world_analyze":
      return { projectTypes: ["node"], agents: [], providers: [], recommendedProvider: "nexus_native", reason: "No extra infrastructure.", existingWorld: false };
    case "world_characters_from_agents":
      return [linked];
    case "world_create":
      world = makeWorld({ characters: (args?.spec as { characters: World["characters"] }).characters });
      return { world, steps: ["Backup of .agent-project: C:/b"], warnings: [], missionId: null, backup: null };
    case "world_save":
      world = args?.world as World;
      return world;
    case "world_control":
      world = { ...world!, running: Boolean(args?.running), tick: world!.tick + 1 };
      return world;
    default:
      return null;
  }
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});
beforeEach(() => {
  world = null;
  vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => Promise.resolve(respond(cmd, args as Record<string, unknown>)));
  vi.mocked(invoke).mockClear();
  useStore.getState().loadSnapshot(makeSnapshot({ agents: [makeAgent("central", { kind: "central" }), makeAgent("w1", { name: "Builder", status: "working" })] }));
});
afterEach(cleanup);

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

describe("AiWorldView", () => {
  it("offers the one-click conversion and the providers' real prerequisites", async () => {
    await mount(<AiWorldView />);
    expect(screen.getByText("MAKE THIS PROJECT AN AI TOWN")).toBeTruthy();
    expect(screen.getByText("Convex")).toBeTruthy();
    expect(screen.getByLabelText("missing")).toBeTruthy();
  });

  it("one click pre-fills the recommended world, then creates it on confirmation", async () => {
    await mount(<AiWorldView />);
    await act(async () => fireEvent.click(screen.getByText("MAKE THIS PROJECT AN AI TOWN")));
    expect(screen.getByText(/1 linked to NEXUS agents/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Create")));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("world_create", {
      spec: expect.objectContaining({ provider: "nexus_native", mode: "hybrid", characters: [expect.objectContaining({ nexusAgent: "w1" })] }),
    });
    expect(screen.getByText("Backup of .agent-project: C:/b")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Open the world")));
    expect(screen.getByText("Test Town")).toBeTruthy();
  });

  it("opens the wizard when the UI flag is raised", async () => {
    await mount(<AiWorldView />);
    await act(async () => useUi.getState().setAiWorldWizard(true));
    expect(screen.getByText("Make this project an AI Town")).toBeTruthy();
    expect(useUi.getState().aiWorldWizard).toBe(false);
  });

  it("runs the world and switches its mode through world_control", async () => {
    world = makeWorld({ characters: [linked] });
    await mount(<AiWorldView />);
    expect(screen.getByText("Run")).toBeTruthy();
    expect(screen.getByText(/Workshop/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Run")));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("world_control", { running: true, mode: null, speed: null });
    expect(screen.getByText("Pause")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Simulation" })));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("world_control", { running: null, mode: "simulation", speed: null });
  });
});

describe("CharacterDetail", () => {
  it("shows the real agent state of a linked character in a live mode", async () => {
    useStore.getState().upsertAgent(makeAgent("w1", { name: "Builder", status: "working", currentAction: "Running npm test" }));
    const w = makeWorld({ characters: [linked] });
    await mount(<CharacterDetail world={w} character={linked} agents={useStore.getState().project!.agents} onConversation={() => undefined} />);
    expect(screen.getByText("Open agent")).toBeTruthy();
    expect(screen.getByText("Running npm test")).toBeTruthy();
    expect(screen.queryByText("Send instruction")).toBeNull();
    await act(async () => fireEvent.click(screen.getByText("Open agent")));
    expect(useStore.getState().view).toEqual({ name: "agent", agentId: "w1" });
  });

  it("never presents a simulated character as the real agent", async () => {
    const w = makeWorld({ mode: "simulation", characters: [{ ...linked, mood: "curious" }] });
    await mount(<CharacterDetail world={w} character={w.characters[0]} agents={useStore.getState().project!.agents} onConversation={() => undefined} />);
    expect(screen.getByText(/simulated, not your real agent/)).toBeTruthy();
    expect(screen.queryByText("Open agent")).toBeNull();
    expect(screen.getByText("simulated")).toBeTruthy();
  });

  it("sends a real instruction in real execution mode", async () => {
    const w = makeWorld({ mode: "real_execution", characters: [linked] });
    await mount(<CharacterDetail world={w} character={linked} agents={useStore.getState().project!.agents} onConversation={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText(/Instruction for Builder/), { target: { value: "Add tests" } });
    await act(async () => fireEvent.click(screen.getByText("Send")));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("send_user_message", { to: "w1", body: "Add tests" });
  });
});

describe("conversations", () => {
  it("labels real NEXUS messages and simulated conversations", async () => {
    const line = { speaker: "Builder", text: "Done", ts: "1" };
    const w = makeWorld({
      characters: [linked],
      conversations: [
        { id: "r", participants: ["builder"], room: null, lines: [line], origin: "real", startedAt: "2" },
        { id: "s", participants: ["builder"], room: null, lines: [line], origin: "simulated", startedAt: "1" },
      ],
    });
    await mount(<WorldFeed world={w} tab="conversations" onTab={() => undefined} />);
    expect(screen.getByText("real NEXUS messages")).toBeTruthy();
    expect(screen.getByText("simulated (generated by Claude)")).toBeTruthy();
  });

  it("saves automatic conversation settings with a cost notice", async () => {
    world = makeWorld({ characters: [linked] });
    await mount(<EditWorldDialog world={world} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText(/one real Claude call \(haiku\), billed/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/talk on their own/));
    await act(async () => fireEvent.click(screen.getByText("Save")));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("world_save", {
      world: expect.objectContaining({ settings: expect.objectContaining({ llmConversations: true, maxConversationsPerHour: 6, conversationModel: "haiku" }) }),
    });
  });
});

describe("AiWorldPanel", () => {
  it("links to the full view when there is no world", async () => {
    await mount(<AiWorldPanel />);
    await act(async () => fireEvent.click(screen.getByText("Open AI World")));
    expect(useStore.getState().view.name).toBe("world");
  });

  it("labels a simulated world", async () => {
    world = makeWorld({ mode: "simulation", characters: [linked] });
    await mount(<AiWorldPanel />);
    expect(screen.getByText("Simulation — not your real agents")).toBeTruthy();
  });
});
