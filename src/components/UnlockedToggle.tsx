import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { saveSettingsWith } from "../state/actions";
import { useStore } from "../store";
import { useT } from "../i18n";

/** The CLAUDE UNLOCKED switch. Turning it on is confirmed; it is blocked during an emergency stop. */
export function UnlockedToggle({ large }: { large?: boolean }) {
  const t = useT();
  const unlocked = useStore((s) => s.project?.settings.autonomy.unlocked ?? false);
  const emergency = useStore((s) => s.project?.emergency ?? false);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    const next = !unlocked;
    if (next) {
      const ok = await ask(t("comp.unlock.confirm"), {
        title: t("comp.unlock.title"),
        kind: "warning",
        okLabel: t("comp.unlock.ok"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }
    setBusy(true);
    await saveSettingsWith((s) => ({ ...s, autonomy: { ...s.autonomy, unlocked: next } }), next ? t("comp.unlock.on") : t("comp.unlock.off"));
    setBusy(false);
  };

  return (
    <button
      className={`unlock-toggle${unlocked ? " on" : ""}${large ? " large" : ""}`}
      role="switch"
      aria-checked={unlocked}
      onClick={() => void toggle()}
      disabled={busy || (emergency && !unlocked)}
      title={emergency && !unlocked ? t("comp.unlock.releaseFirst") : undefined}
    >
      {unlocked ? <LockOpen size={large ? 16 : 13} /> : <Lock size={large ? 16 : 13} />}
      <span className="unlock-label">CLAUDE UNLOCKED</span>
      <span className="unlock-state">{unlocked ? t("comp.unlock.stateOn") : t("comp.unlock.stateOff")}</span>
    </button>
  );
}
