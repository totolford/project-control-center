import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { CapabilityReport } from "../../lib/centralTypes";
import type { LogEntry, ProjectSnapshot } from "../../lib/types";
import { powerPreset } from "../../lib/power";
import { makeAgent, makeSettings, makeSnapshot } from "../../test/fixtures";
import { useStore } from "../../store";
import { RecoveryDialog } from "../../components/RecoveryDialog";
import { CentralAutonomySettings, RecoverySettings } from "../settings/RecoverySettings";
import { findReport } from "../ai/CapabilityPanel";
import { buildChat, parseResumeReport } from "./chatModel";
import { ResumeCard, SupervisorNote } from "./CentralCards";
import { autonomyOf, nudgeLimit } from "./centralLogic";
import { affectsCentral } from "./centralState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

afterEach(cleanup);

// The text crates/pcc-orchestrator/src/resume.rs renders (ResumeReport::render).
const REPORT = `[NEXUS RESUME REPORT]
Control Center recovered.
Mission: M-0002 "Port the scripts" (active)
Previous state: NEXUS ended unexpectedly — interrupted during TASK-0003 "Step TASK-0003" (builder)
Verified progress: 71/142 tasks completed and verified
Files: 140/140 files reported by completed tasks are on disk
Repository: branch main · HEAD 1a2b3c4 · 2 uncommitted file(s): src/a.lua, src/b.lua
MCP: Roblox Studio ✓ connected (12 tools) · github ✗ failed: timeout · docs ? not verified yet
Claude: Central session recovered (--resume)
Agents: Central (commander) working; Builder (specialist) working · TASK-0003 → restarted (--resume)
Last action: builder — Editing Workspace.Script (10:04:12)
Done: TASK-0001 "Step 1"; TASK-0002 "Step 2"
Remaining: TASK-0003 "Step 3" in_progress (builder)
Next action: Continue TASK-0003 "Step 3" with builder from where it stopped (inspect its files before redoing anything).

Continue this mission from the verified point: do not restart it and do not redo completed work.`;

function input(id: number, text: string): LogEntry {
  return { id, agentId: "central", sessionId: 1, ts: "2026-10-08T10:05:00Z", kind: "input", text };
}

describe("resume report in the chat", () => {
  it("parses the verified report NEXUS sends Central", () => {
    const r = parseResumeReport(REPORT)!;
    expect(r.recovered).toBe(true);
    expect(r.nothing).toBe(false);
    expect(r.progress).toEqual({ verified: 71, total: 142 });
    expect(r.mcp).toEqual([
      { server: "Roblox Studio", state: "ok", detail: "connected (12 tools)" },
      { server: "github", state: "failed", detail: "failed: timeout" },
      { server: "docs", state: "unknown", detail: "not verified yet" },
    ]);
    expect(r.facts.find((f) => f.label === "Next action")?.value).toMatch(/^Continue TASK-0003/);
    expect(r.instruction).toMatch(/^Continue this mission from the verified point/);
    expect(parseResumeReport("hello")).toBeNull();
  });

  it("turns the system message into a resume card and the user's words into a user message", () => {
    const text = `[MESSAGE msg-1 · from user · user]\nreprends\n\n---\n\n[MESSAGE msg-2 · from system · system]\n${REPORT}`;
    const items = buildChat([input(1, text), input(2, "[MESSAGE msg-3 · from system · system]\n[NEXUS SUPERVISOR] Your turn ended while the mission is still running.")]);
    expect(items.map((i) => i.type)).toEqual(["user", "resume", "supervisor"]);
    const nothing = buildChat([input(3, "[MESSAGE msg-4 · from system · system]\n[NEXUS RESUME REPORT]\nNothing to resume: no running or interrupted mission was found.\nLast mission: none in this project\nNext action: Tell the user.")]);
    expect(nothing[0].type === "resume" && nothing[0].report.nothing).toBe(true);
  });

  it("renders the recovery card with progress, MCP state and the next action", () => {
    render(<ResumeCard report={parseResumeReport(REPORT)!} ts="2026-10-08T10:05:00Z" />);
    expect(screen.getByText("Control Center recovered")).toBeTruthy();
    expect(screen.getByText("Verified progress 71/142")).toBeTruthy();
    expect(screen.getByText("MCP Roblox Studio")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("71");
    expect(screen.getByText(/^Continue TASK-0003/).className).toBe("is-next");
    // The instruction to Central is folded away.
    expect(screen.queryByText(/do not redo completed work/)).toBeNull();
    fireEvent.click(screen.getByText("Instruction given to Central"));
    expect(screen.getByText(/do not redo completed work/)).toBeTruthy();
  });

  it("folds supervisor reminders", () => {
    render(<SupervisorNote text="Mission M-1 is still open." ts="2026-10-08T10:05:00Z" />);
    expect(screen.getByText(/Mission supervisor/)).toBeTruthy();
  });
});

describe("autonomy", () => {
  it("mirrors the backend presets and reminder limits", () => {
    expect(autonomyOf(powerPreset("low"))).toEqual({ level: "low", label: "LOW", reminders: 0 });
    expect(autonomyOf(powerPreset("maximum"))).toEqual({ level: "maximum", label: "MAXIMUM", reminders: 6 });
    expect(nudgeLimit(null)).toBe(2);
    expect(nudgeLimit("high")).toBe(4);
  });

  it("refreshes on the events that change Central's state", () => {
    expect(affectsCentral({ name: "mission.blocked", agentId: "central", kind: "SystemNotice" })).toBe(true);
    expect(affectsCentral({ name: "supervisor.stopped", agentId: "central", kind: "SystemNotice" })).toBe(true);
    expect(affectsCentral({ name: "tool.used", agentId: "builder", kind: "ToolUsed" })).toBe(false);
  });

  it("shows Central's level in Settings and applies a preset", async () => {
    useStore.getState().loadSnapshot(makeSnapshot({ agents: [makeAgent("central", { kind: "central", permissions: powerPreset("high") })] }) as ProjectSnapshot);
    render(<CentralAutonomySettings />);
    expect(screen.getByTestId("autonomy-explain").textContent).toMatch(/^HIGH — .*Up to 4 supervisor reminders/);
    fireEvent.click(screen.getByText("MAXIMUM"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("apply_power", { agentId: "central", level: "maximum" }));
  });
});

describe("Settings → Missions → Recovery", () => {
  it("defaults every switch to on for older projects and edits the draft", () => {
    const onChange = vi.fn();
    render(<RecoverySettings value={undefined} onChange={onChange} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(6);
    expect(boxes.every((b) => b.checked)).toBe(true);
    fireEvent.click(screen.getByLabelText(/Auto-resume missions after crash/));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ autoResumeMissions: false, autoReconnectMcp: true, validateFilesBeforeResume: true }));
  });

  it("resumes now through the resume service", async () => {
    render(<RecoverySettings value={undefined} onChange={() => undefined} />);
    fireEvent.click(screen.getByText("Resume now"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("central_resume", { missionId: null }));
  });

  it("shows an automatic resume as a notice, not a blocking dialog", async () => {
    useStore.getState().loadSnapshot(
      makeSnapshot({
        settings: makeSettings(),
        recovery: {
          agents: [],
          missions: [],
          autoResumed: { missionId: "M-0001", title: "Ship it", summary: 'M-0001 "Ship it": verified progress 3/5 tasks · Next: Review TASK-4', ok: true, at: "2026-10-08T10:00:00Z" },
        },
      }) as ProjectSnapshot,
    );
    render(<RecoveryDialog />);
    expect(screen.getByTestId("auto-resume-notice")).toBeTruthy();
    expect(screen.getByText("Mission resumed automatically")).toBeTruthy();
    expect(screen.queryByText("Resume")).toBeNull();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("central_dismiss_auto_resume"));
    await waitFor(() => expect(useStore.getState().project?.recovery).toBeNull());
  });
});

describe("capability test", () => {
  const report = (model: string): CapabilityReport => ({
    runtime: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model,
    at: "2026-10-08T10:00:00Z",
    results: [],
    centralMode: "limited_tools",
    summary: "",
  });
  it("finds the stored report of the configured model", () => {
    expect(findReport([report("llama3:latest")], "ollama", "llama3")?.model).toBe("llama3:latest");
    expect(findReport([report("llama3:latest")], "lmstudio", "llama3")).toBeNull();
    expect(findReport([report("qwen3:8b")], "ollama", null)).toBeNull();
  });
});
