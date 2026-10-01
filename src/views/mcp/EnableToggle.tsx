import { useState } from "react";
import { Power, PowerOff } from "lucide-react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { Connection } from "../../lib/types";
import { useStore } from "../../store";
import { Spinner } from "../../components/Common";

/** Connect / Disconnect = enable / disable a NEXUS connection (stored secrets are kept). */
export function EnableToggle({ conn }: { conn: Connection }) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    const updated = await attempt(
      () => api.updateConnection(conn.id, { name: conn.name, kind: conn.kind, config: conn.config, enabled: !conn.enabled }),
      conn.enabled ? `${conn.name} disconnected: agents can no longer use it` : `${conn.name} connected`,
    );
    setBusy(false);
    if (updated) useStore.getState().upsertConnection(updated);
  };

  return (
    <button
      className="btn"
      onClick={() => void toggle()}
      disabled={busy}
      title={conn.enabled ? "Disable: calls are denied and new sessions do not receive it" : "Enable: granted agents receive it at their next session start"}
    >
      {busy ? <Spinner size={12} /> : conn.enabled ? <PowerOff size={14} /> : <Power size={14} />} {conn.enabled ? "Disconnect" : "Connect"}
    </button>
  );
}
