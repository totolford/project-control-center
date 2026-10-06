import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { makeAgent, makeSnapshot } from "../../test/fixtures";
import { useStore } from "../../store";
import { useUi } from "../../state/ui";
import type { AiTownStatus, World } from "../../lib/types";
import { useRightContext } from "../../state/context";
import { useAiTown } from "./aiTownStore";
import { makeCharacter, makeWorld } from "./fixtures";
import { AiWorldPanel, AiWorldView } from "./index";
import { CharacterDetail } from "./CharacterDetail";
import { WorldFeed } from "./WorldFeed";
import { EditWorldDialog } from "./EditWorldDialog";
import { CustomizeCharacter } from "./CustomizeCharacter";

let world: World | null = null;
let town: AiTownStatus;
const TOWN_WORLD = { url: "http://127.0.0.1:3210", worldId: "w9", engineId: "e9", frontend: "/ai-town/index.html?embed=nexus&world=w9" };

function townStatus(patch: Partial<AiTownStatus> = {}): AiTownStatus {
  return {
    node: "v20.11.0",
    npm: "10.2.4",
    source: "C:/NEXUS/ai-town",
    upstreamCommit: "8e05997aaaaaaa",
    runtimeDir: "C:/Users/u/AppData/Local/NEXUS/ai-town",
    installed: false,
    needsReinstall: false,
    running: false,
    url: null,
    lastError: null,
    log: [],
    ...patch,
  };
}
const linked = makeCharacter("builder", { name: "Builder", nexusAgent: "w1", activity: "Editing app.ts", room: "workshop" });

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(() => Promise.resolve(true)), open: vi.fn() }));

function respond(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "world_get":
      return world;
    case "world_providers":
      return [
        { id: "nexus_native", name: "NEXUS Native", description: "Inside NEXUS", prerequisites: [], ready: true },
        { id: "ai_town", name: "AI Town (integrated)", description: "Bundled", prerequisites: [{ name: "Node.js 18+", met: false, detail: "Node 18 or newer required", required: true }], ready: false },
        { id: "custom", name: "Custom world project", description: "Any folder", prerequisites: [{ name: "World folder", met: false, detail: "pick one", required: true }], ready: false },
      ];
    case "ai_town_status":
      return town;
    case "ai_town_install":
      town = { ...town, installed: true };
      return town;
    case "ai_town_start":
      town = { ...town, running: true, url: TOWN_WORLD.url };
      return TOWN_WORLD;
    case "ai_town_stop":
      town = { ...town, running: false };
      return town;
    case "world_analyze":
      return { projectTypes: ["node"], agents: [], providers: [], recommendedProvider: "nexus_native", reason: "No extra infrastructure.", existingWorld: false };
    case "world_characters_from_agents":
      return [linked];
    case "world_create":
      world = makeWorld({ characters: (args?.spec as { characters: World["characters"] }).characters });
      return { world, steps: ["Backup of .agent-project: C:/b"], warnings: [], backup: null };
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
  // No Node.js: the native fallback opens by default (AI Town tests set their own status).
  town = townStatus({ node: null, npm: null });
  useAiTown.setState({ status: null, world: null, projectId: null, busy: null, progress: [], error: null, frontendBuilt: null });
  useRightContext.getState().resetContext();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response('<script src="/ai-town/assets/index.js"></script>', { status: 200, headers: { "content-type": "text/html" } }))));
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

describe("AiWorldView: integrated AI Town", () => {
  it("asks for consent, then installs, starts and shows the town", async () => {
    town = townStatus();
    await mount(<AiWorldView />);
    await act(async () => fireEvent.click(screen.getByText(/MAKE THIS PROJECT AN AI TOWN/)));
    expect(screen.getByText("Install AI Town on this PC?")).toBeTruthy();
    expect(screen.getByText(/downloads AI Town's npm packages/)).toBeTruthy();
    expect(screen.getAllByText("C:/Users/u/AppData/Local/NEXUS/ai-town")).toHaveLength(2);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("ai_town_install");
    await act(async () => fireEvent.click(screen.getByText("Install and start")));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("ai_town_install");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("ai_town_start");
    const frame = screen.getByTitle("AI Town") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(TOWN_WORLD.frontend);
  });

  it("cancelling the consent installs nothing", async () => {
    town = townStatus();
    await mount(<AiWorldView />);
    await act(async () => fireEvent.click(screen.getByText(/MAKE THIS PROJECT AN AI TOWN/)));
    await act(async () => fireEvent.click(screen.getByText("Cancel")));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("ai_town_install");
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("ai_town_start");
  });

  it("routes the iframe's messages, and only from the iframe", async () => {
    town = townStatus({ installed: true, running: true, url: TOWN_WORLD.url });
    await mount(<AiWorldView />);
    const frame = screen.getByTitle("AI Town") as HTMLIFrameElement;
    const post = (data: unknown, source: Window | null = frame.contentWindow, origin = window.location.origin) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
      });
    await post({ source: "ai-town", type: "talk", nexusId: "w1" }, window);
    expect(useRightContext.getState().right).toEqual({ kind: "central" });
    await post({ source: "ai-town", type: "talk", nexusId: "w1" }, frame.contentWindow, "http://evil.example");
    expect(useRightContext.getState().right).toEqual({ kind: "central" });
    await post({ source: "ai-town", type: "talk", nexusId: "w1" });
    expect(useRightContext.getState().right).toEqual({ kind: "agent", agentId: "w1", tab: "chat" });
    await post({ source: "ai-town", type: "viewWork", nexusId: "w1" });
    expect(useRightContext.getState().right).toEqual({ kind: "agent", agentId: "w1", tab: "work" });
    await post({ source: "ai-town", type: "action", nexusId: "w1", action: "stop" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("stop_agent", { id: "w1" });
    await post({ source: "ai-town", type: "action", nexusId: "w1", action: "pause" });
    // Pause is the real hierarchy pause (nothing delivered until resumed), not a bare interrupt.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("pause_agent", { id: "w1" });
    await post({ source: "ai-town", type: "action", nexusId: "w1", action: "resume" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("resume_agent", { id: "w1" });
    await post({ source: "ai-town", type: "action", nexusId: "w1", action: "promote" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("promote_agent", { id: "w1" });
    await post({ source: "ai-town", type: "action", nexusId: "w1", action: "customize" });
    expect(screen.getByText("Customize Character — Builder")).toBeTruthy();
    await post({ source: "ai-town", type: "openBuilding", zone: "skill_shop" });
    expect(useStore.getState().view.name).toBe("market");
  });

  it("explains what is missing without Node.js and offers the native world", async () => {
    await mount(<AiWorldView />);
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "AI Town" })));
    expect(screen.getByText(/install Node.js 18 or newer/)).toBeTruthy();
    expect((screen.getByText(/MAKE THIS PROJECT AN AI TOWN/).closest("button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByText("Open the native 2D world")));
    expect(screen.getByText("CREATE THE NATIVE WORLD")).toBeTruthy();
  });
});

describe("AiWorldView: native fallback", () => {
  it("offers the native world and its providers' real prerequisites", async () => {
    await mount(<AiWorldView />);
    expect(screen.getByText("CREATE THE NATIVE WORLD")).toBeTruthy();
    expect(screen.getByText("World folder")).toBeTruthy();
    expect(screen.queryByText("AI Town (integrated)")).toBeNull();
    expect(screen.getByLabelText("missing")).toBeTruthy();
  });

  it("one click pre-fills the recommended world, then creates it on confirmation", async () => {
    await mount(<AiWorldView />);
    await act(async () => fireEvent.click(screen.getByText("CREATE THE NATIVE WORLD")));
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
    expect(screen.getByText("Create the native 2D world")).toBeTruthy();
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

describe("CustomizeCharacter", () => {
  it("saves a preset that looks like its label, a tint and a badge", async () => {
    const agent = makeAgent("w1", { name: "Builder" });
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) =>
      Promise.resolve(cmd === "set_agent_appearance" ? { ...agent, profile: { ...agent.profile, appearance: (args as { appearance: unknown }).appearance } } : respond(cmd, args as Record<string, unknown>)),
    );
    await mount(<CustomizeCharacter agent={agent} world={null} onClose={() => undefined} />);
    expect(screen.getByTitle("NEXUS sprite: steel body, box head, antenna")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /Robot/ })));
    fireEvent.change(screen.getByPlaceholderText("none"), { target: { value: "#ff0000" } });
    fireEvent.change(screen.getByLabelText(/^Badge/), { target: { value: "DEV" } });
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Import spritesheet" })));
    expect(screen.getByText(/32×32 frames/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Save")));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_agent_appearance", {
      agentId: "w1",
      appearance: { skin: "nexus-robot", preset: "robot", displayName: null, badge: "DEV", tint: "#ff0000" },
    });
    expect(useStore.getState().project!.agents.find((a) => a.id === "w1")?.profile.appearance?.skin).toBe("nexus-robot");
  });
});
