// I18nManager: one instance per independently translated surface (the NEXUS UI, the AI World). Holds the
// active locale, resolves keys with English fallback, interpolates {placeholders}, selects plurals with
// Intl.PluralRules and formats numbers and dates with Intl.

import { DEFAULT_LOCALE, INTL_TAGS, type LanguagePref, type Locale, resolveLocale, toLanguagePref } from "./locales";
import type { Messages } from "./define";

export type Vars = Record<string, string | number | null | undefined>;
export type Catalogs = Record<Locale, Messages>;

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"] as const;

export class I18nManager<K extends string = string> {
  private current: Locale;
  private pref: LanguagePref = "auto";
  private listeners = new Set<() => void>();
  private plural = new Map<Locale, Intl.PluralRules>();
  private numbers = new Map<string, Intl.NumberFormat>();

  constructor(
    private catalogs: Catalogs,
    initial: Locale = DEFAULT_LOCALE,
  ) {
    this.current = initial;
  }

  get locale(): Locale {
    return this.current;
  }

  /** The preference that produced the locale ("auto" when it was detected from the system). */
  get preference(): LanguagePref {
    return this.pref;
  }

  /** BCP 47 tag of the active locale, for Intl APIs and the `lang` attribute. */
  get tag(): string {
    return INTL_TAGS[this.current];
  }

  /**
   * Applies a preference chain, most specific first (e.g. project override, then app setting). The first
   * explicit language wins; "auto" or unset entries fall through to the system language.
   */
  setLanguage(...prefs: (string | null | undefined)[]): Locale {
    const explicit = prefs.find((p) => toLanguagePref(p) !== "auto");
    this.pref = toLanguagePref(explicit);
    return this.setLocale(resolveLocale(prefs));
  }

  setLocale(locale: Locale): Locale {
    if (locale !== this.current) {
      this.current = locale;
      this.listeners.forEach((l) => l());
    }
    return locale;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Locale => this.current;

  /** True when the key (or its plural forms) exists in English. */
  has(key: string): boolean {
    const en = this.catalogs.en;
    return key in en || `${key}_other` in en;
  }

  /** Translates a typed key. `count` selects the plural form and is also available as {count}. */
  t = (key: K, vars?: Vars): string => this.translate(key, vars);

  /** Translates a key built at runtime (e.g. from an enum); returns `fallback` (or the key) when unknown. */
  dynamic = (key: string, vars?: Vars, fallback?: string): string =>
    this.has(key) ? this.translate(key, vars) : interpolate(fallback ?? key, vars, (n) => this.formatNumber(n));

  private translate(key: string, vars?: Vars): string {
    const count = vars?.count;
    const raw =
      typeof count === "number" && !(key in this.catalogs.en) ? this.pluralMessage(key, count) : this.lookup(key);
    return interpolate(raw ?? key, vars, (n) => this.formatNumber(n));
  }

  private lookup(key: string): string | undefined {
    return this.catalogs[this.current]?.[key] ?? this.catalogs.en[key];
  }

  private pluralMessage(key: string, count: number): string | undefined {
    const own = this.catalogs[this.current] ?? {};
    const category = this.rules(this.current).select(count);
    const exact = own[`${key}_${category}`] ?? own[`${key}_other`];
    if (exact !== undefined) return exact;
    // English fallback uses English plural rules.
    const en = this.catalogs.en;
    return en[`${key}_${this.rules("en").select(count)}`] ?? en[`${key}_other`];
  }

  private rules(locale: Locale): Intl.PluralRules {
    let r = this.plural.get(locale);
    if (!r) {
      r = new Intl.PluralRules(INTL_TAGS[locale]);
      this.plural.set(locale, r);
    }
    return r;
  }

  formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
    const cacheKey = `${this.current}|${JSON.stringify(options ?? {})}`;
    let f = this.numbers.get(cacheKey);
    if (!f) {
      f = new Intl.NumberFormat(this.tag, options);
      this.numbers.set(cacheKey, f);
    }
    return f.format(n);
  }

  formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat(this.tag, options ?? { dateStyle: "medium", timeStyle: "short" }).format(d);
  }

  /** "5 minutes ago", "in 2 days"… from a signed number of seconds relative to now. */
  formatRelativeSeconds(seconds: number, style: Intl.RelativeTimeFormatStyle = "narrow"): string {
    const f = new Intl.RelativeTimeFormat(this.tag, { numeric: "auto", style });
    const abs = Math.abs(seconds);
    if (abs < 60) return f.format(Math.round(seconds), "second");
    if (abs < 3600) return f.format(Math.trunc(seconds / 60), "minute");
    if (abs < 86400) return f.format(Math.trunc(seconds / 3600), "hour");
    return f.format(Math.trunc(seconds / 86400), "day");
  }

  formatList(items: string[], type: Intl.ListFormatType = "conjunction"): string {
    return new Intl.ListFormat(this.tag, { type, style: "long" }).format(items);
  }

  /** Plural categories this locale distinguishes for whole numbers (used by the completeness test). */
  integerPluralCategories(locale: Locale): string[] {
    const r = this.rules(locale);
    const seen = new Set<string>();
    for (let n = 0; n <= 200; n++) seen.add(r.select(n));
    return PLURAL_SUFFIXES.filter((s) => seen.has(s));
  }
}

/** Replaces {name} placeholders; numbers use the locale's number format. Unknown placeholders stay visible. */
export function interpolate(message: string, vars: Vars | undefined, num: (n: number) => string): string {
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) return whole;
    return typeof v === "number" ? num(v) : v;
  });
}

export const PLURAL_SUFFIX_RE = new RegExp(`_(${PLURAL_SUFFIXES.join("|")})$`);
