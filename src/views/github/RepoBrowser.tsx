import { useEffect, useState } from "react";
import { Lock, Search } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import { Loading } from "../../components/Common";
import { ownerOptions, repoRow, type RepoRow } from "./githubModel";
import type { GithubAccount } from "../../lib/types";

/** Search the signed-in account's (or an organization's) repositories through gh. */
export function RepoBrowser({ account, selected, onSelect }: { account: GithubAccount; selected: string | null; onSelect: (repo: string) => void }) {
  const owners = ownerOptions(account);
  const [owner, setOwner] = useState(owners[0] ?? "");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [rows, setRows] = useState<RepoRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    api
      .githubRepositories(owner || null, submitted.trim() || null)
      .then((list) => !cancelled && setRows(list.map(repoRow).filter((r): r is RepoRow => r !== null)))
      .catch((e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [owner, submitted]);

  return (
    <div className="gh-browser">
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query);
        }}
      >
        <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner">
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" />
        <button className="btn btn-sm" type="submit">
          <Search size={12} /> Search
        </button>
      </form>
      {error && <div className="notice notice-error small">{error}</div>}
      <div className="gh-repo-list">
        {rows === null && <Loading />}
        {rows?.length === 0 && !error && <div className="muted small pad">No repository found.</div>}
        {rows?.map((r) => (
          <button key={r.fullName} className={`gh-repo${selected === r.fullName ? " selected" : ""}`} onClick={() => onSelect(r.fullName)}>
            <span className="row">
              <strong className="ellipsis">{r.name}</strong>
              {r.visibility !== "public" && <Lock size={11} className="muted" aria-label={r.visibility} />}
              <span className="chip tone-grey">{r.visibility}</span>
              {r.fork && <span className="chip tone-dim">fork</span>}
              <span className="spacer" />
              {r.language && <span className="muted small">{r.language}</span>}
              <span className="muted small">{formatRelative(r.updatedAt)}</span>
            </span>
            {r.description && <span className="muted small ellipsis">{r.description}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
