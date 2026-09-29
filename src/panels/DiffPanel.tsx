import { memo, useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import type { GitOverview } from "../lib/types";
import { Loading } from "../components/Common";
import { AgentBranchCard } from "../views/git/AgentBranchCard";
import type { PanelBodyProps } from "../workspace/registry";
import { useStore } from "../store";

/** The agent's branch diff against the base branch (from gitOverview). */
export const DiffPanel = memo(function DiffPanel({ spec }: PanelBodyProps) {
  const gitVersion = useStore((s) => s.project?.gitVersion ?? 0);
  const [overview, setOverview] = useState<GitOverview | null | undefined>(undefined);
  const load = useCallback(async () => {
    const o = await attempt(() => api.gitOverview());
    setOverview(o === undefined ? null : o);
  }, []);
  useEffect(() => {
    void load();
  }, [load, gitVersion]);

  if (overview === undefined) return <Loading />;
  if (overview === null) return <div className="muted pad">Not a git repository.</div>;
  const entry = overview.agents.find((a) => a.agentId === spec.agentId);
  if (!entry) return <div className="muted pad">This agent has no branch of its own (it works in the shared folder).</div>;
  return (
    <div className="panel-scroll pad-sm">
      <AgentBranchCard entry={entry} baseBranch={overview.status.branch ?? "HEAD"} onChanged={() => void load()} />
    </div>
  );
});
