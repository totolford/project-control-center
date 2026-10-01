import { Star } from "lucide-react";
import { commandLabel } from "../../lib/cliArgs";
import { currentOptionValue } from "../../lib/claudeEnv";
import type { CliCommand } from "../../lib/types";
import { useClaude } from "../../state/claude";
import { RunForm } from "./RunForm";

/** Description, usage, arguments and options of one CLI command, with the Run form. */
export function CommandDetail({
  command,
  exe,
  favorite,
  onToggleFavorite,
  onRan,
}: {
  command: CliCommand;
  exe: string | null;
  favorite: boolean;
  onToggleFavorite: () => void;
  onRan: (label: string) => void;
}) {
  const settings = useClaude((s) => s.env?.settings ?? null);
  return (
    <div className="cmd-detail">
      <div className="row">
        <h2 className="mono grow">{commandLabel(command)}</h2>
        <button className={`icon-btn${favorite ? " active" : ""}`} onClick={onToggleFavorite} aria-label={favorite ? "Remove from favorites" : "Add to favorites"} title="Favorite">
          <Star size={14} fill={favorite ? "currentColor" : "none"} />
        </button>
      </div>
      {command.aliases.length > 0 && <div className="muted small">Aliases: {command.aliases.join(", ")}</div>}
      <p className="prewrap">{command.description || <span className="muted">No description in the help text.</span>}</p>
      <dl className="kv">
        <dt>Usage</dt>
        <dd className="mono small">{command.usage || "—"}</dd>
        <dt>Signature</dt>
        <dd className="mono small">{command.signature || "—"}</dd>
        <dt>Category</dt>
        <dd>{command.category || "—"}</dd>
      </dl>

      {command.arguments.length > 0 && (
        <>
          <div className="section-label">Arguments</div>
          <table className="table compact-table">
            <tbody>
              {command.arguments.map((a) => (
                <tr key={a.name}>
                  <td className="mono">{a.name}</td>
                  <td>{a.description || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {command.options.length > 0 && (
        <>
          <div className="section-label">Options</div>
          <div className="table-wrap">
            <table className="table compact-table">
              <thead>
                <tr>
                  <th>Flags</th>
                  <th>Description</th>
                  <th>Choices</th>
                  <th>Default</th>
                  <th>Current value</th>
                </tr>
              </thead>
              <tbody>
                {command.options.map((o) => (
                  <tr key={o.flags}>
                    <td className="mono nowrap">{o.flags}</td>
                    <td>{o.description || "—"}</td>
                    <td className="mono small">{o.choices.length > 0 ? o.choices.join(" | ") : "—"}</td>
                    <td className="mono small">{o.default ?? "—"}</td>
                    <td className="mono small">{currentOptionValue(o, settings) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-label">Run</div>
      <RunForm key={commandLabel(command)} command={command} exe={exe} onRan={onRan} />
    </div>
  );
}
