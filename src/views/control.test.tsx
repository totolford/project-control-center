import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { powerPreset } from "../lib/power";
import { makeAgent, makeSettings, makeSnapshot } from "../test/fixtures";
import { useStore } from "../store";
import { useClaude } from "../state/claude";
import { ModelsView } from "./models/ModelsView";
import { Capabilities } from "./Capabilities";
import { ClaudeOverview } from "./claude/ClaudeOverview";
import { ControlRail } from "../workspace/ControlRail";
import { EmergencyBanner } from "../shell/SafetyControls";

vi.mock("@tauri-apps/api/core", async () => {
  const { responses } = await import("../test/responses");
  return { invoke: vi.fn((cmd: string) => Promise.resolve(responses[cmd] ?? null)) };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(() => Promise.resolve(true)) }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  useClaude.setState({ env: null, loading: false, error: null, skills: null });
  vi.mocked(invoke).mockClear();
  useStore.getState().loadSnapshot(
    makeSnapshot({
      agents: [makeAgent("central", { name: "Central", kind: "central" }), makeAgent("w1", { name: "Builder", permissions: { ...powerPreset("low"), network: "allow" } })],
    }),
  );
});
afterEach(cleanup);

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

describe("Claude Control Center views", () => {
  it("lists Claude Code models verbatim and says what is not exposed", async () => {
    await mount(<ModelsView />);
    expect(screen.getByText("Most capable")).toBeTruthy();
    expect(screen.getByText("low, high")).toBeTruthy();
    expect(screen.getAllByText("Not exposed by Claude Code").length).toBe(6);
    expect(screen.getByText("✓ Fast mode")).toBeTruthy();
  });

  it("shows presets and Custom power, and cycles a capability through the API", async () => {
    await mount(<Capabilities />);
    expect(screen.getByText("NORMAL")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    const network = screen.getAllByTitle(/^network: allow/)[0];
    await act(async () => fireEvent.click(network));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("update_agent", { id: "w1", patch: { permissions: expect.objectContaining({ network: "deny" }) } });
  });

  it("renders rate limits, context and the UNLOCKED switch in the CONTROL rail", async () => {
    await mount(<ControlRail />);
    expect(screen.getByText("CONTROL")).toBeTruthy();
    expect(screen.getByText("5-hour window")).toBeTruthy();
    expect(screen.getByText("1/1 connected")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /CLAUDE UNLOCKED/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("reports unavailable sections instead of inventing them", async () => {
    const { responses } = await import("../test/responses");
    const env = responses.claude_environment as Record<string, unknown>;
    responses.claude_environment = { ...env, usage: null, account: null, unavailable: ["usage: timed out"] };
    try {
      await mount(<ClaudeOverview />);
      expect(screen.getByText("usage: timed out")).toBeTruthy();
      expect(screen.getByText("Unavailable (usage not answered)")).toBeTruthy();
      expect(screen.getAllByText("Not reported by Claude Code").length).toBe(2);
    } finally {
      responses.claude_environment = env;
    }
  });

  it("shows the emergency banner and releases it through the API", async () => {
    useStore.getState().loadSnapshot(makeSnapshot({ settings: makeSettings(), emergency: true }));
    await mount(<EmergencyBanner />);
    expect(screen.getByRole("alert").textContent).toContain("Emergency stop active");
    await act(async () => fireEvent.click(screen.getByText("Release")));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("release_emergency");
  });
});
