import { memo } from "react";
import { CAPABILITIES } from "../lib/labels";
import type { Access, Capability, PermissionSet } from "../lib/types";
import { Segmented } from "./Tabs";
import { lazyLabels, useT } from "../i18n";

const ACCESS_LABEL = lazyLabels<Access>({ deny: "comp.access.deny", ask: "comp.access.ask", allow: "comp.access.allow" });

const ACCESS_OPTIONS: { value: Access; readonly label: string; tone: string }[] = [
  { value: "deny", tone: "seg-red" },
  { value: "ask", tone: "seg-amber" },
  { value: "allow", tone: "seg-green" },
].map((o) => ({
  ...(o as { value: Access; tone: string }),
  get label() {
    return ACCESS_LABEL[o.value as Access];
  },
}));

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
  const t = useT();
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
                <span className="perm-over" title={t("comp.access.overTitle", { max: ACCESS_LABEL[ceiling?.[c.key] ?? "deny"] })}>
                  {t("comp.access.over")}
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
