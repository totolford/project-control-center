import { useEffect, useMemo, useState } from "react";
import { Plus, Target } from "lucide-react";
import { MISSION_STATUS } from "../lib/labels";
import { formatRelative } from "../lib/format";
import type { Mission } from "../lib/types";
import { useMissions, useReadOnly } from "../store";
import { useRightContext } from "../state/context";
import { useUi } from "../state/ui";
import { EmptyState, PageHeader } from "../components/Common";
import { Chip } from "../components/StatusBadge";
import { ProgressBar } from "../components/ProgressBar";
import { ImprovementCard } from "./missions/ImprovementCard";
import { MissionDetail } from "./missions/MissionDetail";
import { NewMission } from "./missions/NewMission";
import { MISSION_TABS, groupMissions, missionNumber, missionTab, progressPct, queuePosition } from "./missions/logic";
import { useMissionSelection } from "./missions/selection";
import "./missions/missions.css";

const EMPTY: Record<string, string> = {
  active: "No mission is running.",
  queued: "Nothing is waiting. A new mission is queued when another one is running.",
  completed: "No completed mission yet.",
  failed: "No failed or cancelled mission.",
  archived: "Archived missions appear here. Archive a finished mission to hide it from the other tabs.",
};

function MissionRow({ m, missions, selected, onSelect }: { m: Mission; missions: Mission[]; selected: boolean; onSelect: () => void }) {
  const meta = MISSION_STATUS[m.status];
  const pct = progressPct(m);
  const position = queuePosition(m, missions);
  return (
    <button className={`mission-row${selected ? " selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <div className="row">
        <span className="mission-num">{missionNumber(m.id)}</span>
        <span className="mission-row-title grow ellipsis" title={m.title}>
          {m.title}
        </span>
        <Chip tone={meta.tone}>{position !== null ? `Queued #${position}` : meta.label}</Chip>
      </div>
      {m.status !== "queued" && <ProgressBar value={pct === null ? null : pct / 100} label={m.taskTotal > 0 ? `${m.taskDone}/${m.taskTotal}` : "no tasks"} />}
      <div className="muted tiny">
        {m.priority !== "normal" && `${m.priority} priority · `}
        {m.skills.length > 0 && `${m.skills.length} skill${m.skills.length > 1 ? "s" : ""} · `}
        {m.completedAt ? `finished ${formatRelative(m.completedAt)}` : `created ${formatRelative(m.createdAt)}`}
      </div>
    </button>
  );
}

export function Missions() {
  const missions = useMissions();
  const readOnly = useReadOnly();
  const newMission = useUi((s) => s.newMission);
  const newMissionText = useUi((s) => s.newMissionText);
  const setNewMission = useUi((s) => s.setNewMission);
  const openContext = useRightContext((s) => s.openContext);
  const { selected, tab, select, setTab } = useMissionSelection();
  const [composing, setComposing] = useState<{ text: string } | null>(null);

  // Entry points elsewhere (command bar "/mission", "+ New Mission" buttons) set the request.
  useEffect(() => {
    if (!newMission) return;
    setComposing({ text: newMissionText });
    setNewMission(false);
  }, [newMission, newMissionText, setNewMission]);

  const groups = useMemo(() => groupMissions(missions), [missions]);
  const list = groups[tab];
  const picked = missions.find((m) => m.id === selected);
  const current = picked && missionTab(picked) === tab ? picked : (list[0] ?? null);

  const choose = (m: Mission) => {
    select(m.id);
    openContext({ kind: "mission", missionId: m.id });
  };

  return (
    <div className="page">
      <PageHeader
        title="Missions"
        subtitle="Central plans each mission into tasks run by specialised agents. One mission runs at a time; the others wait in the queue by priority."
        actions={
          !readOnly && (
            <button className="btn primary" onClick={() => setComposing({ text: "" })} disabled={!!composing}>
              <Plus size={14} /> New Mission
            </button>
          )
        }
      />
      {composing && (
        <NewMission
          initialText={composing.text}
          onClose={() => setComposing(null)}
          onCreated={(m) => {
            setComposing(null);
            select(m.id, missionTab(m));
            openContext({ kind: "mission", missionId: m.id });
          }}
        />
      )}
      <ImprovementCard />
      <div className="tabs" role="tablist" aria-label="Mission status">
        {MISSION_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === tab} className={`tab${t.key === tab ? " active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
            <span className="mission-tab-count">{groups[t.key].length}</span>
          </button>
        ))}
      </div>
      {missions.length === 0 ? (
        <EmptyState icon={<Target size={22} />} title="No missions yet">
          Click “New Mission”, describe what you want to accomplish, and NEXUS estimates what it needs before Central starts.
        </EmptyState>
      ) : list.length === 0 ? (
        <div className="muted pad">{EMPTY[tab]}</div>
      ) : (
        <div className="missions-layout">
          <div className="mission-rows" role="list">
            {list.map((m) => (
              <MissionRow key={m.id} m={m} missions={missions} selected={current?.id === m.id} onSelect={() => choose(m)} />
            ))}
          </div>
          {current && (
            <div className="panel pad">
              <MissionDetail mission={current} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
