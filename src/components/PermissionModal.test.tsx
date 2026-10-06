import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PermissionOutcome, PermissionRecord, PermissionStatusReport } from "../lib/types";
import { makeAgent, makeSnapshot } from "../test/fixtures";
import { useStore } from "../store";
import { useUi } from "../state/ui";
import { PermissionModal } from "./PermissionModal";
import { appliedText, expiryText, reportDetails, riskLabel, STALE_HEADLINE } from "../lib/permissionState";
import { isOpenPermission } from "../state/reducer";

const invoke = vi.fn((_cmd: string, _args?: unknown): Promise<unknown> => Promise.resolve(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

function record(patch: Partial<PermissionRecord> = {}): PermissionRecord {
  return {
    id: "perm-1325d8236e24",
    agentId: "ops",
    toolName: "Bash",
    capability: "shell",
    summary: "Bash: rm -rf build",
    input: { command: "rm -rf build" },
    reason: "destructive command",
    ruleKey: "Bash:rm",
    createdAt: "2026-10-03T10:00:00.000Z",
    status: "pending",
    kind: "tool",
    updatedAt: "2026-10-03T10:00:00.000Z",
    expiresAt: null,
    missionId: null,
    taskId: null,
    resource: "rm -rf build",
    risk: "destructive",
    requestedBy: "ops",
    processId: 4242,
    sessionEpoch: 1,
    sessionRow: 1,
    requestId: "req-1",
    toolUseId: null,
    decision: null,
    decidedAt: null,
    decidedBy: null,
    resolution: null,
    recoveries: 0,
    ...patch,
  };
}

const lostReport: PermissionStatusReport = {
  id: "perm-1325d8236e24",
  found: true,
  record: record({ status: "lost", resolution: "the agent was stopped" }),
  explanation: "Lost: the agent's session ended at 2026-10-03 10:05:00 UTC before an answer could be delivered. Ops has no running session (status: Stopped).",
  agentName: "Ops",
  agentStatus: "stopped",
  sessionAlive: false,
  processId: null,
  sameSession: false,
  executed: false,
  executionDetail: "Not executed: the agent never received an approval for this request.",
  canRerequest: true,
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve(null));
  useUi.setState({ permissionsDeferred: false });
  useStore.getState().closeProject();
  useStore.getState().loadSnapshot(makeSnapshot({ agents: [makeAgent("central"), makeAgent("ops", { name: "Ops" })], pendingPermissions: [record()] }));
});
afterEach(cleanup);

describe("permission wording", () => {
  it("labels risks, expiry and outcomes", () => {
    expect(riskLabel("destructive")).toEqual({ text: "Destructive", tone: "red" });
    expect(riskLabel(undefined).text).toBe("Capability");
    const now = Date.parse("2026-10-03T10:00:00Z");
    expect(expiryText(null, now)).toBeNull();
    expect(expiryText("2026-10-03T10:12:00Z", now)).toBe("expires in 12 min");
    expect(expiryText("2026-10-03T11:30:00Z", now)).toBe("expires in 1 h 30 min");
    expect(expiryText("2026-10-03T09:00:00Z", now)).toBe("expires now");
    const applied: PermissionOutcome = { id: "p", applied: true, status: "consumed", message: "Approved.", record: null };
    expect(appliedText(applied)).toBe("Approved.");
    expect(reportDetails(lostReport)).toEqual([
      "Not executed: the agent never received an approval for this request.",
      "Reason: the agent was stopped.",
      "You can ask the agent to try again; a new request will be shown if it still needs it.",
    ]);
    expect(isOpenPermission({ status: "recovered" })).toBe(true);
    expect(isOpenPermission({ status: "lost" })).toBe(false);
  });
});

describe("PermissionModal", () => {
  it("shows risk, resource and process of the request", () => {
    render(<PermissionModal />);
    expect(screen.getByText("Destructive")).toBeTruthy();
    expect(screen.getAllByText("rm -rf build").length).toBeGreaterThan(0);
    expect(screen.getByText(/pid 4242/)).toBeTruthy();
  });

  it("explains a stale request with the agent's real state instead of an error", async () => {
    let answerStatus: (r: PermissionStatusReport) => void = () => undefined;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "resolve_permission") {
        const o: PermissionOutcome = {
          id: "perm-1325d8236e24",
          applied: false,
          status: "lost",
          message: "Lost: the agent's session ended before an answer could be delivered.",
          record: null,
        };
        return Promise.resolve(o);
      }
      if (cmd === "permission_status") return new Promise((res) => (answerStatus = res));
      if (cmd === "rerequest_permission") return Promise.resolve("Asked ops to request it again if it still needs it.");
      return Promise.resolve(null);
    });
    render(<PermissionModal />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    });
    // Immediately: no raw "not found", a clear headline and the lookup in progress.
    expect(screen.getByText(STALE_HEADLINE)).toBeTruthy();
    expect(screen.getByText("Checking the agent's real state…")).toBeTruthy();
    expect(screen.queryByText(/not found/i)).toBeNull();
    await act(async () => {
      answerStatus(lostReport);
    });
    expect(screen.queryByText("Checking the agent's real state…")).toBeNull();
    expect(screen.getByText(lostReport.explanation)).toBeTruthy();
    expect(screen.getByText("Lost")).toBeTruthy();
    expect(screen.getByText(/Not executed/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Ask the agent again/ }));
    });
    expect(invoke).toHaveBeenCalledWith("rerequest_permission", { id: "perm-1325d8236e24" });
    expect(screen.queryByText(STALE_HEADLINE)).toBeNull();
  });

  it("says when the state cannot be checked", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "resolve_permission") {
        return Promise.resolve({ id: "x", applied: false, status: null, message: "This permission request is no longer available: x is not known in this project.", record: null });
      }
      if (cmd === "permission_status") return Promise.reject("No project is open");
      return Promise.resolve(null);
    });
    render(<PermissionModal />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    });
    expect(screen.getByText(/could not be checked: No project is open/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ask the agent again/ })).toBeNull();
  });
});
