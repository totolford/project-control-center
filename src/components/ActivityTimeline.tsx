import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { formatClock } from "../lib/format";
import type { LucideIcon } from "lucide-react";
import { Bot, Folder, GitBranch, ListChecks, MessageSquare, OctagonX, Plug, ShieldCheck, Wrench } from "lucide-react";
import { groupOf, kindTone, toolOf, type ActivityGroup } from "../lib/activityGroups";
import type { PccEvent } from "../lib/types";
import { useAgents, useTimeline } from "../store";
import { Loading, Spinner } from "./Common";
import { Chip } from "./StatusBadge";

const PAGE = 200;

const GROUP_ICON: Record<ActivityGroup, LucideIcon> = {
  agents: Bot,
  tasks: ListChecks,
  messages: MessageSquare,
  tools: Wrench,
  permissions: ShieldCheck,
  mcp_skills: Plug,
  git: GitBranch,
  safety: OctagonX,
  project: Folder,
};

export interface TimelineFilter {
  agentId?: string;
  missionId?: string;
  kind?: string;
  /** Kind groups to show; empty or absent = all. */
  groups?: ActivityGroup[];
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
  const Icon = GROUP_ICON[groupOf(e.kind)];
  const tool = e.kind === "ToolUsed" ? toolOf(e.payload) : null;
  return (
    <button className={`event-row${selected ? " selected" : ""}`} onClick={() => onSelect(e)}>
      <span className="mono muted">{formatClock(e.ts)}</span>
      <span className={`event-kind tone-${kindTone(e.kind)}-fg`}>
        <Icon size={12} />
        <Chip tone={kindTone(e.kind)}>{e.kind}</Chip>
      </span>
      <span className="event-agent">{agentName ?? e.agentId ?? ""}</span>
      <span className="event-summary">
        {tool && <span className="mono tool-name">{tool}</span>}
        {e.summary}
      </span>
    </button>
  );
});

/** Persisted timeline: first page from the backend, older pages on scroll, live events prepended. */
export function ActivityTimeline({
  filter,
  selectedId,
  onSelect,
  onKinds,
}: {
  filter: TimelineFilter;
  selectedId?: number;
  onSelect: (e: PccEvent) => void;
  /** Receives the event kinds seen so far (for filter menus). */
  onKinds?: (kinds: string[]) => void;
}) {
  const agents = useAgents();
  const timeline = useTimeline();
  const [history, setHistory] = useState<PccEvent[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { agentId, missionId, kind, groups } = filter;

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    api
      .events({ agentId, missionId, limit: PAGE })
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
  }, [agentId, missionId]);

  const all = useMemo(() => {
    if (!history) return [];
    const newest = history.reduce((m, e) => Math.max(m, e.id), 0);
    const live = timeline.filter((e) => e.id > newest && (!agentId || e.agentId === agentId) && (!missionId || e.missionId === missionId));
    return [...live, ...history].sort((a, b) => b.id - a.id);
  }, [history, timeline, agentId, missionId]);
  const rows = useMemo(
    () => all.filter((e) => (!kind || e.kind === kind) && (!groups || groups.length === 0 || groups.includes(groupOf(e.kind)))),
    [all, kind, groups],
  );

  useEffect(() => {
    onKinds?.([...new Set(all.map((e) => e.kind))].sort());
  }, [all, onKinds]);

  const loadMore = useCallback(async () => {
    if (!history || loadingMore || !hasMore || history.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = history.reduce((m, e) => Math.min(m, e.id), Number.MAX_SAFE_INTEGER);
      const older = await api.events({ agentId, missionId, before: oldest, limit: PAGE });
      setHasMore(older.length >= PAGE);
      setHistory((cur) => [...(cur ?? []), ...older.filter((e) => e.id < oldest)]);
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, missionId, hasMore, history, loadingMore]);

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

  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

  return (
    <div className="event-scroll" ref={scrollRef} onScroll={onScroll}>
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
                  <EventRow e={e} agentName={e.agentId ? names.get(e.agentId) : undefined} selected={selectedId === e.id} onSelect={onSelect} />
                </div>
              );
            })}
          </div>
          <div className="muted small pad center">{loadingMore ? <Spinner size={12} /> : hasMore ? "Scroll for older events" : "Beginning of timeline"}</div>
        </>
      )}
    </div>
  );
}
