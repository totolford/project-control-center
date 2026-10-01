import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../../lib/api";
import { DECISIONS, decisionMeta, filterDecisions, mergeDecisions, oldestId } from "../../lib/decisions";
import { formatDateTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import type { DecisionRecord } from "../../lib/types";
import { useAgents, useStore } from "../../store";
import { Loading, Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";

const PAGE = 200;

const Row = memo(function Row({ d, agent }: { d: DecisionRecord; agent: string }) {
  const meta = decisionMeta(d.decision);
  return (
    <div className={`journal-row${d.decision === "auto_approved" ? " auto" : ""}`}>
      <span className="mono muted">{formatDateTime(d.ts)}</span>
      <span className="ellipsis">{agent}</span>
      <Chip tone={meta.tone}>{meta.label}</Chip>
      <span className="mono small ellipsis">{d.capability ?? "—"}</span>
      <span className="ellipsis" title={`${d.toolName}: ${d.summary}`}>
        {d.summary}
      </span>
      <span className="muted small ellipsis" title={d.reason ?? undefined}>
        {d.reason ?? "—"} <span className="dim">({d.actor})</span>
      </span>
    </div>
  );
});

/** Approval journal: every permission decision, newest first, live, paged on scroll. */
export function DecisionJournal() {
  const agents = useAgents();
  const version = useStore((s) => s.project?.decisionVersion ?? 0);
  const [agentId, setAgentId] = useState("");
  const [decision, setDecision] = useState("");
  const [list, setList] = useState<DecisionRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setList(null);
    api
      .listDecisions(agentId || null, null, PAGE)
      .then((page) => {
        if (cancelled) return;
        setList(page);
        setHasMore(page.length >= PAGE);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(e);
          setList([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Live refresh: merge the newest page whenever a permission event arrives.
  useEffect(() => {
    if (version === 0) return;
    api
      .listDecisions(agentId || null, null, 50)
      .then((page) => setList((cur) => (cur ? mergeDecisions(cur, page) : cur)))
      .catch(() => undefined);
  }, [version, agentId]);

  const loadMore = useCallback(async () => {
    const before = list ? oldestId(list) : null;
    if (!list || before === null || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const older = await api.listDecisions(agentId || null, before, PAGE);
      setHasMore(older.length >= PAGE);
      setList((cur) => mergeDecisions(cur ?? [], older));
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingMore(false);
    }
  }, [list, loadingMore, hasMore, agentId]);

  const rows = useMemo(() => (list ? filterDecisions(list, { agentId, decision }) : []), [list, agentId, decision]);
  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 20,
    getItemKey: (i) => rows[i].id,
  });
  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadMore();
  };

  return (
    <div className="journal">
      <div className="filters">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="Filter by decision">
          <option value="">All decisions</option>
          {DECISIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        <span className="muted small">{list ? `${rows.length} shown` : ""}</span>
      </div>
      <div className="journal-row journal-head">
        <span>Time</span>
        <span>Agent</span>
        <span>Decision</span>
        <span>Capability</span>
        <span>Summary</span>
        <span>Reason</span>
      </div>
      <div className="journal-scroll" ref={scrollRef} onScroll={onScroll}>
        {list === null ? (
          <Loading />
        ) : rows.length === 0 ? (
          <div className="muted pad">No decision journaled yet.</div>
        ) : (
          <>
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const d = rows[item.index];
                return (
                  <div key={item.key} className="v-row" style={{ transform: `translateY(${item.start}px)`, height: item.size }}>
                    <Row d={d} agent={names.get(d.agentId) ?? d.agentId} />
                  </div>
                );
              })}
            </div>
            <div className="muted small pad center">{loadingMore ? <Spinner size={12} /> : hasMore ? "Scroll for older decisions" : "Beginning of journal"}</div>
          </>
        )}
      </div>
    </div>
  );
}
