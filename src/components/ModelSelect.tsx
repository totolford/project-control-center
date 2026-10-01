import { memo } from "react";
import { modelLabel, modelValue } from "../lib/claudeEnv";
import { useModels } from "../state/claude";

/** Model picker over the models Claude Code reports; "default" = Claude Code's own default. */
export const ModelSelect = memo(function ModelSelect({
  value,
  onChange,
  disabled,
  label = "Model",
}: {
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const models = useModels();
  const known = models.map((m) => modelValue(m)).filter((v): v is string => v !== null && v !== "default");
  return (
    <select className="mono" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} aria-label={label}>
      <option value="">default</option>
      {models.map((m) => {
        const v = modelValue(m);
        if (!v || v === "default") return null;
        return (
          <option key={v} value={v}>
            {modelLabel(m)} ({v})
          </option>
        );
      })}
      {value && !known.includes(value) && <option value={value}>{value} (not listed by Claude Code)</option>}
    </select>
  );
});
