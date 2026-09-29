import { RotateCcw } from "lucide-react";
import { Section } from "../../components/Common";
import { useLayoutContext, useProviders } from "../../workspace/hooks";
import { confirmResetLayout, useWorkspace } from "../../workspace/store";

/** Workspace layout options and the (read-only) list of agent providers. */
export function WorkspaceSettings() {
  const ctx = useLayoutContext();
  const autoAdd = useWorkspace((s) => s.ws?.autoAddAgents ?? true);
  const hasWs = useWorkspace((s) => s.ws !== null);
  const update = useWorkspace((s) => s.update);
  const providers = useProviders();
  return (
    <>
      <Section title="Workspace">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoAdd}
            disabled={!hasWs}
            onChange={(e) => update((ws) => ({ ...ws, autoAddAgents: e.target.checked }))}
          />
          Add a terminal panel automatically when a new agent is created
        </label>
        <p className="muted small">The layout (tabs, panels, sizes) is saved in .agent-project/settings/workspace.json.</p>
        <button className="btn" onClick={() => void confirmResetLayout(ctx)} disabled={!hasWs}>
          <RotateCcw size={13} /> Reset workspace layout
        </button>
      </Section>
      <Section title="Agent providers">
        {providers === null ? (
          <div className="muted small">Detecting…</div>
        ) : providers.length === 0 ? (
          <div className="muted small">No provider reported by the backend.</div>
        ) : (
          <ul className="provider-list">
            {providers.map((p) => (
              <li key={p.id} className={p.available ? "" : "unavailable"}>
                <span className={`dot tone-${p.available ? "green" : p.installed ? "amber" : "grey"}`} />
                <strong>{p.name}</strong>
                <span className="muted small grow">{p.description}</span>
                <span className="small">{p.available ? "Available" : "Unavailable"}</span>
                <span className="muted small">{p.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
