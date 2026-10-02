import { Field } from "../../../components/Common";
import { Segmented } from "../../../components/Tabs";
import type { WorldMode } from "../../../lib/types";
import { ListEditor } from "../ListEditor";
import { MODE_META } from "../status";
import { MAX_SPEED, MIN_SPEED } from "../wizard";

export interface WorldFields {
  name: string;
  description: string;
  environment: string;
  rules: string[];
  speed: number;
  mode: WorldMode;
}

export const MODE_OPTIONS: { value: WorldMode; label: string }[] = [
  { value: "simulation", label: MODE_META.simulation.label },
  { value: "hybrid", label: MODE_META.hybrid.label },
  { value: "real_execution", label: MODE_META.real_execution.label },
];

/** Step 2 of the wizard, also used by "Edit world". */
export function StepWorld<S extends WorldFields>({ state, set }: { state: S; set: (s: S) => void }) {
  return (
    <div className="world-step">
      <div className="form-row">
        <Field label="Name">
          <input value={state.name} onChange={(e) => set({ ...state, name: e.target.value })} />
        </Field>
        <Field label="Map" hint="Fixed layout: one room per kind of real activity.">
          <input value="Campus map (9 rooms)" readOnly />
        </Field>
      </div>
      <Field label="Description">
        <textarea rows={2} value={state.description} onChange={(e) => set({ ...state, description: e.target.value })} />
      </Field>
      <Field label="Environment" hint="Setting given to Claude when it writes simulated conversations.">
        <input value={state.environment} onChange={(e) => set({ ...state, environment: e.target.value })} />
      </Field>
      <Field label="Rules" group>
        <ListEditor items={state.rules} onChange={(rules) => set({ ...state, rules })} placeholder="e.g. Nobody works at night" addLabel="Add rule" />
      </Field>
      <Field label={`Simulation speed: ${state.speed} ticks/s`} hint="How often the world advances (movement, rooms, events).">
        <input
          type="range"
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={0.5}
          value={state.speed}
          onChange={(e) => set({ ...state, speed: Number(e.target.value) })}
        />
      </Field>
      <Field label="Mode" group hint={MODE_META[state.mode].explain}>
        <Segmented options={MODE_OPTIONS} value={state.mode} onChange={(mode) => set({ ...state, mode })} label="World mode" />
      </Field>
    </div>
  );
}
