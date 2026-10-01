import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { McpCandidate, RobloxDetection } from "../../lib/types";
import { Spinner } from "../../components/Common";

/** MCP servers found in other tools' configuration on this machine (api.knownMcpServers). */
export function KnownServersPicker({ onPick }: { onPick: (c: McpCandidate) => void }) {
  const [known, setKnown] = useState<McpCandidate[] | null>(null);
  useEffect(() => {
    void attempt(() => api.knownMcpServers()).then((k) => setKnown(k ?? []));
  }, []);
  if (known === null)
    return (
      <div className="muted small">
        <Spinner size={12} /> Looking for MCP servers configured on this machine…
      </div>
    );
  if (known.length === 0) return <div className="muted small">No other MCP server configuration detected on this machine.</div>;
  return (
    <div className="candidates">
      <span className="muted small">Import from detected servers:</span>
      {known.map((c) => (
        <button key={`${c.source}-${c.name}`} className="btn btn-sm" onClick={() => onPick(c)} title={c.source}>
          {c.name}
        </button>
      ))}
    </div>
  );
}

/** Roblox Studio installation and its MCP server candidates (api.robloxDetect). */
export function RobloxPicker({ onPick }: { onPick: (c: McpCandidate) => void }) {
  const [det, setDet] = useState<RobloxDetection | null | undefined>(undefined);
  useEffect(() => {
    void attempt(() => api.robloxDetect()).then((d) => setDet(d ?? null));
  }, []);
  if (det === undefined)
    return (
      <div className="muted small">
        <Spinner size={12} /> Detecting Roblox Studio…
      </div>
    );
  if (det === null) return null;
  return (
    <div className="detect-box">
      <div>
        Roblox Studio: <strong>{det.studioInstalled ? "installed" : "not found"}</strong>
        {det.studioInstalled && <span className="muted"> · {det.studioRunning ? "running" : "not running"}</span>}
        {det.studioPath && <div className="mono muted small">{det.studioPath}</div>}
      </div>
      {det.mcpCandidates.length > 0 ? (
        <div className="candidates">
          <span className="muted small">Detected MCP servers:</span>
          {det.mcpCandidates.map((c) => (
            <button key={`${c.source}-${c.name}`} className="btn btn-sm" onClick={() => onPick(c)} title={c.source}>
              Use {c.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="muted small">
          No Roblox Studio MCP server detected. Enter its command manually (for example the Roblox Studio MCP server executable with{" "}
          <code>--stdio</code>).
        </div>
      )}
    </div>
  );
}
