// Shared state of the Skill Market (the view and the right-panel SkillPanel).
// Holds only what the backend returned; reloaded after every action.

import { create } from "zustand";
import { api, errorMessage } from "../../lib/api";
import type { MarketIndex, MarketStatus } from "../../lib/types";

interface MarketState {
  index: MarketIndex | null;
  status: MarketStatus | null;
  error: string | null;
  loading: boolean;
  /** Entry ids of the last GitHub search (null = no search shown). */
  hits: Set<string> | null;
  hitsQuery: string | null;
  load: () => Promise<void>;
  setIndex: (index: MarketIndex) => void;
  setHits: (query: string | null, hits: string[] | null) => void;
}

export const useMarket = create<MarketState>((set) => ({
  index: null,
  status: null,
  error: null,
  loading: false,
  hits: null,
  hitsQuery: null,
  load: async () => {
    set({ loading: true });
    try {
      const [index, status] = await Promise.all([api.marketIndex(), api.marketStatus()]);
      set({ index, status, error: null, loading: false });
    } catch (e) {
      set({ error: errorMessage(e), loading: false });
    }
  },
  setIndex: (index) => set({ index }),
  setHits: (hitsQuery, hits) => set({ hitsQuery, hits: hits ? new Set(hits) : null }),
}));
