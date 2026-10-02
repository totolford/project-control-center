import { useState } from "react";
import { Maximize2, Pause, Play } from "lucide-react";
import { Loading } from "../../components/Common";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { useAgents, useStore } from "../../store";
import { characterRing, liveAgent, MODE_META } from "./status";
import { useWorld } from "./useWorld";
import { WorldCanvas } from "./WorldCanvas";

/** Compact AI World for a workspace panel: same map, run / pause and the selected character. */
export function AiWorldPanel() {
  const { world, loading, publish } = useWorld();
  const agents = useAgents();
  const navigate = useStore((s) => s.navigate);
  const openAgent = useStore((s) => s.openAgent);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (loading && !world) return <Loading text="Loading the AI World…" />;
  if (!world) {
    return (
      <div className="world-panel-empty">
        <div className="small muted">This project has no AI World yet.</div>
        <button className="btn btn-sm primary" onClick={() => navigate({ name: "world" })}>
          Open AI World
        </button>
      </div>
    );
  }

  const selected = world.characters.find((c) => c.id === selectedId);
  const ring = selected ? characterRing(selected, world.mode, agents) : null;
  const agent = selected ? liveAgent(selected, world.mode, agents) : undefined;

  const toggle = async () => {
    const w = await attempt(() => api.worldControl({ running: !world.running }));
    if (w) publish(w);
  };

  return (
    <div className="world-panel">
      <div className="world-panel-bar">
        <button className="btn btn-sm" onClick={() => void toggle()}>
          {world.running ? <Pause size={12} /> : <Play size={12} />} {world.running ? "Pause" : "Run"}
        </button>
        <span className={`chip ${world.mode === "simulation" ? "tone-amber" : "tone-accent"}`} title={MODE_META[world.mode].explain}>
          {world.mode === "simulation" ? "Simulation — not your real agents" : MODE_META[world.mode].label}
        </span>
        <span className="tiny mono muted">tick {world.tick}</span>
        <span className="spacer" />
        <button className="icon-btn" title="Open full view" aria-label="Open full view" onClick={() => navigate({ name: "world" })}>
          <Maximize2 size={13} />
        </button>
      </div>
      <div className="world-panel-map">
        <WorldCanvas world={world} agents={agents} selectedId={selectedId} onSelect={setSelectedId} compact />
      </div>
      {selected && ring && (
        <div className="world-panel-card">
          <div className="row">
            <strong>{selected.name}</strong>
            <span className="tiny" style={{ color: ring.color }}>
              {ring.label}
            </span>
            <span className="spacer" />
            {agent && (
              <button className="link-btn tiny" onClick={() => openAgent(agent.id)}>
                Linked to {agent.name}
              </button>
            )}
          </div>
          <div className="tiny muted">{selected.activity ?? "No current activity"}</div>
        </div>
      )}
    </div>
  );
}
