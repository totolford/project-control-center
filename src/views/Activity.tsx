import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CircleAlert, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { formatClock, formatDateTime } from "../lib/format";
import { MISSION_STATUS } from "../lib/labels";
import type { Message, PccEvent } from "../lib/types";
import { useAgents, useMissions, useStore, useTimeline } from "../store";
import { useUi } from "../state/ui";
import { JsonView, Loading, PageHeader } from "../components/Common";
import { Chip } from "../components/StatusBadge";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { ACTIVITY_GROUPS, groupOf, kindTone, toolOf, type ActivityGroup } from "../lib/activityGroups";
import { toggleIn } from "../lib/autonomy";
import { groupByMission, matches, mergeEntries, SEVERITIES, toEntry, type ChainFilter, type JournalEntry, type MissionGroup, type Severity } from "./diagnostics/journal";
import { callOptional, hasApi } from "./diagnostics/optional";
import { rich, useT } from "../i18n";

const SEVERITY_TONE: Record<Severity, "grey" | "amber" | "red"> = { info: "grey", warning: "amber", error: "red", critical: "red" };
const SEVERITY_ICON = { info: Info, warning: TriangleAlert, error: CircleAlert, critical: OctagonAlert };
const PAGE = 500;
/** Rows shown per mission group before "Show earlier". */
const GROUP_PREVIEW = 60;

export function EventDetail({ event, onClose }: { event: PccEvent; onClose: () => void }) {
  const t = useT();
  const agents = useAgents();
  const missions = useMissions();
  const openAgent = useStore((s) => s.openAgent);
  const openTask = useStore((s) => s.openTask);
  const openMessage = useUi((s) => s.openMessage);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const entry = toEntry(event);
  return (
    <aside className="drawer" aria-label={t("act.detail")}>
      <div className="drawer-header">
        <Chip tone={kindTone(event.kind)}>{event.kind}</Chip>
        <h2 className="grow">#{event.id}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t("act.closeDetail")}>
          <X size={16} />
        </button>
      </div>
      <div className="drawer-body">
        <p>{event.summary}</p>
        <dl className="kv">
          <dt>{t("act.event")}</dt>
          <dd className="mono">{entry.name}</dd>
          <dt>{t("act.severity")}</dt>
          <dd>
            <Chip tone={SEVERITY_TONE[entry.severity]}>{t.dynamic(`act.sev.${entry.severity}`, undefined, entry.severity)}</Chip>
          </dd>
          <dt>{t("act.source")}</dt>
          <dd>{entry.source}</dd>
          {entry.pid !== null && (
            <>
              <dt>{t("act.process")}</dt>
              <dd className="mono">PID {entry.pid}</dd>
            </>
          )}
          <dt>{t("act.time")}</dt>
          <dd>
            {formatDateTime(event.ts)} ({formatClock(event.ts)})
          </dd>
          {event.agentId && (
            <>
              <dt>{t("act.agent")}</dt>
              <dd>
                <button className="link-btn" onClick={() => openAgent(event.agentId!)}>
                  {agentName(event.agentId)}
                </button>
              </dd>
            </>
          )}
          {event.taskId && (
            <>
              <dt>{t("act.task")}</dt>
              <dd>
                <button className="link-btn mono" onClick={() => openTask(event.taskId!)}>
                  {event.taskId}
                </button>
              </dd>
            </>
          )}
          {event.missionId && (
            <>
              <dt>{t("act.mission")}</dt>
              <dd>{missions.find((m) => m.id === event.missionId)?.title ?? event.missionId}</dd>
            </>
          )}
        </dl>
        {event.kind === "ToolUsed" && toolOf(event.payload) && (
          <p>{rich(t("act.tool"), { tool: <code>{toolOf(event.payload)}</code> })}</p>
        )}
        {event.kind === "AgentMessage" && (
          <button className="btn btn-sm" onClick={() => openMessage(event.payload as Message)}>
            {t("act.openMessage")}
          </button>
        )}
        <div className="section-label">{t("act.payload")}</div>
        <JsonView value={event.payload} />
      </div>
    </aside>
  );
}

interface Loaded {
  entries: PccEvent[];
  hasMore: boolean;
  /** Where the history comes from: the journal API, or the plain event log on engines without it. */
  via: "journal" | "events";
}

async function loadPage(f: ChainFilter, before?: number): Promise<Loaded> {
  if (hasApi("journal")) {
    const r = await callOptional<PccEvent[]>("journal", {
      agent: f.agentId ?? null,
      mission: f.missionId ?? null,
      severity: f.severity ?? null,
      source: f.source ?? null,
      before: before ?? null,
      limit: PAGE,
    });
    if (r.state === "ok" && Array.isArray(r.value)) return { entries: r.value, hasMore: r.value.length >= PAGE, via: "journal" };
  }
  const list = (await api.events({ agentId: f.agentId, missionId: f.missionId, before, limit: PAGE })) ?? [];
  return { entries: list, hasMore: list.length >= PAGE, via: "events" };
}

function ChainRow({ e, agentName, selected, onSelect }: { e: JournalEntry; agentName: string | null; selected: boolean; onSelect: (e: JournalEntry) => void }) {
  const t = useT();
  const Icon = SEVERITY_ICON[e.severity];
  return (
    <li className={`chain-row sev-${e.severity}${selected ? " selected" : ""}`}>
      <button className="chain-btn" onClick={() => onSelect(e)} aria-label={`${t.dynamic(`act.sev.${e.severity}`, undefined, e.severity)} ${e.name}: ${e.summary}`}>
        <span className="chain-node" aria-hidden="true">
          <Icon size={11} />
        </span>
        <span className="chain-time mono muted" title={formatDateTime(e.ts)}>
          {formatClock(e.ts)}
        </span>
        <span className="chain-name mono ellipsis" title={e.name}>
          {e.name}
        </span>
        <span className="chain-agent ellipsis">{agentName ?? ""}</span>
        <span className="chain-summary ellipsis" title={e.summary}>
          {e.summary}
        </span>
        <span className="chain-meta mono muted">
          {e.pid !== null ? `PID ${e.pid} · ` : ""}
          {e.source}
        </span>
      </button>
    </li>
  );
}

function GroupCard({
  group,
  agentName,
  selectedId,
  onSelect,
}: {
  group: MissionGroup;
  agentName: (id: string) => string;
  selectedId: number | undefined;
  onSelect: (e: JournalEntry) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const status = group.mission ? MISSION_STATUS[group.mission.status] : null;
  const rows = all ? group.entries : group.entries.slice(-GROUP_PREVIEW);
  return (
    <section className="chain-group" aria-label={group.title}>
      <header className="chain-head">
        <button className="chain-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="chain-title ellipsis">{group.title}</span>
        </button>
        {status && <Chip tone={status.tone}>{status.label}</Chip>}
        <span className="muted small mono">
          {formatClock(group.first)} → {formatClock(group.last)}
        </span>
        <span className="spacer" />
        {(["critical", "error", "warning"] as Severity[]).map((s) =>
          group.counts[s] > 0 ? (
            <Chip key={s} tone={SEVERITY_TONE[s]}>
              {group.counts[s]} {t.dynamic(`act.sev.${s}`, undefined, s)}
            </Chip>
          ) : null,
        )}
        <span className="muted small">{t("act.events", { count: group.entries.length })}</span>
      </header>
      {open && (
        <>
          {!all && group.entries.length > GROUP_PREVIEW && (
            <button className="link-btn small chain-more" onClick={() => setAll(true)}>
              {t("act.showEarlier", { count: group.entries.length - GROUP_PREVIEW })}
            </button>
          )}
          <ol className="chain">
            {rows.map((e) => (
              <ChainRow key={e.id} e={e} agentName={e.agentId ? agentName(e.agentId) : null} selected={selectedId === e.id} onSelect={onSelect} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/** Spec §47: the readable chain of real events (journal), grouped by mission, with filters. */
export function Activity() {
  const t = useT();
  const agents = useAgents();
  const missions = useMissions();
  const timeline = useTimeline();
  const [mode, setMode] = useState<"chain" | "timeline">("chain");
  const [agentId, setAgentId] = useState("");
  const [missionId, setMissionId] = useState("");
  const [severity, setSeverity] = useState<Severity | "">("");
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [groups, setGroups] = useState<ActivityGroup[]>([]);
  const [selected, setSelected] = useState<PccEvent | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const serverFilter = useMemo<ChainFilter>(
    () => ({ agentId: agentId || undefined, missionId: missionId || undefined, severity: severity || undefined, source: source || undefined }),
    [agentId, missionId, severity, source],
  );

  useEffect(() => {
    if (mode !== "chain") return;
    let alive = true;
    setLoaded(null);
    setError(null);
    loadPage(serverFilter)
      .then((l) => alive && setLoaded(l))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [serverFilter, mode]);

  const loadMore = useCallback(async () => {
    if (!loaded || loadingMore || loaded.entries.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = loaded.entries.reduce((m, e) => Math.min(m, e.id), Number.MAX_SAFE_INTEGER);
      const more = await loadPage(serverFilter, oldest);
      setLoaded((cur) => (cur ? { ...more, entries: [...cur.entries, ...more.entries] } : more));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [loaded, loadingMore, serverFilter]);

  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const agentName = useCallback((id: string) => names.get(id) ?? id, [names]);
  const entries = useMemo(() => {
    if (!loaded) return [];
    const newest = loaded.entries.reduce((m, e) => Math.max(m, e.id), 0);
    const filter: ChainFilter = { ...serverFilter, text: text.trim() || undefined };
    return mergeEntries(
      timeline.filter((e) => e.id > newest),
      loaded.entries,
    ).filter((e) => matches(e, filter, agentName) && (groups.length === 0 || groups.includes(groupOf(e.kind))));
  }, [loaded, timeline, serverFilter, text, groups, agentName]);
  const sources = useMemo(() => [...new Set(["engine", "ui", ...(loaded?.entries ?? []).map((e) => toEntry(e).source)])].sort(), [loaded]);
  const chain = useMemo(() => groupByMission(entries, missions), [entries, missions]);

  return (
    <div className="page page-fill">
      <PageHeader
        title={t("act.title")}
        subtitle={t("act.subtitle")}
        actions={
          <div className="seg-btns" role="group" aria-label={t("act.display")}>
            <button className={`btn btn-sm${mode === "chain" ? " primary" : ""}`} aria-pressed={mode === "chain"} onClick={() => setMode("chain")}>
              {t("act.byMission")}
            </button>
            <button className={`btn btn-sm${mode === "timeline" ? " primary" : ""}`} aria-pressed={mode === "timeline"} onClick={() => setMode("timeline")}>
              {t("act.timeline")}
            </button>
          </div>
        }
      />
      <div className="filters">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label={t("act.filterAgent")}>
          <option value="">{t("act.allAgents")}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={missionId} onChange={(e) => setMissionId(e.target.value)} aria-label={t("act.filterMission")}>
          <option value="">{t("act.allMissions")}</option>
          {missions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        {mode === "chain" ? (
          <>
            <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "")} aria-label={t("act.minSeverity")}>
              <option value="">{t("act.allSeverities")}</option>
              {SEVERITIES.slice(1).map((s) => (
                <option key={s} value={s}>
                  {t("act.andAbove", { severity: t.dynamic(`act.sev.${s}`, undefined, s) })}
                </option>
              ))}
            </select>
            <select value={source} onChange={(e) => setSource(e.target.value)} aria-label={t("act.filterSource")}>
              <option value="">{t("act.allSources")}</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input className="filter-search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("act.searchPlaceholder")} aria-label={t("act.search")} />
          </>
        ) : (
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t("act.filterKind")}>
            <option value="">{t("act.allKinds")}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="chips-row activity-groups" role="group" aria-label={t("act.groups")}>
        {ACTIVITY_GROUPS.map((g) => {
          const on = groups.includes(g.key);
          return (
            <button key={g.key} className={`chip chip-toggle${on ? " tone-accent" : " tone-dim"}`} aria-pressed={on} onClick={() => setGroups(toggleIn(groups, g.key, !on))}>
              {g.label}
            </button>
          );
        })}
        {groups.length > 0 && (
          <button className="link-btn small" onClick={() => setGroups([])}>
            {t("act.showAll")}
          </button>
        )}
      </div>
      <div className="split">
        <div className="split-main">
          {mode === "timeline" ? (
            <ActivityTimeline
              filter={{ agentId: agentId || undefined, missionId: missionId || undefined, kind: kind || undefined, groups }}
              selectedId={selected?.id}
              onSelect={setSelected}
              onKinds={setKinds}
            />
          ) : error ? (
            <div className="pad">
              <Chip tone="red">{t("common.unavailable")}</Chip> <span className="muted">{t("act.journalError", { error })}</span>
            </div>
          ) : !loaded ? (
            <Loading />
          ) : (
            <div className="chain-scroll">
              {chain.length === 0 && <div className="muted pad">{t("act.noMatch")}</div>}
              {chain.map((g) => (
                <GroupCard key={g.missionId ?? "none"} group={g} agentName={agentName} selectedId={selected?.id} onSelect={setSelected} />
              ))}
              <div className="muted small pad center">
                {loaded.hasMore ? (
                  <button className="link-btn small" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? t("common.loading") : t("act.loadOlder")}
                  </button>
                ) : (
                  t("act.journalStart")
                )}
                {loaded.via === "events" && <div>{t("act.noJournalApi")}</div>}
              </div>
            </div>
          )}
        </div>
        {selected && <EventDetail event={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
