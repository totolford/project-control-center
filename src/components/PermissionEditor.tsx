import { memo } from "react";
import { CAPABILITIES } from "../lib/labels";
import type { Access, Capability, PermissionSet } from "../lib/types";
import { Segmented } from "./Tabs";

const ACCESS_OPTIONS: { value: Access; label: string; tone: string }[] = [
  { value: "deny", label: "Deny", tone: "seg-red" },
  { value: "ask", label: "Ask", tone: "seg-amber" },
  { value: "allow", label: "Allow", tone: "seg-green" },
];

const RANK: Record<Access, number> = { deny: 0, ask: 1, allow: 2 };

/** Edits a PermissionSet: one deny/ask/allow control per capability. */
export const PermissionEditor = memo(function PermissionEditor({
  value,
  onChange,
  disabled,
  ceiling,
}: {
  value: PermissionSet;
  onChange: (next: PermissionSet) => void;
  disabled?: boolean;
  /** Optional upper bound; capabilities above it are flagged (the backend clamps them). */
  ceiling?: PermissionSet;
}) {
  const set = (cap: Capability, access: Access) => onChange({ ...value, [cap]: access });
  return (
    <div className="perm-grid">
      {CAPABILITIES.map((c) => {
        const current: Access = value[c.key] ?? "deny";
        const over = ceiling ? RANK[current] > RANK[ceiling[c.key] ?? "deny"] : false;
        return (
          <div className="perm-row" key={c.key} data-capability={c.key}>
            <div className="perm-name">
              <span className="perm-group">{c.group}</span>
              <span>{c.label}</span>
              {over && (
                <span className="perm-over" title={`Exceeds project maximum (${ceiling?.[c.key]})`}>
                  above max
                </span>
              )}
            </div>
            <Segmented options={ACCESS_OPTIONS} value={current} onChange={(a) => set(c.key, a)} disabled={disabled} label={c.label} />
          </div>
        );
      })}
    </div>
  );
});
