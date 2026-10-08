// Public i18n API.
//
//   const t = useT();             // in components: re-renders when the language changes
//   t("common.save")               // typed keys, English fallback
//   t("common.agents", { count })  // plurals via Intl.PluralRules (keys common.agents_one / _other)
//   t("x.hello", { name })         // {name} interpolation
//   t.dynamic(`status.${s}`, undefined, s)  // keys built at runtime, with a fallback
//   rich(t("x.run"), { cmd: <code>gh</code> })  // {placeholders} replaced by elements
//
// Outside React (toasts, model helpers called during render) import `t` directly. The AI World has its
// own instance (`worldI18n` / `useWorldT`) so its language can differ from the interface.

import { createElement, Fragment, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { CATALOGS, type MessageKey } from "./catalog";
import { DEFAULT_LOCALE, type Locale } from "./locales";
import { I18nManager, type Vars } from "./manager";

export type { MessageKey } from "./catalog";
export type { Vars } from "./manager";
export { I18nManager } from "./manager";
export * from "./locales";

/** The NEXUS interface. */
export const i18n = new I18nManager<MessageKey>(CATALOGS, DEFAULT_LOCALE);
/** The AI World UI (world language may differ from the interface language). */
export const worldI18n = new I18nManager<MessageKey>(CATALOGS, DEFAULT_LOCALE);

export interface TFunction {
  (key: MessageKey, vars?: Vars): string;
  /** Key built at runtime; `fallback` (or the key itself) when the catalog does not have it. */
  dynamic: (key: string, vars?: Vars, fallback?: string) => string;
  locale: Locale;
  manager: I18nManager<MessageKey>;
}

function bind(m: I18nManager<MessageKey>, locale: Locale): TFunction {
  const fn = ((key: MessageKey, vars?: Vars) => m.t(key, vars)) as TFunction;
  fn.dynamic = m.dynamic;
  fn.locale = locale;
  fn.manager = m;
  return fn;
}

/** Translate with the interface language (non-React code; components should prefer useT). */
export const t: TFunction = Object.assign((key: MessageKey, vars?: Vars) => i18n.t(key, vars), {
  dynamic: i18n.dynamic,
  manager: i18n,
  get locale() {
    return i18n.locale;
  },
}) as TFunction;

/** Subscribes to a manager's locale. */
export function useLocale(m: I18nManager<MessageKey> = i18n): Locale {
  return useSyncExternalStore(m.subscribe, m.getSnapshot, m.getSnapshot);
}

/** `t` for the interface language; the component re-renders when it changes. */
export function useT(): TFunction {
  const locale = useLocale(i18n);
  return useMemo(() => bind(i18n, locale), [locale]);
}

/** `t` for the AI World language. */
export function useWorldT(): TFunction {
  const locale = useLocale(worldI18n);
  return useMemo(() => bind(worldI18n, locale), [locale]);
}

/** Replaces {placeholders} of a translated message with elements (e.g. <code>, links); others stay as text. */
export function rich(message: string, parts: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of message.matchAll(/\{(\w+)\}/g)) {
    if (!(m[1] in parts)) continue;
    out.push(message.slice(last, m.index));
    out.push(createElement(Fragment, { key: out.length }, parts[m[1]]));
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(message.slice(last));
  return out;
}

/**
 * A record of labels translated each time a value is read (for module-level tables such as status
 * labels): `const LABEL = lazyLabels({ ok: "x.ok", failed: "x.failed" })`.
 */
export function lazyLabels<K extends string>(keys: Record<K, MessageKey>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of Object.keys(keys) as K[]) {
    Object.defineProperty(out, k, { get: () => i18n.t(keys[k]), enumerable: true });
  }
  return out;
}
