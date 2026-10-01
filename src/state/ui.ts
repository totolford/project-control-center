// Local-only UI state (overlays, read markers, layout toggles). Nothing here comes from or goes to the backend.

import { create } from "zustand";
import { isBool, readPref, writePref } from "../lib/prefs";
import type { Message } from "../lib/types";

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
  openMessage: (m: Message | null) => void;
  setCommandOpen: (open: boolean) => void;
  setNotificationsOpen: (open: boolean) => void;
  markRead: (id: number) => void;
  setPermissionsDeferred: (deferred: boolean) => void;
  openDialog: (d: Dialog) => void;
  toggleNav: () => void;
  toggleRail: () => void;
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
}));
