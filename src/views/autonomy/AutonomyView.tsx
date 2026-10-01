import { useState } from "react";
import { Info, RotateCw } from "lucide-react";
import { api } from "../../lib/api";
import { isLive } from "../../lib/labels";
import { run } from "../../lib/toast";
import { useAgents, useStore } from "../../store";
import { PageHeader, Section } from "../../components/Common";
import { UnlockedToggle } from "../../components/UnlockedToggle";
import { AutonomyRules } from "./AutonomyRules";
import { DecisionJournal } from "./DecisionJournal";

function RestartLive() {
  const agents = useAgents();
  const [busy, setBusy] = useState(false);
  const live = agents.filter((a) => isLive(a.status));
  const restart = async () => {
    setBusy(true);
    for (const a of live) await run(() => api.restartAgent(a.id));
    setBusy(false);
  };
  return (
    <div className="notice">
      <Info size={14} />
      <span className="grow">The tools available to a session that is already running only change after it restarts.</span>
      <button className="btn btn-sm" onClick={() => void restart()} disabled={busy || live.length === 0}>
        <RotateCw size={12} /> Restart agents to apply ({live.length} running)
      </button>
    </div>
  );
}

/** CLAUDE UNLOCKED: the rules NEXUS uses to answer permission prompts, and the approval journal. */
export function AutonomyView() {
  const unlocked = useStore((s) => s.project?.settings.autonomy.unlocked ?? false);
  const emergency = useStore((s) => s.project?.emergency ?? false);
  return (
    <div className="page">
      <PageHeader title="CLAUDE UNLOCKED" subtitle="NEXUS answers Claude Code's permission prompts on your behalf according to these rules. It never bypasses Claude Code's safety; every decision is journaled." />
      <div className={`unlock-hero${unlocked ? " on" : ""}`}>
        <UnlockedToggle large />
        <div className="small">
          {unlocked ? (
            <>Every agent currently uses the unlocked permissions below instead of its own.</>
          ) : (
            <>Off: each agent uses its own permissions (Agents → profile) and asks you when they say “ask”.</>
          )}
          {emergency && <div className="tone-red-fg">Emergency stop active: auto-approval is suspended until it is released.</div>}
        </div>
      </div>
      <RestartLive />
      <AutonomyRules />
      <Section title="Approval journal">
        <DecisionJournal />
      </Section>
    </div>
  );
}
