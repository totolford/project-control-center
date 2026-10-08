// Central's execution state (autonomy level, missions waiting for the user, auto-resume notice, local
// capability), fetched from central_state and refreshed on the backend events that change it.

import { create } from "zustand";
import { onEvent } from "../../lib/api";
import { centralApi } from "../../lib/centralApi";
import type { CentralState } from "../../lib/centralTypes";
import type { PccEvent } from "../../lib/types";

interface CentralStore {
  state: CentralState | null;
  refresh: () => Promise<void>;
}

export const useCentral = create<CentralStore>((set) => ({
  state: null,
  refresh: async () => {
    try {
      set({ state: await centralApi.state() });
    } catch {
      set({ state: null });
    }
  },
}));

/** Events after which central_state may have changed. */
export function affectsCentral(e: Pick<PccEvent, "name" | "agentId" | "kind">): boolean {
  const n = e.name ?? "";
  if (n.startsWith("mission.") || n.startsWith("supervisor.") || n === "ai.capabilityTest") return true;
  if (e.kind === "MissionUpdated") return true;
  return e.agentId === "central" && (e.kind === "AgentUpdated" || n.startsWith("agent.") || n.startsWith("power."));
}

let users = 0;
let stop: (() => void) | null = null;

/** Keeps the Central state fresh while at least one component uses it. */
export function subscribeCentral(): () => void {
  users += 1;
  if (users === 1) {
    void useCentral.getState().refresh();
    let timer: number | undefined;
    const unlisten = onEvent((e) => {
      if (!affectsCentral(e)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void useCentral.getState().refresh(), 250);
    });
    stop = () => {
      window.clearTimeout(timer);
      void unlisten.then((f) => f()).catch(() => undefined);
    };
  }
  return () => {
    users -= 1;
    if (users === 0) {
      stop?.();
      stop = null;
    }
  };
}
