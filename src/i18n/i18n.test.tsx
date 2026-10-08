import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, NAMESPACES } from "./catalog";
import { i18n, I18nManager, LOCALES, useT } from "./index";
import { detectLocale, resolveLocale, toLanguagePref } from "./locales";
import { PLURAL_SUFFIX_RE } from "./manager";

const catalogs = {
  en: { hello: "Hello {name}", "files_one": "{count} file", "files_other": "{count} files", onlyEn: "English only" },
  fr: { hello: "Bonjour {name}", "files_one": "{count} fichier", "files_other": "{count} fichiers" },
};

describe("I18nManager", () => {
  it("interpolates and falls back to English for missing keys", () => {
    const m = new I18nManager(catalogs, "fr");
    expect(m.t("hello", { name: "Ada" })).toBe("Bonjour Ada");
    expect(m.t("onlyEn")).toBe("English only");
    expect(m.t("missing.key")).toBe("missing.key");
    expect(m.t("hello")).toBe("Bonjour {name}");
  });

  it("selects plural forms with Intl.PluralRules", () => {
    const m = new I18nManager(catalogs, "en");
    expect(m.t("files", { count: 1 })).toBe("1 file");
    expect(m.t("files", { count: 1200 })).toBe("1,200 files");
    m.setLocale("fr");
    expect(m.t("files", { count: 0 })).toBe("0 fichier"); // French: 0 is singular
    expect(m.t("files", { count: 2 })).toBe("2 fichiers");
  });

  it("dynamic keys use the fallback when unknown", () => {
    const m = new I18nManager(catalogs, "fr");
    expect(m.dynamic("hello", { name: "x" })).toBe("Bonjour x");
    expect(m.dynamic("status.weird", undefined, "weird")).toBe("weird");
  });

  it("formats numbers and dates per locale", () => {
    const m = new I18nManager(catalogs, "fr");
    expect(m.formatNumber(1234.5).replace(/\s/g, " ")).toBe("1 234,5");
    m.setLocale("en");
    expect(m.formatDate("2026-01-02T10:00:00Z", { year: "numeric", timeZone: "UTC" })).toBe("2026");
    expect(m.formatDate("not a date")).toBe("");
  });

  it("resolves the preference chain and Auto detection", () => {
    expect(detectLocale(["fr-CA", "en-US"])).toBe("fr");
    expect(detectLocale(["xx", "fr-BE"])).toBe("fr");
    expect(detectLocale(["xx"])).toBe("en");
    expect(detectLocale(["de-DE"])).toBe("en"); // unsupported languages fall back to English
    expect(resolveLocale(["auto", "en"], ["fr-FR"])).toBe("en");
    expect(resolveLocale([null, "auto"], ["fr-FR"])).toBe("fr");
    expect(toLanguagePref("klingon")).toBe("auto");
    const m = new I18nManager(catalogs, "en");
    m.setLanguage("fr", "en");
    expect(m.locale).toBe("fr");
    expect(m.preference).toBe("fr");
    m.setLanguage(undefined, "auto");
    expect(m.preference).toBe("auto");
  });

  it("notifies subscribers only on change", () => {
    const m = new I18nManager(catalogs, "en");
    let n = 0;
    const off = m.subscribe(() => n++);
    m.setLocale("en");
    m.setLocale("fr");
    off();
    m.setLocale("en");
    expect(n).toBe(1);
  });
});

describe("catalog", () => {
  it("every key has a translation in every locale", () => {
    const missing: string[] = [];
    for (const ns of NAMESPACES) {
      for (const [key, row] of Object.entries(ns)) {
        LOCALES.forEach((l, i) => {
          if (typeof row[i] !== "string" || row[i] === "") missing.push(`${l}:${key}`);
        });
      }
    }
    expect(missing).toEqual([]);
  });

  it("keys are unique across namespaces", () => {
    const seen = new Map<string, number>();
    for (const ns of NAMESPACES) for (const k of Object.keys(ns)) seen.set(k, (seen.get(k) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it("translations keep the English placeholders", () => {
    const bad: string[] = [];
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const [key, en] of Object.entries(CATALOGS.en)) {
      for (const l of LOCALES) {
        const text = CATALOGS[l][key];
        if (text !== undefined && vars(text) !== vars(en)) bad.push(`${l}:${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("plural groups always have an _other form", () => {
    const bases = new Set(Object.keys(CATALOGS.en).filter((k) => PLURAL_SUFFIX_RE.test(k)).map((k) => k.replace(PLURAL_SUFFIX_RE, "")));
    expect([...bases].filter((b) => !(`${b}_other` in CATALOGS.en))).toEqual([]);
  });
});

function Probe() {
  const t = useT();
  return <button>{t("common.save")}</button>;
}

describe("useT", () => {
  afterEach(() => i18n.setLocale("en"));
  it("re-renders when the language changes", () => {
    render(<Probe />);
    expect(screen.getByRole("button").textContent).toBe("Save");
    act(() => void i18n.setLanguage("fr"));
    expect(screen.getByRole("button").textContent).toBe("Enregistrer");
    act(() => void i18n.setLanguage("en"));
    expect(screen.getByRole("button").textContent).toBe("Save");
  });
});
