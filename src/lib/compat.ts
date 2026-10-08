// Project format compatibility: banners, report rows, migration integrity lines (pure, tested).

import type { CompatibilityReport, CompatStatus } from "./types";
import { lazyLabels, t } from "../i18n";

export type CompatBanner =
  | { kind: "read_only"; minimum: string; notes: string[] }
  | { kind: "newer_format"; notes: string[] }
  | null;

/** Banner shown under the top bar: read-only wins over the "newer format" info. */
export function compatBanner(readOnly: boolean, report: CompatibilityReport | null): CompatBanner {
  if (readOnly) {
    return { kind: "read_only", minimum: report?.minimumNexusVersion ?? t("compat.aNewerVersion"), notes: report?.notes ?? [] };
  }
  if (report?.status === "newer_format") return { kind: "newer_format", notes: report.notes };
  return null;
}

const COMPAT_LABEL = lazyLabels<CompatStatus>({
  compatible: "compat.status.compatible",
  migration_available: "compat.status.migration_available",
  newer_format: "compat.status.newer_format",
  requires_newer_nexus: "compat.status.requires_newer_nexus",
});

const COMPAT_TONE: Record<CompatStatus, "green" | "amber" | "blue" | "red"> = {
  compatible: "green",
  migration_available: "amber",
  newer_format: "blue",
  requires_newer_nexus: "red",
};

export const COMPAT_STATUS: Record<CompatStatus, { readonly label: string; tone: "green" | "amber" | "blue" | "red" }> = Object.fromEntries(
  (Object.keys(COMPAT_TONE) as CompatStatus[]).map((s) => [
    s,
    {
      tone: COMPAT_TONE[s],
      get label() {
        return COMPAT_LABEL[s];
      },
    },
  ]),
) as Record<CompatStatus, { readonly label: string; tone: "green" | "amber" | "blue" | "red" }>;

export interface CompatRow {
  label: string;
  value: string;
  /** Highlighted when the project is ahead of / behind this NEXUS. */
  warn?: boolean;
}

function orUnknown(v: string | number | null): string {
  return v === null || v === "" ? t("compat.unknown") : String(v);
}

export function compatRows(r: CompatibilityReport): CompatRow[] {
  return [
    {
      label: t("compat.row.projectFormat"),
      value: t("compat.supported", { value: String(r.projectFormat), supported: String(r.supportedFormat) }),
      warn: r.projectFormat !== r.supportedFormat,
    },
    { label: t("compat.row.thisNexus"), value: r.appVersion },
    { label: t("compat.row.createdWith"), value: orUnknown(r.createdWith) },
    { label: t("compat.row.lastOpenedWith"), value: orUnknown(r.lastOpenedWith) },
    { label: t("compat.row.minimum"), value: r.minimumNexusVersion ?? t("compat.none") },
    {
      label: t("compat.row.schema"),
      value: t("compat.supported", { value: orUnknown(r.databaseSchema), supported: String(r.supportedDatabaseSchema) }),
      warn: r.databaseSchema !== null && r.databaseSchema !== r.supportedDatabaseSchema,
    },
    { label: t("compat.row.unknownFields"), value: r.unknownFields.length === 0 ? t("compat.none") : r.unknownFields.join(", "), warn: r.unknownFields.length > 0 },
  ];
}

/** Integrity lines start with "ok:" or "error:"; anything else is shown as-is (neutral). */
export function integrityLine(line: string): { state: "ok" | "error" | "info"; text: string } {
  const m = /^(ok|error):\s*(.*)$/i.exec(line);
  if (!m) return { state: "info", text: line };
  return { state: m[1].toLowerCase() as "ok" | "error", text: m[2] };
}

export const rollbackNotice = () => t("compat.rollbackNotice");
