// Opens the AI Setup wizard: automatically on first launch (`AiSetupGate`) or from AI Engines / Settings.

import { create } from "zustand";

interface AiSetupState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useAiSetup = create<AiSetupState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
