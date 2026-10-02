import { useEffect, useState } from "react";
import { Crown } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { MASTER_CONFIRM, domainView, type MasterSwitch } from "../../lib/master";
import { useLoad } from "../../lib/useLoad";
import type { MasterDomain } from "../../lib/types";
import { saveSettingsWith } from "../../state/actions";
import { useReadOnly, useStore } from "../../store";

/** api.masterStatus(), reloaded (debounced) when settings, connections, MCP or skills change. */
export function useMasterStatus() {
  const version = useStore((s) => s.project?.masterVersion ?? 0);
  const state = useLoad(() => api.masterStatus());
  const { reload } = state;
  useEffect(() => {
    if (version === 0) return;
    const timer = window.setTimeout(() => void reload(), 300);
    return () => window.clearTimeout(timer);
  }, [version, reload]);
  return state;
}

/** The ACTIVE / INACTIVE switch. Activation is confirmed and blocked during an emergency stop or in read-only mode. */
export function MasterToggle({ large }: { large?: boolean }) {
  const active = useStore((s) => s.project?.settings.masterControl.active ?? false);
  const emergency = useStore((s) => s.project?.emergency ?? false);
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    const next = !active;
    if (next && !(await ask(MASTER_CONFIRM, { title: "Activate NEXUS MASTER CONTROL", kind: "warning", okLabel: "Activate" }))) return;
    setBusy(true);
    await saveSettingsWith((s) => ({ ...s, masterControl: { ...s.masterControl, active: next } }), next ? "MASTER CONTROL active" : "MASTER CONTROL inactive");
    setBusy(false);
  };
  const blocked = readOnly || (emergency && !active);
  return (
    <button
      className={`unlock-toggle master-toggle${active ? " on" : ""}${large ? " large" : ""}`}
      role="switch"
      aria-checked={active}
      onClick={() => void toggle()}
      disabled={busy || blocked}
      title={readOnly ? "Compatibility mode: this project is read-only" : emergency && !active ? "Release the emergency stop first" : undefined}
    >
      <Crown size={large ? 16 : 13} />
      <span className="unlock-label">MASTER CONTROL</span>
      <span className="unlock-state">{active ? "ACTIVE" : "INACTIVE"}</span>
    </button>
  );
}

/** Saves one domain switch of settings.masterControl. */
export async function setMasterSwitch(key: MasterSwitch, value: boolean): Promise<void> {
  await saveSettingsWith((s) => ({ ...s, masterControl: { ...s.masterControl, [key]: value } }));
}

/** Level bar + availability of one domain as reported by the backend. */
export function DomainBar({ domain, compact }: { domain: MasterDomain; compact?: boolean }) {
  const v = domainView(domain);
  return (
    <div className={`domain-bar state-${v.state}`} title={domain.detail}>
      <div className="row">
        <span className={compact ? "small grow" : "grow"}>{domain.label}</span>
        <span className={`small domain-state tone-${v.tone}`}>{domain.available ? "✓" : "✗"} {v.label}</span>
      </div>
      <div className="progress-track">
        <div className={`progress-fill tone-${v.tone}`} style={{ width: `${v.percent}%` }} />
      </div>
      {!compact && <div className="muted small">{domain.detail}</div>}
    </div>
  );
}
