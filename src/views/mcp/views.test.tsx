import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Connection, ProjectSnapshot, Skill } from "../../lib/types";
import { useStore } from "../../store";
import { McpView } from "./McpView";
import { SkillsView } from "../skills/SkillsView";
import { Connections } from "../Connections";

const mcpConn: Connection = {
  id: "fs",
  name: "Filesystem",
  kind: "mcp",
  config: { transport: "stdio", command: "npx", args: ["-y", "fs"], env: {}, secretEnv: ["TOKEN"] },
  credentialRef: "ref",
  status: "connected",
  statusDetail: "MCP connected",
  lastChecked: null,
  createdAt: "2026-01-01T00:00:00Z",
  enabled: true,
  lastUsed: null,
};

const skill: Skill = {
  id: "deploy",
  name: "deploy",
  description: "Deploys the app",
  scope: "project",
  source: null,
  enabled: true,
  editable: true,
  dir: "C:/p/.claude/skills/deploy",
  frontmatter: { name: "deploy", "metadata.requires-mcp": "missing-server" },
  allowedTools: ["Bash"],
  files: ["SKILL.md"],
  problems: [],
};

const responses: Record<string, unknown> = {
  claude_environment: {
    capturedAt: "2026-01-01T00:00:00Z",
    commands: [{ name: "deploy" }],
    plugins: [],
    unavailable: [],
    mcpServers: [{ name: "github", status: "failed", error: "boom", config: { type: "http", url: "https://x", headers: { Authorization: "Bearer SECRET" } }, scope: "user", source: "user" }],
  },
  list_skills: [skill],
  list_events: [],
  connection_secret_keys: ["TOKEN"],
  update_connection: { ...mcpConn, enabled: false, status: "unknown" },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => Promise.resolve(responses[cmd] ?? null)),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

beforeAll(() => {
  useStore.getState().loadSnapshot({
    info: { id: "p", name: "P", root: "C:/p", createdAt: "", formatVersion: 1 },
    settings: {},
    agents: [],
    tasks: [],
    missions: [],
    connections: [mcpConn],
    pendingPermissions: [],
    repo: null,
    recovery: null,
    emergency: false,
  } as unknown as ProjectSnapshot);
});

afterEach(cleanup);

describe("tool views", () => {
  it("lists NEXUS and Claude Code MCP servers without showing secret values", async () => {
    const { container } = render(<McpView />);
    expect(screen.getByText("Filesystem")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("github")).toBeTruthy());
    fireEvent.click(screen.getByText("github"));
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getAllByText("Not exposed by Claude Code").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("SECRET");
    fireEvent.click(screen.getByText("Filesystem"));
    expect(screen.getByText("Not tested yet")).toBeTruthy();
  });

  it("shows skills with discovery and missing requirements", async () => {
    render(<SkillsView />);
    await waitFor(() => expect(screen.getByText("deploy")).toBeTruthy());
    fireEvent.click(screen.getByText("deploy"));
    expect(document.querySelector(".tools-req.tone-red-fg")?.textContent).toContain("missing-server");
    expect(screen.getByText("Yes, Claude Code lists it")).toBeTruthy();
  });

  it("renders connection cards with secret names only", async () => {
    render(<Connections />);
    expect(screen.getByText("Filesystem")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/secrets in Credential Manager \(TOKEN\)/)).toBeTruthy());
    expect(screen.getByText(/mcp__fs__\*/)).toBeTruthy();
  });

  it("disconnects a connection without touching its secrets", async () => {
    render(<Connections />);
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() => expect(screen.getByText("Connect")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("update_connection", {
      id: "fs",
      input: { name: "Filesystem", kind: "mcp", config: mcpConn.config, enabled: false },
    });
    expect(useStore.getState().project?.connections[0].enabled).toBe(false);
  });
});
