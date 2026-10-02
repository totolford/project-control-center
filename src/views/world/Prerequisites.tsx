import type { WorldPrerequisite } from "../../lib/types";

/** ✓ / ✗ list of a provider's prerequisites, as checked by the backend. */
export function Prerequisites({ items }: { items: WorldPrerequisite[] }) {
  return (
    <ul className="world-prereqs">
      {items.map((p) => (
        <li key={p.name}>
          <span className={p.met ? "tone-green-fg" : p.required ? "tone-red-fg" : "tone-amber-fg"} aria-label={p.met ? "met" : "missing"}>
            {p.met ? "✓" : "✗"}
          </span>{" "}
          <strong>{p.name}</strong>
          {!p.required && <span className="dim"> (optional)</span>}
          {p.detail && <span className="muted"> — {p.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
