// Project format compatibility: banners, report rows, migration integrity lines (pure, tested).

import type { CompatibilityReport, CompatStatus } from "./types";

export type CompatBanner =
  | { kind: "read_only"; minimum: string; notes: string[] }
  | { kind: "newer_format"; notes: string[] }
  | null;

/** Banner shown under the top bar: read-only wins over the "newer format" info. */
export function compatBanner(readOnly: boolean, report: CompatibilityReport | null): CompatBanner {
  if (readOnly) {
    return { kind: "read_only", minimum: report?.minimumNexusVersion ?? "a newer version", notes: report?.notes ?? [] };
  }
  if (report?.status === "newer_format") return { kind: "newer_format", notes: report.notes };
  return null;
}

export const COMPAT_STATUS: Record<CompatStatus, { label: string; tone: "green" | "amber" | "blue" | "red" }> = {
  compatible: { label: "Compatible", tone: "green" },
  migration_available: { label: "Migration available", tone: "amber" },
  newer_format: { label: "Newer format (fields preserved)", tone: "blue" },
  requires_newer_nexus: { label: "Requires a newer NEXUS", tone: "red" },
};

export interface CompatRow {
  label: string;
  value: string;
  /** Highlighted when the project is ahead of / behind this NEXUS. */
  warn?: boolean;
}

function orUnknown(v: string | number | null): string {
  return v === null || v === "" ? "unknown" : String(v);
}

export function compatRows(r: CompatibilityReport): CompatRow[] {
  return [
    { label: "Project format", value: `${r.projectFormat} (supported ${r.supportedFormat})`, warn: r.projectFormat !== r.supportedFormat },
    { label: "This NEXUS", value: r.appVersion },
    { label: "Created with", value: orUnknown(r.createdWith) },
    { label: "Last opened with", value: orUnknown(r.lastOpenedWith) },
    { label: "Minimum NEXUS", value: r.minimumNexusVersion ?? "none" },
    {
      label: "Database schema",
      value: `${orUnknown(r.databaseSchema)} (supported ${r.supportedDatabaseSchema})`,
      warn: r.databaseSchema !== null && r.databaseSchema !== r.supportedDatabaseSchema,
    },
    { label: "Unknown fields", value: r.unknownFields.length === 0 ? "none" : r.unknownFields.join(", "), warn: r.unknownFields.length > 0 },
  ];
}

/** Integrity lines start with "ok:" or "error:"; anything else is shown as-is (neutral). */
export function integrityLine(line: string): { state: "ok" | "error" | "info"; text: string } {
  const m = /^(ok|error):\s*(.*)$/i.exec(line);
  if (!m) return { state: "info", text: line };
  return { state: m[1].toLowerCase() as "ok" | "error", text: m[2] };
}

export const ROLLBACK_NOTICE =
  "The project was restored to its previous format from the backup and closed. Opening it again with this NEXUS migrates it again; open it with the older NEXUS to keep the previous format.";
