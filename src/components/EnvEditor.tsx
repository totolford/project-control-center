import { useEffect, useState } from "react";
import { Plus, Save, TriangleAlert, X } from "lucide-react";
import { Spinner } from "./Common";

type Row = { key: string; value: string };

function toRows(env: Record<string, string>): Row[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function toEnv(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value;
  return out;
}

/** Key/value editor for non-secret environment variables. */
export function EnvEditor({
  value,
  onSave,
  disabled,
  saveLabel = "Save variables",
}: {
  value: Record<string, string>;
  onSave: (env: Record<string, string>) => Promise<unknown> | void;
  disabled?: boolean;
  saveLabel?: string;
}) {
  const savedKey = JSON.stringify(value);
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [saving, setSaving] = useState(false);
  useEffect(() => setRows(toRows(value)), [savedKey]);
  const dirty = JSON.stringify(toEnv(rows)) !== savedKey;
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="env-editor">
      <div className="notice notice-warn small">
        <TriangleAlert size={13} /> Values are stored in the project in plain text. Never put secrets here — store them in a connection (Windows Credential Manager).
      </div>
      {rows.map((r, i) => (
        <div key={i} className="env-row">
          <input className="mono" value={r.key} placeholder="NAME" onChange={(e) => setRow(i, { key: e.target.value })} aria-label="Variable name" disabled={disabled || saving} />
          <input className="mono grow" value={r.value} placeholder="value" onChange={(e) => setRow(i, { value: e.target.value })} aria-label={`Value of ${r.key || "variable"}`} disabled={disabled || saving} />
          <button className="icon-btn" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove variable" disabled={disabled || saving}>
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="row">
        <button className="btn btn-sm" onClick={() => setRows((rs) => [...rs, { key: "", value: "" }])} disabled={disabled || saving}>
          <Plus size={12} /> Variable
        </button>
        <span className="spacer" />
        <button
          className="btn btn-sm primary"
          disabled={!dirty || disabled || saving}
          onClick={async () => {
            setSaving(true);
            await onSave(toEnv(rows));
            setSaving(false);
          }}
        >
          {saving ? <Spinner size={11} /> : <Save size={12} />} {saveLabel}
        </button>
      </div>
    </div>
  );
}
