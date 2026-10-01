import { useState } from "react";
import { Eye, EyeOff, LogIn, RefreshCw, TriangleAlert } from "lucide-react";
import { isObj, maskAccount } from "../../lib/claudeEnv";
import { formatDateTime } from "../../lib/format";
import { useClaudeEnv } from "../../state/claude";
import { openClaudeInTerminal } from "../../terminal/openInTerminal";
import { Loading, PageHeader, Section, Spinner } from "../../components/Common";
import { ContextBar, RateLimitBars } from "../../components/UsageBars";
import { Fields, InventorySection, ProcessesSection, SessionSection } from "./ClaudeSections";

/** Everything the installed Claude Code reports about itself, the account and its limits. */
export function ClaudeOverview() {
  const { env, loading, error, refresh } = useClaudeEnv();
  const [revealAccount, setRevealAccount] = useState(false);
  const cli = env?.cli;
  return (
    <div className="page">
      <PageHeader
        title="Claude Code"
        subtitle={env ? `Captured ${formatDateTime(env.capturedAt)} from one short control session (no model call).` : "Asks the installed Claude Code; takes a few seconds."}
        actions={
          <button className="btn" onClick={refresh} disabled={loading}>
            {loading ? <Spinner size={12} /> : <RefreshCw size={13} />} Refresh
          </button>
        }
      />
      {error && <div className="notice notice-error">{error}</div>}
      {env && env.unavailable.length > 0 && (
        <div className="notice notice-warn">
          <TriangleAlert size={14} />
          <div>
            <strong>Unavailable — Claude Code did not answer:</strong>
            <ul className="bullet-list">
              {env.unavailable.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {!env ? (
        loading ? <Loading text="Asking Claude Code…" /> : null
      ) : (
        <>
          <div className="grid-2">
            <Section title="Installation & authentication">
              <dl className="kv">
                <dt>Version</dt>
                <dd className="mono">{cli?.version ?? "—"}</dd>
                <dt>Path</dt>
                <dd className="mono small">{cli?.path ?? "—"}</dd>
                <dt>Logged in</dt>
                <dd>{cli?.loggedIn === null ? "unknown" : cli?.loggedIn ? "yes" : "no"}</dd>
                <dt>Auth method</dt>
                <dd>{cli?.authMethod ?? "—"}</dd>
                <dt>Subscription</dt>
                <dd>{cli?.subscription ?? "—"}</dd>
              </dl>
              {cli?.loggedIn === false && (
                <button className="btn" onClick={() => void openClaudeInTerminal(["auth", "login"], cli.path)}>
                  <LogIn size={13} /> Log in (claude auth login in Raw Terminal)
                </button>
              )}
            </Section>
            <Section title="Account (shown locally only)">
              <button className="btn btn-sm" onClick={() => setRevealAccount((r) => !r)}>
                {revealAccount ? <EyeOff size={12} /> : <Eye size={12} />} {revealAccount ? "Hide e-mail" : "Show e-mail"}
              </button>
              <Fields value={revealAccount ? env.account : maskAccount(env.account)} empty="Not reported by Claude Code" />
            </Section>
          </div>
          <div className="grid-2">
            <Section title="Context usage of a fresh session">
              <ContextBar env={env} details />
            </Section>
            <Section title="Rate limits">
              <RateLimitBars env={env} />
            </Section>
          </div>
          <div className="grid-2">
            <Section title="Session usage">
              <Fields value={isObj(env.usage) ? env.usage.session : null} empty="Not reported by Claude Code" />
            </Section>
            <SessionSection env={env} />
          </div>
          <div className="grid-2">
            <ProcessesSection />
            <InventorySection env={env} />
          </div>
        </>
      )}
    </div>
  );
}
