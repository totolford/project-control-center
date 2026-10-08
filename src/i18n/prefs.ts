// Language preferences: the app-level setting (AppSettings, every project on this machine) and the
// optional project override (ProjectSettings in .agent-project/settings.json). Both hold "auto" or a
// locale; the project wins when explicit, "auto" falls through to the app setting, then to the system.

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import type { AppSettings } from "../lib/types";
import { useStore } from "../store";
import { i18n, worldI18n } from "./index";
import { isLocale, toLanguagePref, type LanguagePref, type Locale } from "./locales";

const REMEMBERED = "nexus.locale";

interface AppLanguages {
  /** App settings as last read from or written to the backend (null until loaded). */
  app: AppSettings | null;
  setApp: (app: AppSettings) => void;
}

export const useAppLanguages = create<AppLanguages>((set) => ({
  app: null,
  setApp: (app) => set({ app }),
}));

/** The app-level preferences, "auto" while unknown. */
export function appLanguagePrefs(app: AppSettings | null): { ui: LanguagePref; world: LanguagePref } {
  return { ui: toLanguagePref(app?.uiLanguage), world: toLanguagePref(app?.aiWorldLanguage) };
}

/** Applies a project override and the app setting to both managers. */
export function applyLanguages(project: { uiLanguage?: string; aiWorldLanguage?: string } | null | undefined, app: AppSettings | null): void {
  const ui = i18n.setLanguage(project?.uiLanguage, app?.uiLanguage);
  worldI18n.setLanguage(project?.aiWorldLanguage, app?.aiWorldLanguage);
  if (typeof document !== "undefined") document.documentElement.lang = i18n.tag;
  try {
    localStorage.setItem(REMEMBERED, ui);
  } catch {
    // storage unavailable: the next start shows English until the settings load
  }
}

/**
 * Saves part of the app settings without losing the other fields (re-reads the backend first, so a
 * concurrent change to e.g. the Claude Code path is kept). Applies the result at once.
 */
export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await api.appSettings().catch(() => useAppLanguages.getState().app);
  const saved = await api.saveAppSettings({ claudePath: null, ...current, ...patch });
  useAppLanguages.getState().setApp(saved);
  return saved;
}

/** Shows the last used language before the settings load (avoids an English flash at startup). */
export function restoreRememberedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(REMEMBERED);
    if (isLocale(v)) {
      i18n.setLocale(v);
      return v;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Keeps the interface and AI World languages in sync with the app and project settings. Mount once. */
export function useLanguageSync(): void {
  const app = useAppLanguages((s) => s.app);
  const projectUi = useStore((s) => s.project?.settings.uiLanguage);
  const projectWorld = useStore((s) => s.project?.settings.aiWorldLanguage);

  useEffect(() => {
    let alive = true;
    api
      .appSettings()
      .then((a) => alive && useAppLanguages.getState().setApp(a))
      .catch(() => alive && useAppLanguages.getState().setApp({ claudePath: null }));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // Until the app settings load, keep the remembered language unless the project is explicit.
    if (!app && !isLocale(projectUi)) return;
    applyLanguages({ uiLanguage: projectUi, aiWorldLanguage: projectWorld }, app);
  }, [app, projectUi, projectWorld]);
}
