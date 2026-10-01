import { useState } from "react";
import { LockOpen, OctagonX, ShieldOff, Siren, Square } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { useStore } from "../store";
import { Modal } from "../components/Modal";

function RevokeDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    setBusy(true);
    const ok = await run(() => api.revokeAllPermissions(), "All permissions revoked");
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
          <ShieldOff size={17} /> Revoke all permissions?
        </span>
      }
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" onClick={() => void revoke()} disabled={busy}>
            Revoke all permissions
          </button>
        </>
      }
    >
      <p>This immediately:</p>
      <ul className="bullet-list">
        <li>sets every agent (Central included) to the LOW power preset — read-only project, git and GitHub;</li>
        <li>deletes every saved “allow always” rule of every agent;</li>
        <li>turns CLAUDE UNLOCKED and auto-approval off.</li>
      </ul>
      <p className="muted small">Running sessions keep the tools they started with until they are restarted; NEXUS enforces the new permissions on every request from now on.</p>
    </Modal>
  );
}

/** Always-visible safety controls of the top bar. */
export function SafetyControls() {
  const unlocked = useStore((s) => s.project?.settings.autonomy.unlocked ?? false);
  const emergency = useStore((s) => s.project?.emergency ?? false);
  const navigate = useStore((s) => s.navigate);
  const [revoking, setRevoking] = useState(false);

  const emergencyStop = async () => {
    const ok = await ask(
      "EMERGENCY STOP kills every Claude Code process managed by NEXUS, rejects pending permission prompts and blocks autonomy, auto-approval and new work until you release it.",
      { title: "Emergency stop", kind: "warning", okLabel: "Emergency stop" },
    );
    if (ok) await run(() => api.emergencyStop(), "Emergency stop active");
  };

  return (
    <div className="safety">
      {unlocked && (
        <button className="unlocked-badge" onClick={() => navigate({ name: "autonomy" })} title="CLAUDE UNLOCKED is on: NEXUS answers permission prompts per your rules">
          <LockOpen size={12} /> UNLOCKED
        </button>
      )}
      <button className="btn btn-sm safety-btn" onClick={() => void run(() => api.stopAll(), "Stop requested for all agents")} title="Stop every agent session">
        <Square size={12} /> <span className="btn-text">Stop all</span>
      </button>
      <button className="btn btn-sm safety-btn warn" onClick={() => setRevoking(true)} title="Lower every agent to LOW, delete saved rules, turn UNLOCKED off">
        <ShieldOff size={12} /> <span className="btn-text">Revoke all</span>
      </button>
      <button className="btn btn-sm safety-btn danger" onClick={() => void emergencyStop()} disabled={emergency} title="Kill all sessions and block autonomy">
        <OctagonX size={12} /> <span className="btn-text">Emergency stop</span>
      </button>
      {revoking && <RevokeDialog onClose={() => setRevoking(false)} />}
    </div>
  );
}

export function EmergencyBanner() {
  const emergency = useStore((s) => s.project?.emergency ?? false);
  const [busy, setBusy] = useState(false);
  if (!emergency) return null;
  const release = async () => {
    setBusy(true);
    await run(() => api.releaseEmergency(), "Emergency stop released");
    setBusy(false);
  };
  return (
    <div className="emergency-banner" role="alert">
      <Siren size={14} />
      <strong>Emergency stop active — autonomy and new work blocked</strong>
      <span className="spacer" />
      <button className="btn btn-sm" onClick={() => void release()} disabled={busy}>
        Release
      </button>
    </div>
  );
}
