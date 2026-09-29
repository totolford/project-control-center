import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { api } from "../../lib/api";
import { mergeLogs, subscribeLogs } from "../../lib/logBus";
import { toast } from "../../lib/toast";
import { formatClock } from "../../lib/format";
import type { LogEntry, LogKind } from "../../lib/types";
import { Loading, Spinner } from "../../components/Common";

const PAGE = 200;
const COLLAPSE_LINES = 6;
const COLLAPSE_CHARS = 600;

const PREFIX: Record<LogKind, string> = {
  input: "›",
  assistant_text: "●",
  thinking: "∴",
  tool_use: "⚙",
  tool_result: "↳",
  system: "·",
  result: "✓",
  stderr: "!",
  error: "✗",
};

const LogLine = memo(function LogLine({
  entry,
  newSession,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  newSession: boolean;
  expanded: boolean;
  onToggle: (id: number) => void;
}) {
  let text = entry.text;
  let hidden = 0;
  if (entry.kind === "tool_result" && !expanded) {
    const lines = text.split("\n");
    if (lines.length > COLLAPSE_LINES) {
      hidden = lines.length - 3;
      text = lines.slice(0, 3).join("\n");
    } else if (text.length > COLLAPSE_CHARS) {
      hidden = -1;
      text = `${text.slice(0, 300)}…`;
    }
  }
  const collapsible = entry.kind === "tool_result" && (hidden !== 0 || expanded);
  return (
    <>
      {newSession && <div className="log-session">session #{entry.sessionId}</div>}
      <div className={`log log-${entry.kind}`}>
        <span className="log-time">{formatClock(entry.ts)}</span>
        <span className="log-prefix" aria-hidden="true">
          {PREFIX[entry.kind] ?? "·"}
        </span>
        <div className="log-text">
          {text}
          {collapsible && (
            <button className="log-toggle" onClick={() => onToggle(entry.id)}>
              {expanded ? "collapse" : hidden > 0 ? `show ${hidden} more lines` : "show all"}
            </button>
          )}
        </div>
      </div>
    </>
  );
});

/** Real session transcript: paginated backwards, appended live, virtualized. */
export function Terminal({ agentId }: { agentId: string }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prepended = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let ready = false;
    let buffer: LogEntry[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = buffer;
      buffer = [];
      setEntries((cur) => (cur.length > 0 && batch[0].id > cur[cur.length - 1].id ? [...cur, ...batch] : mergeLogs(cur, batch)));
    };
    const unsubscribe = subscribeLogs(agentId, (e) => {
      buffer.push(e);
      if (ready && !frame) frame = requestAnimationFrame(flush);
    });
    setEntries([]);
    setLoading(true);
    api
      .agentLogs(agentId, null, PAGE)
      .then((logs) => {
        if (cancelled) return;
        const sorted = [...logs].sort((a, b) => a.id - b.id);
        setHasMore(logs.length >= PAGE);
        const live = buffer;
        buffer = [];
        setEntries(mergeLogs(sorted, live));
      })
      .catch((e) => !cancelled && toast.error(e))
      .finally(() => {
        if (cancelled) return;
        ready = true;
        setLoading(false);
        if (buffer.length) flush();
      });
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [agentId]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 24,
    getItemKey: (i) => entries[i].id,
  });

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || entries.length === 0) return;
    setLoadingOlder(true);
    try {
      const older = await api.agentLogs(agentId, entries[0].id, PAGE);
      setHasMore(older.length >= PAGE);
      if (older.length > 0) {
        prepended.current = older.length;
        setEntries((cur) => mergeLogs(older, cur));
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingOlder(false);
    }
  }, [agentId, entries, hasMore, loadingOlder]);

  // Keep the previously first line in place after older lines are prepended.
  useLayoutEffect(() => {
    if (prepended.current > 0) {
      virtualizer.scrollToIndex(prepended.current, { align: "start" });
      prepended.current = 0;
    } else if (atBottomRef.current && entries.length > 0) {
      virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries, loading, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    atBottomRef.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (el.scrollTop < 60) void loadOlder();
  };

  const toggle = useCallback((id: number) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const jumpToBottom = () => {
    atBottomRef.current = true;
    setAtBottom(true);
    if (entries.length > 0) virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
  };

  if (loading) return <Loading text="Loading transcript…" />;

  return (
    <div className="terminal-wrap">
      <div className="terminal-top muted small">
        {loadingOlder ? <Spinner size={12} /> : entries.length === 0 ? "" : hasMore ? "Scroll up to load older lines" : "Beginning of transcript"}
      </div>
      <div className="terminal" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Agent session transcript">
        {entries.length === 0 ? (
          <div className="muted pad">No session output yet. Logs appear here as soon as the agent runs.</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = entries[item.index];
              const prev = item.index > 0 ? entries[item.index - 1] : undefined;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="log-row"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <LogLine
                    entry={entry}
                    newSession={prev !== undefined && prev.sessionId !== entry.sessionId}
                    expanded={expanded.has(entry.id)}
                    onToggle={toggle}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!atBottom && entries.length > 0 && (
        <button className="btn jump-bottom" onClick={jumpToBottom}>
          <ArrowDown size={13} /> Latest
        </button>
      )}
      <div className="terminal-footer muted small">{entries.length.toLocaleString()} lines loaded</div>
    </div>
  );
}
