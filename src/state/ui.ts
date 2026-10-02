// Local-only UI state (overlays, read markers, layout toggles). Nothing here comes from or goes to the backend.

import { create } from "zustand";
import { isBool, readPref, writePref } from "../lib/prefs";
import type { Message } from "../lib/types";

export type ComposerMode = "mission" | "central" | "command";

export type Dialog = { type: "newAgent"; provider: string } | { type: "addConnection" } | null;

interface UiState {
  messageDetail: Message | null;
  commandOpen: boolean;
  notificationsOpen: boolean;
  /** Highest event id the user has seen in the notification center. */
  lastReadId: number;
  /** The permission prompt was put aside with "Later"; a new request or a click brings it back. */
  permissionsDeferred: boolean;
  dialog: Dialog;
  /** Main navigation shows icons only (remembered per machine). */
  navCollapsed: boolean;
  /** CONTROL rail of the Swarm view is shown (remembered per machine). */
  railOpen: boolean;
  /** Bottom composer mode (the command bar can switch it). */
  composerMode: ComposerMode;
  /** User-request cards are folded into a single pill (they come back when a new request arrives). */
  requestsCollapsed: boolean;
  /** Explanation shown once on the welcome screen (e.g. after a rollback closed the project). */
  welcomeNotice: string | null;
  /** The AI World view opens its "make this project an AI Town" wizard (read and cleared by src/views/world). */
  aiWorldWizard: boolean;
  openMessage: (m: Message | null) => void;
  setCommandOpen: (open: boolean) => void;
  setNotificationsOpen: (open: boolean) => void;
  markRead: (id: number) => void;
  setPermissionsDeferred: (deferred: boolean) => void;
  openDialog: (d: Dialog) => void;
  toggleNav: () => void;
  toggleRail: () => void;
  setComposerMode: (mode: ComposerMode) => void;
  setRequestsCollapsed: (collapsed: boolean) => void;
  setWelcomeNotice: (text: string | null) => void;
  setAiWorldWizard: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  messageDetail: null,
  commandOpen: false,
  notificationsOpen: false,
  lastReadId: 0,
  permissionsDeferred: false,
  dialog: null,
  navCollapsed: readPref("navCollapsed", false, isBool),
  railOpen: readPref("railOpen", true, isBool),
  composerMode: "mission",
  requestsCollapsed: false,
  welcomeNotice: null,
  aiWorldWizard: false,
  openMessage: (messageDetail) => set({ messageDetail }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
  markRead: (id) => set((s) => ({ lastReadId: Math.max(s.lastReadId, id) })),
  setPermissionsDeferred: (permissionsDeferred) => set({ permissionsDeferred }),
  openDialog: (dialog) => set({ dialog }),
  toggleNav: () =>
    set((s) => {
      writePref("navCollapsed", !s.navCollapsed);
      return { navCollapsed: !s.navCollapsed };
    }),
  toggleRail: () =>
    set((s) => {
      writePref("railOpen", !s.railOpen);
      return { railOpen: !s.railOpen };
    }),
  setComposerMode: (composerMode) => set({ composerMode }),
  setRequestsCollapsed: (requestsCollapsed) => set({ requestsCollapsed }),
  setWelcomeNotice: (welcomeNotice) => set({ welcomeNotice }),
  setAiWorldWizard: (aiWorldWizard) => set({ aiWorldWizard }),
}));
