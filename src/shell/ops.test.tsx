import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Interpretation, Message, UserRequest } from "../lib/types";
import { makeAgent, makeSnapshot } from "../test/fixtures";
import { useStore } from "../store";
import { useRightContext } from "../state/context";
import { useUi } from "../state/ui";
import { UserRequests } from "./UserRequests";
import { UniversalBar } from "./UniversalBar";
import { CompatBanner } from "./CompatBanner";

vi.mock("@tauri-apps/api/core", async () => {
  const { responses } = await import("../test/responses");
  return { invoke: vi.fn((cmd: string) => Promise.resolve(responses[cmd] ?? null)) };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(() => Promise.resolve(true)), open: vi.fn(() => Promise.resolve(null)) }));

const secretRequest: UserRequest = {
  id: "req1",
  agentId: "central",
  kind: "secret",
  title: "Password of the Pi",
  reason: "SSH needs it",
  connectionId: "c1",
  key: "password",
  createdAt: "2026-01-01T00:00:00Z",
};

const interpretation: Interpretation = {
  raw: "claude mcp add github -e GITHUB_TOKEN=ghp_secret -- npx server-github",
  program: "claude",
  tokens: [],
  intent: { type: "add_mcp", name: "github", transport: "stdio", scope: null, command: "npx", args: ["server-github"], url: null, env: [["GITHUB_TOKEN", "ghp_secret"]], headers: [] },
  summary: "Add the MCP server github",
  capability: "mcp",
  destructive: false,
};

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useUi.setState({ newMission: false, newMissionText: "", requestsCollapsed: false });
  useRightContext.setState({ right: { kind: "central" }, rightOpen: true });
  useStore.getState().closeProject();
});
afterEach(cleanup);

describe("user requests", () => {
  it("sends a secret once and clears it from the UI", async () => {
    useStore.getState().loadSnapshot(makeSnapshot({ agents: [makeAgent("central", { name: "Central" })], userRequests: [secretRequest] }));
    await act(async () => {
      render(<UserRequests />);
    });
    expect(screen.getByText("Central needs `password` for c1")).toBeTruthy();
    const input = screen.getByLabelText("Value of password") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "hunter2" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Provide/ }));
    });
    expect(invoke).toHaveBeenCalledWith("provide_secret", { id: "req1", value: "hunter2" });
    expect(useStore.getState().project?.userRequests).toEqual([]);
    expect(screen.queryByDisplayValue("hunter2")).toBeNull();
  });
});

function sentMessage(to: string, body: string): Message {
  return { id: "MSG-1", from: "user", to, kind: "user", subject: null, body, taskId: null, missionId: null, createdAt: "2026-01-01T00:00:00Z", deliveredAt: null };
}

async function typeAndEnter(text: string, opts: { altKey?: boolean } = {}) {
  const bar = screen.getByRole("combobox", { name: /Ask Central Agent/ });
  fireEvent.change(bar, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(bar, { key: "Enter", ...opts });
  });
  return bar as HTMLTextAreaElement;
}

describe("universal command bar", () => {
  const snap = () =>
    makeSnapshot({ agents: [makeAgent("central", { name: "Central", kind: "central" }), makeAgent("w1", { name: "Movement Agent", createdBy: "central" })] });

  it("explains a pasted command line without secret values, then creates the connection", async () => {
    useStore.getState().loadSnapshot(makeSnapshot());
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "interpret_command" ? interpretation : cmd === "apply_command" ? { connection: null, created: false, message: "Already exists" } : null),
    );
    await act(async () => {
      render(<UniversalBar />);
    });
    await typeAndEnter(interpretation.raw);
    expect(invoke).toHaveBeenCalledWith("interpret_command", { line: interpretation.raw });
    expect(invoke).not.toHaveBeenCalledWith("send_user_message", expect.anything());
    const card = screen.getByLabelText("Interpreted command");
    expect(card.textContent).toContain("Add the MCP server github");
    expect(card.textContent).toContain("GITHUB_TOKEN=••••");
    expect(card.textContent).not.toContain("ghp_secret");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create connection/ }));
    });
    expect(invoke).toHaveBeenCalledWith("apply_command", { line: interpretation.raw });
    expect(screen.getByText("Already exists")).toBeTruthy();
  });

  it("sends plain text to Central and shows the Central chat", async () => {
    useStore.getState().loadSnapshot(snap());
    useRightContext.setState({ right: { kind: "agent", agentId: "w1" }, rightOpen: false });
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      const a = args as { to: string; body: string } | undefined;
      return Promise.resolve(cmd === "send_user_message" && a ? sentMessage(a.to, a.body) : null);
    });
    await act(async () => {
      render(<UniversalBar />);
    });
    const bar = await typeAndEnter("What is left to do?");
    expect(invoke).toHaveBeenCalledWith("send_user_message", { to: "central", body: "What is left to do?" });
    expect(invoke).toHaveBeenCalledWith("ai_town_say", { agentId: "central", text: "What is left to do?" });
    expect(useRightContext.getState()).toMatchObject({ right: { kind: "central" }, rightOpen: true });
    expect(bar.value).toBe("");
  });

  it("opens New Mission with the objective from /mission", async () => {
    useStore.getState().loadSnapshot(snap());
    await act(async () => {
      render(<UniversalBar />);
    });
    await typeAndEnter("/mission Fix the login flow");
    expect(useUi.getState()).toMatchObject({ newMission: true, newMissionText: "Fix the login flow" });
    expect(useStore.getState().view.name).toBe("missions");
    expect(invoke).not.toHaveBeenCalledWith("send_user_message", expect.anything());
  });

  it("talks to an agent with /agent <name> <message> and opens its chat", async () => {
    useStore.getState().loadSnapshot(snap());
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      const a = args as { to: string; body: string } | undefined;
      return Promise.resolve(cmd === "send_user_message" && a ? sentMessage(a.to, a.body) : null);
    });
    await act(async () => {
      render(<UniversalBar />);
    });
    await typeAndEnter("/agent movement agent check the jump height");
    expect(invoke).toHaveBeenCalledWith("send_user_message", { to: "w1", body: "check the jump height" });
    expect(useRightContext.getState().right).toEqual({ kind: "agent", agentId: "w1", tab: "chat" });
  });

  it("suggests slash commands and completes them with Tab", async () => {
    useStore.getState().loadSnapshot(snap());
    await act(async () => {
      render(<UniversalBar />);
    });
    const bar = screen.getByRole("combobox", { name: /Ask Central Agent/ }) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: "/mi" } });
    expect(screen.getByRole("option", { name: /\/mission/ })).toBeTruthy();
    fireEvent.keyDown(bar, { key: "Tab" });
    expect(bar.value).toBe("/mission ");
  });
});

describe("compatibility mode", () => {
  it("shows the read-only banner and blocks messages to Central", async () => {
    useStore.getState().loadSnapshot(
      makeSnapshot({
        readOnly: true,
        compatibility: {
          status: "requires_newer_nexus",
          projectFormat: 3,
          supportedFormat: 2,
          appVersion: "0.2.0",
          createdWith: "0.3.0",
          lastOpenedWith: "0.3.0",
          minimumNexusVersion: "0.3.0",
          databaseSchema: 4,
          supportedDatabaseSchema: 3,
          unknownFields: [],
          plan: [],
          notes: ["Opened read-only"],
          readOnly: true,
        },
      }),
    );
    await act(async () => {
      render(
        <>
          <CompatBanner />
          <UniversalBar />
        </>,
      );
    });
    expect(screen.getByText(/requires NEXUS ≥ 0.3.0; it is opened read-only/)).toBeTruthy();
    expect(screen.getByText("Opened read-only")).toBeTruthy();
    const bar = screen.getByRole("combobox", { name: /Ask Central Agent/ }) as HTMLTextAreaElement;
    expect(bar.placeholder).toContain("read-only");
    await typeAndEnter("hello");
    expect(invoke).not.toHaveBeenCalledWith("send_user_message", expect.anything());
  });
});
