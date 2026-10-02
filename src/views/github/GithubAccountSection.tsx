import { Check, ExternalLink, LogIn, RefreshCw, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "../../lib/api";
import { run } from "../../lib/toast";
import type { GithubAccount, GithubStatus } from "../../lib/types";
import { githubSignIn } from "../../state/opsActions";
import { useAgents, useConnections, useStore } from "../../store";
import { Section, Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { CONNECTION_STATUS } from "../../lib/labels";
import { GITHUB_CAPS, accountState, agentGithubAccess } from "./githubModel";

const ACCESS_TONE = { deny: "grey", ask: "amber", allow: "green" } as const;

function Abilities({ account }: { account: GithubAccount }) {
  return (
    <table className="table compact-table">
      <thead>
        <tr>
          <th>Action</th>
          <th>Token</th>
          <th>Requires scope</th>
        </tr>
      </thead>
      <tbody>
        {account.abilities.map((a) => (
          <tr key={a.action}>
            <td>{a.action}</td>
            <td>{a.allowedByToken ? <Check size={13} className="tone-green-fg" aria-label="allowed" /> : <X size={13} className="tone-red-fg" aria-label="not allowed" />}</td>
            <td className="mono small">{a.requires}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** How NEXUS agents can use GitHub: effective github_* capabilities and the project's GitHub connections. */
function AgentUsage() {
  const agents = useAgents();
  const connections = useConnections().filter((c) => c.kind === "github");
  const autonomy = useStore((s) => s.project?.settings.autonomy);
  const navigate = useStore((s) => s.navigate);
  const rows = agentGithubAccess(agents, autonomy?.unlocked ? autonomy.unlockedPermissions : null);
  return (
    <div>
      <div className="row">
        <div className="section-label grow">NEXUS agents</div>
        <button className="link-btn small" onClick={() => navigate({ name: "capabilities" })}>
          Capabilities matrix
        </button>
      </div>
      {autonomy?.unlocked && <div className="tiny tone-amber-fg">CLAUDE UNLOCKED: the unlocked permissions apply to every agent.</div>}
      <table className="table compact-table">
        <thead>
          <tr>
            <th>Agent</th>
            {GITHUB_CAPS.map((c) => (
              <th key={c}>{c.replace("github_", "")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              {r.access.map((a, i) => (
                <td key={i}>
                  <Chip tone={ACCESS_TONE[a]}>{a}</Chip>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-label">GitHub connection of the project</div>
      {connections.length === 0 ? (
        <div className="muted small">
          None. Agents reach GitHub through <code>gh</code> with their github_* capabilities;{" "}
          <button className="link-btn" onClick={() => navigate({ name: "connections" })}>
            add a GitHub connection
          </button>{" "}
          to grant it explicitly.
        </div>
      ) : (
        connections.map((c) => (
          <div key={c.id} className="row small">
            <Chip tone={CONNECTION_STATUS[c.status].tone}>{CONNECTION_STATUS[c.status].label}</Chip>
            <strong>{c.name}</strong>
            {!c.enabled && <span className="muted">disabled</span>}
            {c.statusDetail && <span className="muted ellipsis">{c.statusDetail}</span>}
          </div>
        ))
      )}
    </div>
  );
}

/** Account status ("each permission visible") and how NEXUS uses it. */
export function GithubAccountSection({
  status,
  account,
  accountError,
  loading,
  onReload,
}: {
  status: GithubStatus | null;
  account: GithubAccount | null;
  accountError: string | null;
  loading: boolean;
  onReload: () => void;
}) {
  const state = status ? accountState(status) : null;
  const reload = (
    <button className="btn btn-sm ghost" onClick={onReload} disabled={loading} aria-label="Refresh GitHub account">
      {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
    </button>
  );
  return (
    <Section title="Account" actions={reload}>
      <div className="grid-2">
        <div>
          {!status && (loading ? <Spinner /> : <div className="muted">GitHub status unavailable.</div>)}
          {state === "not_installed" && (
            <div className="notice notice-warn">
              <span className="grow">
                GitHub CLI (<code>gh</code>) is not installed. NEXUS uses the official CLI for every GitHub action.
              </span>
              <button className="btn btn-sm" onClick={() => void run(() => openUrl("https://cli.github.com"))}>
                <ExternalLink size={12} /> cli.github.com
              </button>
            </div>
          )}
          {state === "not_signed_in" && (
            <div className="gh-conn">
              <span className="gh-dot off">○</span> <strong>Not connected</strong>
              <button className="btn btn-sm primary" onClick={() => void githubSignIn()}>
                <LogIn size={12} /> Connect GitHub
              </button>
              <div className="muted small">Opens the official device sign-in (gh auth login --web) in the Terminal view. Refresh here when it is done.</div>
            </div>
          )}
          {state === "signed_in" && (
            <>
              <div className="gh-conn">
                <span className="gh-dot on">●</span> <strong>Connected</strong>
                {account && (
                  <>
                    <span className="mono">{account.login}</span>
                    {account.name && <span className="muted">{account.name}</span>}
                    {account.url && (
                      <button className="icon-btn" onClick={() => void run(() => openUrl(account.url!))} aria-label="Open profile">
                        <ExternalLink size={12} />
                      </button>
                    )}
                  </>
                )}
              </div>
              {accountError && <div className="notice notice-error small">Account details unavailable: {accountError}</div>}
              {account && (
                <>
                  <dl className="kv kv-tight">
                    <dt>Organizations</dt>
                    <dd>{account.organizations.length > 0 ? account.organizations.join(", ") : "none"}</dd>
                    <dt>Token scopes</dt>
                    <dd className="mono small">{account.scopes.length > 0 ? account.scopes.join(", ") : "none reported"}</dd>
                    <dt>Git protocol</dt>
                    <dd className="mono">{account.gitProtocol ?? "unknown"}</dd>
                  </dl>
                  <Abilities account={account} />
                </>
              )}
            </>
          )}
          {status?.detail && <div className="muted small">{status.detail}</div>}
        </div>
        <AgentUsage />
      </div>
    </Section>
  );
}

/** Loads gh status, then the account when signed in. */
export async function loadGithubAccount(): Promise<{ status: GithubStatus; account: GithubAccount | null; accountError: string | null }> {
  const status = await api.githubStatus();
  if (!status.cliInstalled || !status.authenticated) return { status, account: null, accountError: null };
  try {
    return { status, account: await api.githubAccount(), accountError: null };
  } catch (e) {
    return { status, account: null, accountError: errorMessage(e) };
  }
}
