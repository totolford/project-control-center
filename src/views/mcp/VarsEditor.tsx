import { KeyRound, Plus, Trash2 } from "lucide-react";
import type { DraftVar, McpDraft } from "./mcpDraft";

/** Environment variables (stdio) or HTTP headers (remote), each plain or secret. Secret values are never displayed back. */
export function VarsEditor({ draft, onChange }: { draft: McpDraft; onChange: (vars: DraftVar[]) => void }) {
  const headers = draft.transport !== "stdio";
  const claude = draft.target === "claude";
  const set = (i: number, patch: Partial<DraftVar>) => onChange(draft.vars.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <div>
      {claude ? (
        <div className="notice notice-warn">
          <KeyRound size={14} /> Claude Code config files only accept <code>{"${VAR}"}</code> references: set the real value as an environment variable
          of your user account. To keep a secret value in Windows Credential Manager, add the server to NEXUS instead.
        </div>
      ) : (
        <div className="notice">
          <KeyRound size={14} /> Secret values go to Windows Credential Manager; the project only stores their names.
        </div>
      )}
      {draft.vars.length === 0 && <div className="muted small">No {headers ? "headers" : "environment variables"}.</div>}
      {draft.vars.map((v, i) => {
        const kept = v.secret && !v.value && draft.storedSecrets.includes(v.key);
        return (
          <div key={i} className="tools-var">
            <input className="mono" value={v.key} placeholder={headers ? "Header" : "NAME"} aria-label="Name" onChange={(e) => set(i, { key: e.target.value })} />
            <input
              className="mono grow"
              type={v.secret ? "password" : "text"}
              value={v.value}
              autoComplete="off"
              aria-label="Value"
              placeholder={claude ? "${MY_VARIABLE}" : kept ? "stored — leave blank to keep" : "value"}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            {!claude && (
              <label className="checkbox small" title="Store the value in Windows Credential Manager">
                <input type="checkbox" checked={v.secret} onChange={(e) => set(i, { secret: e.target.checked, value: "" })} /> secret
              </label>
            )}
            <button className="icon-btn" aria-label={`Remove ${v.key || "row"}`} onClick={() => onChange(draft.vars.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
      <button className="btn btn-sm" onClick={() => onChange([...draft.vars, { key: "", value: "", secret: !claude && headers }])}>
        <Plus size={14} /> Add {headers ? "header" : "variable"}
      </button>
    </div>
  );
}
