// Supported interface languages and "Auto" detection from the OS / webview locale.

export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

/** A language preference as stored in settings: a locale, or "auto" (follow the system). */
export type LanguagePref = "auto" | Locale;
export const LANGUAGE_PREFS: LanguagePref[] = ["auto", ...LOCALES];

export const DEFAULT_LOCALE: Locale = "en";

/** Each language's name in its own language (shown in pickers, never translated). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  fr: "Français",
};

/** BCP 47 tag handed to Intl formatters. */
export const INTL_TAGS: Record<Locale, string> = {
  en: "en",
  fr: "fr-FR",
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

export function isLanguagePref(v: unknown): v is LanguagePref {
  return v === "auto" || isLocale(v);
}

/** Normalizes a stored value: anything unknown (null, "", "klingon") means "auto". */
export function toLanguagePref(v: unknown): LanguagePref {
  return isLanguagePref(v) ? v : "auto";
}

/** First supported language among BCP 47 tags such as ["fr-CA", "en-US"]; English when none matches. */
export function detectLocale(tags: readonly string[] | undefined | null): Locale {
  for (const tag of tags ?? []) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** The system languages as the webview reports them (empty outside a browser). */
export function systemLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  const list = navigator.languages?.length ? [...navigator.languages] : [];
  if (navigator.language && !list.includes(navigator.language)) list.push(navigator.language);
  return list;
}

/** Resolves a preference chain: the first explicit language wins, "auto"/unset falls through to the system. */
export function resolveLocale(prefs: readonly (string | null | undefined)[], system: readonly string[] = systemLanguages()): Locale {
  for (const p of prefs) if (isLocale(p)) return p;
  return detectLocale(system);
}
