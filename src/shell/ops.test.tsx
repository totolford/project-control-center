import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Interpretation, UserRequest } from "../lib/types";
import { makeAgent, makeSnapshot } from "../test/fixtures";
import { useStore } from "../store";
import { useUi } from "../state/ui";
import { UserRequests } from "./UserRequests";
import { MissionComposer } from "./MissionComposer";
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
  useUi.setState({ composerMode: "mission", requestsCollapsed: false });
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

describe("command interpreter", () => {
  it("shows what was understood without secret values and creates the connection", async () => {
    useStore.getState().loadSnapshot(makeSnapshot());
    useUi.setState({ composerMode: "command" });
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "interpret_command" ? interpretation : cmd === "apply_command" ? { connection: null, created: false, message: "Already exists" } : null),
    );
    await act(async () => {
      render(<MissionComposer />);
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: interpretation.raw } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Interpret/ }));
    });
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

  it("makes RUN the hero action of the mission composer", async () => {
    useStore.getState().loadSnapshot(makeSnapshot());
    await act(async () => {
      render(<MissionComposer />);
    });
    expect(screen.getByText("What do you want to accomplish?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /RUN/ })).toBeTruthy();
  });
});

describe("compatibility mode", () => {
  it("shows the read-only banner and blocks missions", async () => {
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
          <MissionComposer />
        </>,
      );
    });
    expect(screen.getByText(/requires NEXUS ≥ 0.3.0; it is opened read-only/)).toBeTruthy();
    expect(screen.getByText("Opened read-only")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  });
});
