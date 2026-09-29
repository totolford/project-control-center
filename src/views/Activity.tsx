import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { formatClock, formatDateTime } from "../lib/format";
import type { Tone } from "../lib/labels";
import type { EventKind, PccEvent } from "../lib/types";
import { useAgents, useMissions, useStore, useTimeline } from "../store";
import { JsonView, Loading, PageHeader, Spinner } from "../components/Common";
import { Chip } from "../components/StatusBadge";

const PAGE = 200;

function kindTone(kind: EventKind): Tone {
  if (kind === "Error" || kind === "AgentCrashed" || kind === "TaskFailed") return "red";
  if (kind.startsWith("Permission") || kind === "ReviewRequested") return "amber";
  if (kind.startsWith("Mission")) return "accent";
  if (kind === "TaskCompleted") return "green";
  if (kind === "AgentMessage") return "blue";
  return "grey";
}

const EventRow = memo(function EventRow({
  e,
  agentName,
  selected,
  onSelect,
}: {
  e: PccEvent;
  agentName: string | undefined;
  selected: boolean;
  onSelect: (e: PccEvent) => void;
}) {
  return (
    <button className={`event-row${selected ? " selected" : ""}`} onClick={() => onSelect(e)}>
      <span className="mono muted">{formatClock(e.ts)}</span>
      <Chip tone={kindTone(e.kind)}>{e.kind}</Chip>
      <span className="event-agent">{agentName ?? e.agentId ?? ""}</span>
      <span className="event-summary">{e.summary}</span>
    </button>
  );
});

export function Activity() {
  const agents = useAgents();
  const missions = useMissions();
  const timeline = useTimeline();
  const openAgent = useStore((s) => s.openAgent);
  const openTask = useStore((s) => s.openTask);
  const [agentFilter, setAgentFilter] = useState("");
  const [missionFilter, setMissionFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [history, setHistory] = useState<PccEvent[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<PccEvent | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filter = useMemo(
    () => ({ agentId: agentFilter || undefined, missionId: missionFilter || undefined }),
    [agentFilter, missionFilter],
  );

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    api
      .events({ ...filter, limit: PAGE })
      .then((events) => {
        if (cancelled) return;
        setHistory(events);
        setHasMore(events.length >= PAGE);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e);
        setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const rows = useMemo(() => {
    if (!history) return [];
    const newest = history.length ? Math.max(...history.map((e) => e.id)) : 0;
    const live = timeline.filter(
      (e) => e.id > newest && (!filter.agentId || e.agentId === filter.agentId) && (!filter.missionId || e.missionId === filter.missionId),
    );
    const all = [...live, ...history].sort((a, b) => b.id - a.id);
    return kindFilter ? all.filter((e) => e.kind === kindFilter) : all;
  }, [history, timeline, filter, kindFilter]);

  const loadMore = useCallback(async () => {
    if (!history || loadingMore || !hasMore || history.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = Math.min(...history.map((e) => e.id));
      const older = await api.events({ ...filter, before: oldest, limit: PAGE });
      setHasMore(older.length >= PAGE);
      setHistory((cur) => [...(cur ?? []), ...older.filter((e) => e.id < oldest)]);
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingMore(false);
    }
  }, [filter, hasMore, history, loadingMore]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 20,
    getItemKey: (i) => rows[i].id,
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadMore();
  };

  const kinds = useMemo(() => [...new Set([...(history ?? []), ...timeline].map((e) => e.kind))].sort(), [history, timeline]);
  const agentName = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name : undefined);

  return (
    <div className="page page-fill">
      <PageHeader title="Activity" subtitle="Timeline of everything that happened in this project." />
      <div className="filters">
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={missionFilter} onChange={(e) => setMissionFilter(e.target.value)} aria-label="Filter by mission">
          <option value="">All missions</option>
          {missions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} aria-label="Filter by kind">
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div className="split">
        <div className="split-main event-scroll" ref={scrollRef} onScroll={onScroll}>
          {history === null ? (
            <Loading />
          ) : rows.length === 0 ? (
            <div className="muted pad">No events yet.</div>
          ) : (
            <>
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const e = rows[item.index];
                  return (
                    <div key={item.key} className="v-row" style={{ transform: `translateY(${item.start}px)`, height: item.size }}>
                      <EventRow e={e} agentName={agentName(e.agentId)} selected={selected?.id === e.id} onSelect={setSelected} />
                    </div>
                  );
                })}
              </div>
              <div className="muted small pad center">{loadingMore ? <Spinner size={12} /> : hasMore ? "Scroll for older events" : "Beginning of timeline"}</div>
            </>
          )}
        </div>
        {selected && (
          <aside className="drawer" aria-label="Event detail">
            <div className="drawer-header">
              <Chip tone={kindTone(selected.kind)}>{selected.kind}</Chip>
              <h2 className="grow">#{selected.id}</h2>
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close event detail">
                <X size={16} />
              </button>
            </div>
            <div className="drawer-body">
              <p>{selected.summary}</p>
              <dl className="kv">
                <dt>Time</dt>
                <dd>
                  {formatDateTime(selected.ts)} ({formatClock(selected.ts)})
                </dd>
                {selected.agentId && (
                  <>
                    <dt>Agent</dt>
                    <dd>
                      <button className="link-btn" onClick={() => openAgent(selected.agentId!)}>
                        {agentName(selected.agentId) ?? selected.agentId}
                      </button>
                    </dd>
                  </>
                )}
                {selected.taskId && (
                  <>
                    <dt>Task</dt>
                    <dd>
                      <button className="link-btn mono" onClick={() => openTask(selected.taskId!)}>
                        {selected.taskId}
                      </button>
                    </dd>
                  </>
                )}
                {selected.missionId && (
                  <>
                    <dt>Mission</dt>
                    <dd>{missions.find((m) => m.id === selected.missionId)?.title ?? selected.missionId}</dd>
                  </>
                )}
              </dl>
              <div className="section-label">Payload</div>
              <JsonView value={selected.payload} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
