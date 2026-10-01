import { useState } from "react";
import { Play, SquareTerminal } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { buildArgs, commandLabel, isInteractive, isMutating, missingArgs, optionName, parseArgName, type OptionValues } from "../../lib/cliArgs";
import { attempt } from "../../lib/toast";
import type { CliCommand, CliRun } from "../../lib/types";
import { openClaudeInTerminal } from "../../terminal/openInTerminal";
import { Spinner } from "../../components/Common";

function RunResult({ result }: { result: CliRun }) {
  return (
    <div className="cli-result">
      <div className="row small">
        <span className={`chip tone-${result.exitCode === 0 ? "green" : "red"}`}>exit {result.exitCode ?? "none (timed out or killed)"}</span>
        <span className="muted">{(result.durationMs / 1000).toFixed(1)} s</span>
        <span className="mono muted ellipsis">claude {result.args.join(" ")}</span>
      </div>
      {result.stdout && <pre className="json cli-out">{result.stdout}</pre>}
      {result.stderr && <pre className="json cli-out cli-err">{result.stderr}</pre>}
      {!result.stdout && !result.stderr && <div className="muted small">No output.</div>}
    </div>
  );
}

/** Builds the arguments of a command from a form and runs it without a terminal. */
export function RunForm({ command, exe, onRan }: { command: CliCommand; exe: string | null; onRan: (label: string) => void }) {
  const [positional, setPositional] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<OptionValues>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CliRun | null>(null);
  const args = buildArgs(command, positional, options);
  const missing = missingArgs(command, positional);
  const interactive = isInteractive(command);

  const execute = async () => {
    if (isMutating(command)) {
      const ok = await ask(`This changes Claude Code's configuration or installation:\n\nclaude ${args.join(" ")}`, { title: "Run command", kind: "warning", okLabel: "Run" });
      if (!ok) return;
    }
    setRunning(true);
    const r = await attempt(() => api.runClaudeCli(args));
    setRunning(false);
    if (r) {
      setResult(r);
      onRan(commandLabel(command));
    }
  };

  return (
    <div className="run-form">
      {command.arguments.map((a) => {
        const spec = parseArgName(a.name);
        return (
          <label key={a.name} className="field">
            <span className="field-label">
              {spec.name}
              {spec.required ? " *" : ""}
              {spec.variadic ? " (several, space-separated)" : ""}
            </span>
            <input className="mono" value={positional[a.name] ?? ""} onChange={(e) => setPositional({ ...positional, [a.name]: e.target.value })} />
            {a.description && <span className="field-hint">{a.description}</span>}
          </label>
        );
      })}
      {command.options.length > 0 && (
        <details>
          <summary className="small">Options ({command.options.length})</summary>
          <div className="run-options">
            {command.options.map((o) => {
              const name = optionName(o);
              if (o.value === null) {
                return (
                  <label key={o.flags} className="checkbox small" title={o.description}>
                    <input type="checkbox" checked={options[name] === true} onChange={(e) => setOptions({ ...options, [name]: e.target.checked })} />
                    <span className="mono">{o.flags}</span>
                  </label>
                );
              }
              const v = typeof options[name] === "string" ? (options[name] as string) : "";
              return (
                <label key={o.flags} className="field" title={o.description}>
                  <span className="field-label mono">{o.flags}</span>
                  {o.choices.length > 0 ? (
                    <select value={v} onChange={(e) => setOptions({ ...options, [name]: e.target.value })}>
                      <option value="">(not set)</option>
                      {o.choices.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input className="mono" value={v} placeholder={o.default ?? ""} onChange={(e) => setOptions({ ...options, [name]: e.target.value })} />
                  )}
                </label>
              );
            })}
          </div>
        </details>
      )}
      <div className="cli-preview mono small">claude {args.join(" ")}</div>
      <div className="row">
        {interactive ? (
          <button className="btn primary" onClick={() => void openClaudeInTerminal(args, exe)}>
            <SquareTerminal size={13} /> Open in Raw Terminal
          </button>
        ) : (
          <button className="btn primary" onClick={() => void execute()} disabled={running || missing.length > 0} title={missing.length > 0 ? `Missing: ${missing.join(", ")}` : undefined}>
            {running ? <Spinner size={12} /> : <Play size={13} />} Run
          </button>
        )}
        {isMutating(command) && <span className="chip tone-amber">changes configuration</span>}
        {interactive && <span className="muted small">Interactive: runs in a terminal.</span>}
        {!interactive && (
          <button className="btn ghost" onClick={() => void openClaudeInTerminal(args, exe)} title="Run it in a PowerShell terminal instead">
            <SquareTerminal size={13} /> In terminal
          </button>
        )}
      </div>
      {result && <RunResult result={result} />}
    </div>
  );
}
