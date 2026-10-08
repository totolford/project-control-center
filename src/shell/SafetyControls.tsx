import { useState } from "react";
import { LockOpen, OctagonX, ShieldOff, Siren, Square } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { useStore } from "../store";
import { Modal } from "../components/Modal";
import { useT } from "../i18n";

function RevokeDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const t = useT();
  const revoke = async () => {
    setBusy(true);
    const ok = await run(() => api.revokeAllPermissions(), t("cmd.safety.revoked"));
    setBusy(false);
    if (ok) {
      void useStore.getState().refresh().catch(() => undefined);
      onClose();
    }
  };
  return (
    <Modal
      title={
        <span className="perm-title">
          <ShieldOff size={17} /> {t("cmd.safety.revokeTitle")}
        </span>
      }
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn danger" onClick={() => void revoke()} disabled={busy}>
            {t("cmd.safety.revokeAll")}
          </button>
        </>
      }
    >
      <p>{t("cmd.safety.revokeIntro")}</p>
      <ul className="bullet-list">
        <li>{t("cmd.safety.revoke1")}</li>
        <li>{t("cmd.safety.revoke2")}</li>
        <li>{t("cmd.safety.revoke3")}</li>
      </ul>
      <p className="muted small">{t("cmd.safety.revokeNote")}</p>
    </Modal>
  );
}

/** Always-visible safety controls of the top bar. */
export function SafetyControls() {
  const unlocked = useStore((s) => s.project?.settings.autonomy.unlocked ?? false);
  const emergency = useStore((s) => s.project?.emergency ?? false);
  const navigate = useStore((s) => s.navigate);
  const [revoking, setRevoking] = useState(false);
  const t = useT();

  const emergencyStop = async () => {
    const ok = await ask(
      t("cmd.safety.emergencyText"),
      { title: t("cmd.safety.emergency"), kind: "warning", okLabel: t("cmd.safety.emergency"), cancelLabel: t("common.cancel") },
    );
    if (ok) await run(() => api.emergencyStop(), t("cmd.safety.emergencyActive"));
  };

  return (
    <div className="safety">
      {unlocked && (
        <button className="unlocked-badge" onClick={() => navigate({ name: "autonomy" })} title={t("cmd.safety.unlockedTitle")}>
          <LockOpen size={12} /> UNLOCKED
        </button>
      )}
      <button className="btn btn-sm safety-btn" onClick={() => void run(() => api.stopAll(), t("cmd.stopDone"))} title={t("cmd.safety.stopAllTitle")}>
        <Square size={12} /> <span className="btn-text">{t("cmd.safety.stopAll")}</span>
      </button>
      <button className="btn btn-sm safety-btn warn" onClick={() => setRevoking(true)} title={t("cmd.safety.revokeAllTitle")}>
        <ShieldOff size={12} /> <span className="btn-text">{t("cmd.safety.revokeShort")}</span>
      </button>
      <button className="btn btn-sm safety-btn danger" onClick={() => void emergencyStop()} disabled={emergency} title={t("cmd.safety.emergencyTitle")}>
        <OctagonX size={12} /> <span className="btn-text">{t("cmd.safety.emergency")}</span>
      </button>
      {revoking && <RevokeDialog onClose={() => setRevoking(false)} />}
    </div>
  );
}

export function EmergencyBanner() {
  const emergency = useStore((s) => s.project?.emergency ?? false);
  const [busy, setBusy] = useState(false);
  const t = useT();
  if (!emergency) return null;
  const release = async () => {
    setBusy(true);
    await run(() => api.releaseEmergency(), t("cmd.releaseDone"));
    setBusy(false);
  };
  return (
    <div className="emergency-banner" role="alert">
      <Siren size={14} />
      <strong>{t("cmd.safety.banner")}</strong>
      <span className="spacer" />
      <button className="btn btn-sm" onClick={() => void release()} disabled={busy}>
        {t("cmd.safety.release")}
      </button>
    </div>
  );
}
