import { memo, useState } from "react";
import type { PccEvent } from "../lib/types";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { EventDetail } from "../views/Activity";
import type { PanelBodyProps } from "../workspace/registry";

const NO_FILTER = {};

/** Timeline panel; scoped to an agent or mission when the panel spec says so. */
export const ActivityPanel = memo(function ActivityPanel({ spec }: PanelBodyProps) {
  const [selected, setSelected] = useState<PccEvent | null>(null);
  const filter = spec.agentId || spec.missionId ? { agentId: spec.agentId, missionId: spec.missionId } : NO_FILTER;
  return (
    <div className="activity-panel">
      <ActivityTimeline filter={filter} selectedId={selected?.id} onSelect={setSelected} />
      {selected && <EventDetail event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
});
