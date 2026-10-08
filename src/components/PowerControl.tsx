import { memo } from "react";
import { POWER_LABEL, POWER_LEVELS, detectPower, powerScore } from "../lib/power";
import type { PermissionSet, PowerLevel } from "../lib/types";
import { useT } from "../i18n";

/** LOW → MAXIMUM bar with the preset buttons; "Custom" when the permissions match no preset. */
export const PowerControl = memo(function PowerControl({
  permissions,
  onApply,
  disabled,
  compact,
}: {
  permissions: PermissionSet;
  onApply: (level: PowerLevel) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const level = detectPower(permissions);
  const score = powerScore(permissions);
  return (
    <div className={`power${compact ? " compact" : ""}`}>
      {level === null && <span className="chip tone-amber power-custom-chip">{t("comp.power.custom")}</span>}
      <div className="power-track" title={level ? POWER_LABEL[level] : t("comp.power.custom")}>
        <div className={`power-fill power-${level ?? "custom"}`} style={{ width: `${Math.round(score * 100)}%` }} />
      </div>
      <div className="power-levels" role="radiogroup" aria-label={t("comp.power.aria")}>
        {POWER_LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={level === l}
            className={`power-btn${level === l ? ` active power-${l}` : ""}`}
            onClick={() => onApply(l)}
            disabled={disabled}
            title={t("comp.power.apply", { level: POWER_LABEL[l] })}
          >
            {POWER_LABEL[l]}
          </button>
        ))}
      </div>
    </div>
  );
});
