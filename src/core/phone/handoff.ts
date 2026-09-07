/**
 * Turning "Open with FACET" into something the shell can actually open.
 *
 * Android hands over a list of absolute paths (see `OpenBridge.kt` and
 * `openwith.rs`). The shell opens `FileEntry` objects, and a `FileEntry` is not
 * just a path -- it carries the kind, the size and the date the viewer, the
 * header and the sibling strip all read. So the paths have to be resolved
 * against the real directory before anything can be shown.
 *
 * All of that is here rather than in `shell.ts` for one reason: it is the part
 * with rules in it, and rules that live in a class that needs a WebView, a
 * MediaStore and a phone are rules that never get tested. Everything below is
 * a plain function over a `list` callback.
 *
 * Two behaviours worth stating outright, because they are choices and not
 * mechanics:
 *
 *  - **One file opens its whole folder.** Tapping a photo in another app and
 *    landing on a viewer that cannot swipe is the thing that makes a gallery
 *    feel like a dead end. The folder is listed, the tapped file is found in
 *    it, and swiping walks the album exactly as it would have from inside.
 *  - **A shared selection opens itself.** Twelve photos sent from the system
 *    gallery are twelve entries the user chose, possibly from twelve folders.
 *    Listing the first one's folder would silently throw the other eleven
 *    away, so the selection *is* the sibling set, in the order it arrived.
 */

import { extOf, kindForExt, type FileEntry } from "@core/explorer/types";

/** What the shell needs to show a hand-off: what to open, and what to swipe. */
export interface Handoff {
  entry: FileEntry;
  siblings: FileEntry[];
}

/** Just enough of a filesystem to resolve a path. */
export type ListDir = (path: string) => Promise<{ entries: FileEntry[] }>;

/**
 * Normalise a path for comparison.
 *
 * Android is the only platform this runs on today and it is all forward
 * slashes, but the paths come from another app's idea of the file: a trailing
 * slash, a doubled separator or a Windows-style one in a desktop test would
 * otherwise make an entry that is plainly the same file fail to match, and the
 * failure looks like "it opened the wrong thing".
 */
export function normPath(path: string): string {
  const flat = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return flat.length > 1 && flat.endsWith("/") ? flat.slice(0, -1) : flat;
}

/** The folder a path sits in. `/` for a path with no folder above it. */
export function dirOf(path: string): string {
  const p = normPath(path);
  const cut = p.lastIndexOf("/");
  if (cut < 0) return "";
  return cut === 0 ? "/" : p.slice(0, cut);
}

/** The last segment of a path. */
export function baseOf(path: string): string {
  const p = normPath(path);
  const cut = p.lastIndexOf("/");
  return cut < 0 ? p : p.slice(cut + 1);
}

/**
 * The paths worth acting on, in order, with duplicates and blanks gone.
 *
 * A share sheet can send the same file twice (one from the grid, one from the
 * clip data), and an empty string resolves to the current directory, which
 * would open the whole volume as though the user had asked for it.
 */
export function cleanPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const p = normPath(raw.trim());
    if (p === "" || p === "/") continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * A `FileEntry` built from a path alone.
 *
 * The fallback for a file the directory listing does not contain -- it was
 * deleted between the share and the poll, or it lives somewhere the listing
 * fails outright (an app's private cache, which is exactly where `OpenBridge`
 * puts a copied mail attachment). Opening it with no size and no date is worth
 * far more than not opening it: the viewer reads the bytes itself.
 */
export function entryFromPath(path: string): FileEntry {
  const p = normPath(path);
  const name = baseOf(p);
  const ext = extOf(name);
  return { path: p, name, kind: kindForExt(ext), ext };
}

/**
 * Resolve what Android handed over into something to open.
 *
 * Returns null only when there is nothing to open at all, which is the normal
 * case on every poll: an empty list in, null out, and the caller does nothing.
 *
 * A listing that throws is not an error here. The folder may be unreadable, or
 * may not exist because the file is a copy in the app's own cache; either way
 * the path itself is still openable, and refusing to open it because its
 * neighbours could not be counted would be the wrong trade.
 */
export async function resolveHandoff(
  paths: readonly string[],
  list: ListDir,
): Promise<Handoff | null> {
  const clean = cleanPaths(paths);
  const first = clean[0];
  if (first === undefined) return null;

  // A selection: the user picked these, so these are the set. Resolved against
  // their own folders where that is cheap -- one listing per distinct folder,
  // and a selection almost always comes from one.
  if (clean.length > 1) {
    const byDir = new Map<string, FileEntry[]>();
    for (const dir of new Set(clean.map(dirOf))) {
      byDir.set(dir, await entriesOf(dir, list));
    }
    const siblings = clean.map((p) => {
      const found = (byDir.get(dirOf(p)) ?? []).find((e) => normPath(e.path) === p);
      return found ?? entryFromPath(p);
    });
    // `first` is `clean[0]`, so `siblings[0]` exists by construction; the
    // check is for the type, not for the possibility.
    const entry = siblings[0] ?? entryFromPath(first);
    return { entry, siblings };
  }

  const siblings = await entriesOf(dirOf(first), list);
  const found = siblings.find((e) => normPath(e.path) === first);
  if (found) return { entry: found, siblings };
  // Not in its own folder: opened from somewhere the listing cannot reach, or
  // gone since the intent was sent. Open it alone rather than not at all.
  return { entry: entryFromPath(first), siblings: [] };
}

async function entriesOf(dir: string, list: ListDir): Promise<FileEntry[]> {
  if (dir === "") return [];
  try {
    const listing = await list(dir);
    return listing.entries.filter((e) => e.kind !== "folder");
  } catch {
    return [];
  }
}
