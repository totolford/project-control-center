import type { TokenSaverSettings as TokenSaver } from "../../lib/types";
import { useAgents } from "../../store";
import { Section } from "../../components/Common";
import { useT } from "../../i18n";
import { DEFAULT_TOKEN_SAVER, nextStart, opusWorkers } from "./tokenSaver";

const THRESHOLDS = [0, 30_000, 60_000, 100_000, 150_000];

/** Settings → Token saver (edited inside the Settings draft; projects from before 0.5.1 read the defaults). */
export function TokenSaverSettings({ value, onChange }: { value: TokenSaver | undefined; onChange: (v: TokenSaver) => void }) {
  const t = useT();
  const agents = useAgents();
  const current = { ...DEFAULT_TOKEN_SAVER, ...value };
  const opus = opusWorkers(agents);
  return (
    <Section title={t("tokens.title")}>
      <p className="muted small">{t("tokens.subtitle")}</p>
      <label className="checkbox recovery-switch">
        <input type="checkbox" checked={current.lazyWake} onChange={(e) => onChange({ ...current, lazyWake: e.target.checked })} />
        <span>
          {t("tokens.lazyWake")}
          <span className="field-hint">{t("tokens.lazyWakeHint")}</span>
        </span>
      </label>
      <label className="field">
        <span>{t("tokens.fresh")}</span>
        <select
          value={current.freshSessionAboveTokens}
          onChange={(e) => onChange({ ...current, freshSessionAboveTokens: Number(e.target.value) })}
        >
          {THRESHOLDS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? t("tokens.never") : t("tokens.k", { count: n / 1000 })}
            </option>
          ))}
        </select>
        <span className="field-hint">{t("tokens.freshHint")}</span>
      </label>
      {agents.length > 0 && (
        <table className="table small" data-testid="token-agents">
          <thead>
            <tr>
              <th>{t("tokens.agentsTitle")}</th>
              <th>{t("tokens.context")}</th>
              <th>{t("tokens.next")}</th>
            </tr>
          </thead>
          <tbody>
            {agents
              .filter((a) => a.status !== "retired")
              .map((a) => {
                const next = nextStart(a, current);
                return (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td className="mono">{a.contextTokens ? t("tokens.k", { count: Math.round(a.contextTokens / 1000) }) : t("tokens.unknown")}</td>
                    <td>{next === "fresh" ? t("tokens.freshNext") : next === "resume" ? t("tokens.resume") : t("tokens.noSession")}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}
      {opus > 0 && <p className="notice notice-warn small">{t("tokens.opusHint", { count: opus })}</p>}
    </Section>
  );
}
