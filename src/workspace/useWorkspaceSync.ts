import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useLayoutContext } from "./hooks";
import { addPanelToActive } from "./layout";
import { useWorkspace } from "./store";

/**
 * Keeps the workspace in step with the project: loads it when a project opens, prunes panels
 * whose agent/connection disappeared, and (if enabled) adds a terminal for each new agent.
 */
export function useWorkspaceSync() {
  const projectId = useStore((s) => s.project?.info.id ?? null);
  const ctx = useLayoutContext();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const loaded = useWorkspace((s) => s.ws !== null && s.projectId === projectId);
  const known = useRef<Set<string> | null>(null);
  // Only membership matters here; status updates arrive constantly and must not trigger work.
  const idsKey = `${ctx.agents.map((a) => a.id).join(",")}|${ctx.connections.map((c) => c.id).join(",")}`;

  useEffect(() => {
    known.current = null;
    if (projectId) void useWorkspace.getState().load(projectId, ctxRef.current);
    else useWorkspace.getState().clear();
  }, [projectId]);

  useEffect(() => {
    if (!loaded) return;
    const current = ctxRef.current;
    const { prune, update } = useWorkspace.getState();
    prune(current);
    if (!known.current) {
      known.current = new Set(current.agents.map((a) => a.id));
      return;
    }
    const fresh = current.agents.filter((a) => !known.current!.has(a.id));
    for (const a of fresh) known.current.add(a.id);
    if (!useWorkspace.getState().ws?.autoAddAgents) return;
    for (const a of fresh) {
      if (a.kind === "worker" && a.status !== "retired") update((w) => addPanelToActive(w, { type: "AgentTerminal", agentId: a.id }));
    }
  }, [idsKey, loaded]);
}
