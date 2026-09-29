import { useMemo } from "react";
import { Target } from "lucide-react";
import { useMissions } from "../store";
import { EmptyState, PageHeader } from "../components/Common";
import { MissionCard, isRunning } from "../panels/MissionPanel";

export function Missions() {
  const missions = useMissions();
  const sorted = useMemo(
    () => [...missions].sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || b.createdAt.localeCompare(a.createdAt)),
    [missions],
  );
  return (
    <div className="page">
      <PageHeader
        title="Missions"
        subtitle="Describe a goal in the composer below. Central plans it, creates specialised agents and tasks, and routes their work."
      />
      {sorted.length === 0 ? (
        <EmptyState icon={<Target size={22} />} title="No missions yet">
          Type what you want to build in “What do you want to build?” and press Ctrl+Enter.
        </EmptyState>
      ) : (
        <div className="mission-list">
          {sorted.map((m) => (
            <div key={m.id} className="panel pad-md">
              <MissionCard mission={m} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
