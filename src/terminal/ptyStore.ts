// Raw Terminal sessions (ConPTY processes owned by the backend). The list comes from api.ptyList
// and is kept current by spawn/close results and PTY exit events.

import { create } from "zustand";
import { api } from "../lib/api";
import { observeAllPty } from "../lib/ptyBus";
import { attempt, run } from "../lib/toast";
import type { PtyInfo, TerminalProfile } from "../lib/types";

interface PtyState {
  sessions: PtyInfo[];
  active: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  spawn: (profile: TerminalProfile, agentId?: string | null) => Promise<PtyInfo | undefined>;
  close: (id: string) => Promise<void>;
  setActive: (id: string) => void;
}

export const usePty = create<PtyState>((set, get) => ({
  sessions: [],
  active: null,
  loaded: false,
  refresh: async () => {
    const list = await attempt(() => api.ptyList());
    if (!list) return;
    const active = get().active;
    set({ sessions: list, loaded: true, active: active && list.some((s) => s.id === active) ? active : (list[0]?.id ?? null) });
  },
  spawn: async (profile, agentId = null) => {
    const info = await attempt(() => api.ptySpawn({ profile, agentId, cols: 120, rows: 30 }));
    if (info) set((s) => ({ sessions: [...s.sessions.filter((x) => x.id !== info.id), info], active: info.id }));
    return info;
  },
  close: async (id) => {
    if (!(await run(() => api.ptyClose(id)))) return;
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      return { sessions, active: s.active === id ? (sessions[sessions.length - 1]?.id ?? null) : s.active };
    });
  },
  setActive: (active) => set({ active }),
}));

observeAllPty((e) => {
  if (e.type !== "exit") return;
  usePty.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === e.id ? { ...x, running: false, exitCode: e.code } : x)) }));
});
