import { useState } from "react";
import { Link2, Plus, Sparkles, X } from "lucide-react";
import { Spinner } from "../../../components/Common";
import { api } from "../../../lib/api";
import { attempt } from "../../../lib/toast";
import type { Character } from "../../../lib/types";
import { blankCharacter, mergeCharacters, removeCharacter, unlinkAll } from "../characters";
import type { CharacterSource, WizardState } from "../wizard";

const SOURCES: { id: CharacterSource; title: string; summary: string }[] = [
  { id: "agents", title: "From NEXUS agents", summary: "One character per agent, linked: in Hybrid / Real execution it mirrors that agent." },
  { id: "roles", title: "Existing project roles", summary: "The same characters without the link: they are simulated." },
  { id: "custom", title: "Custom characters", summary: "Create characters by hand, then edit them in the next step." },
  { id: "generated", title: "AI generated", summary: "Claude invents characters from a description." },
];

export function StepAgents({ state, set }: { state: WizardState; set: (s: WizardState) => void }) {
  const [busy, setBusy] = useState(false);
  const [customName, setCustomName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(4);

  const fromAgents = async (source: CharacterSource) => {
    setBusy(true);
    const chars = await attempt(() => api.worldCharactersFromAgents());
    setBusy(false);
    if (chars) set({ ...state, source, characters: source === "roles" ? unlinkAll(chars) : chars });
  };

  const choose = (source: CharacterSource) => {
    if (source === "agents" || source === "roles") void fromAgents(source);
    else set({ ...state, source });
  };

  const addCustom = () => {
    const name = customName.trim();
    if (!name) return;
    const taken = new Set(state.characters.map((c) => c.id));
    set({ ...state, characters: [...state.characters, blankCharacter(name, taken, state.characters.length)] });
    setCustomName("");
  };

  const generate = async () => {
    setBusy(true);
    const chars = await attempt(() => api.worldGenerateCharacters(prompt.trim(), count));
    setBusy(false);
    if (chars) set({ ...state, characters: mergeCharacters(state.characters, chars) });
  };

  return (
    <div className="world-step">
      <div className="world-choices" role="radiogroup" aria-label="Characters source">
        {SOURCES.map((s) => (
          <label key={s.id} className={`world-choice${state.source === s.id ? " active" : ""}`}>
            <input type="radio" name="source" checked={state.source === s.id} disabled={busy} onChange={() => choose(s.id)} />
            <div className="grow">
              <strong>{s.title}</strong>
              <div className="small muted">{s.summary}</div>
            </div>
          </label>
        ))}
      </div>

      {state.source === "custom" && (
        <form className="row world-gap" onSubmit={(e) => (e.preventDefault(), addCustom())}>
          <input className="grow" value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Character name" />
          <button type="submit" className="btn btn-sm" disabled={!customName.trim()}>
            <Plus size={13} /> Add character
          </button>
        </form>
      )}

      {state.source === "generated" && (
        <div className="world-gap stack">
          <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. A small game studio: a lead designer, two engineers and a QA tester" />
          <div className="row">
            <label className="row small">
              Count <input type="number" min={1} max={12} value={count} onChange={(e) => setCount(Math.min(12, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 60 }} />
            </label>
            <span className="tiny muted">Uses Claude (haiku): one real call, a few cents.</span>
            <span className="spacer" />
            <button type="button" className="btn btn-sm" disabled={busy || !prompt.trim()} onClick={() => void generate()}>
              {busy ? <Spinner size={12} /> : <Sparkles size={13} />} Generate with Claude
            </button>
          </div>
        </div>
      )}

      <div className="section-label row">
        Characters ({state.characters.length})
        {busy && <Spinner size={12} />}
        <span className="spacer" />
        {state.characters.length > 0 && (
          <button type="button" className="link-btn muted" onClick={() => set({ ...state, characters: [] })}>
            Clear all
          </button>
        )}
      </div>
      <CharacterChips characters={state.characters} onRemove={(id) => set({ ...state, characters: removeCharacter(state.characters, id) })} />
    </div>
  );
}

function CharacterChips({ characters, onRemove }: { characters: Character[]; onRemove: (id: string) => void }) {
  if (characters.length === 0) return <div className="small muted">No characters yet.</div>;
  return (
    <div className="world-chips">
      {characters.map((c) => (
        <span key={c.id} className={`chip ${c.nexusAgent ? "tone-accent" : "tone-grey"}`} title={c.nexusAgent ? `Linked to agent ${c.nexusAgent}` : "Simulated character"}>
          {c.nexusAgent && <Link2 size={11} />} {c.name}
          <button type="button" className="world-chip-x" aria-label={`Remove ${c.name}`} onClick={() => onRemove(c.id)}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}
