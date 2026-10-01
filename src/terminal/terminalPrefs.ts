// Raw Terminal display preferences (per machine).

import { create } from "zustand";
import { isNumber, readPref, writePref } from "../lib/prefs";

export const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18];

interface TerminalPrefs {
  fontSize: number;
  setFontSize: (size: number) => void;
}

export const useTerminalPrefs = create<TerminalPrefs>((set) => ({
  fontSize: readPref("terminalFontSize", 13, isNumber),
  setFontSize: (fontSize) => {
    writePref("terminalFontSize", fontSize);
    set({ fontSize });
  },
}));

export const XTERM_THEME = {
  background: "#0b0d10",
  foreground: "#e7eaf0",
  cursor: "#6f8ef0",
  cursorAccent: "#0b0d10",
  selectionBackground: "rgba(111, 142, 240, 0.35)",
  black: "#1b2027",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#c9d1d9",
  brightBlack: "#59616d",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

export const XTERM_FONT = '"Cascadia Code", "Cascadia Mono", Consolas, monospace';
