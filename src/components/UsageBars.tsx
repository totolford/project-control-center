import { memo } from "react";
import { contextUsage, percentRatio, rateLimits } from "../lib/claudeEnv";
import { formatDateTime, formatRelative } from "../lib/format";
import type { ClaudeEnvironment } from "../lib/types";
import { ProgressBar } from "./ProgressBar";

function resetText(iso: string | null): string {
  if (!iso) return "reset time not reported";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return `resets ${iso}`;
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return `reset ${formatRelative(iso)}`;
  const h = Math.floor(mins / 60);
  return `resets in ${h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`} (${formatDateTime(iso)})`;
}

/** Subscription rate-limit windows as reported by Claude Code (usage.rate_limits). */
export const RateLimitBars = memo(function RateLimitBars({ env }: { env: ClaudeEnvironment | null }) {
  if (!env) return <div className="muted small">Not loaded yet</div>;
  const limits = rateLimits(env.usage);
  if (limits.length === 0) {
    return <div className="muted small">{env.usage ? "Not exposed by Claude Code for this account" : "Unavailable (usage not answered)"}</div>;
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
  if (!env) return <div className="muted small">Not loaded yet</div>;
  const ctx = contextUsage(env.context);
  if (!ctx) return <div className="muted small">Unavailable (context usage not answered)</div>;
  const tokens = ctx.totalTokens !== null && ctx.maxTokens !== null ? `${ctx.totalTokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()} tokens` : "—";
  return (
    <div className="usage-bar">
      <div className="small">Fresh session</div>
      <ProgressBar value={percentRatio(ctx.percent)} label={ctx.percent === null ? "—" : undefined} />
      <div className="muted tiny">{tokens}</div>
      {details && ctx.categories.length > 0 && (
        <table className="table compact-table">
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {ctx.categories.map((c, i) => (
              <tr key={`${c.name}-${i}`}>
                <td>{c.name}</td>
                <td className="num mono">{c.tokens === null ? "—" : c.tokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});
