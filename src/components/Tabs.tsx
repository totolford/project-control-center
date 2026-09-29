import type { ReactNode } from "react";

export interface TabDef<K extends string> {
  key: K;
  label: ReactNode;
}

export function Tabs<K extends string>({ tabs, active, onChange }: { tabs: TabDef<K>[]; active: K; onChange: (k: K) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={t.key === active}
          className={`tab${t.key === active ? " active" : ""}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Segmented control for a small set of exclusive options. */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
}: {
  options: { value: V; label: string; tone?: string }[];
  value: V;
  onChange: (v: V) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          className={`seg${o.value === value ? ` active ${o.tone ?? ""}` : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
