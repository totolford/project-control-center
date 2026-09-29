import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "../../lib/api";
import { run } from "../../lib/toast";
import type { GithubOverview, GithubStatus } from "../../lib/types";
import { Section, Spinner } from "../../components/Common";

/** GitHub items come from `gh` JSON; only well-known fields are read, defensively. */
interface GhItem {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  headRefName?: string;
  author?: { login?: string };
}

function asItems(list: unknown[]): GhItem[] {
  return list.filter((x): x is GhItem => typeof x === "object" && x !== null);
}

function ItemList({ items, empty }: { items: GhItem[]; empty: string }) {
  if (items.length === 0) return <div className="muted small">{empty}</div>;
  return (
    <ul className="gh-list">
      {items.map((it, i) => (
        <li key={it.number ?? i}>
          <span className="muted mono">#{it.number ?? "?"}</span>
          <span className="grow">{it.title ?? "(untitled)"}</span>
          {it.headRefName && <code className="small">{it.headRefName}</code>}
          {it.author?.login && <span className="muted small">{it.author.login}</span>}
          {it.url && (
            <button className="icon-btn" onClick={() => void run(() => openUrl(it.url!))} aria-label="Open on GitHub">
              <ExternalLink size={12} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** GitHub status and repository overview. `bare` renders without the page Section (for workspace panels). */
export function GithubPanel({ bare }: { bare?: boolean }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [overview, setOverview] = useState<GithubOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.githubStatus();
      setStatus(s);
      setOverview(s.authenticated && s.repo ? await api.githubOverview() : null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = (
    <button className="btn ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh GitHub">
      {loading ? <Spinner size={12} /> : <RefreshCw size={13} />}
    </button>
  );
  const content = (
    <>
      {error && <div className="notice notice-error">{error}</div>}
      {status && (
        <div className="gh-status">
          {!status.cliInstalled ? (
            <span>
              GitHub CLI (<code>gh</code>) is not installed.
            </span>
          ) : !status.authenticated ? (
            <span>
              Not logged in. Run <code>gh auth login</code> in a terminal.
            </span>
          ) : (
            <span>
              Logged in as <strong>{status.account ?? "unknown"}</strong>
              {status.repo ? (
                <>
                  {" "}
                  · repo <code>{status.repo}</code>
                </>
              ) : (
                " · no GitHub remote detected"
              )}
            </span>
          )}
          {status.detail && <div className="muted small">{status.detail}</div>}
        </div>
      )}
      {overview && (
        <div className="gh-overview">
          <div className="row">
            <strong>{overview.repo}</strong>
            {overview.visibility && <span className="chip tone-grey">{overview.visibility.toLowerCase()}</span>}
            {overview.defaultBranch && <span className="muted small">default: {overview.defaultBranch}</span>}
            {overview.url && (
              <button className="link-btn" onClick={() => void run(() => openUrl(overview.url!))}>
                <ExternalLink size={12} /> Open
              </button>
            )}
          </div>
          {overview.description && <div className="muted">{overview.description}</div>}
          <div className="grid-3">
            <div>
              <div className="section-label">Pull requests ({overview.pullRequests.length})</div>
              <ItemList items={asItems(overview.pullRequests)} empty="No open pull requests." />
            </div>
            <div>
              <div className="section-label">Issues ({overview.issues.length})</div>
              <ItemList items={asItems(overview.issues)} empty="No open issues." />
            </div>
            <div>
              <div className="section-label">Branches ({overview.branches.length})</div>
              <ul className="gh-list">
                {overview.branches.map((b) => (
                  <li key={b}>
                    <code>{b}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  );
  if (bare) {
    return (
      <div className="panel-scroll pad-sm">
        <div className="row-end">{refresh}</div>
        {content}
      </div>
    );
  }
  return (
    <Section title="GitHub" actions={refresh}>
      {content}
    </Section>
  );
}
