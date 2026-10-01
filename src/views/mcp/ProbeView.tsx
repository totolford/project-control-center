import type { McpItem, McpProbe } from "../../lib/types";
import { formatClock } from "../../lib/format";

export interface ProbeRecord {
  probe: McpProbe;
  at: string;
}

function ItemList({ items, empty }: { items: McpItem[]; empty: string }) {
  if (items.length === 0) return <div className="muted small">{empty}</div>;
  return (
    <ul className="tools-items">
      {items.map((i) => (
        <li key={i.name}>
          <code>{i.name}</code>
          {i.description && <span className="muted small"> {i.description}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Result of a real MCP handshake (tools/list, resources/list, prompts/list). */
export function ProbeView({ record, toolsOnly }: { record: ProbeRecord | null; toolsOnly?: boolean }) {
  if (!record) return <div className="muted small">Not tested yet. Run a test to list tools, resources and prompts.</div>;
  const p = record.probe;
  return (
    <div className="tools-probe">
      <dl className="kv kv-inline">
        <dt>Server</dt>
        <dd>{p.serverName ? `${p.serverName}${p.serverVersion ? ` ${p.serverVersion}` : ""}` : "Not reported by the server"}</dd>
        <dt>Response time</dt>
        <dd>
          {p.latencyMs} ms <span className="muted small">(tested {formatClock(record.at)})</span>
        </dd>
        <dt>Protocol</dt>
        <dd>{p.protocolVersion ?? "Not reported"}</dd>
      </dl>
      <div className="section-label">Tools ({p.tools.length})</div>
      <ItemList items={p.tools} empty="The server exposes no tools." />
      {!toolsOnly && (
        <>
          <div className="section-label">Resources{p.resources ? ` (${p.resources.length})` : ""}</div>
          {p.resources ? <ItemList items={p.resources} empty="No resources." /> : <div className="muted small">Not supported by this server.</div>}
          <div className="section-label">Prompts{p.prompts ? ` (${p.prompts.length})` : ""}</div>
          {p.prompts ? <ItemList items={p.prompts} empty="No prompts." /> : <div className="muted small">Not supported by this server.</div>}
          <div className="section-label">Server output (stderr, last lines)</div>
          {p.stderrTail.length ? <pre className="json">{p.stderrTail.join("\n")}</pre> : <div className="muted small">The server wrote nothing to stderr.</div>}
        </>
      )}
    </div>
  );
}
