// Wording for permission requests and their outcomes (pure, tested).

import type { Tone } from "./labels";
import type { PermissionOutcome, PermissionRecord, PermissionStatus, PermissionStatusReport } from "./types";
import { lazyLabels, t } from "../i18n";

export const staleHeadline = () => t("perm.staleHeadline");
export const checkingText = () => t("perm.checking");

export const STATUS_LABEL: Record<PermissionStatus, string> = lazyLabels({
  pending: "perm.status.pending",
  approved: "perm.status.approved",
  denied: "perm.status.denied",
  expired: "perm.status.expired",
  cancelled: "perm.status.cancelled",
  consumed: "perm.status.consumed",
  lost: "perm.status.lost",
  recovered: "perm.status.recovered",
});

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
      return { text: t("perm.risk.destructive"), tone: "red" };
    case "outside_workspace":
      return { text: t("perm.risk.outside"), tone: "amber" };
    case "approval":
      return { text: t("perm.risk.approval"), tone: "blue" };
    default:
      return { text: t("perm.risk.capability"), tone: "amber" };
  }
}

/** "expires in 12 min" / "expires now" / null when it never expires. */
export function expiryText(expiresAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const min = Math.round((at - now) / 60_000);
  if (min <= 0) return t("perm.expiresNow");
  if (min < 60) return t("perm.expiresMin", { min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? t("perm.expiresHoursMin", { h, min: m }) : t("perm.expiresHours", { h });
}

/** A decision that did not apply means the card the user acted on was stale. */
export function isStale(o: PermissionOutcome): boolean {
  return !o.applied;
}

/** Toast after a decision that applied now. */
export function appliedText(o: PermissionOutcome): string {
  return o.message || (o.status === "denied" ? t("perm.denied") : t("perm.approved"));
}

/** Lines shown under the explanation of a stale request. */
export function reportDetails(r: PermissionStatusReport): string[] {
  const lines: string[] = [];
  if (r.executionDetail) lines.push(r.executionDetail);
  if (r.found && r.record?.resolution) lines.push(t("perm.reason", { reason: r.record.resolution }));
  if (r.found && r.sessionAlive && !r.sameSession && r.record?.kind === "tool") {
    lines.push(t("perm.newerSession"));
  }
  if (r.canRerequest) lines.push(t("perm.canRerequest"));
  return lines;
}

/** Short identity of a request (tool and touched resource). */
export function requestTitle(r: Pick<PermissionRecord, "toolName" | "resource">): string {
  return r.resource ? `${r.toolName} · ${r.resource}` : r.toolName;
}
