import { diffLines } from "./skillModel";

/** Unified diff with added / removed lines colored. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diffLines(diff);
  if (lines.length === 0) return <div className="muted">No changes.</div>;
  return (
    <pre className="tools-diff">
      {lines.map((l, i) => (
        <div key={i} className={`tools-diff-${l.kind}`}>
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}
