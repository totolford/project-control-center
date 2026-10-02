import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Pause, Pencil, Play, Trash2, UserPlus } from "lucide-react";
import { Segmented } from "../../components/Tabs";
import { api } from "../../lib/api";
import { attempt, run } from "../../lib/toast";
import type { World, WorldMode } from "../../lib/types";
import { MODE_OPTIONS } from "./wizard/StepWorld";
import { MODE_META, PROVIDER_LABEL } from "./status";
import { MAX_SPEED, MIN_SPEED } from "./wizard";

/** Run / pause, mode, speed and world-level actions. */
export function WorldToolbar({ world, onWorld, onDeleted, onEdit, onAddCharacter }: {
  world: World;
  onWorld: (w: World) => void;
  onDeleted: () => void;
  onEdit: () => void;
  onAddCharacter: () => void;
}) {
  const [speed, setSpeed] = useState(world.settings.speed);
  useEffect(() => setSpeed(world.settings.speed), [world.settings.speed]);

  const control = async (opts: { running?: boolean; mode?: WorldMode; speed?: number }) => {
    const w = await attempt(() => api.worldControl(opts));
    if (w) onWorld(w);
  };

  const remove = async () => {
    const ok = await ask(`Delete the AI World “${world.name}”? Its characters, conversations and events are removed. Your agents are not affected.`, {
      title: "Delete world",
      kind: "warning",
    });
    if (ok && (await run(() => api.worldDelete(), "World deleted"))) onDeleted();
  };

  return (
    <div className="world-toolbar">
      <button className={`btn${world.running ? "" : " primary"}`} onClick={() => void control({ running: !world.running })}>
        {world.running ? <Pause size={14} /> : <Play size={14} />} {world.running ? "Pause" : "Run"}
      </button>
      <Segmented options={MODE_OPTIONS} value={world.mode} onChange={(mode) => void control({ mode })} label="World mode" />
      <label className="world-speed" title="Ticks per second">
        <input
          type="range"
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={0.5}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          onPointerUp={() => speed !== world.settings.speed && void control({ speed })}
          onKeyUp={() => speed !== world.settings.speed && void control({ speed })}
        />
        <span className="tiny mono">{speed} t/s</span>
      </label>
      <span className="tiny mono muted" title="World tick">
        tick {world.tick}
      </span>
      <span className="chip tone-accent" title={`Provider: ${world.provider}`}>
        {PROVIDER_LABEL[world.provider] ?? world.provider}
      </span>
      <span className="spacer" />
      <button className="btn btn-sm" onClick={onAddCharacter}>
        <UserPlus size={13} /> Add character from agent
      </button>
      <button className="btn btn-sm" onClick={onEdit}>
        <Pencil size={13} /> Edit world
      </button>
      <button className="btn btn-sm danger-ghost" onClick={() => void remove()}>
        <Trash2 size={13} /> Delete world
      </button>
      <div className={`world-mode-note${world.mode === "simulation" ? " sim" : ""}`}>{MODE_META[world.mode].explain}</div>
    </div>
  );
}
