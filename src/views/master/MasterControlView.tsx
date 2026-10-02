import { useState } from "react";
import { RefreshCw, ShieldOff, Square } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { MASTER_SWITCHES, domainOf, masterOff } from "../../lib/master";
import { run } from "../../lib/toast";
import { saveSettingsWith } from "../../state/actions";
import { useReadOnly, useStore } from "../../store";
import { Loading, PageHeader, Section, Spinner } from "../../components/Common";
import { PermissionEditor } from "../../components/PermissionEditor";
import { DomainBar, MasterToggle, setMasterSwitch, useMasterStatus } from "./MasterParts";

function Emergency() {
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    const ok = await ask(
      "REVOKE ACCESS lowers every agent to LOW, deletes every saved “allow always” rule, turns CLAUDE UNLOCKED off and deactivates MASTER CONTROL.",
      { title: "Revoke access", kind: "warning", okLabel: "Revoke access" },
    );
    if (!ok) return;
    setBusy(true);
    if (await run(() => api.revokeAllPermissions(), "All permissions revoked")) {
      // Revoking rewrites the settings: fold them in before switching MASTER CONTROL off.
      await useStore.getState().refresh().catch(() => undefined);
      await saveSettingsWith((s) => ({ ...s, masterControl: masterOff(s.masterControl) }), "MASTER CONTROL inactive");
    }
    setBusy(false);
  };
  return (
    <div className="row master-emergency">
      <button className="btn danger" onClick={() => void run(() => api.stopAll(), "Stop requested for all agents")}>
        <Square size={13} /> STOP ALL
      </button>
      <button className="btn danger" onClick={() => void revoke()} disabled={busy}>
        {busy ? <Spinner size={12} /> : <ShieldOff size={13} />} REVOKE ACCESS
      </button>
    </div>
  );
}

/** NEXUS MASTER CONTROL: what Central may do on its own, per domain, with the real availability of each. */
export function MasterControlView() {
  const master = useStore((s) => s.project?.settings.masterControl);
  const readOnly = useReadOnly();
  const { data: status, error, loading, reload } = useMasterStatus();
  const [saving, setSaving] = useState<string | null>(null);
  if (!master) return null;

  const flip = async (key: (typeof MASTER_SWITCHES)[number]["key"], value: boolean) => {
    setSaving(key);
    await setMasterSwitch(key, value);
    setSaving(null);
  };
  const claude = domainOf(status, "claude");

  return (
    <div className="page">
      <PageHeader
        title="NEXUS MASTER CONTROL"
        subtitle="Central acts on the domains you open here without asking you each time. Destructive actions keep following your manual rules; nothing bypasses Claude Code, Windows or external services."
        actions={
          <button className="btn" onClick={() => void reload()} disabled={loading}>
            {loading ? <Spinner size={12} /> : <RefreshCw size={13} />} Refresh status
          </button>
        }
      />
      <div className={`unlock-hero master-hero${master.active ? " on" : ""}`}>
        <MasterToggle large />
        <div className="small grow">
          {master.active ? "Central uses every domain switched on below, within what is really available." : "Inactive: Central follows its own permissions and asks you as usual."}
        </div>
        <Emergency />
      </div>
      {error && <div className="notice notice-error">Status unavailable: {error}</div>}
      <Section title="Domains">
        {!status && loading && <Loading />}
        <div className="master-domains">
          {claude && (
            <div className="master-domain">
              <span className="muted small">always on</span>
              <DomainBar domain={claude} />
            </div>
          )}
          {MASTER_SWITCHES.map((sw) => {
            const domain = domainOf(status, sw.key);
            return (
              <div key={sw.key} className="master-domain">
                <label className="checkbox" title={sw.hint}>
                  <input type="checkbox" checked={master[sw.key]} disabled={readOnly || saving !== null} onChange={(e) => void flip(sw.key, e.target.checked)} />
                  <strong>{sw.label}</strong>
                  {saving === sw.key && <Spinner size={11} />}
                </label>
                {domain ? <DomainBar domain={domain} /> : <div className="muted small">{sw.hint}</div>}
              </div>
            );
          })}
        </div>
      </Section>
      <Section title="Central's effective permissions">
        {status ? (
          <PermissionEditor value={status.centralPermissions} onChange={() => undefined} disabled />
        ) : (
          <div className="muted small">{loading ? "Loading…" : "Unavailable."}</div>
        )}
      </Section>
    </div>
  );
}
