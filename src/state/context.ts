// What the right-hand panel shows (0.3 layout). Shared contract between the
// shell (which renders the panel), the AI World (characters, buildings) and
// the views that select things (missions, skills). Local UI state only.

import { create } from "zustand";
import { isBool, isNumber, readPref, writePref } from "../lib/prefs";

export type RightContext =
  /** Default: the real conversation with the Central agent. */
  | { kind: "central" }
  /** Talk / inspect one agent (its real Claude Code session). */
  | { kind: "agent"; agentId: string; tab?: "chat" | "work" | "profile" }
  | { kind: "mission"; missionId: string }
  /** A skill, installed (`skillId` = Skill.id) or from the marketplace (`marketId`). */
  | { kind: "skill"; skillId?: string; marketId?: string };

export const RIGHT_MIN_WIDTH = 300;
export const RIGHT_MAX_WIDTH = 720;
export const RIGHT_DEFAULT_WIDTH = 380;

export function clampRightWidth(w: number): number {
  return Math.round(Math.min(RIGHT_MAX_WIDTH, Math.max(RIGHT_MIN_WIDTH, w)));
}

interface ContextState {
  right: RightContext;
  /** The right panel is shown (remembered per machine). */
  rightOpen: boolean;
  /** Width in px (remembered per machine). */
  rightWidth: number;
  openContext: (c: RightContext) => void;
  /** Back to the Central chat. */
  resetContext: () => void;
  setRightOpen: (open: boolean) => void;
  setRightWidth: (width: number) => void;
}

export const useRightContext = create<ContextState>((set) => ({
  right: { kind: "central" },
  rightOpen: readPref("rightOpen", true, isBool),
  rightWidth: clampRightWidth(readPref("rightWidth", RIGHT_DEFAULT_WIDTH, isNumber)),
  openContext: (right) => {
    writePref("rightOpen", true);
    set({ right, rightOpen: true });
  },
  resetContext: () => set({ right: { kind: "central" } }),
  setRightOpen: (rightOpen) => {
    writePref("rightOpen", rightOpen);
    set({ rightOpen });
  },
  setRightWidth: (width) => {
    const rightWidth = clampRightWidth(width);
    writePref("rightWidth", rightWidth);
    set({ rightWidth });
  },
}));
