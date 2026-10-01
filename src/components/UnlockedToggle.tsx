import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { saveSettingsWith } from "../state/actions";
import { useStore } from "../store";

/** The CLAUDE UNLOCKED switch. Turning it on is confirmed; it is blocked during an emergency stop. */
export function UnlockedToggle({ large }: { large?: boolean }) {
  const unlocked = useStore((s) => s.project?.settings.autonomy.unlocked ?? false);
  const emergency = useStore((s) => s.project?.emergency ?? false);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    const next = !unlocked;
    if (next) {
      const ok = await ask(
        "NEXUS will answer Claude Code's permission prompts on your behalf using the UNLOCKED rules, for every agent. Claude Code's own safety is never bypassed and every decision is journaled.",
        { title: "Turn CLAUDE UNLOCKED on", kind: "warning", okLabel: "Unlock" },
      );
      if (!ok) return;
    }
    setBusy(true);
    await saveSettingsWith((s) => ({ ...s, autonomy: { ...s.autonomy, unlocked: next } }), next ? "CLAUDE UNLOCKED on" : "CLAUDE UNLOCKED off");
    setBusy(false);
  };

  return (
    <button
      className={`unlock-toggle${unlocked ? " on" : ""}${large ? " large" : ""}`}
      role="switch"
      aria-checked={unlocked}
      onClick={() => void toggle()}
      disabled={busy || (emergency && !unlocked)}
      title={emergency && !unlocked ? "Release the emergency stop first" : undefined}
    >
      {unlocked ? <LockOpen size={large ? 16 : 13} /> : <Lock size={large ? 16 : 13} />}
      <span className="unlock-label">CLAUDE UNLOCKED</span>
      <span className="unlock-state">{unlocked ? "ON" : "OFF"}</span>
    </button>
  );
}
