// Visual state of an agent panel, derived only from real agent/task data.

import type { Tone } from "../lib/labels";
import type { Agent, Task } from "../lib/types";

export type VisualState =
  | "working"
  | "thinking"
  | "starting"
  | "awaiting_permission"
  | "waiting"
  | "blocked"
  | "review"
  | "completed"
  | "error"
  | "disconnected"
  | "offline"
  | "stopped"
  | "retired";

export const VISUAL_STATE: Record<VisualState, { label: string; tone: Tone; pulse?: boolean }> = {
  working: { label: "Working", tone: "green", pulse: true },
  thinking: { label: "Thinking", tone: "green", pulse: true },
  starting: { label: "Starting", tone: "amber" },
  awaiting_permission: { label: "Awaiting permission", tone: "amber", pulse: true },
  waiting: { label: "Waiting", tone: "blue" },
  blocked: { label: "Blocked", tone: "orange" },
  review: { label: "Review", tone: "accent" },
  completed: { label: "Completed", tone: "green" },
  error: { label: "Error", tone: "red" },
  disconnected: { label: "Disconnected", tone: "orange" },
  offline: { label: "Offline", tone: "grey" },
  stopped: { label: "Stopped", tone: "grey" },
  retired: { label: "Retired", tone: "dim" },
};

export interface StateInputs {
  agent: Pick<Agent, "status" | "currentAction">;
  /** The agent's current task, if any. */
  currentTask?: Pick<Task, "status"> | null;
  /** The agent's most recently updated task. */
  lastTask?: Pick<Task, "status"> | null;
  /** The last finished turn of the session ended in an error. */
  lastTurnError?: boolean;
}

export function deriveVisualState({ agent, currentTask, lastTask, lastTurnError }: StateInputs): VisualState {
  switch (agent.status) {
    case "retired":
      return "retired";
    case "crashed":
      return "error";
    case "disconnected":
      return "disconnected";
    case "awaiting_permission":
      return "awaiting_permission";
    case "starting":
      return "starting";
    case "working":
      return agent.currentAction === "Thinking" ? "thinking" : "working";
    default:
      break;
  }
  if (lastTurnError) return "error";
  if (currentTask && (currentTask.status === "blocked" || currentTask.status === "waiting")) return "blocked";
  if (currentTask?.status === "review" || (!currentTask && lastTask?.status === "review")) return "review";
  if (agent.status === "stopped") return "stopped";
  if (agent.status === "offline") return !currentTask && lastTask?.status === "completed" ? "completed" : "offline";
  if (!currentTask && lastTask?.status === "completed") return "completed";
  return "waiting";
}

/** Most recently updated task assigned to the agent. */
export function lastTaskOf(tasks: Task[], agentId: string): Task | undefined {
  let best: Task | undefined;
  for (const t of tasks) if (t.agent === agentId && (!best || t.updatedAt > best.updatedAt)) best = t;
  return best;
}
