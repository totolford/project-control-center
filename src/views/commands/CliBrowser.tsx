import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Star } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { categories, commandKey, commandLabel, filterCommands, flattenCommands, isInteractive, isMutating } from "../../lib/cliArgs";
import { isStringList, pushRecent, readPref, writePref } from "../../lib/prefs";
import type { CliCommand } from "../../lib/types";
import { Loading, Spinner } from "../../components/Common";
import { CommandDetail } from "./CommandDetail";

function useCommandTree() {
  const [root, setRoot] = useState<CliCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setRoot(await api.claudeCommandTree(refresh));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(false);
  }, [load]);
  return { root, error, loading, reload: () => void load(true) };
}

function useStoredList(key: string) {
  const [list, setList] = useState<string[]>(() => readPref(key, [], isStringList));
  const update = (next: string[]) => {
    setList(next);
    writePref(key, next);
  };
  return [list, update] as const;
}

/** Claude Code CLI command tree with search, categories, favorites and history. */
export function CliBrowser({ exe }: { exe: string | null }) {
  const { root, error, loading, reload } = useCommandTree();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState("");
  const [favorites, setFavorites] = useStoredList("cliFavorites");
  const [history, setHistory] = useStoredList("cliHistory");
  const all = useMemo(() => (root ? flattenCommands(root) : []), [root]);
  const shown = useMemo(() => filterCommands(all, query, category), [all, query, category]);
  const current = all.find((c) => commandKey(c) === selected) ?? all[0];
  const byKey = (keys: string[]) => keys.map((k) => all.find((c) => commandKey(c) === k)).filter((c): c is CliCommand => Boolean(c));

  if (!root) return loading ? <Loading text="Reading claude --help…" /> : <div className="notice notice-error">Command tree unavailable: {error ?? "no answer"}</div>;

  const item = (c: CliCommand) => (
    <button key={commandKey(c)} className={`cmd-row${current && commandKey(c) === commandKey(current) ? " active" : ""}`} onClick={() => setSelected(commandKey(c))} style={{ paddingLeft: 8 + c.path.length * 10 }}>
      <span className="mono ellipsis grow">{commandLabel(c)}</span>
      {isMutating(c) && <span className="dot tone-amber" title="Changes configuration" />}
      {isInteractive(c) && <span className="tiny muted">TUI</span>}
    </button>
  );

  return (
    <div className="cmd-center">
      <div className="cmd-side">
        <div className="filters">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search commands and flags" aria-label="Search commands" className="grow" />
          <button className="icon-btn" onClick={reload} disabled={loading} title="Re-read the help of the installed version" aria-label="Refresh">
            {loading ? <Spinner size={12} /> : <RefreshCw size={13} />}
          </button>
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories(all).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="cmd-list-scroll">
          {favorites.length > 0 && !query && (
            <>
              <div className="section-label">
                <Star size={11} /> Favorites
              </div>
              {byKey(favorites).map(item)}
            </>
          )}
          {history.length > 0 && !query && (
            <>
              <div className="section-label">Recent runs</div>
              {byKey(history.slice(0, 6)).map(item)}
            </>
          )}
          <div className="section-label">Commands ({shown.length})</div>
          {shown.map(item)}
        </div>
      </div>
      <div className="cmd-main">
        {current && (
          <CommandDetail
            command={current}
            exe={exe}
            favorite={favorites.includes(commandKey(current))}
            onToggleFavorite={() => {
              const k = commandKey(current);
              setFavorites(favorites.includes(k) ? favorites.filter((x) => x !== k) : [...favorites, k]);
            }}
            onRan={() => setHistory(pushRecent(history, commandKey(current)))}
          />
        )}
      </div>
    </div>
  );
}
