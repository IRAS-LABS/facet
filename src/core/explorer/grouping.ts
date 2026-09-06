/**
 * Grouping — the "Group by" half of Explorer's View tab.
 *
 * Sorting answers *what order*; grouping answers *what belongs together*, and
 * the two are independent: a folder grouped by kind is still sorted by name
 * inside each kind. So this file does not sort. It buckets, and the caller sorts
 * within the buckets with the sort key it already had. Folding the two into one
 * comparator was the first attempt and it collapsed the moment "group by size,
 * sort by name" was asked for — there is no single key that expresses that.
 *
 * A bucket has a `rank` as well as a label because the useful order for most of
 * these is not alphabetical. Grouped by date, "Today" comes before "Last week";
 * sorted by label it would come after "Earlier this year" and before
 * "Yesterday", which is a list nobody can read. The rank is the bucket's own
 * idea of where it sits, and the caller only chooses whether to walk it forwards
 * or backwards.
 *
 * Every bucketer is total. Entries arrive from a directory listing, which means
 * missing sizes, missing timestamps and names in scripts nobody planned for; a
 * bucketer that returned undefined for those would produce a group of files that
 * simply do not appear in the folder, which is the one failure a file manager
 * may never have.
 */

import type { FileEntry } from "./types";

export type GroupKey = "none" | "name" | "kind" | "size" | "modified";

export interface GroupDef {
  readonly id: GroupKey;
  /** What the menu calls it. */
  readonly label: string;
}

/** Menu order, and the order the View menu draws them in. */
export const GROUPS: readonly GroupDef[] = [
  { id: "none", label: "(None)" },
  { id: "name", label: "Name" },
  { id: "kind", label: "Type" },
  { id: "size", label: "Size" },
  { id: "modified", label: "Date modified" },
];

/**
 * Total, for the same reason `modes.parse` is: a group key arrives from a saved
 * per-folder rule this build did not necessarily write, and a folder that
 * refuses to open because it remembers a grouping that no longer exists is an
 * unopenable folder with no way to fix it from inside the app.
 */
export function isGroup(v: unknown): v is GroupKey {
  return typeof v === "string" && GROUPS.some((g) => g.id === v);
}

export function parseGroup(v: unknown, fallback: GroupKey = "none"): GroupKey {
  return isGroup(v) ? v : fallback;
}

/** One bucket's identity: what to print, and where it sits among its siblings. */
export interface Bucket {
  /** Stable across a re-list, so a collapsed group stays collapsed. */
  id: string;
  label: string;
  rank: number;
}

const KIND_LABEL: Record<string, string> = {
  folder: "Folders",
  image: "Pictures",
  video: "Videos",
  audio: "Music",
  document: "Documents",
  tabular: "Data",
  model3d: "3D models",
  archive: "Archives",
  code: "Code",
  binary: "Other",
};

/** Rank order for kind groups — folders first, the catch-all last. */
const KIND_RANK: readonly string[] = [
  "folder", "image", "video", "audio", "document",
  "tabular", "model3d", "archive", "code", "binary",
];

/**
 * Size bands, in bytes, smallest first. The boundaries are Explorer's, near
 * enough: they are chosen so that a folder of photographs does not land entirely
 * in one bucket, which is the only thing that would make the grouping useless.
 */
const SIZE_BANDS: ReadonlyArray<readonly [number, string]> = [
  [0, "Empty"],
  [16 * 1024, "Tiny"],
  [1024 * 1024, "Small"],
  [128 * 1024 * 1024, "Medium"],
  [1024 * 1024 * 1024, "Large"],
  [Number.POSITIVE_INFINITY, "Huge"],
];

const DAY = 86_400_000;

/** Combining marks, so "Ä" folds to "A" rather than falling through to Other. */
const MARKS = /[̀-ͯ]/g;

/**
 * Date bands, relative to *now*.
 *
 * `now` is a parameter rather than a `Date.now()` call inside the loop for two
 * reasons, and only one of them is testing. The other is that bucketing a large
 * folder is not instantaneous, and a run that crossed midnight partway through
 * would put two files modified one second apart into "Today" and "Yesterday".
 */
function dateBucket(ms: number | undefined, now: number): Bucket {
  if (ms === undefined || !Number.isFinite(ms)) {
    return { id: "d:none", label: "Unknown", rank: 99 };
  }
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const age = startOfToday - new Date(ms).setHours(0, 0, 0, 0);
  if (age <= 0) return { id: "d:0", label: "Today", rank: 0 };
  if (age <= DAY) return { id: "d:1", label: "Yesterday", rank: 1 };
  if (age <= 7 * DAY) return { id: "d:7", label: "Earlier this week", rank: 2 };
  if (age <= 14 * DAY) return { id: "d:14", label: "Last week", rank: 3 };
  if (age <= 31 * DAY) return { id: "d:31", label: "Earlier this month", rank: 4 };
  if (age <= 365 * DAY) return { id: "d:365", label: "Earlier this year", rank: 5 };
  return { id: "d:old", label: "A long time ago", rank: 6 };
}

/**
 * The first-letter bucket.
 *
 * Accents are folded rather than tested for with a naive `[A-Z]`: a folder of
 * files beginning with "Ä" or "É" grouped under "Other" is a folder where the
 * grouping has quietly given up. Anything that is still not a Latin letter after
 * folding gets one of two catch-alls, which is honest and — unlike a single
 * "Other" — tells you which kind of thing it was.
 */
function nameBucket(name: string): Bucket {
  const first = name.trim().charAt(0);
  if (first === "") return { id: "n:?", label: "Other", rank: 3 };
  if (/[0-9]/.test(first)) return { id: "n:#", label: "0 – 9", rank: 1 };
  const folded = first.normalize("NFD").replace(MARKS, "").toUpperCase();
  if (/^[A-Z]$/.test(folded)) return { id: `n:${folded}`, label: folded, rank: 2 };
  // Letters outside Latin keep their own group rather than being swept in with
  // the punctuation — they are still names, and there may be a great many.
  //
  // `\p{L}` and not "does upper-casing change it": the case trick recognises
  // Greek and Cyrillic and then files every Chinese, Japanese, Hebrew and
  // Arabic name under "Symbols", because those scripts have no case for
  // upper-casing to change. Ask whether it is a letter, which is the actual
  // question.
  if (/^\p{L}/u.test(folded)) return { id: `n:${folded}`, label: folded, rank: 2 };
  return { id: "n:!", label: "Symbols", rank: 0 };
}

/** Which bucket an entry falls in, for a given grouping. */
export function bucketOf(entry: FileEntry, key: GroupKey, now: number): Bucket {
  switch (key) {
    case "name":
      return nameBucket(entry.name);
    case "kind": {
      const rank = KIND_RANK.indexOf(entry.kind);
      return {
        id: `k:${entry.kind}`,
        label: KIND_LABEL[entry.kind] ?? entry.kind,
        rank: rank < 0 ? KIND_RANK.length : rank,
      };
    }
    case "size": {
      // A folder has no size worth banding — Explorer does not walk every child
      // to find one either, and filing every folder under "Empty" would be a lie.
      if (entry.kind === "folder") return { id: "s:dir", label: "Folders", rank: -1 };
      const size = entry.size ?? 0;
      for (let i = 0; i < SIZE_BANDS.length; i++) {
        const band = SIZE_BANDS[i]!;
        if (size <= band[0] || i === SIZE_BANDS.length - 1) {
          return { id: `s:${i}`, label: band[1], rank: i };
        }
      }
      return { id: "s:?", label: "Unknown", rank: 99 };
    }
    case "modified":
      return dateBucket(entry.modified, now);
    case "none":
    default:
      return { id: "", label: "", rank: 0 };
  }
}

export interface Group {
  bucket: Bucket;
  entries: FileEntry[];
}

/**
 * Split an already-sorted list into groups, keeping the order within each.
 *
 * The input must already be sorted, and this must be a *stable* partition, or
 * the sort the caller just performed is thrown away inside every bucket. That is
 * why it is a single pass into a `Map` rather than a sort by rank: a `Map`
 * preserves insertion order, so pushing in list order means each bucket comes
 * out in list order for free.
 *
 * `descending` reverses the *bucket* order only. Grouped by date and sorted
 * newest-first, "Today" belongs at the top; the headers have to follow the arrow
 * or the list reads as though the sort did not apply.
 */
export function groupEntries(
  entries: readonly FileEntry[],
  key: GroupKey,
  descending = false,
  now: number = Date.now(),
): Group[] {
  if (key === "none") return [];
  const map = new Map<string, Group>();
  for (const e of entries) {
    const bucket = bucketOf(e, key, now);
    const at = map.get(bucket.id);
    if (at) at.entries.push(e);
    else map.set(bucket.id, { bucket, entries: [e] });
  }
  const out = [...map.values()];
  // Rank first, label second. The tiebreak carries `name`, where every letter
  // shares rank 2 and the label *is* the order.
  out.sort(
    (a, b) =>
      a.bucket.rank - b.bucket.rank ||
      a.bucket.label.localeCompare(b.bucket.label, undefined, { numeric: true }),
  );
  return descending ? out.reverse() : out;
}

/**
 * The grouped order, as one list.
 *
 * The shell hands every view a single flat array of entries, and that is worth
 * keeping: the list virtualiser, the keyboard cursor, shift-ranges and the
 * selection all index into it, and a display order that disagreed with that
 * array would make shift-clicking select things that are not between the two
 * rows you clicked. So grouping reorders the array itself, and a view draws a
 * heading wherever the bucket changes from one entry to the next.
 *
 * Ungrouped, this returns the input untouched — including the same array, so
 * the common case costs nothing.
 */
export function groupedOrder(
  entries: FileEntry[],
  key: GroupKey,
  descending = false,
  now: number = Date.now(),
): FileEntry[] {
  if (key === "none") return entries;
  return groupEntries(entries, key, descending, now).flatMap((g) => g.entries);
}

/** Where a heading goes: the entry it sits above, and what it says. */
export interface Boundary {
  /** Index into the grouped array of the first entry under this heading. */
  index: number;
  label: string;
  /** How many entries the heading covers, for the count beside its name. */
  count: number;
}

/**
 * Where the headings go in an already-grouped array.
 *
 * Both views draw headings and neither of them should be finding the boundaries
 * itself: the list places them in row slots and the gallery in pixels, but
 * *where* a group starts is the same question in both, and two answers to it
 * would eventually be two different answers.
 *
 * `entries` must be in grouped order — the shell puts them there with
 * `groupedOrder`. This walks it once looking for the point where the bucket id
 * changes, so a bucket that appears twice becomes two headings, which is the
 * honest rendering of an array that is not grouped after all.
 *
 * `now` is taken by the caller for the same reason `groupEntries` takes it: a
 * pass that crossed midnight would call one file "Today" and the next
 * "Yesterday" and split a group nothing else split.
 */
export function groupBoundaries(
  entries: readonly FileEntry[],
  key: GroupKey,
  now: number = Date.now(),
): Boundary[] {
  if (key === "none") return [];
  const out: Boundary[] = [];
  let seen = "";
  for (let i = 0; i < entries.length; i++) {
    const bucket = bucketOf(entries[i]!, key, now);
    if (i === 0 || bucket.id !== seen) {
      seen = bucket.id;
      out.push({ index: i, label: bucket.label, count: 0 });
    }
    out[out.length - 1]!.count++;
  }
  return out;
}
