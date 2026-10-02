import { Plus, X } from "lucide-react";
import { removeAt, replaceAt } from "./characters";

/** Editable list of short texts (rules, goals, memory). */
export function ListEditor({ items, onChange, placeholder, addLabel = "Add" }: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel?: string;
}) {
  return (
    <div className="world-list-editor">
      {items.map((item, i) => (
        <div key={i} className="world-list-row">
          <input value={item} placeholder={placeholder} onChange={(e) => onChange(replaceAt(items, i, e.target.value))} />
          <button type="button" className="icon-btn" aria-label="Remove" onClick={() => onChange(removeAt(items, i))}>
            <X size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm ghost" onClick={() => onChange([...items, ""])}>
        <Plus size={13} /> {addLabel}
      </button>
    </div>
  );
}
