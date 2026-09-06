/**
 * Favorites — a set of paths, kept in localStorage.
 *
 * A star is a fact about a file the way a column count is a fact about the
 * grid: purely presentational, per-device, and cheap to lose. That is why this
 * is localStorage rather than a sidecar file on the card — a `.facet-favs`
 * beside every folder would turn one tap into disk writes and sync questions,
 * and the worst case of losing the set is re-tapping a few stars.
 *
 * Keyed by path, which means a renamed or moved file drops its star. Accepted:
 * tracking identity across renames needs content hashing, and a stale star on
 * a path that no longer exists is filtered out at read time by whoever joins
 * this set against the live scan.
 */

const KEY = "fct.phone.favs.v1";

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...(cache ?? [])]));
  } catch { /* private mode; stars just do not persist */ }
}

export function isFav(path: string): boolean {
  return load().has(path);
}

export function favPaths(): ReadonlySet<string> {
  return load();
}

/** Toggle. Returns the new state. */
export function toggleFav(path: string): boolean {
  const set = load();
  const now = !set.has(path);
  if (now) set.add(path);
  else set.delete(path);
  save();
  return now;
}

/** A file left the card (deleted, renamed): its star goes with it. */
export function dropFav(path: string): void {
  const set = load();
  if (set.delete(path)) save();
}
