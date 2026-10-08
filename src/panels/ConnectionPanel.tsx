import { memo, useState } from "react";
import { Zap } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import { CONNECTION_STATUS } from "../lib/labels";
import { formatRelative } from "../lib/format";
import type { Connection } from "../lib/types";
import { Chip } from "../components/StatusBadge";
import { Spinner } from "../components/Common";
import type { PanelBodyProps } from "../workspace/registry";
import { useAgents, useConnections, useStore } from "../store";
import { useT } from "../i18n";

/** Status block shared by connection panels: status, detail, last check, Test button, granted agents. */
export function ConnectionStatusBlock({ conn }: { conn: Connection }) {
  const t = useT();
  const upsertConnection = useStore((s) => s.upsertConnection);
  const openAgent = useStore((s) => s.openAgent);
  const agents = useAgents();
  const [testing, setTesting] = useState(false);
  const status = CONNECTION_STATUS[conn.status];
  const granted = agents.filter((a) => a.connections.includes(conn.id));

  const test = async () => {
    setTesting(true);
    const updated = await attempt(() => api.checkConnection(conn.id));
    setTesting(false);
    if (updated) upsertConnection(updated);
  };

  return (
    <div className="conn-block">
      <div className="row">
        <strong className="grow ellipsis">{conn.name}</strong>
        <Chip tone={status.tone}>{status.label}</Chip>
        <button className="btn btn-sm" onClick={() => void test()} disabled={testing}>
          {testing ? <Spinner size={12} /> : <Zap size={12} />} {t("panel.test")}
        </button>
      </div>
      {conn.statusDetail && <div className={`small ${conn.status === "error" ? "tone-red-fg" : "muted"}`}>{conn.statusDetail}</div>}
      <div className="muted small">
        {conn.kind} · {t("panel.checked", { when: formatRelative(conn.lastChecked) })}
      </div>
      <div className="section-label">{t("panel.agentsWithAccess", { count: granted.length })}</div>
      {granted.length === 0 ? (
        <div className="muted small">{t("panel.noGrant")}</div>
      ) : (
        <div className="chips-row">
          {granted.map((a) => (
            <button key={a.id} className="chip tone-grey chip-btn" onClick={() => openAgent(a.id)}>
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const ConnectionPanel = memo(function ConnectionPanel({ spec }: PanelBodyProps) {
  const t = useT();
  const conn = useConnections().find((c) => c.id === spec.connectionId);
  if (!conn) return <div className="muted pad">{t("panel.connRemoved")}</div>;
  return (
    <div className="panel-scroll pad-sm">
      <ConnectionStatusBlock conn={conn} />
    </div>
  );
});
