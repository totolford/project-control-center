import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CircleAlert, X } from "lucide-react";
import { api } from "../../lib/api";
import { COMMAND_DECISIONS, commandDecisionMeta, commandDuration, filterCommands, formatExit, mergeCommands, oldestCommandId } from "../../lib/commandJournal";
import { formatDateTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import type { CommandRecord } from "../../lib/types";
import { useAgents, useStore } from "../../store";
import { JsonView, Loading, Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";

const PAGE = 200;
const LIVE_DEBOUNCE_MS = 700;

const Row = memo(function Row({ r, agent, selected, onSelect }: { r: CommandRecord; agent: string; selected: boolean; onSelect: (r: CommandRecord) => void }) {
  const meta = commandDecisionMeta(r.decision);
  return (
    <button className={`cmdj-row${selected ? " selected" : ""}${r.isError ? " error" : ""}`} onClick={() => onSelect(r)}>
      <span className="mono muted">{formatDateTime(r.startedAt)}</span>
      <span className="ellipsis">{agent}</span>
      <span className="muted small">{r.source}</span>
      <span className="mono ellipsis" title={r.raw}>
        {r.raw}
      </span>
      <span className="mono small ellipsis">{r.program ?? "—"}</span>
      <span className="small ellipsis" title={r.target ?? undefined}>
        {r.target ?? "—"}
      </span>
      <span className="mono small ellipsis">{r.capability ?? "—"}</span>
      <Chip tone={meta.tone}>{meta.label}</Chip>
      <span className="mono small">{commandDuration(r)}</span>
      <span className="mono small">{formatExit(r.exitCode)}</span>
      <span>{r.isError ? <CircleAlert size={12} className="tone-red-fg" aria-label="error" /> : ""}</span>
    </button>
  );
});

function Detail({ r, agent, onClose }: { r: CommandRecord; agent: string; onClose: () => void }) {
  const meta = commandDecisionMeta(r.decision);
  return (
    <aside className="drawer" aria-label="Command detail">
      <div className="drawer-header">
        <Chip tone={meta.tone}>{meta.label}</Chip>
        <h2 className="grow">#{r.id}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close command detail">
          <X size={16} />
        </button>
      </div>
      <div className="drawer-body">
        <pre className="cmd-raw mono">{r.raw}</pre>
        <dl className="kv">
          <dt>Agent</dt>
          <dd>{agent}</dd>
          <dt>Source</dt>
          <dd>{r.source}</dd>
          <dt>Started</dt>
          <dd className="mono">{formatDateTime(r.startedAt)}</dd>
          <dt>Duration</dt>
          <dd className="mono">{commandDuration(r)}</dd>
          <dt>Exit code</dt>
          <dd className={`mono${r.isError ? " tone-red-fg" : ""}`}>
            {formatExit(r.exitCode)}
            {r.isError ? " · error" : ""}
          </dd>
          <dt>Program</dt>
          <dd className="mono">{r.program ?? "—"}</dd>
          <dt>Target</dt>
          <dd>{r.target ?? "—"}</dd>
          <dt>Capability</dt>
          <dd className="mono">{r.capability ?? "—"}</dd>
          {r.toolUseId && (
            <>
              <dt>Tool use</dt>
              <dd className="mono small">{r.toolUseId}</dd>
            </>
          )}
        </dl>
        <div className="section-label">Output</div>
        {r.output ? <pre className="json cmd-output">{r.output}</pre> : <div className="muted small">No output recorded.</div>}
        <div className="section-label">Parsed</div>
        <JsonView value={r.parsed} />
      </div>
    </aside>
  );
}

/** Every command run by agents, the user and the interpreter: newest first, live, paged on scroll. */
export function CommandJournal() {
  const agents = useAgents();
  const version = useStore((s) => s.project?.commandVersion ?? 0);
  const [agentId, setAgentId] = useState("");
  const [source, setSource] = useState("");
  const [decision, setDecision] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [list, setList] = useState<CommandRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<CommandRecord | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setList(null);
    api
      .listCommands(agentId || null, null, PAGE)
      .then((page) => {
        if (cancelled) return;
        setList(page);
        setHasMore(page.length >= PAGE);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e);
        setList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Live refresh on ToolUsed events, debounced so a burst of tool calls costs one query.
  useEffect(() => {
    if (version === 0) return;
    const timer = window.setTimeout(() => {
      api
        .listCommands(agentId || null, null, 50)
        .then((page) => setList((cur) => (cur ? mergeCommands(cur, page) : cur)))
        .catch(() => undefined);
    }, LIVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [version, agentId]);

  const loadMore = useCallback(async () => {
    const before = list ? oldestCommandId(list) : null;
    if (!list || before === null || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const older = await api.listCommands(agentId || null, before, PAGE);
      setHasMore(older.length >= PAGE);
      setList((cur) => mergeCommands(cur ?? [], older));
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingMore(false);
    }
  }, [list, loadingMore, hasMore, agentId]);

  const rows = useMemo(() => (list ? filterCommands(list, { source, decision, errorsOnly }) : []), [list, source, decision, errorsOnly]);
  const sources = useMemo(() => [...new Set((list ?? []).map((r) => r.source))].sort(), [list]);
  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const name = (id: string) => (id === "user" ? "You" : (names.get(id) ?? id));
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 28, overscan: 20, getItemKey: (i) => rows[i].id });
  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadMore();
  };

  return (
    <div className="split cmdj">
      <div className="split-main cmdj-main">
        <div className="filters">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filter by agent">
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filter by source">
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="Filter by decision">
            <option value="">All decisions</option>
            {COMMAND_DECISIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
          <label className="checkbox">
            <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors only
          </label>
          <span className="muted small">{list ? `${rows.length} shown` : ""}</span>
        </div>
        <div className="cmdj-row cmdj-head">
          <span>Time</span>
          <span>Agent</span>
          <span>Source</span>
          <span>Command</span>
          <span>Program</span>
          <span>Target</span>
          <span>Capability</span>
          <span>Decision</span>
          <span>Duration</span>
          <span>Exit</span>
          <span />
        </div>
        <div className="cmdj-scroll" ref={scrollRef} onScroll={onScroll}>
          {list === null ? (
            <Loading />
          ) : rows.length === 0 ? (
            <div className="muted pad">No command journaled yet. Commands run by agents, by you and by the interpreter appear here.</div>
          ) : (
            <>
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const r = rows[item.index];
                  return (
                    <div key={item.key} className="v-row" style={{ transform: `translateY(${item.start}px)`, height: item.size }}>
                      <Row r={r} agent={name(r.agentId)} selected={selected?.id === r.id} onSelect={setSelected} />
                    </div>
                  );
                })}
              </div>
              <div className="muted small pad center">{loadingMore ? <Spinner size={12} /> : hasMore ? "Scroll for older commands" : "Beginning of journal"}</div>
            </>
          )}
        </div>
      </div>
      {selected && <Detail r={selected} agent={name(selected.agentId)} onClose={() => setSelected(null)} />}
    </div>
  );
}
