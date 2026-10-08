// Typed message namespaces. Each key is one row holding its text in every language, in LOCALES order:
//
//   "settings.title": ["Settings", "Paramètres"],
//   //                  en          fr
//
// English (first) is the source of truth. A missing or null translation falls back to English at runtime
// and is reported by the catalog completeness test.
//
// Plurals: `key_one`, `key_other` (plus `_zero`, `_two`, `_few`, `_many` if ever needed) are selected with
// Intl.PluralRules when `t("key", { count })` is called.

export type Row = readonly [en: string, fr?: string | null];
export type Namespace = Record<string, Row>;

export function defineMessages<N extends Namespace>(ns: N): N {
  return ns;
}

/** One locale's flattened messages (key → text). */
export type Messages = Record<string, string>;
