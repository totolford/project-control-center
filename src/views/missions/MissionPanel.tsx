// Right-panel view of one mission (contract: src/state/context.ts, kind "mission").

import { useMissions, useStore } from "../../store";
import { MissionDetail } from "./MissionDetail";
import { missionTab } from "./logic";
import { useMissionSelection } from "./selection";
import "./missions.css";

export function MissionPanel({ missionId }: { missionId: string }) {
  const mission = useMissions().find((m) => m.id === missionId);
  const navigate = useStore((s) => s.navigate);
  const select = useMissionSelection((s) => s.select);
  if (!mission) {
    return <div className="muted pad">Mission {missionId} is not in this project.</div>;
  }
  return (
    <div className="mission-panel">
      <MissionDetail mission={mission} compact />
      <div className="row-end">
        <button
          className="link-btn"
          onClick={() => {
            select(mission.id, missionTab(mission));
            navigate({ name: "missions" });
          }}
        >
          Open in Missions
        </button>
      </div>
    </div>
  );
}
