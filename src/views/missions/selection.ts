// Which mission and tab the Missions page shows (local UI state, shared with
// the right panel's "Open in Missions" and the New Mission flow).

import { create } from "zustand";
import type { MissionTab } from "./logic";

interface MissionSelection {
  selected: string | null;
  tab: MissionTab;
  select: (id: string | null, tab?: MissionTab) => void;
  setTab: (tab: MissionTab) => void;
}

export const useMissionSelection = create<MissionSelection>((set) => ({
  selected: null,
  tab: "active",
  select: (selected, tab) => set(tab ? { selected, tab } : { selected }),
  setTab: (tab) => set({ tab }),
}));
