// Bodies of the Add / Edit MCP wizard steps (state lives in McpWizard).

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useStore, sortAgents, useAgents } from "../../store";
import { Field } from "../../components/Common";
import { Segmented } from "../../components/Tabs";
import { Chip } from "../../components/StatusBadge";
import type { ClaudeScope, McpDraft, Transport } from "./mcpDraft";
import { applyCandidate } from "./mcpDraft";
import { KnownServersPicker, RobloxPicker } from "./ImportPickers";
import { VarsEditor } from "./VarsEditor";

export interface StepProps {
  draft: McpDraft;
  update: (patch: Partial<McpDraft>) => void;
  editing: boolean;
}

export function NameStep({ draft, update, editing }: StepProps) {
  const [roblox, setRoblox] = useState(draft.kind === "roblox_studio");
  return (
    <>
      <Field label="Name" hint={draft.target === "claude" ? "Letters, digits, dashes and underscores." : "Agents see it as mcp__<id>__<tool>; the id is derived from the name."}>
        <input value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. filesystem" autoFocus />
      </Field>
      {!editing && (
        <>
          <KnownServersPicker onPick={(c) => update(applyCandidate(draft, c, "mcp"))} />
          {roblox ? (
            <RobloxPicker onPick={(c) => update(applyCandidate(draft, c, "roblox_studio"))} />
          ) : (
            <button className="link-btn small" onClick={() => setRoblox(true)}>
              Detect Roblox Studio MCP server
            </button>
          )}
        </>
      )}
    </>
  );
}

export function TargetStep({ draft, update }: StepProps) {
  return (
    <>
      <div className="tools-choice">
        <label className={`tools-option${draft.target === "nexus" ? " active" : ""}`}>
          <input type="radio" checked={draft.target === "nexus"} onChange={() => update({ target: "nexus" })} />
          <div>
            <strong>NEXUS connection for agents</strong> <Chip tone="accent">Recommended</Chip>
            <div className="muted small">
              NEXUS agents run with <code>--strict-mcp-config</code>: they only get the MCP connections granted to them here. Secrets stay in Windows
              Credential Manager.
            </div>
          </div>
        </label>
        <label className={`tools-option${draft.target === "claude" ? " active" : ""}`}>
          <input type="radio" checked={draft.target === "claude"} onChange={() => update({ target: "claude" })} />
          <div>
            <strong>Claude Code configuration</strong>
            <div className="muted small">
              Used when you run <code>claude</code> yourself. NEXUS agents do not see it (use "Use in NEXUS" later to give it to agents).
            </div>
          </div>
        </label>
      </div>
      {draft.target === "claude" && (
        <Field group label="Scope">
          <Segmented<ClaudeScope>
            options={[
              { value: "local", label: "Local (this project, private)" },
              { value: "project", label: "Project (.mcp.json, shared)" },
              { value: "user", label: "User (all projects)" },
            ]}
            value={draft.claudeScope}
            onChange={(claudeScope) => update({ claudeScope })}
            label="Scope"
          />
        </Field>
      )}
    </>
  );
}

export function TransportStep({ draft, update }: StepProps) {
  const hints: Record<Transport, string> = {
    stdio: "NEXUS / Claude Code starts the server as a local process and talks over stdin/stdout.",
    http: "Remote server reached over Streamable HTTP.",
    sse: "Remote server using Server-Sent Events (older transport).",
  };
  return (
    <Field group label="Transport" hint={hints[draft.transport]}>
      <Segmented<Transport>
        options={[
          { value: "stdio", label: "stdio (local process)" },
          { value: "http", label: "HTTP" },
          { value: "sse", label: "SSE" },
        ]}
        value={draft.transport}
        onChange={(transport) => update({ transport, vars: [] })}
        label="Transport"
      />
    </Field>
  );
}

export function ServerStep({ draft, update }: StepProps) {
  if (draft.transport !== "stdio")
    return (
      <Field label="URL">
        <input className="mono" value={draft.url} onChange={(e) => update({ url: e.target.value })} placeholder="https://example.com/mcp" />
      </Field>
    );
  return (
    <>
      <Field label="Command">
        <input className="mono" value={draft.command} onChange={(e) => update({ command: e.target.value })} placeholder="npx, node, uvx, C:\path\server.exe…" />
      </Field>
      <Field label="Arguments" hint="One per line.">
        <textarea className="mono" rows={4} value={draft.args} onChange={(e) => update({ args: e.target.value })} />
      </Field>
    </>
  );
}

export function VarsStep({ draft, update }: StepProps) {
  return <VarsEditor draft={draft} onChange={(vars) => update({ vars })} />;
}

export function KindStep({ draft, update }: StepProps) {
  return (
    <Field
      group
      label="Kind"
      hint={draft.kind === "roblox_studio" ? "Health checks also report whether Roblox Studio is installed and running." : "Any MCP server."}
    >
      <Segmented
        options={[
          { value: "mcp", label: "Generic MCP" },
          { value: "roblox_studio", label: "Roblox Studio" },
        ]}
        value={draft.kind}
        onChange={(kind) => update({ kind })}
        label="Kind"
      />
    </Field>
  );
}

export function PermissionsStep() {
  const agents = sortAgents(useAgents()).filter((a) => a.status !== "retired");
  const openAgent = useStore((s) => s.openAgent);
  return (
    <>
      <p>
        Agents call MCP tools under the <code>mcp</code> capability. An agent needs both: access to this connection (next step) and{" "}
        <code>mcp</code> set to Ask or Allow in its permissions.
      </p>
      <table className="table">
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>
                mcp: <strong>{a.permissions.mcp}</strong>
              </td>
              <td className="num">
                <button className="link-btn small" onClick={() => openAgent(a.id)}>
                  Agent profile <ExternalLink size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function AgentsStep({ draft, update }: StepProps) {
  const agents = sortAgents(useAgents()).filter((a) => a.status !== "retired");
  const toggle = (id: string) =>
    update({ agentIds: draft.agentIds.includes(id) ? draft.agentIds.filter((x) => x !== id) : [...draft.agentIds, id] });
  return (
    <>
      {agents.length === 0 && <div className="muted small">No agents yet. You can grant access later.</div>}
      {agents.map((a) => (
        <label key={a.id} className="checkbox">
          <input type="checkbox" checked={draft.agentIds.includes(a.id)} onChange={() => toggle(a.id)} /> {a.name}
          <span className="muted small">{a.role}</span>
        </label>
      ))}
      <p className="muted small">
        MCP access is granted per agent (Central included): NEXUS has no per-mission MCP grants.
      </p>
    </>
  );
}
