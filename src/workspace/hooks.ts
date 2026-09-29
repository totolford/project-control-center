// Shared hooks for swarm panels. Each selects a narrow slice so panels re-render only when needed.

import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { subscribeLogs } from "../lib/logBus";
import { parseToolUse } from "../lib/toolText";
import type { LogEntry, ProviderInfo } from "../lib/types";
import { useAgents, useConnections, useStore } from "../store";
import { deriveVisualState, lastTaskOf, type VisualState } from "./agentState";
import type { LayoutContext } from "./layoutPersist";

export function useVisualState(agentId: string | undefined): VisualState | null {
  return useStore((s) => {
    const p = s.project;
    const agent = agentId ? p?.agents.find((a) => a.id === agentId) : undefined;
    if (!p || !agent) return null;
    const currentTask = agent.currentTask ? p.tasks.find((t) => t.id === agent.currentTask) : null;
    return deriveVisualState({ agent, currentTask, lastTask: lastTaskOf(p.tasks, agent.id), lastTurnError: s.turnErrors[agent.id] });
  });
}

export function useLayoutContext(): LayoutContext {
  const agents = useAgents();
  const connections = useConnections();
  return useMemo(() => ({ agents, connections }), [agents, connections]);
}

/** Agent providers from the backend, loaded once per app run. */
const useProviderStore = create<{ list: ProviderInfo[] | null; loading: boolean; load: () => Promise<void> }>((set, get) => ({
  list: null,
  loading: false,
  load: async () => {
    if (get().loading || get().list) return;
    set({ loading: true });
    try {
      set({ list: await api.listAgentProviders() });
    } catch {
      set({ list: [] });
    } finally {
      set({ loading: false });
    }
  },
}));

export function useProviders(): ProviderInfo[] | null {
  const list = useProviderStore((s) => s.list);
  const load = useProviderStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return list;
}

/** First available provider id (Claude Code preferred), or null when none can be used. */
export function availableProviderId(): string | null {
  const list = useProviderStore.getState().list ?? [];
  return (list.find((p) => p.available && p.id === "claude-code") ?? list.find((p) => p.available))?.id ?? null;
}

export function useProviderName(providerId: string): string {
  const list = useProviders();
  return list?.find((p) => p.id === providerId)?.name ?? providerId;
}

/** Log entries of one agent matching `keep` (a stable function): last `limit` from history + live, oldest first. */
export function useFilteredLogs(agentId: string | undefined, keep: (e: LogEntry) => boolean, limit: number, historySize = 300): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setEntries([]);
    const add = (list: LogEntry[]) => {
      const kept = list.filter(keep);
      if (kept.length === 0) return;
      setEntries((cur) => {
        const byId = new Map(cur.map((e) => [e.id, e]));
        for (const e of kept) byId.set(e.id, e);
        return [...byId.values()].sort((x, y) => x.id - y.id).slice(-limit);
      });
    };
    const unsubscribe = subscribeLogs(agentId, (e) => add([e]));
    api
      .agentLogs(agentId, null, historySize)
      .then((logs) => !cancelled && add(logs))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [agentId, keep, limit, historySize]);
  return entries;
}

export const isToolUse = (e: LogEntry) => e.kind === "tool_use";
export const isAssistantText = (e: LogEntry) => e.kind === "assistant_text";

/** Last `n` tool actions of an agent, described readably. */
export function useRecentActions(agentId: string | undefined, n: number): { id: number; ts: string; action: string }[] {
  const logs = useFilteredLogs(agentId, isToolUse, n);
  return useMemo(() => logs.map((e) => ({ id: e.id, ts: e.ts, action: parseToolUse(e.text).action })).reverse(), [logs]);
}

/** Latest assistant text of an agent. */
export function useLatestAssistantText(agentId: string | undefined): LogEntry | null {
  const logs = useFilteredLogs(agentId, isAssistantText, 1, 50);
  return logs[logs.length - 1] ?? null;
}
