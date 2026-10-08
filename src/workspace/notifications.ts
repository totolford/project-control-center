// Notifications derived from real timeline events (no local invention).

import type { Tone } from "../lib/labels";
import type { Message, PccEvent, Task } from "../lib/types";
import { t, type MessageKey } from "../i18n";

export type NotificationTarget =
  | { type: "permission"; id: string }
  | { type: "request"; id: string }
  | { type: "agent"; id: string }
  | { type: "task"; id: string }
  | { type: "mission"; id: string }
  | { type: "message"; message: Message };

export interface Notification {
  /** Event id: notifications are ordered and marked read by it. */
  id: number;
  ts: string;
  tone: Tone;
  title: string;
  body: string;
  target: NotificationTarget | null;
}

const TASK_ATTENTION: Record<string, { tone: Tone; label: MessageKey }> = {
  blocked: { tone: "orange", label: "bar.notif.taskBlocked" },
  failed: { tone: "red", label: "bar.notif.taskFailed" },
  review: { tone: "accent", label: "bar.notif.taskReview" },
};

function firstLine(text: string, max = 140): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function fromEvent(e: PccEvent, name: (id: string) => string): Notification | null {
  const p: unknown = e.payload;
  const base = { id: e.id, ts: e.ts };
  switch (e.kind) {
    case "PermissionRequested":
      if (!isRecord(p) || typeof p.id !== "string") return null;
      return { ...base, tone: "amber", title: t("bar.notif.needsPermission", { name: name(String(p.agentId ?? e.agentId ?? "")) }), body: String(p.summary ?? e.summary), target: { type: "permission", id: p.id } };
    case "UserRequested":
      if (!isRecord(p) || typeof p.id !== "string") return null;
      return { ...base, tone: "amber", title: t("bar.req.action", { agent: name(String(p.agentId ?? e.agentId ?? "")) }), body: String(p.title ?? e.summary), target: { type: "request", id: p.id } };
    case "AgentCrashed":
      return { ...base, tone: "red", title: t("bar.notif.crashed", { name: name(e.agentId ?? "") }), body: e.summary, target: e.agentId ? { type: "agent", id: e.agentId } : null };
    case "Error":
      return { ...base, tone: "red", title: t("common.error"), body: e.summary, target: e.agentId ? { type: "agent", id: e.agentId } : null };
    case "AgentCreated":
      return { ...base, tone: "blue", title: t("bar.notif.newAgent"), body: e.summary, target: e.agentId ? { type: "agent", id: e.agentId } : null };
    case "MissionCompleted":
      return { ...base, tone: "green", title: t("bar.notif.missionDone"), body: e.summary, target: e.missionId ? { type: "mission", id: e.missionId } : null };
    case "ReviewRequested":
      return { ...base, tone: "accent", title: t("bar.notif.review"), body: e.summary, target: e.taskId ? { type: "task", id: e.taskId } : null };
    case "TaskFailed":
    case "TaskUpdated": {
      const task = isRecord(p) ? (p as unknown as Task) : null;
      const attention = task ? TASK_ATTENTION[task.status] : undefined;
      if (!task || !attention) return null;
      return { ...base, tone: attention.tone, title: t(attention.label), body: task.title, target: { type: "task", id: task.id } };
    }
    case "AgentMessage": {
      if (!isRecord(p) || typeof p.id !== "string") return null;
      const m = p as unknown as Message;
      return { ...base, tone: "blue", title: `${name(m.from)} → ${name(m.to)}`, body: `${m.kind}: ${firstLine(m.subject ?? m.body)}`, target: { type: "message", message: m } };
    }
    default:
      return null;
  }
}

/** Notifications for timeline events (newest first), skipping repeated task-status updates. */
export function deriveNotifications(events: PccEvent[], name: (id: string) => string): Notification[] {
  const out: Notification[] = [];
  const seenTaskStatus = new Set<string>();
  for (const e of events) {
    const n = fromEvent(e, name);
    if (!n) continue;
    if (n.target?.type === "task" && (e.kind === "TaskUpdated" || e.kind === "TaskFailed")) {
      const key = `${n.target.id}:${n.title}`;
      if (seenTaskStatus.has(key)) continue;
      seenTaskStatus.add(key);
    }
    out.push(n);
  }
  return out;
}

export function unreadCount(list: Notification[], lastReadId: number): number {
  return list.filter((n) => n.id > lastReadId).length;
}
