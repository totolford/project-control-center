// Skill Market: skills and plugins that can be installed, from identifiable
// real sources (Claude Code marketplaces, NEXUS catalog, GitHub), distinct
// from the installed Skills view. Nothing is installed without the user.

import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Globe, RefreshCw, Search, Settings2, Store, X } from "lucide-react";
import { api } from "../../lib/api";
import { attempt, toast } from "../../lib/toast";
import type { CliRun } from "../../lib/types";
import { useStore } from "../../store";
import { useRightContext } from "../../state/context";
import { EmptyState, Loading, PageHeader, Spinner } from "../../components/Common";
import { CliRunOutput } from "../mcp/CliRunOutput";
import { MarketCard } from "./MarketCard";
import { MARKET_CATEGORIES, shouldAutoRefresh, visibleEntries, type MarketCategory } from "./marketModel";
import { useMarket } from "./marketStore";
import { SourcesDialog } from "./SourcesDialog";
import "./market.css";

export function MarketView() {
  const { index, status, error, load, setIndex, hits, hitsQuery, setHits } = useMarket();
  const navigate = useStore((s) => s.navigate);
  const toolsVersion = useStore((s) => s.project?.toolsVersion ?? 0);
  const right = useRightContext((s) => s.right);
  const [category, setCategory] = useState<MarketCategory>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"refresh" | "marketplaces" | "search" | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [run, setRun] = useState<CliRun | null>(null);
  const [sources, setSources] = useState(false);
  const autoChecked = useRef(false);

  // Reload when skills or plugins change elsewhere (SkillChanged events).
  useEffect(() => {
    void load();
  }, [load, toolsVersion]);

  const refresh = async (updateMarketplaces: boolean) => {
    setBusy(updateMarketplaces ? "marketplaces" : "refresh");
    const r = await attempt(() => api.marketRefresh(updateMarketplaces));
    setBusy(null);
    if (!r) return;
    setIndex(r.index);
    setProblems(r.errors);
    setRun(r.marketplaceRun);
    await load();
    if (r.errors.length === 0) toast.success(updateMarketplaces ? "Marketplaces and signals refreshed" : "Signals refreshed");
  };

  // Periodic refresh (opt-in): GitHub stars and user repositories once a day, never marketplaces.
  useEffect(() => {
    if (!status || autoChecked.current) return;
    autoChecked.current = true;
    void api.marketSettings().then((settings) => {
      if (status.gh && shouldAutoRefresh(settings, status.lastRefresh, Date.now())) void refresh(false);
    }, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const searchGithub = async () => {
    setBusy("search");
    const r = await attempt(() => api.marketSearchGithub(query));
    setBusy(null);
    if (!r) return;
    setIndex(r.index);
    setHits(query, r.hits);
    setCategory("all");
    if (r.hits.length === 0) toast.info(`No SKILL.md found on GitHub for “${query}”.`);
  };

  // "New" is relative to when the index was loaded.
  const now = useMemo(() => Date.now(), [index]);
  const entries = index?.entries ?? [];
  const visible = useMemo(() => visibleEntries(entries, category, hits ? "" : query, now, hits), [entries, category, query, hits, now]);
  const counts = useMemo(() => {
    const out: Partial<Record<MarketCategory, number>> = {};
    for (const c of MARKET_CATEGORIES) out[c.id] = visibleEntries(entries, c.id, "", now).length;
    return out;
  }, [entries, now]);
  const selectedId = right.kind === "skill" ? right.marketId : undefined;

  return (
    <div className="page mk-page">
      <PageHeader
        title="Skill Market"
        subtitle="Skills and plugins from Claude Code marketplaces, the NEXUS catalog and GitHub. Analyzed from their real files before you install; nothing is installed automatically."
        actions={
          <>
            <button className="btn" onClick={() => navigate({ name: "skills" })} title="Installed skills (edit, test, enable)">
              <BookOpen size={14} /> Installed skills
            </button>
            <button className="btn" onClick={() => setSources(true)}>
              <Settings2 size={14} /> Sources
            </button>
            <button className="btn" onClick={() => void refresh(false)} disabled={busy !== null} title="Refresh GitHub stars and your repositories">
              {busy === "refresh" ? <Spinner size={12} /> : <RefreshCw size={14} />} Refresh
            </button>
            <button className="btn" onClick={() => void refresh(true)} disabled={busy !== null || !status?.claude} title="claude plugin marketplace update, then refresh">
              {busy === "marketplaces" ? <Spinner size={12} /> : <Store size={14} />} Update marketplaces
            </button>
          </>
        }
      />

      {status && !status.gh && (
        <div className="notice notice-warn">GitHub CLI (gh) not found: GitHub search, stars and standalone skill installs are unavailable. Marketplace plugins still work.</div>
      )}
      {status && !status.claude && <div className="notice notice-warn">Claude Code was not detected: marketplaces and plugins are unavailable.</div>}
      {error && <div className="notice notice-error">Market unavailable: {error}</div>}
      {problems.length > 0 && (
        <div className="notice notice-warn">
          <div className="grow">
            Some sources could not be refreshed:
            <ul>
              {problems.slice(0, 8).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setProblems([])}>
            <X size={14} />
          </button>
        </div>
      )}
      {run && run.exitCode !== 0 && <CliRunOutput run={run} />}

      <div className="mk-toolbar">
        <div className="tools-search mk-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (hits) setHits(null, null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim().length >= 2 && status?.gh) void searchGithub();
            }}
            placeholder="Filter, or press Enter to search GitHub"
            aria-label="Search skills"
          />
        </div>
        <button className="btn" onClick={() => void searchGithub()} disabled={busy !== null || query.trim().length < 2 || !status?.gh} title={status?.gh ? "GitHub code search for SKILL.md files" : "Needs the GitHub CLI (gh)"}>
          {busy === "search" ? <Spinner size={12} /> : <Globe size={14} />} Search GitHub
        </button>
        <span className="muted small">
          {index && (
            <>
              {index.signalsFetchedAt ? `Stars as of ${index.signalsFetchedAt.slice(0, 16).replace("T", " ")}` : "Stars not fetched yet (Refresh)"}
            </>
          )}
        </span>
      </div>

      <div className="mk-categories" role="group" aria-label="Categories">
        {MARKET_CATEGORIES.map((c) => (
          <button key={c.id} className={`mk-cat${category === c.id ? " active" : ""}`} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
            {c.label} <span className="mk-cat-count">{counts[c.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {hits && (
        <div className="notice">
          GitHub results for “{hitsQuery}”: {hits.size} skill folder(s), merged with entries already known. Results are cached with their date.
          <button className="btn btn-sm" onClick={() => setHits(null, null)}>
            Show everything
          </button>
        </div>
      )}

      {!index && !error ? (
        <Loading text="Reading marketplaces, catalog and skills…" />
      ) : visible.length === 0 ? (
        <EmptyState icon={<Store size={22} />} title="Nothing here">
          {category === "new"
            ? "No entry has a real update date in the last 60 days."
            : category === "popular"
              ? "No entry has a real popularity signal yet: Refresh fetches GitHub stars."
              : "No entry matches. Try Search GitHub."}
        </EmptyState>
      ) : (
        <div className="mk-grid">
          {visible.map((e) => (
            <MarketCard key={e.id} entry={e} selected={e.id === selectedId} />
          ))}
        </div>
      )}

      {sources && <SourcesDialog onClose={() => setSources(false)} />}
    </div>
  );
}
