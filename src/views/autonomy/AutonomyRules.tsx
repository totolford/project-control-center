import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { CHECKLIST, EFFECTIVE_MARK, effectiveAccess, toggleIn } from "../../lib/autonomy";
import { CAPABILITIES } from "../../lib/labels";
import type { AutonomySettings } from "../../lib/types";
import { saveSettingsWith } from "../../state/actions";
import { useStore } from "../../store";
import { Section, Spinner } from "../../components/Common";
import { PermissionEditor } from "../../components/PermissionEditor";

function Checklist({ autonomy }: { autonomy: AutonomySettings }) {
  return (
    <table className="table checklist-table">
      <tbody>
        {CHECKLIST.map((item) => (
          <tr key={item.label}>
            <td>{item.label}</td>
            <td>
              {item.caps.length === 0 ? (
                <span className="muted small">{item.note}</span>
              ) : (
                <div className="chips-row">
                  {item.caps.map((cap) => {
                    const m = EFFECTIVE_MARK[effectiveAccess(autonomy, cap)];
                    return (
                      <span key={cap} className={`chip tone-${m.tone}`} title={cap}>
                        {m.mark} {CAPABILITIES.find((c) => c.key === cap)?.label ?? cap}: {m.label}
                      </span>
                    );
                  })}
                  {item.note && <span className="muted tiny">{item.note}</span>}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Editor of the UNLOCKED rules (everything in AutonomySettings except the on/off switch). */
export function AutonomyRules() {
  const saved = useStore((s) => s.project?.settings.autonomy);
  const [draft, setDraft] = useState<AutonomySettings | undefined>(saved);
  const [saving, setSaving] = useState(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => setDraft(saved), [savedKey]);
  if (!saved || !draft) return null;

  const set = <K extends keyof AutonomySettings>(k: K, v: AutonomySettings[K]) => setDraft({ ...draft, [k]: v });
  const dirty = JSON.stringify({ ...draft, unlocked: saved.unlocked }) !== savedKey;
  const save = async () => {
    setSaving(true);
    await saveSettingsWith((s) => ({ ...s, autonomy: { ...draft, unlocked: s.autonomy.unlocked } }), "UNLOCKED rules saved");
    setSaving(false);
  };

  return (
    <Section
      title="Rules"
      actions={
        <>
          <button className="btn" onClick={() => setDraft(saved)} disabled={!dirty || saving}>
            Reset
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Spinner size={12} /> : <Save size={13} />} Save rules
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div>
          <div className="section-label">What agents may do while UNLOCKED</div>
          <Checklist autonomy={draft} />
        </div>
        <div className="stack">
          <label className="checkbox">
            <input type="checkbox" checked={draft.autoApprove} onChange={(e) => set("autoApprove", e.target.checked)} />
            <span>
              <strong>Auto approve</strong> — answer “ask” prompts with yes instead of asking you
            </span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.manualForDestructive} onChange={(e) => set("manualForDestructive", e.target.checked)} />
            Keep destructive actions manual (deleting directories, force pushes, resets…)
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.manualForOutsideWorkspace} onChange={(e) => set("manualForOutsideWorkspace", e.target.checked)} />
            Keep actions outside the agent's workspace manual
          </label>
          <div className="section-label">Always manual (even with auto approve)</div>
          <div className="check-grid">
            {CAPABILITIES.map((c) => (
              <label key={c.key} className="checkbox">
                <input type="checkbox" checked={draft.manualCapabilities.includes(c.key)} onChange={(e) => set("manualCapabilities", toggleIn(draft.manualCapabilities, c.key, e.target.checked))} />
                {c.label}
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="section-label">Unlocked permissions (apply to every agent while UNLOCKED)</div>
      <PermissionEditor value={draft.unlockedPermissions} onChange={(v) => set("unlockedPermissions", v)} disabled={saving} />
    </Section>
  );
}
