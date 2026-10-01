import type { CliRun } from "../../lib/types";

/** Output of a `claude …` command run by NEXUS. */
export function CliRunOutput({ run }: { run: CliRun }) {
  const ok = run.exitCode === 0;
  return (
    <div className={`notice ${ok ? "" : "notice-error"} tools-cli`}>
      <div className="grow">
        <div className="row">
          <code>claude {run.args.join(" ")}</code>
          <span className="muted small">
            exit {run.exitCode ?? "none (timed out)"} · {run.durationMs} ms
          </span>
        </div>
        {run.stdout.trim() && <pre className="json">{run.stdout.trim()}</pre>}
        {run.stderr.trim() && <pre className="json tone-red-fg">{run.stderr.trim()}</pre>}
      </div>
    </div>
  );
}
