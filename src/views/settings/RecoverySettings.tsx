import { useState } from "react";
import "../../styles/central.css";
import { History } from "lucide-react";
import { api } from "../../lib/api";
import { centralApi } from "../../lib/centralApi";
import { DEFAULT_MISSION_RECOVERY, type MissionRecoverySettings } from "../../lib/centralTypes";
import { run, toast } from "../../lib/toast";
import type { PowerLevel } from "../../lib/types";
import { useAgent, useReadOnly } from "../../store";
import { Section, Spinner } from "../../components/Common";
import { PowerControl } from "../../components/PowerControl";
import { useT, type MessageKey } from "../../i18n";
import { autonomyOf } from "../central/centralLogic";

type Switch = keyof MissionRecoverySettings;

const SWITCHES: { key: Switch; label: MessageKey; hint: MessageKey }[] = [
  { key: "autoResumeMissions", label: "central.recovery.autoResumeMissions", hint: "central.recovery.autoResumeMissionsHint" },
  { key: "autoReconnectMcp", label: "central.recovery.autoReconnectMcp", hint: "central.recovery.autoReconnectMcpHint" },
  { key: "autoRestartAgents", label: "central.recovery.autoRestartAgents", hint: "central.recovery.autoRestartAgentsHint" },
  { key: "restoreWorld", label: "central.recovery.restoreWorld", hint: "central.recovery.restoreWorldHint" },
  { key: "recoverPermissions", label: "central.recovery.recoverPermissions", hint: "central.recovery.recoverPermissionsHint" },
  { key: "validateFilesBeforeResume", label: "central.recovery.validateFiles", hint: "central.recovery.validateFilesHint" },
];

/** Settings → Missions → Recovery (edited inside the Settings draft; projects from before 0.5 read the defaults). */
export function RecoverySettings({ value, onChange }: { value: MissionRecoverySettings | undefined; onChange: (v: MissionRecoverySettings) => void }) {
  const t = useT();
  const readOnly = useReadOnly();
  const [resuming, setResuming] = useState(false);
  const current = { ...DEFAULT_MISSION_RECOVERY, ...value };
  const resumeNow = async () => {
    setResuming(true);
    try {
      const r = await centralApi.resume();
      toast.success(t("central.recovery.resuming", { id: r.missionId }));
    } catch (e) {
      toast.error(e);
    } finally {
      setResuming(false);
    }
  };
  return (
    <Section
      title={t("central.recovery.title")}
      actions={
        <button className="btn btn-sm" onClick={() => void resumeNow()} disabled={resuming || readOnly} title={t("central.recovery.resumeNowTitle")}>
          {resuming ? <Spinner size={11} /> : <History size={12} />} {t("central.recovery.resumeNow")}
        </button>
      }
    >
      <p className="muted small">{t("central.recovery.subtitle")}</p>
      <div className="recovery-switches">
        {SWITCHES.map((s) => (
          <label key={s.key} className="checkbox recovery-switch">
            <input type="checkbox" checked={current[s.key]} onChange={(e) => onChange({ ...current, [s.key]: e.target.checked })} />
            <span>
              {t(s.label)}
              <span className="field-hint">{t(s.hint)}</span>
            </span>
          </label>
        ))}
      </div>
    </Section>
  );
}

/** Central's autonomy level: its power preset, applied at once (MAXIMUM never bypasses protections). */
export function CentralAutonomySettings() {
  const t = useT();
  const readOnly = useReadOnly();
  const central = useAgent("central");
  if (!central) {
    return (
      <Section title={t("central.autonomy.title")}>
        <div className="muted small">{t("central.autonomy.noCentral")}</div>
      </Section>
    );
  }
  const a = autonomyOf(central.permissions);
  const apply = (level: PowerLevel) => void run(() => api.applyPower("central", level), t("central.autonomy.applied", { level: level.toUpperCase() }));
  return (
    <Section title={t("central.autonomy.title")}>
      <p className="muted small">{t("central.autonomy.subtitle")}</p>
      <PowerControl permissions={central.permissions} onApply={apply} disabled={readOnly} />
      <p className="small" data-testid="autonomy-explain">
        <strong>{a.label}</strong> — {t.dynamic(`central.autonomy.level.${a.label}`, { count: a.reminders })}
      </p>
    </Section>
  );
}
