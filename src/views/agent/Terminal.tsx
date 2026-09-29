import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { api } from "../../lib/api";
import { mergeLogs, subscribeLogs } from "../../lib/logBus";
import { toast } from "../../lib/toast";
import type { LogEntry } from "../../lib/types";
import { Loading, Spinner } from "../../components/Common";
import { LogLine } from "./LogLine";

const PAGE = 200;

/** Real session transcript: paginated backwards, appended live, virtualized. */
export function Terminal({ agentId, dense }: { agentId: string; dense?: boolean }) {
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
    <div className={`terminal-wrap${dense ? " dense" : ""}`}>
      {(!dense || loadingOlder) && (
        <div className="terminal-top muted small">
          {loadingOlder ? <Spinner size={12} /> : entries.length === 0 ? "" : hasMore ? "Scroll up to load older lines" : "Beginning of transcript"}
        </div>
      )}
      <div className="terminal" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Agent session transcript">
        {entries.length === 0 ? (
          <div className="muted pad">No session output yet.</div>
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
                    showTime={!dense}
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
      {!dense && <div className="terminal-footer muted small">{entries.length.toLocaleString()} lines loaded</div>}
    </div>
  );
}
