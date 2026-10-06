import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { CrashReport, InterruptedMission, ProjectSnapshot } from "../lib/types";
import { useStore } from "../store";
import { RecoveryDialog } from "./RecoveryDialog";
import { CrashReportNotice, pendingReports } from "./CrashReportNotice";
import { OrphanNotice } from "./OrphanNotice";

const report = (over: Partial<CrashReport>): CrashReport => ({
  id: "CR-1",
  at: "2026-01-01T00:00:00.000Z",
  title: "NEXUS recovered from an unexpected failure",
  component: "nexus",
  severity: "error",
  whatHappened: "The NEXUS instance ended without closing.",
  possibleCause: "Crash or reboot.",
  preserved: ["Tasks"],
  restarted: [],
  lost: ["The turn in progress"],
  details: [],
  agentId: null,
  missionId: null,
  project: null,
  acknowledged: false,
  source: "project",
  ...over,
});

let reports: CrashReport[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(
      cmd === "crash_reports"
        ? reports
        : cmd === "mission_checkpoints"
          ? []
          : cmd === "recovery_state"
            ? { project: { orphans: [{ pid: 4242, kind: "claude_session", label: "Claude Code session of builder", reason: "no NEXUS parent", agentId: "builder" }] } }
            : cmd === "cleanup_orphan"
              ? { orphan: {}, steps: [{ step: "State check", outcome: "pid 4242 is still running" }], terminated: true, alreadyGone: false, modifiedFiles: [], sessionId: null }
              : null,
    ),
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const mission: InterruptedMission = {
  missionId: "M-0001",
  title: "Ship it",
  status: "active",
  interruptedDuring: 'TASK-0002 "Patch the script" (builder)',
  lastAction: { agentId: "builder", tool: "mcp__Roblox_Studio__get_script", description: "Reading Workspace.X.Script", at: "2026-01-01T10:00:00Z" },
  filesSinceCheckpoint: [],
  filesNote: "No file was written since the last checkpoint.",
  lastCheckpoint: { seq: 3, name: "checkpoint-003.json", at: "2026-01-01T09:58:00Z", reason: "periodic", status: "active", currentStep: "", files: 0 },
  tasksInProgress: [],
  agents: [],
  previousRun: "NEXUS ended unexpectedly",
  brief: "[RECOVERY] Mission M-0001",
};

function load(recovery: unknown) {
  useStore.getState().loadSnapshot({
    info: { id: "p", name: "P", root: "C:/p", createdAt: "", formatVersion: 1 },
    settings: {},
    agents: [],
    tasks: [],
    missions: [],
    connections: [],
    pendingPermissions: [],
    repo: null,
    recovery,
    emergency: false,
  } as unknown as ProjectSnapshot);
}

afterEach(cleanup);

describe("recovery UI", () => {
  it("asks about an interrupted mission with the recorded facts", async () => {
    load({ agents: [{ agentId: "central", name: "Central", claudeSessionId: "s", taskId: null }], missions: [mission], previousRun: "NEXUS ended unexpectedly" });
    render(<RecoveryDialog />);
    expect(screen.getByText("Mission Ship it was interrupted")).toBeTruthy();
    expect(screen.getByText(/Reading Workspace.X.Script/)).toBeTruthy();
    expect(screen.getByText("No file was written since the last checkpoint.")).toBeTruthy();
    fireEvent.click(screen.getByText("Inspect"));
    await waitFor(() => expect(screen.getByText("No checkpoint recorded.")).toBeTruthy());
    fireEvent.click(screen.getByText("Resume"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("resume_interrupted_mission", { id: "M-0001" }));
    await waitFor(() => expect(useStore.getState().project?.recovery).toBeNull());
  });

  it("keeps a mission-only recovery from the snapshot", () => {
    load({ agents: [], missions: [mission] });
    expect(useStore.getState().project?.recovery?.missions?.length).toBe(1);
  });

  it("shows each unacknowledged engine report once", async () => {
    load(null);
    reports = [report({}), report({ id: "UI-1", source: "interface" }), report({ id: "CR-0", acknowledged: true })];
    expect(pendingReports(reports).map((r) => r.id)).toEqual(["CR-1"]);
    render(<CrashReportNotice />);
    await waitFor(() => expect(screen.getByText("NEXUS recovered from an unexpected failure")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Dismiss report"));
    expect(invoke).toHaveBeenCalledWith("acknowledge_crash_report", { id: "CR-1" });
    expect(screen.queryByText("NEXUS recovered from an unexpected failure")).toBeNull();
  });

  it("offers orphan cleanup and never stops anything by itself", async () => {
    load(null);
    render(<OrphanNotice />);
    await waitFor(() => expect(screen.getByText(/1 process left by a previous NEXUS run/)).toBeTruthy());
    expect(invoke).not.toHaveBeenCalledWith("cleanup_orphan", expect.anything());
    fireEvent.click(screen.getByText("Clean up"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("cleanup_orphan", { pid: 4242 }));
    await waitFor(() => expect(screen.queryByText(/process left by a previous NEXUS run/)).toBeNull());
  });
});
