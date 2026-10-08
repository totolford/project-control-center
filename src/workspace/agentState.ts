// Visual state of an agent panel, derived only from real agent/task data.

import { t, type MessageKey } from "../i18n";
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

type StateMeta = { readonly label: string; tone: Tone; pulse?: boolean };

/** `label` is read at render time, in the current interface language. */
function meta(key: MessageKey, tone: Tone, pulse?: boolean): StateMeta {
  return {
    tone,
    ...(pulse ? { pulse } : {}),
    get label() {
      return t(key);
    },
  };
}

export const VISUAL_STATE: Record<VisualState, StateMeta> = {
  working: meta("vstate.working", "green", true),
  thinking: meta("vstate.thinking", "green", true),
  starting: meta("vstate.starting", "amber"),
  awaiting_permission: meta("vstate.awaiting_permission", "amber", true),
  waiting: meta("vstate.waiting", "blue"),
  blocked: meta("vstate.blocked", "orange"),
  review: meta("vstate.review", "accent"),
  completed: meta("vstate.completed", "green"),
  error: meta("vstate.error", "red"),
  disconnected: meta("vstate.disconnected", "orange"),
  offline: meta("vstate.offline", "grey"),
  stopped: meta("vstate.stopped", "grey"),
  retired: meta("vstate.retired", "dim"),
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
