// Wording for permission requests and their outcomes (pure, tested).

import type { Tone } from "./labels";
import type { PermissionOutcome, PermissionRecord, PermissionStatus, PermissionStatusReport } from "./types";

export const STALE_HEADLINE = "This permission request is no longer available.";
export const CHECKING_TEXT = "Checking the agent's real state…";

export const STATUS_LABEL: Record<PermissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
  consumed: "Approved · delivered",
  lost: "Lost",
  recovered: "Recovered",
};

export const STATUS_TONE: Record<PermissionStatus, Tone> = {
  pending: "amber",
  approved: "green",
  denied: "red",
  expired: "grey",
  cancelled: "grey",
  consumed: "green",
  lost: "red",
  recovered: "blue",
};

export function riskLabel(risk: string | null | undefined): { text: string; tone: Tone } {
  switch (risk) {
    case "destructive":
      return { text: "Destructive", tone: "red" };
    case "outside_workspace":
      return { text: "Outside the project", tone: "amber" };
    case "approval":
      return { text: "Needs approval", tone: "blue" };
    default:
      return { text: "Capability", tone: "amber" };
  }
}

/** "expires in 12 min" / "expires now" / null when it never expires. */
export function expiryText(expiresAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const min = Math.round((at - now) / 60_000);
  if (min <= 0) return "expires now";
  if (min < 60) return `expires in ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `expires in ${h} h${m ? ` ${m} min` : ""}`;
}

/** A decision that did not apply means the card the user acted on was stale. */
export function isStale(o: PermissionOutcome): boolean {
  return !o.applied;
}

/** Toast after a decision that applied now. */
export function appliedText(o: PermissionOutcome): string {
  return o.message || (o.status === "denied" ? "Denied." : "Approved.");
}

/** Lines shown under the explanation of a stale request. */
export function reportDetails(r: PermissionStatusReport): string[] {
  const lines: string[] = [];
  if (r.executionDetail) lines.push(r.executionDetail);
  if (r.found && r.record?.resolution) lines.push(`Reason: ${r.record.resolution}.`);
  if (r.found && r.sessionAlive && !r.sameSession && r.record?.kind === "tool") {
    lines.push("The agent is running in a newer session than the one that asked.");
  }
  if (r.canRerequest) lines.push("You can ask the agent to try again; a new request will be shown if it still needs it.");
  return lines;
}

/** Short identity of a request (tool and touched resource). */
export function requestTitle(r: Pick<PermissionRecord, "toolName" | "resource">): string {
  return r.resource ? `${r.toolName} · ${r.resource}` : r.toolName;
}
