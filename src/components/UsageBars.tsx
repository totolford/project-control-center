import { memo } from "react";
import { contextUsage, percentRatio, rateLimits } from "../lib/claudeEnv";
import { formatDateTime, formatRelative } from "../lib/format";
import type { ClaudeEnvironment } from "../lib/types";
import { ProgressBar } from "./ProgressBar";
import { t, useT } from "../i18n";

function resetText(iso: string | null): string {
  if (!iso) return t("comp.usage.resetUnknown");
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return t("comp.usage.resetsAt", { at: iso });
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return t("comp.usage.wasReset", { when: formatRelative(iso) });
  const h = Math.floor(mins / 60);
  return t("comp.usage.resetsIn", { duration: h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`, at: formatDateTime(iso) });
}

/** Subscription rate-limit windows as reported by Claude Code (usage.rate_limits). */
export const RateLimitBars = memo(function RateLimitBars({ env }: { env: ClaudeEnvironment | null }) {
  const t = useT();
  if (!env) return <div className="muted small">{t("comp.usage.notLoaded")}</div>;
  const limits = rateLimits(env.usage);
  if (limits.length === 0) {
    return <div className="muted small">{env.usage ? t("comp.usage.notExposed") : t("comp.usage.noUsage")}</div>;
  }
  return (
    <div className="usage-bars">
      {limits.map((l) => (
        <div key={l.key} className="usage-bar" title={resetText(l.resetsAt)}>
          <div className="small">{l.label}</div>
          <ProgressBar value={percentRatio(l.percent)} />
          <div className="muted tiny">{resetText(l.resetsAt)}</div>
        </div>
      ))}
    </div>
  );
});

/** Context window usage of a fresh session in this project (get_context_usage). */
export const ContextBar = memo(function ContextBar({ env, details }: { env: ClaudeEnvironment | null; details?: boolean }) {
  const t = useT();
  if (!env) return <div className="muted small">{t("comp.usage.notLoaded")}</div>;
  const ctx = contextUsage(env.context);
  if (!ctx) return <div className="muted small">{t("comp.usage.noContext")}</div>;
  const tokens = ctx.totalTokens !== null && ctx.maxTokens !== null ? t("comp.usage.tokensOf", { used: ctx.totalTokens, max: ctx.maxTokens }) : "—";
  return (
    <div className="usage-bar">
      <div className="small">{t("comp.usage.fresh")}</div>
      <ProgressBar value={percentRatio(ctx.percent)} label={ctx.percent === null ? "—" : undefined} />
      <div className="muted tiny">{tokens}</div>
      {details && ctx.categories.length > 0 && (
        <table className="table compact-table">
          <thead>
            <tr>
              <th>{t("comp.usage.category")}</th>
              <th className="num">{t("comp.usage.tokens")}</th>
            </tr>
          </thead>
          <tbody>
            {ctx.categories.map((c, i) => (
              <tr key={`${c.name}-${i}`}>
                <td>{c.name}</td>
                <td className="num mono">{c.tokens === null ? "—" : t.manager.formatNumber(c.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});
