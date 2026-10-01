import { useState } from "react";
import { X } from "lucide-react";
import { formatClock, formatDateTime } from "../lib/format";
import type { Message, PccEvent } from "../lib/types";
import { useAgents, useMissions, useStore } from "../store";
import { useUi } from "../state/ui";
import { JsonView, PageHeader } from "../components/Common";
import { Chip } from "../components/StatusBadge";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { ACTIVITY_GROUPS, kindTone, toolOf, type ActivityGroup } from "../lib/activityGroups";
import { toggleIn } from "../lib/autonomy";

export function EventDetail({ event, onClose }: { event: PccEvent; onClose: () => void }) {
  const agents = useAgents();
  const missions = useMissions();
  const openAgent = useStore((s) => s.openAgent);
  const openTask = useStore((s) => s.openTask);
  const openMessage = useUi((s) => s.openMessage);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <aside className="drawer" aria-label="Event detail">
      <div className="drawer-header">
        <Chip tone={kindTone(event.kind)}>{event.kind}</Chip>
        <h2 className="grow">#{event.id}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close event detail">
          <X size={16} />
        </button>
      </div>
      <div className="drawer-body">
        <p>{event.summary}</p>
        <dl className="kv">
          <dt>Time</dt>
          <dd>
            {formatDateTime(event.ts)} ({formatClock(event.ts)})
          </dd>
          {event.agentId && (
            <>
              <dt>Agent</dt>
              <dd>
                <button className="link-btn" onClick={() => openAgent(event.agentId!)}>
                  {agentName(event.agentId)}
                </button>
              </dd>
            </>
          )}
          {event.taskId && (
            <>
              <dt>Task</dt>
              <dd>
                <button className="link-btn mono" onClick={() => openTask(event.taskId!)}>
                  {event.taskId}
                </button>
              </dd>
            </>
          )}
          {event.missionId && (
            <>
              <dt>Mission</dt>
              <dd>{missions.find((m) => m.id === event.missionId)?.title ?? event.missionId}</dd>
            </>
          )}
        </dl>
        {event.kind === "ToolUsed" && toolOf(event.payload) && (
          <p>
            Tool <code>{toolOf(event.payload)}</code>
          </p>
        )}
        {event.kind === "AgentMessage" && (
          <button className="btn btn-sm" onClick={() => openMessage(event.payload as Message)}>
            Open message
          </button>
        )}
        <div className="section-label">Payload</div>
        <JsonView value={event.payload} />
      </div>
    </aside>
  );
}

export function Activity() {
  const agents = useAgents();
  const missions = useMissions();
  const [agentId, setAgentId] = useState("");
  const [missionId, setMissionId] = useState("");
  const [kind, setKind] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [groups, setGroups] = useState<ActivityGroup[]>([]);
  const [selected, setSelected] = useState<PccEvent | null>(null);

  return (
    <div className="page page-fill">
      <PageHeader title="Activity" subtitle="Timeline of everything that happened in this project." />
      <div className="filters">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={missionId} onChange={(e) => setMissionId(e.target.value)} aria-label="Filter by mission">
          <option value="">All missions</option>
          {missions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div className="chips-row activity-groups" role="group" aria-label="Event groups">
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
            Show all
          </button>
        )}
      </div>
      <div className="split">
        <div className="split-main">
          <ActivityTimeline
            filter={{ agentId: agentId || undefined, missionId: missionId || undefined, kind: kind || undefined, groups }}
            selectedId={selected?.id}
            onSelect={setSelected}
            onKinds={setKinds}
          />
        </div>
        {selected && <EventDetail event={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
