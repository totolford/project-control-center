// Real session transcript of one agent for the chat: history page from agent_logs, then live lines
// from pcc://log (batched per animation frame), older pages on demand.

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { mergeLogs, subscribeLogs } from "../../lib/logBus";
import { toast } from "../../lib/toast";
import type { LogEntry } from "../../lib/types";

export const CHAT_PAGE = 300;

export function useChatLogs(agentId: string) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let ready = false;
    let buffer: LogEntry[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = buffer;
      buffer = [];
      setEntries((cur) => mergeLogs(cur, batch));
    };
    const unsubscribe = subscribeLogs(agentId, (e) => {
      buffer.push(e);
      if (ready && !frame) frame = requestAnimationFrame(flush);
    });
    setEntries([]);
    setLoading(true);
    api
      .agentLogs(agentId, null, CHAT_PAGE)
      .then((logs) => {
        if (cancelled) return;
        setHasMore(logs.length >= CHAT_PAGE);
        const live = buffer;
        buffer = [];
        setEntries(mergeLogs([...logs].sort((a, b) => a.id - b.id), live));
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

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || entries.length === 0) return;
    setLoadingOlder(true);
    try {
      const older = await api.agentLogs(agentId, entries[0].id, CHAT_PAGE);
      setHasMore(older.length >= CHAT_PAGE);
      if (older.length > 0) setEntries((cur) => mergeLogs([...older].sort((a, b) => a.id - b.id), cur));
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingOlder(false);
    }
  }, [agentId, entries, hasMore, loadingOlder]);

  return { entries, loading, hasMore, loadingOlder, loadOlder };
}
