import { FlaskConical } from "lucide-react";
import { api } from "../../lib/api";
import { toggleIn } from "../../lib/autonomy";
import { run } from "../../lib/toast";
import type { ImprovementMode, ImprovementSettings as Improvement } from "../../lib/types";
import { Field, Section } from "../../components/Common";
import { Segmented } from "../../components/Tabs";

const FOCUS_AREAS = [
  "bugs",
  "dead code",
  "architecture",
  "performance",
  "cleanup",
  "UI",
  "documentation",
  "conventions",
  "tests",
  "git",
  "MCP",
  "skills",
  "configuration",
  "recurring errors",
  "automations",
];

const MODES: { value: ImprovementMode; label: string }[] = [
  { value: "propose", label: "Propose" },
  { value: "implement", label: "Implement" },
];

export const MODE_HELP: Record<ImprovementMode, string> = {
  propose: "Central analyses the project and creates review tasks describing each improvement (what, why, risk). Nothing is changed.",
  implement: "Central plans and implements improvements through workers, with tests. Every task requires review; merges still need your approval.",
};

/** Continuous Improvement settings (edited inside the Settings draft). */
export function ImprovementSettings({ value, onChange }: { value: Improvement; onChange: (v: Improvement) => void }) {
  const set = <K extends keyof Improvement>(k: K, v: Improvement[K]) => onChange({ ...value, [k]: v });
  const custom = value.focus.filter((f) => !FOCUS_AREAS.includes(f));
  return (
    <Section
      title="Continuous improvement"
      actions={
        <button className="btn btn-sm" onClick={() => void run(() => api.startImprovementCycle(), "Improvement cycle started")}>
          <FlaskConical size={12} /> Run a cycle now
        </button>
      }
    >
      <label className="checkbox">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Run improvement cycles automatically
      </label>
      <div className="form-row">
        <Field label="Interval (minutes)">
          <input type="number" min={10} value={value.intervalMinutes} onChange={(e) => set("intervalMinutes", Math.max(10, Math.floor(Number(e.target.value) || 10)))} />
        </Field>
        <Field label="Max runs per day">
          <input type="number" min={1} max={48} value={value.maxRunsPerDay} onChange={(e) => set("maxRunsPerDay", Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
        </Field>
        <Field label="Mode" hint={MODE_HELP[value.mode]} group>
          <Segmented options={MODES} value={value.mode} onChange={(m) => set("mode", m)} label="Mode" />
        </Field>
      </div>
      <div className="section-label">Focus areas</div>
      <div className="chips-row">
        {[...FOCUS_AREAS, ...custom].map((f) => {
          const on = value.focus.includes(f);
          return (
            <button key={f} className={`chip chip-toggle${on ? " tone-accent" : " tone-dim"}`} aria-pressed={on} onClick={() => set("focus", toggleIn(value.focus, f, !on))}>
              {f}
            </button>
          );
        })}
      </div>
    </Section>
  );
}
