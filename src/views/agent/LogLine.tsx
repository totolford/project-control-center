import { memo } from "react";
import { formatClock } from "../../lib/format";
import { parseToolUse, previewResult } from "../../lib/toolText";
import type { LogEntry, LogKind } from "../../lib/types";

const PREFIX: Record<LogKind, string> = {
  input: ">",
  assistant_text: " ",
  thinking: "✻",
  tool_use: "⏺",
  tool_result: "⎿",
  system: "·",
  result: "✓",
  stderr: "!",
  error: "✗",
};

function ToolUse({ text }: { text: string }) {
  const call = parseToolUse(text);
  return (
    <span title={text}>
      {call.nested && <span className="log-dim">↳ </span>}
      {call.action}
      {call.input && <span className="log-dim log-args"> {call.name}</span>}
    </span>
  );
}

/** One transcript line. Tool results are collapsed to their first lines unless expanded. */
export const LogLine = memo(function LogLine({
  entry,
  newSession,
  expanded,
  onToggle,
  showTime,
}: {
  entry: LogEntry;
  newSession: boolean;
  expanded: boolean;
  onToggle: (id: number) => void;
  showTime: boolean;
}) {
  const collapsible = entry.kind === "tool_result" || (entry.kind === "error" && entry.text.includes("\n"));
  let body: React.ReactNode = entry.text;
  let hidden = 0;
  if (entry.kind === "tool_use") body = <ToolUse text={entry.text} />;
  else if (collapsible && !expanded) {
    const preview = previewResult(entry.text, 2);
    hidden = preview.hidden;
    body = preview.head.length > 400 ? `${preview.head.slice(0, 400)}…` : preview.head;
  }
  return (
    <>
      {newSession && <div className="log-session">session #{entry.sessionId}</div>}
      <div className={`log log-${entry.kind}`}>
        {showTime && <span className="log-time">{formatClock(entry.ts)}</span>}
        <span className="log-prefix" aria-hidden="true">
          {PREFIX[entry.kind] ?? "·"}
        </span>
        <div className="log-text">
          {body}
          {collapsible && (hidden > 0 || expanded) && (
            <button className="log-toggle" onClick={() => onToggle(entry.id)}>
              {expanded ? "collapse" : `+${hidden} lines`}
            </button>
          )}
        </div>
      </div>
    </>
  );
});
