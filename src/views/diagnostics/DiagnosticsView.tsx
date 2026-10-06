import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Cpu, HardDrive, HeartPulse, MemoryStick, MonitorUp } from "lucide-react";
import { api, errorMessage, onHealth } from "../../lib/api";
import { formatBytes, formatDateTime, formatRelative } from "../../lib/format";
import type { CoreStatus, PccEvent, RendererIncident, Resources, WatchdogStatus } from "../../lib/types";
import { useAgents, useConnections, useMissions, useTasks, useTimeline } from "../../store";
import { JsonView, PageHeader, Section } from "../../components/Common";
import { Chip, StatusDot } from "../../components/StatusBadge";
import { fetchCoreStatus, rendererHealth, useHealth } from "../../shell/health/health";
import { isRestartEvent, mergeEntries, type JournalEntry } from "./journal";
import { callOptional, hasApi, type Optional } from "./optional";
import { Tree } from "./Tree";
import { aiApi } from "../../lib/aiApi";
import type { AiOverview } from "../../lib/aiTypes";
import { runtimeTree } from "../ai/aiLogic";
import { agentTree, countNodes, genericTree, mcpTree, missionTree, permissionTree, processTree, statusTone } from "./trees";

const POLL_MS = 5000;
/** All agents, newest 300 permission records. */
const PERMISSION_ARGS: unknown[] = [null, 300];

/** API names other workstreams may expose, first match wins (see optional.ts). */
export const OPTIONAL_APIS = {
  processTree: ["processTree"],
  recoveryState: ["recoveryState"],
  crashReports: ["crashReports"],
  journal: ["journal"],
  permissions: ["permissionHistory"],
} as const;

function firstApi(names: readonly string[]): string | null {
  return names.find(hasApi) ?? null;
}

function usePolled<T>(names: readonly string[], args: unknown[] = [], everyMs = POLL_MS): Optional<T> {
  const [value, setValue] = useState<Optional<T>>({ state: "loading" });
  const key = JSON.stringify(args);
  const namesKey = names.join(",");
  useEffect(() => {
    let alive = true;
    const list = namesKey.split(",");
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      const name = firstApi(list);
      const v: Optional<T> = name
        ? await callOptional<T>(name, ...(JSON.parse(key) as unknown[]))
        : { state: "unavailable", reason: `Not provided by this NEXUS build (api.${list[0]} is missing).` };
      if (alive) setValue(v);
    };
    void load();
    const t = everyMs ? window.setInterval(() => void load(), everyMs) : undefined;
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [namesKey, key, everyMs]);
  return value;
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <div className="diag-unavailable">
      <Chip tone="grey">Unavailable</Chip> <span className="muted small">{reason}</span>
    </div>
  );
}

function OptionalBlock<T>({ value, children }: { value: Optional<T>; children: (v: T) => ReactNode }) {
  if (value.state === "loading") return <div className="muted small">Loading…</div>;
  if (value.state === "unavailable") return <Unavailable reason={value.reason} />;
  return <>{children(value.value)}</>;
}

function Tile({ icon, label, value, sub, tone }: { icon: ReactNode; label: string; value: string; sub?: string; tone?: "green" | "amber" | "red" | "grey" }) {
  return (
    <div className="diag-tile">
      <div className="diag-tile-head">
        {icon}
        <span>{label}</span>
        {tone && <StatusDot tone={tone} />}
      </div>
      <div className="diag-tile-value">{value}</div>
      {sub && <div className="diag-tile-sub muted small ellipsis" title={sub}>{sub}</div>}
    </div>
  );
}

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="diag-kv">
      {rows.map(([k, v]) => (
        <div key={k} className="diag-kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function pct(used: number, total: number): string {
  return total > 0 ? `${Math.round((used / total) * 100)} %` : "—";
}

function RendererSection({ watchdog }: { watchdog: WatchdogStatus | null }) {
  const signal = useHealth((s) => s.signal);
  const lastBeatAt = useHealth((s) => s.lastBeatAt);
  const t = rendererHealth.totals;
  const heap = rendererHealth.heap;
  return (
    <Section title="Interface (renderer)">
      <div className="diag-signal">
        <StatusDot tone={signal.level} pulse={signal.level === "red"} />
        <strong>{signal.level === "green" ? "Healthy" : signal.level === "amber" ? "Warnings" : "Degraded"}</strong>
        {signal.notes.length > 0 && <span className="muted small">{signal.notes.join(" · ")}</span>}
      </div>
      <Kv
        rows={[
          ["Engine heartbeat", lastBeatAt ? `answered ${formatRelative(new Date(lastBeatAt).toISOString())}` : "no answer yet"],
          ["Failed heartbeats", String(rendererHealth.heartbeatFailures)],
          ["Watchdog", watchdog ? (watchdog.enabled ? `on · ${watchdog.recoveries} recoveries since start` : "disabled (NEXUS_RENDERER_WATCHDOG)") : "Unavailable"],
          ["View crashes contained", String(t.renderErrors)],
          ["Script errors", `${t.windowErrors} errors · ${t.rejections} unhandled rejections`],
          ["Frame stalls", `${t.stalls}${t.stalls > 0 ? ` · longest ${(rendererHealth.longestStallMs / 1000).toFixed(1)} s` : ""}`],
          ["Engine calls (IPC)", `${t.invokeCalls} calls · ${t.invokeErrors} failed`],
          ["AI World errors", String(t.aiWorldErrors)],
          ["Interface memory", heap ? `${formatBytes(heap.used)} of ${formatBytes(heap.limit)} (${pct(heap.used, heap.limit)})` : "Unavailable (performance.memory not exposed)"],
          ["Last error", rendererHealth.lastError ?? "none"],
        ]}
      />
    </Section>
  );
}

function ResourcesSection({ res }: { res: Optional<Resources> }) {
  return (
    <Section title="Machine">
      <OptionalBlock value={res}>
        {(r) => (
          <>
            <Kv
              rows={[
                ["CPU", `${r.cpuPct.toFixed(0)} % · ${r.cpuCores} logical cores`],
                ["Memory", `${formatBytes(r.memoryUsedBytes)} of ${formatBytes(r.memoryTotalBytes)} (${pct(r.memoryUsedBytes, r.memoryTotalBytes)})`],
                ["NEXUS processes", `${r.processes.length} · ${formatBytes(r.processes.reduce((n, p) => n + p.memoryBytes, 0))}`],
              ]}
            />
            <div className="section-label">GPU / VRAM</div>
            {r.gpus.length > 0 ? (
              <Kv
                rows={r.gpus.map((g, i) => [
                  `GPU ${i}`,
                  `${g.name} · ${g.utilizationPct !== null ? `${g.utilizationPct} % load` : "load unknown"} · ${
                    g.vramUsedMb !== null && g.vramTotalMb !== null ? `${g.vramUsedMb} / ${g.vramTotalMb} MB VRAM` : "VRAM unknown"
                  }`,
                ])}
              />
            ) : (
              <Unavailable reason={r.gpuUnavailable ?? "No GPU reported."} />
            )}
          </>
        )}
      </OptionalBlock>
    </Section>
  );
}

function ConnectionsSection({ core, watchdog }: { core: CoreStatus | null; watchdog: WatchdogStatus | null }) {
  const lastBeatAt = useHealth((s) => s.lastBeatAt);
  const ipcLost = rendererHealth.ipcLost();
  const nodes = [
    {
      id: "ipc",
      label: "Interface ↔ engine (Tauri IPC)",
      status: ipcLost ? { label: "Lost", tone: "red" as const } : lastBeatAt ? { label: "Connected", tone: "green" as const } : { label: "Connecting", tone: "amber" as const },
      detail: `${rendererHealth.totals.invokeCalls} calls · ${rendererHealth.totals.invokeErrors} failed`,
      children: [],
    },
    {
      id: "watchdog",
      label: "Renderer watchdog",
      status: watchdog ? (watchdog.enabled ? { label: "Watching", tone: "green" as const } : { label: "Disabled", tone: "grey" as const }) : { label: "Unavailable", tone: "grey" as const },
      detail: watchdog ? `${watchdog.heartbeats} heartbeats · up ${Math.round(watchdog.uptimeSecs / 60)} min` : undefined,
      children: [],
    },
    {
      id: "aitown",
      label: "AI Town backend (Convex, WebSocket)",
      status:
        core?.aiTownRunning === true
          ? { label: "Running", tone: "green" as const }
          : core?.aiTownRunning === false
            ? { label: "Not running", tone: "grey" as const }
            : { label: "Unknown", tone: "grey" as const },
      detail: `${rendererHealth.totals.aiWorldErrors} connection errors seen by the AI World view`,
      children: [],
    },
    {
      id: "mcp",
      label: "MCP connections",
      status: core ? { label: `${core.mcpConnected}/${core.mcpTotal}`, tone: core.mcpConnected < core.mcpTotal ? ("amber" as const) : ("green" as const) } : undefined,
      detail: "see the MCP tree",
      children: [],
    },
  ];
  return (
    <Section title="Connections (IPC / WebSocket)">
      <Tree nodes={nodes} label="Connections" empty="" />
    </Section>
  );
}

function TreeSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <Section title={count !== undefined ? `${title} (${count})` : title}>
      <div className="diag-tree-wrap">{children}</div>
    </Section>
  );
}

function GenericOptional({ names, label, empty, args }: { names: readonly string[]; label: string; empty: string; args?: unknown[] }) {
  const value = usePolled<unknown>(names, args ?? []);
  return (
    <OptionalBlock value={value}>
      {(v) => {
        const nodes = genericTree(v);
        return nodes.length > 0 ? <Tree nodes={nodes} label={label} empty={empty} /> : <JsonView value={v} collapsible label="Raw answer" />;
      }}
    </OptionalBlock>
  );
}

/** Local AI runtimes (AI Engines overview): each status query runs `--version` and health requests, so it is polled slowly. */
function AiRuntimesBlock() {
  const [value, setValue] = useState<Optional<AiOverview>>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      const v: Optional<AiOverview> = await aiApi.overview().then(
        (o) => (o ? { state: "ok" as const, value: o, at: Date.now() } : { state: "unavailable" as const, reason: "The engine returned nothing." }),
        (e) => ({ state: "unavailable" as const, reason: errorMessage(e) }),
      );
      if (alive) setValue(v);
    };
    void load();
    const t = window.setInterval(() => void load(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return (
    <OptionalBlock value={value}>
      {(o) => <Tree nodes={runtimeTree(o)} label="AI runtime tree" empty="No AI runtime." />}
    </OptionalBlock>
  );
}

function EventList({ entries, empty }: { entries: JournalEntry[]; empty: string }) {
  const agents = useAgents();
  if (entries.length === 0) return <div className="muted small">{empty}</div>;
  return (
    <ul className="diag-events">
      {entries.slice(0, 40).map((e) => (
        <li key={e.id} className="diag-event">
          <span className="mono muted">{formatDateTime(e.ts)}</span>
          <Chip tone={statusTone(e.severity === "info" ? "ok" : e.severity === "warning" ? "pending" : "error")}>{e.name}</Chip>
          <span className="ellipsis" title={e.summary}>
            {e.agentId ? <strong>{agents.find((a) => a.id === e.agentId)?.name ?? e.agentId}: </strong> : null}
            {e.summary}
          </span>
          {e.pid !== null && <span className="mono muted small">PID {e.pid}</span>}
        </li>
      ))}
    </ul>
  );
}

function IncidentList({ incidents }: { incidents: RendererIncident[] }) {
  if (incidents.length === 0) return <div className="muted small">No interface incident recorded.</div>;
  return (
    <ul className="diag-events">
      {incidents.map((i) => (
        <li key={i.id} className="diag-event">
          <span className="mono muted">{formatDateTime(i.ts)}</span>
          <Chip tone={i.outcome === "recovered" ? "green" : i.outcome === "failed" ? "red" : i.outcome === "pending" ? "amber" : "grey"}>
            {i.kind} · {i.action === "none" ? i.outcome : `${i.action} · ${i.outcome}`}
          </Chip>
          <span className="ellipsis" title={i.reason}>
            {i.reason}
          </span>
          {i.downtimeMs !== null && <span className="mono muted small">{(i.downtimeMs / 1000).toFixed(1)} s</span>}
        </li>
      ))}
    </ul>
  );
}

/** Crash report as returned by api.crashReports() (recovery workstream); read defensively. */
interface CrashReportLike {
  id: string;
  at: string;
  title: string;
  component?: string;
  severity?: string;
  whatHappened?: string;
  possibleCause?: string;
  preserved?: string[];
  restarted?: string[];
  lost?: string[];
  source?: string;
  acknowledged?: boolean;
}

function asReports(v: unknown): CrashReportLike[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is CrashReportLike => typeof r === "object" && r !== null && typeof (r as CrashReportLike).id === "string");
}

function CrashReportList({ reports }: { reports: CrashReportLike[] }) {
  if (reports.length === 0) return <div className="muted small">No crash report.</div>;
  return (
    <ul className="diag-events">
      {reports.slice(0, 50).map((r) => (
        <li key={r.id} className="diag-event diag-report">
          <span className="mono muted">{formatDateTime(r.at)}</span>
          <Chip tone={r.severity === "critical" || r.severity === "error" ? "red" : r.severity === "warning" ? "amber" : "grey"}>
            {r.component || r.source || "report"}
          </Chip>
          <details className="diag-report-body">
            <summary className="ellipsis" title={r.title}>
              {r.title}
              {r.acknowledged === false && <span className="tone-amber-fg small"> · new</span>}
            </summary>
            {r.whatHappened && <p className="small">{r.whatHappened}</p>}
            {r.possibleCause && <p className="small muted">Possible cause: {r.possibleCause}</p>}
            {[
              ["Restarted", r.restarted],
              ["Preserved", r.preserved],
              ["Lost", r.lost],
            ].map(([k, list]) =>
              Array.isArray(list) && list.length > 0 ? (
                <p key={k as string} className="small">
                  <span className="muted">{k as string}:</span> {(list as string[]).join(" · ")}
                </p>
              ) : null,
            )}
          </details>
        </li>
      ))}
    </ul>
  );
}

/** Crash reports of the engine and its processes (interface incidents are listed above, from the watchdog). */
function EngineCrashReports() {
  const value = usePolled<unknown>(OPTIONAL_APIS.crashReports, [], 15_000);
  return <OptionalBlock value={value}>{(v) => <CrashReportList reports={asReports(v).filter((r) => r.source !== "interface")} />}</OptionalBlock>;
}

/** api.recoveryState(): previous run, interrupted missions, orphans, supervised processes. */
function RecoveryStateBlock() {
  const value = usePolled<unknown>(OPTIONAL_APIS.recoveryState);
  return (
    <OptionalBlock value={value}>
      {(v) => {
        const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
        const project = (typeof o.project === "object" && o.project !== null ? o.project : null) as Record<string, unknown> | null;
        const len = (x: unknown) => (Array.isArray(x) ? x.length : 0);
        const rest = project ? Object.fromEntries(Object.entries(project).filter(([, x]) => Array.isArray(x) && x.length > 0)) : {};
        return (
          <>
            <Kv
              rows={[
                ["Previous run", typeof o.appPreviousRunText === "string" ? o.appPreviousRunText : "Unknown"],
                ...(project
                  ? ([
                      ["Interrupted missions", String(len(project.interruptedMissions))],
                      ["Crashed agents", String(len(project.crashed))],
                      ["Orphan processes", String(len(project.orphans))],
                      ["Supervised", `${len(project.watch)} processes`],
                      ["Last check", typeof project.lastTick === "string" ? formatRelative(project.lastTick) : "never"],
                    ] as [string, ReactNode][])
                  : ([["Project", "No project open"]] as [string, ReactNode][])),
              ]}
            />
            {Object.keys(rest).length > 0 && <Tree nodes={genericTree(rest)} label="Recovery state" empty="" />}
          </>
        );
      }}
    </OptionalBlock>
  );
}

/** api.permissionHistory (permissions workstream): every agent's requests and grants with their state. */
function PermissionsBlock() {
  const agents = useAgents();
  const value = usePolled<unknown>(OPTIONAL_APIS.permissions, PERMISSION_ARGS);
  return (
    <OptionalBlock value={value}>
      {(v) => <Tree nodes={permissionTree(v, agents)} label="Permission tree" empty="No permission request in this project." />}
    </OptionalBlock>
  );
}

/** Spec §48: every live tree of the system, errors, restarts and crash history — read from the running system only. */
export function DiagnosticsView() {
  const agents = useAgents();
  const missions = useMissions();
  const tasks = useTasks();
  const connections = useConnections();
  const timeline = useTimeline();
  const core = useHealth((s) => s.core);
  // Re-render every poll so the renderer counters (not React state) are current.
  const [, setTick] = useState(0);
  const [watchdog, setWatchdog] = useState<WatchdogStatus | null>(null);
  const [incidents, setIncidents] = useState<RendererIncident[] | null>(null);
  const [events, setEvents] = useState<PccEvent[]>([]);
  const resources = usePolled<Resources>(["diagnosticsResources"], [], POLL_MS);
  const journal = usePolled<PccEvent[]>(OPTIONAL_APIS.journal, [{ severity: "warning", limit: 300 }], 15_000);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetchCoreStatus();
      api.watchdogStatus().then((w) => alive && setWatchdog(w ?? null), () => alive && setWatchdog(null));
      setTick((n) => n + 1);
    };
    const loadIncidents = () => api.rendererIncidents(50).then((list) => alive && setIncidents(list ?? []), () => alive && setIncidents(null));
    load();
    void loadIncidents();
    // Without the journal API, recent errors/restarts come from the event log.
    api.events({ limit: 500 }).then((list) => alive && setEvents(list ?? []), () => undefined);
    const t = window.setInterval(load, POLL_MS);
    const unlisten = onHealth(() => void loadIncidents()).catch(() => undefined);
    return () => {
      alive = false;
      window.clearInterval(t);
      void unlisten.then((f) => f?.());
    };
  }, []);

  const entries = useMemo(
    () => mergeEntries(timeline, journal.state === "ok" && Array.isArray(journal.value) ? journal.value : [], events),
    [timeline, journal, events],
  );
  const errors = useMemo(() => entries.filter((e) => e.severity === "error" || e.severity === "critical"), [entries]);
  const restarts = useMemo(() => entries.filter(isRestartEvent), [entries]);
  const agentNodes = useMemo(() => agentTree(agents), [agents]);
  const missionNodes = useMemo(() => missionTree(missions, tasks, agents), [missions, tasks, agents]);
  const mcpNodes = useMemo(() => mcpTree(connections, agents), [connections, agents]);
  const signal = useHealth((s) => s.signal);
  const res = resources.state === "ok" ? resources.value : null;

  return (
    <div className="page diagnostics">
      <PageHeader
        title="Diagnostics"
        subtitle="Live state of the engine, the interface and the machine. Read from the running system; nothing here is estimated."
        actions={
          <>
            <button
              className="btn btn-sm"
              onClick={() => useHealth.getState().openOverlay({ reason: "Reload requested from Diagnostics", auto: false, forced: true, immediate: true })}
              title="Reload the interface; agents, missions and MCP keep running"
            >
              <MonitorUp size={12} /> Reload interface
            </button>
          </>
        }
      />
      <div className="diag-tiles">
        <Tile
          icon={<HeartPulse size={13} />}
          label="Interface"
          value={signal.level === "green" ? "Healthy" : signal.level === "amber" ? "Warnings" : "Degraded"}
          sub={signal.notes[0]}
          tone={signal.level}
        />
        <Tile
          icon={<HeartPulse size={13} />}
          label="Engine"
          value={core ? (core.projectOpen ? `${core.runningAgents} agents running` : "No project") : "Not answering"}
          sub={core?.activeMission ? `Mission: ${core.activeMission}` : "No active mission"}
          tone={core ? "green" : "red"}
        />
        <Tile icon={<Cpu size={13} />} label="CPU" value={res ? `${res.cpuPct.toFixed(0)} %` : "—"} sub={res ? `${res.cpuCores} cores` : undefined} />
        <Tile
          icon={<MemoryStick size={13} />}
          label="Memory"
          value={res ? pct(res.memoryUsedBytes, res.memoryTotalBytes) : "—"}
          sub={res ? `${formatBytes(res.memoryUsedBytes)} / ${formatBytes(res.memoryTotalBytes)}` : undefined}
        />
        <Tile
          icon={<HardDrive size={13} />}
          label="GPU / VRAM"
          value={res ? (res.gpus[0] ? `${res.gpus[0].utilizationPct ?? "?"} %` : "Unavailable") : "—"}
          sub={res ? (res.gpus[0] ? `${res.gpus[0].vramUsedMb ?? "?"} / ${res.gpus[0].vramTotalMb ?? "?"} MB` : (res.gpuUnavailable ?? undefined)) : undefined}
        />
      </div>

      <div className="diag-grid">
        <RendererSection watchdog={watchdog} />
        <ResourcesSection res={resources} />

        <TreeSection title="Processes">
          {firstApi(OPTIONAL_APIS.processTree) ? (
            <GenericOptional names={OPTIONAL_APIS.processTree} label="Process tree" empty="No process reported." />
          ) : (
            <OptionalBlock value={resources}>
              {(r) => (
                <>
                  <div className="muted small diag-note">NEXUS and the processes it started, from the OS process list.</div>
                  <Tree nodes={processTree(r.processes)} label="Process tree" empty="No process found." />
                </>
              )}
            </OptionalBlock>
          )}
        </TreeSection>

        <TreeSection title="Agents" count={agents.length}>
          {!agentNodes.hierarchical && agents.length > 1 && <div className="muted small diag-note">This engine reports no hierarchy: workers are shown under Central.</div>}
          <Tree nodes={agentNodes.roots} label="Agent tree" empty="No agent." />
        </TreeSection>

        <TreeSection title="Missions" count={missions.length}>
          <Tree nodes={missionNodes} label="Mission tree" empty="No mission yet." />
        </TreeSection>

        <TreeSection title="MCP" count={countNodes(mcpNodes) - mcpNodes.reduce((n, m) => n + m.children.length, 0)}>
          <Tree nodes={mcpNodes} label="MCP tree" empty="No MCP connection in this project." />
        </TreeSection>

        <TreeSection title="Permissions">
          <PermissionsBlock />
        </TreeSection>

        <TreeSection title="AI runtimes">
          <AiRuntimesBlock />
        </TreeSection>

        <ConnectionsSection core={core} watchdog={watchdog} />

        <TreeSection title="Recovery">
          <RecoveryStateBlock />
        </TreeSection>

        <Section title={`Errors (${errors.length})`}>
          <EventList entries={errors} empty="No error in the recent journal." />
        </Section>

        <Section title={`Restarts (${restarts.length})`}>
          <EventList entries={restarts} empty="No restart, crash or recovery in the recent journal." />
        </Section>

        <Section title="Crash history">
          <div className="section-label">Interface</div>
          {incidents ? <IncidentList incidents={incidents} /> : <Unavailable reason="The engine did not return the interface incident history." />}
          <div className="section-label">Engine and processes</div>
          <EngineCrashReports />
        </Section>
      </div>
    </div>
  );
}
