/**
 * Fuzzy match score of `query` in `text` (case-insensitive subsequence).
 * Higher is better; null when not all query characters appear in order.
 * Rewards contiguous runs and matches at word starts.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct + (direct === 0 || /\W/.test(t[direct - 1]) ? 200 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += found === prev + 1 ? 8 : 1;
    if (found === 0 || /\W/.test(t[found - 1])) score += 5;
    prev = found;
    ti = found + 1;
  }
  return score;
}

/** Items matching `query`, best first (stable for equal scores). */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, score: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; i: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}
