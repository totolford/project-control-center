import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Connection, McpHealth, McpSupervision, ProjectSnapshot } from "../../lib/types";
import { useStore } from "../../store";
import { cardState, McpSupervisionPanel, serverCards } from "./McpSupervision";

const roblox: Connection = {
  id: "roblox",
  name: "Roblox_Studio",
  kind: "roblox_studio",
  config: { transport: "stdio", command: "cmd.exe", args: ["/c", "cd /d %LOCALAPPDATA%\\Roblox && .\\mcp.bat"], env: {} },
  credentialRef: null,
  status: "connected",
  statusDetail: null,
  lastChecked: null,
  createdAt: "2026-01-01T00:00:00Z",
  enabled: true,
  lastUsed: null,
} as unknown as Connection;

const health = (over: Partial<McpHealth>): McpHealth => ({
  agentId: "builder",
  server: "Roblox_Studio",
  status: "connected",
  transport: "stdio",
  tools: 17,
  toolNames: [],
  serverVersion: null,
  error: null,
  cause: null,
  lastResponseAt: new Date(Date.now() - 1200).toISOString(),
  lastCheckedAt: new Date().toISOString(),
  sessionPid: 900,
  restarts: [],
  reconnecting: false,
  ...over,
});

const sup: McpSupervision = {
  sessions: [health({})],
  probes: [],
  sessionPids: [["builder", 900]],
  sessionChildren: [{ agentId: "builder", pid: 12345, parentPid: 900, name: "cmd.exe" }],
};

let current: McpSupervision = sup;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => Promise.resolve(cmd === "mcp_supervision" ? current : cmd === "restart_mcp" ? ["builder"] : null)),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

beforeAll(() => {
  useStore.getState().loadSnapshot({
    info: { id: "p", name: "P", root: "C:/p", createdAt: "", formatVersion: 1 },
    settings: {},
    agents: [],
    tasks: [],
    missions: [],
    connections: [roblox],
    pendingPermissions: [],
    repo: null,
    recovery: null,
    emergency: false,
  } as unknown as ProjectSnapshot);
});

afterEach(cleanup);

describe("MCP supervision", () => {
  it("groups session reports and probes by server", () => {
    const cards = serverCards(
      { ...sup, probes: [{ connectionId: "roblox", name: "Roblox_Studio", at: "", ok: true, transport: "stdio", serverName: null, serverVersion: null, tools: 17, resources: 0, prompts: null, latencyMs: 40, error: null, stderrTail: [], probes: 1 }] },
      [roblox],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].connection?.id).toBe("roblox");
    expect(cards[0].sessions).toHaveLength(1);
    expect(cards[0].probe?.tools).toBe(17);
    expect(cardState(cards[0])).toEqual({ label: "Connected", tone: "green", cause: null });
  });

  it("says plainly when nothing reports a server", () => {
    const [c] = serverCards({ ...sup, sessions: [], sessionChildren: [] }, [roblox]);
    expect(cardState(c).label).toBe("Not running in any session");
    const failed = serverCards({ ...sup, sessions: [health({ status: "failed", cause: "Process exited unexpectedly" })] }, [roblox])[0];
    expect(cardState(failed)).toEqual({ label: "MCP unavailable", tone: "red", cause: "Process exited unexpectedly" });
  });

  it("shows the live card and asks the session to reconnect", async () => {
    current = sup;
    render(<McpSupervisionPanel />);
    await waitFor(() => expect(screen.getByText("Roblox_Studio")).toBeTruthy());
    expect(screen.getByText(/PID 12345 · stdio · Tools 17/)).toBeTruthy();
    expect(screen.getByText(/Restarts 0/)).toBeTruthy();
    fireEvent.click(screen.getByText("Restart"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("restart_mcp", { server: "Roblox_Studio", agentId: null }));
  });

  it("shows the cause of a failure", async () => {
    current = { ...sup, sessions: [health({ status: "failed", error: "Connection closed", cause: "Process exited unexpectedly" })] };
    render(<McpSupervisionPanel />);
    await waitFor(() => expect(screen.getByText("MCP unavailable")).toBeTruthy());
    expect(screen.getByText("Process exited unexpectedly")).toBeTruthy();
  });
});
