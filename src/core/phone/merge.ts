/**
 * Merging a fast partial scan into an index that is already on screen, and
 * keeping what did not change *identical* -- not merely equal.
 *
 * Both halves exist for the same reason. The phone paints last launch's
 * index in the first frame, then a walk of the card lands some seconds later
 * and every day on screen is rebuilt from scratch, tiles and all, whether or
 * not anything in it changed. Under a cold open that was three seconds of
 * yesterday's roll followed by a full repaint to show one new screenshot. The
 * fix is in two parts: a small, fast pass over the folders new files actually
 * land in, merged here by path so today is right almost immediately; and day
 * sections that keep their object identity when their contents are the same,
 * so the grid can tell "this day is untouched" by one reference comparison
 * and leave its tiles alone.
 *
 * Pure functions, no DOM, so a harness can pin the rules down.
 */

import type { DaySection, GalleryItem } from "./gallery";

/** What `mergeHot` found out about the partial pass. */
export interface HotMerge {
  /** The merged list, newest first. The input array when nothing changed. */
  everything: readonly GalleryItem[];
  /** Files the pass found that the index did not have, or had with another mtime. */
  added: number;
  /** Indexed files the pass proved gone from a folder it fully covered. */
  removed: number;
}

/**
 * Fold a partial, newest-first scan of a few hot folders into the full index.
 *
 * The pass is capped per folder, so a file missing from it is only known to
 * be gone when it is *newer* than the oldest file the pass did return for
 * that folder -- inside the window the pass covered. Anything older is simply
 * beyond the cap and is left alone for the full walk to judge.
 *
 * Returns the same `everything` array (by reference) when the pass agrees
 * with the index, so the caller can skip the emit entirely.
 */
export function mergeHot(
  everything: readonly GalleryItem[],
  hot: readonly GalleryItem[],
): HotMerge {
  if (hot.length === 0) return { everything, added: 0, removed: 0 };

  const fresh = new Map<string, GalleryItem>();
  // Oldest mtime the pass returned per folder: the floor of its coverage.
  const floor = new Map<string, number>();
  for (const it of hot) {
    fresh.set(it.path, it);
    const m = it.modified ?? 0;
    const f = floor.get(it.folder);
    if (f === undefined || m < f) floor.set(it.folder, m);
  }

  let added = 0;
  let removed = 0;
  const kept: GalleryItem[] = [];
  for (const it of everything) {
    const now = fresh.get(it.path);
    if (now) {
      // Same file, same version: keep the *indexed* object so a day made of
      // unchanged files can be recognised as unchanged. A different mtime or
      // size means the file was rewritten and the fresh row wins.
      if (now.modified === it.modified && now.size === it.size) {
        fresh.delete(it.path);
        kept.push(it);
      }
      continue;
    }
    const f = floor.get(it.folder);
    if (f !== undefined && (it.modified ?? 0) >= f) {
      removed += 1;
      continue;
    }
    kept.push(it);
  }
  added = fresh.size;
  if (added === 0 && removed === 0) return { everything, added, removed };

  // Both lists are newest-first; one linear merge keeps them that way.
  const incoming = [...fresh.values()].sort((a, b) => (b.modified ?? -Infinity) - (a.modified ?? -Infinity));
  const out: GalleryItem[] = [];
  let i = 0;
  let j = 0;
  while (i < kept.length || j < incoming.length) {
    const a = kept[i];
    const b = incoming[j];
    if (a === undefined) { out.push(b as GalleryItem); j += 1; continue; }
    if (b === undefined) { out.push(a); i += 1; continue; }
    if ((b.modified ?? -Infinity) > (a.modified ?? -Infinity)) { out.push(b); j += 1; }
    else { out.push(a); i += 1; }
  }
  return { everything: out, added, removed };
}

/** What `mergeIndex` found out about the authoritative list. */
export interface IndexMerge {
  /** The merged list, newest first. The input array when nothing changed. */
  everything: readonly GalleryItem[];
  added: number;
  removed: number;
  /** Files present in both, but with another mtime, size or kind. */
  changed: number;
}

/**
 * Replace the index with an *authoritative* list -- the phone's MediaStore
 * plus whatever the walk found that MediaStore has not indexed -- while
 * keeping every unchanged file as the very object already on screen.
 *
 * Unlike `mergeHot` this list is complete: a file the index has that the list
 * does not is gone, full stop. Same identity rule, though, and the same
 * "same array back when nothing moved" promise, because the grid under the
 * user's finger decides whether to touch a day by reference alone.
 */
export function mergeIndex(
  everything: readonly GalleryItem[],
  authoritative: readonly GalleryItem[],
): IndexMerge {
  const current = new Map<string, GalleryItem>();
  for (const it of everything) current.set(it.path, it);

  let added = 0;
  let changed = 0;
  const out: GalleryItem[] = [];
  const seen = new Set<string>();
  for (const fresh of authoritative) {
    if (seen.has(fresh.path)) continue;
    seen.add(fresh.path);
    const old = current.get(fresh.path);
    if (old === undefined) {
      added += 1;
      out.push(fresh);
    } else if (old.modified === fresh.modified && old.size === fresh.size && old.kind === fresh.kind) {
      out.push(old);
    } else {
      changed += 1;
      out.push(fresh);
    }
  }
  const removed = everything.length - (out.length - added);
  out.sort((a, b) => (b.modified ?? -Infinity) - (a.modified ?? -Infinity));

  if (added === 0 && removed === 0 && changed === 0) {
    let same = out.length === everything.length;
    for (let i = 0; same && i < out.length; i += 1) same = out[i] === everything[i];
    if (same) return { everything, added, removed, changed };
  }
  return { everything: out, added, removed, changed };
}

/**
 * Hand back `next` with every section that matches one in `prev` -- same
 * key, same files in the same order, same versions -- replaced by the `prev`
 * object itself.
 *
 * A day's label is relative ("Today", "Yesterday") and is minted with the
 * section; a match therefore also requires the label to agree, so a section
 * built before midnight is never carried across it under a stale name.
 */
export function reuseDays(
  prev: readonly DaySection[],
  next: readonly DaySection[],
): DaySection[] {
  if (prev.length === 0) return [...next];
  const byKey = new Map<string, DaySection>();
  for (const d of prev) byKey.set(d.key, d);
  return next.map((d) => {
    const old = byKey.get(d.key);
    return old && sameSection(old, d) ? old : d;
  });
}

function sameSection(a: DaySection, b: DaySection): boolean {
  if (a.label !== b.label || a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i += 1) {
    const x = a.items[i];
    const y = b.items[i];
    if (x === undefined || y === undefined) return false;
    // Identity first: the merge above keeps unchanged objects, so this is
    // the common case and costs one comparison per file.
    if (x === y) continue;
    if (x.path !== y.path || x.modified !== y.modified || x.size !== y.size) return false;
  }
  return true;
}

/**
 * Where a horizontal page swipe should land when the finger lifts.
 *
 * `dx` is how far the strip has been dragged (positive = towards the previous
 * page), `vx` the release velocity in px/ms, `width` one page. A flick counts
 * even when the distance is short, because that is how every phone gallery
 * behaves and a swipe that has to travel a third of the screen feels stuck.
 * The result is clamped to the pages that exist: dragging past the first or
 * last picture always springs back.
 */
export function pageTarget(
  dx: number,
  vx: number,
  width: number,
  hasPrev: boolean,
  hasNext: boolean,
): -1 | 0 | 1 {
  const far = Math.abs(dx) > width * 0.3;
  const flick = Math.abs(vx) > 0.45 && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) > 12;
  if (!far && !flick) return 0;
  if (dx < 0) return hasNext ? 1 : 0;
  return hasPrev ? -1 : 0;
}

/**
 * Resistance at the ends of the roll: the strip follows the finger fully
 * while there is a page to reveal and at a third of the speed when there is
 * not, so the edge is felt rather than hit.
 */
export function stripOffset(dx: number, hasPrev: boolean, hasNext: boolean): number {
  if (dx > 0 && !hasPrev) return dx * 0.3;
  if (dx < 0 && !hasNext) return dx * 0.3;
  return dx;
}
