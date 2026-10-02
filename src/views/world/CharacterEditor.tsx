import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Field } from "../../components/Common";
import { ModelSelect } from "../../components/ModelSelect";
import type { Agent, Character } from "../../lib/types";
import { sortAgents } from "../../store";
import { AUTONOMY_LEVELS, blankCharacter, parseCsv, removeAt, removeCharacter, replaceAt, updateCharacter } from "./characters";
import { ListEditor } from "./ListEditor";
import { SPRITES, spriteFill } from "./status";

/** Character template editor (wizard step 4 and "Edit world"). */
export function CharacterEditor({ characters, onChange, agents }: {
  characters: Character[];
  onChange: (chars: Character[]) => void;
  agents: Agent[];
}) {
  const [selected, setSelected] = useState<string | null>(characters[0]?.id ?? null);
  const current = characters.find((c) => c.id === selected) ?? characters[0];

  const add = () => {
    const c = blankCharacter("New character", new Set(characters.map((ch) => ch.id)), characters.length);
    onChange([...characters, c]);
    setSelected(c.id);
  };

  return (
    <div className="world-editor">
      <div className="world-editor-list">
        {characters.map((c) => (
          <button key={c.id} type="button" className={`list-item${c.id === current?.id ? " active" : ""}`} onClick={() => setSelected(c.id)}>
            <span className="row">
              <span className="world-swatch" style={{ background: spriteFill(c.sprite) }} />
              {c.name || <em className="muted">unnamed</em>}
            </span>
            {c.nexusAgent && <span className="tiny muted">linked</span>}
          </button>
        ))}
        <button type="button" className="btn btn-sm ghost" onClick={add}>
          <Plus size={13} /> New character
        </button>
      </div>
      {current ? (
        <CharacterForm
          key={current.id}
          c={current}
          others={characters.filter((o) => o.id !== current.id)}
          agents={agents}
          onPatch={(patch) => onChange(updateCharacter(characters, current.id, patch))}
          onRemove={() => onChange(removeCharacter(characters, current.id))}
        />
      ) : (
        <div className="muted small">Add a character to edit it.</div>
      )}
    </div>
  );
}

function CharacterForm({ c, others, agents, onPatch, onRemove }: {
  c: Character;
  others: Character[];
  agents: Agent[];
  onPatch: (patch: Partial<Character>) => void;
  onRemove: () => void;
}) {
  const autonomy = AUTONOMY_LEVELS.includes(c.autonomy) ? AUTONOMY_LEVELS : [...AUTONOMY_LEVELS, c.autonomy];
  const linkable = sortAgents(agents).filter((a) => a.status !== "retired" || a.id === c.nexusAgent);
  return (
    <div className="world-editor-form">
      <div className="form-row">
        <Field label="Name">
          <input value={c.name} onChange={(e) => onPatch({ name: e.target.value })} />
        </Field>
        <Field label="Linked NEXUS agent" hint="Linked characters mirror the real agent in Hybrid / Real execution.">
          <select value={c.nexusAgent ?? ""} onChange={(e) => onPatch({ nexusAgent: e.target.value || null })}>
            <option value="">None (simulated)</option>
            {linkable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.role}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Personality">
        <textarea rows={2} value={c.personality} onChange={(e) => onPatch({ personality: e.target.value })} />
      </Field>
      <div className="grid-2">
        <Field label="Goals" group>
          <ListEditor items={c.goals} onChange={(goals) => onPatch({ goals })} addLabel="Add goal" />
        </Field>
        <Field label="Memory" group>
          <ListEditor items={c.memory} onChange={(memory) => onPatch({ memory })} addLabel="Add memory" />
        </Field>
      </div>
      <div className="form-row">
        <CsvField label="Skills" value={c.skills} onChange={(skills) => onPatch({ skills })} />
        <CsvField label="Tools" value={c.tools} onChange={(tools) => onPatch({ tools })} />
        <CsvField label="MCP / connections" value={c.mcp} onChange={(mcp) => onPatch({ mcp })} />
      </div>
      <div className="form-row">
        <Field label="Model">
          <ModelSelect value={c.model} onChange={(model) => onPatch({ model })} />
        </Field>
        <Field label="Autonomy">
          <select value={c.autonomy} onChange={(e) => onPatch({ autonomy: e.target.value })}>
            {autonomy.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sprite" group>
          <div className="row">
            {SPRITES.map((s) => (
              <button
                key={s}
                type="button"
                className={`world-sprite${s === c.sprite ? " active" : ""}`}
                style={{ background: spriteFill(s) }}
                aria-label={`Sprite ${s}`}
                aria-pressed={s === c.sprite}
                onClick={() => onPatch({ sprite: s })}
              />
            ))}
          </div>
        </Field>
      </div>
      <Field label="Relationships" group>
        <div className="world-list-editor">
          {c.relationships.map((r, i) => (
            <div key={i} className="world-list-row">
              <select value={r.with} onChange={(e) => onPatch({ relationships: replaceAt(c.relationships, i, { ...r, with: e.target.value }) })}>
                <option value="">Choose…</option>
                {others.map((o) => (
                  <option key={o.id} value={o.name}>
                    {o.name}
                  </option>
                ))}
                {r.with && !others.some((o) => o.name === r.with) && <option value={r.with}>{r.with}</option>}
              </select>
              <input value={r.kind} placeholder="e.g. reports to, mentors, friend" onChange={(e) => onPatch({ relationships: replaceAt(c.relationships, i, { ...r, kind: e.target.value }) })} />
              <button type="button" className="icon-btn" aria-label="Remove relationship" onClick={() => onPatch({ relationships: removeAt(c.relationships, i) })}>
                <X size={13} />
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-sm ghost" disabled={others.length === 0} onClick={() => onPatch({ relationships: [...c.relationships, { with: "", kind: "" }] })}>
            <Plus size={13} /> Add relationship
          </button>
        </div>
      </Field>
      <div className="row-end">
        <button type="button" className="btn btn-sm danger-ghost" onClick={onRemove}>
          <Trash2 size={13} /> Remove character
        </button>
      </div>
    </div>
  );
}

function CsvField({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  // Raw text while typing so a trailing comma is not swallowed.
  const [text, setText] = useState(value.join(", "));
  return (
    <Field label={label} hint="Comma separated">
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseCsv(e.target.value));
        }}
      />
    </Field>
  );
}
