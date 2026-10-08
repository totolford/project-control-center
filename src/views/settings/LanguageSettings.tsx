import { useState } from "react";
import type { ProjectSettings } from "../../lib/types";
import { toast } from "../../lib/toast";
import { useT } from "../../i18n";
import { appLanguagePrefs, saveAppSettings, useAppLanguages } from "../../i18n/prefs";
import { detectLocale, LANGUAGE_PREFS, LOCALE_NAMES, resolveLocale, systemLanguages, toLanguagePref, type LanguagePref } from "../../i18n/locales";
import { Field, Section } from "../../components/Common";

type Set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => void;

function LanguageSelect({ value, autoLabel, onChange, disabled, label }: { value: LanguagePref; autoLabel: string; onChange: (v: LanguagePref) => void; disabled?: boolean; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(toLanguagePref(e.target.value))} disabled={disabled}>
      {LANGUAGE_PREFS.map((p) => (
        <option key={p} value={p} lang={p === "auto" ? undefined : p}>
          {p === "auto" ? autoLabel : LOCALE_NAMES[p]}
        </option>
      ))}
    </select>
  );
}

/** Interface and AI World languages: app-level (saved at once) and the project override (in the draft). */
export function LanguageSettings({ draft, set }: { draft: ProjectSettings; set: Set }) {
  const t = useT();
  const app = useAppLanguages((s) => s.app);
  const [saving, setSaving] = useState(false);
  const prefs = appLanguagePrefs(app);
  const system = LOCALE_NAMES[detectLocale(systemLanguages())];
  const auto = t("settings.language.auto", { name: system });
  const appUi = LOCALE_NAMES[resolveLocale([prefs.ui])];
  const appWorld = LOCALE_NAMES[resolveLocale([prefs.world])];

  const saveApp = async (patch: { uiLanguage?: LanguagePref; aiWorldLanguage?: LanguagePref }) => {
    setSaving(true);
    try {
      await saveAppSettings(patch);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={t("settings.language.title")}>
      <div className="form-row">
        <Field label={t("settings.language.interface")} hint={t("settings.language.interfaceHint")}>
          <LanguageSelect label={t("settings.language.interface")} value={prefs.ui} autoLabel={auto} disabled={!app || saving} onChange={(v) => void saveApp({ uiLanguage: v })} />
        </Field>
        <Field label={t("settings.language.world")} hint={t("settings.language.worldHint")}>
          <LanguageSelect label={t("settings.language.world")} value={prefs.world} autoLabel={auto} disabled={!app || saving} onChange={(v) => void saveApp({ aiWorldLanguage: v })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t("settings.language.projectInterface")} hint={t("settings.language.projectHint")}>
          <LanguageSelect
            label={t("settings.language.projectInterface")}
            value={toLanguagePref(draft.uiLanguage)}
            autoLabel={t("settings.language.inherit", { name: appUi })}
            onChange={(v) => set("uiLanguage", v)}
          />
        </Field>
        <Field label={t("settings.language.projectWorld")} hint={t("settings.language.projectHint")}>
          <LanguageSelect
            label={t("settings.language.projectWorld")}
            value={toLanguagePref(draft.aiWorldLanguage)}
            autoLabel={t("settings.language.inherit", { name: appWorld })}
            onChange={(v) => set("aiWorldLanguage", v)}
          />
        </Field>
      </div>
    </Section>
  );
}
