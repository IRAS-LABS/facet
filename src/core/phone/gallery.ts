/**
 * The gallery model — what "all my photos" means, and how it is grouped.
 *
 * This file holds no DOM. It turns one `scan_media` call into the two shapes
 * the phone shell draws: a date-grouped stream (the Photos tab) and a
 * folder-grouped set of albums (the Albums tab). Both come out of the same
 * scan, because scanning twice for two views of the same files would double the
 * only expensive thing the tab does.
 */

import { extOf, kindForExt, type FileEntry, type FileKind } from "@core/explorer/types";
import type { RawMediaHit, RawMediaRow, RawMediaScan, TauriFs } from "@core/explorer/tauri-fs";

/**
 * What counts as gallery material.
 *
 * Wider than what the WebView can paint: a .dng or a .heic belongs in the
 * gallery even when the tile has to fall back to a kind glyph, because a photo
 * you cannot see a preview of is still a photo you took, and hiding it makes
 * the app look like it lost your files. `thumbnail()` decides what can be
 * drawn; this decides what exists.
 */
export const PHOTO_EXTS = [
  "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "avifs", "jxl", "bmp",
  "heic", "heics", "heif", "svg",
  "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef", "srw",
] as const;

export const VIDEO_EXTS = [
  "mp4", "mkv", "mov", "webm", "avi", "m4v", "3gp", "3g2", "mts", "m2ts", "wmv", "flv", "f4v",
  "mpg", "mpeg", "m2v", "ogv", "vob", "divx", "insv",
] as const;

export const MEDIA_EXTS: readonly string[] = [...PHOTO_EXTS, ...VIDEO_EXTS];

/**
 * Everything else a person goes looking for by date: the download from
 * yesterday, the PDF from Tuesday. Mirrors the Files tab's categories, because
 * "the roll, but with my documents in it" is the same question those categories
 * answer, asked chronologically instead of by type.
 *
 * `ts` is deliberately absent even though MPEG-TS exists: on any card that has
 * ever held a project folder it is TypeScript, and one wrong kind in a roll
 * reads as corruption. Same reasoning as the kind filter in `scanGallery`.
 */
export const EXTRA_EXTS = [
  // documents
  "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "epub", "ppt", "pptx",
  "xls", "xlsx", "ods", "csv", "tsv", "json",
  // audio
  "mp3", "wav", "flac", "aac", "ogg", "opus", "m4a", "wma", "aiff", "amr", "mid",
  // installs and archives
  "apk", "apks", "xapk", "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso",
] as const;

export const ALL_EXTS: readonly string[] = [...MEDIA_EXTS, ...EXTRA_EXTS];

/**
 * Where to look, on a phone.
 *
 * `/sdcard` is deliberately not one entry. Scanning it whole reaches
 * `Android/media/**`, which on a busy phone is tens of thousands of directories
 * of app-private junk, and the walk spends its whole time budget there before
 * it reaches DCIM. Naming the folders people actually keep pictures in gets the
 * grid painted in well under a second; `Android/media` is then listed
 * explicitly, one level deeper, because that is where WhatsApp and Telegram
 * really put things and leaving them out is what makes a gallery feel wrong.
 */
export const ANDROID_MEDIA_ROOTS: readonly string[] = [
  "/sdcard/DCIM",
  "/sdcard/Pictures",
  "/sdcard/Movies",
  "/sdcard/Download",
  "/sdcard/Documents",
  "/sdcard/Snapchat",
  "/sdcard/Android/media/com.whatsapp/WhatsApp/Media",
  "/sdcard/Android/media/org.telegram.messenger/Telegram",
  "/sdcard/Android/media/com.instagram.android",
];

/**
 * The handful of folders worth looking in before anything else.
 *
 * The first pass used to be "the first three roots, three levels down", which
 * on this phone is forty directories -- `DCIM` alone has twenty-seven
 * subfolders, one per app that has ever saved a picture -- and forty
 * directories through Android's storage emulation is about two seconds. All of
 * it to fill a grid whose first screen is sixteen tiles, every one of which
 * came from the camera or a screenshot.
 *
 * So these are named outright and walked one level deep. Both spellings of
 * Screenshots are here because this device has both and neither is empty.
 * Anything missing is skipped in microseconds, and everything else in the
 * gallery arrives with the full walk a few seconds later.
 */
export const ANDROID_HOT_ROOTS: readonly string[] = [
  "/sdcard/DCIM/Camera",
  "/sdcard/DCIM/Screenshots",
  "/sdcard/Pictures/Screenshots",
  "/sdcard/DCIM/Screen recordings",
  "/sdcard/Download",
];

/** The desktop equivalent, so the phone shell is testable on a PC. */
export function desktopMediaRoots(home: string): readonly string[] {
  const h = home.replace(/\/+$/, "");
  return [`${h}/Pictures`, `${h}/Downloads`, `${h}/Videos`, `${h}/Desktop`, `${h}/Documents`];
}

/** A media file, plus the folder it came from. */
export interface GalleryItem extends FileEntry {
  folder: string;
  folderName: string;
}

/** One day's worth of the stream. */
export interface DaySection {
  /** Stable key — `YYYY-MM-DD` in local time, or `"undated"`. */
  key: string;
  /** "Today", "Yesterday", "Tuesday", "14 March", "14 March 2024". */
  label: string;
  items: GalleryItem[];
}

/** One album: every media file in a single folder. */
export interface Album {
  /** The folder path. Stable identity. */
  id: string;
  /** The display name — "Snapchat", not "Pictures/Snapchat". */
  name: string;
  /** Where it came from, shown small under the name when it is not obvious. */
  path: string;
  count: number;
  /** Newest item, used as the cover. */
  cover: GalleryItem | null;
  /** Newest mtime in the album — albums sort by recency, not alphabetically. */
  newest: number;
}

/**
 * Folder → the name a person would call it.
 *
 * Matched against the tail of the path, longest first, so
 * `.../WhatsApp/Media/WhatsApp Video` beats a bare `whatsapp`. Everything
 * unmatched keeps its own folder name, which is nearly always right — an app
 * that saves to `Pictures/Frobnicate` has told us what to call it.
 */
const KNOWN_FOLDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/dcim\/camera$/i, "Camera"],
  [/\/dcim\/screenshots$/i, "Screenshots"],
  [/\/pictures\/screenshots$/i, "Screenshots"],
  [/\/pictures\/screen recordings$/i, "Screen recordings"],
  [/\/dcim\/restored$/i, "Restored"],
  [/whatsapp[ /]*images$/i, "WhatsApp Images"],
  [/whatsapp[ /]*video$/i, "WhatsApp Video"],
  [/whatsapp[ /]*animated gifs$/i, "WhatsApp GIFs"],
  [/whatsapp[ /]*documents$/i, "WhatsApp Documents"],
  [/\/telegram[^/]*$/i, "Telegram"],
  [/\/(pictures|dcim)\/snapchat$/i, "Snapchat"],
  [/\/snapchat$/i, "Snapchat"],
  [/\/(pictures|dcim)\/instagram$/i, "Instagram"],
  [/\/instagram$/i, "Instagram"],
  [/\/(pictures|dcim)\/facebook$/i, "Facebook"],
  [/\/(pictures|dcim)\/twitter$/i, "Twitter"],
  [/\/(pictures|dcim)\/signal$/i, "Signal"],
  [/\/download$/i, "Downloads"],
  [/\/downloads$/i, "Downloads"],
  [/\/movies$/i, "Movies"],
  [/\/pictures$/i, "Pictures"],
  [/\/dcim$/i, "Camera"],
];

export function albumName(folder: string, fallback: string): string {
  for (const [re, name] of KNOWN_FOLDERS) {
    if (re.test(folder)) return name;
  }
  return fallback || folder;
}

/** Raw hit → the entry shape the rest of the app already understands. */
function toItem(hit: RawMediaHit): GalleryItem {
  const ext = extOf(hit.name);
  // `modified` is spread in only when it exists rather than set to `undefined`:
  // under `exactOptionalPropertyTypes` an explicit `undefined` is not the same
  // as an absent key, and the distinction is the one `byDay` relies on to file
  // undated items separately instead of guessing them into Today.
  return {
    path: hit.path,
    name: hit.name,
    kind: kindForExt(ext),
    ext,
    size: hit.size,
    ...(hit.modified === null ? {} : { modified: hit.modified }),
    folder: hit.folder,
    folderName: hit.folderName,
  };
}

/**
 * Run the scan and hand back items, newest first.
 *
 * Rust has already sorted by date, so this does not re-sort: the order arrives
 * correct and re-doing it on 20,000 entries would be pure cost. The scan asks
 * for everything — media plus documents — because the store carves one walk
 * into both the Photos roll and the everything roll, and walking the card
 * twice for two views of the same files would double the only expensive thing
 * the phone does. What this still drops is any entry whose kind came back as
 * `code` — an extension list can collide (a `.ts` is TypeScript far more often
 * than it is a MPEG transport stream, and `kindForExt` says so) and a roll
 * that shows source files has stopped being a roll.
 */
export async function scanGallery(
  fs: Pick<TauriFs, "scanMedia">,
  roots: readonly string[],
  opts: { limit?: number; budgetMs?: number; maxDepth?: number } = {},
): Promise<{ items: GalleryItem[]; trash: GalleryItem[]; truncated: boolean; dirsVisited: number }> {
  let raw: RawMediaScan;
  try {
    raw = await fs.scanMedia(roots, ALL_EXTS, {
      maxDepth: opts.maxDepth ?? 6,
      limit: opts.limit ?? 20000,
      // Generous, because this scan no longer blocks anything: it runs on the
      // blocking pool while the grid is already live off the quick scan, so the
      // only thing the budget decides is whether the deepest folders make it in
      // at all. Eight seconds silently lost six thousand photographs on a cold
      // cache -- a gallery quietly missing half the card, with nothing on screen
      // to say so.
      budgetMs: opts.budgetMs ?? 30000,
    });
  } catch {
    // A missing command (an older binary than this bundle) or a denied root is
    // an empty gallery with a message, not a broken tab.
    return { items: [], trash: [], truncated: false, dirsVisited: 0 };
  }

  const items = raw.hits
    .map(toItem)
    .filter((it) => it.kind !== "code");

  // `raw.trash` is what the same walk found inside `.facet-trash` folders —
  // guarded with `?? []` so a bundle running against an older binary degrades
  // to an empty trash rather than a TypeError in the one function every tab
  // waits on. Unlike the roll, trash keeps its `code` files: whatever was
  // deleted must be restorable, and a filter here would strand those files
  // with no way back short of a file manager.
  const trash = (raw.trash ?? []).map(toItem);

  return { items, trash, truncated: raw.truncated, dirsVisited: raw.dirsVisited };
}

/**
 * A row of the phone's MediaStore index, as a gallery item.
 *
 * Kind comes from the MIME type the system indexer decided on, and only then
 * from the extension -- so a picture a sync client saved as `IMG.JPG`, a WebP with
 * no extension at all, or a clip in a container the extension table has never
 * heard of all still count as media. Samsung Gallery shows them; so must this.
 *
 * The date is the capture time when the row has one and it is plausible,
 * otherwise the file's mtime, otherwise the moment the indexer first saw it.
 * That is the order the phone's own gallery groups by, and it is what makes a
 * photograph that arrived over a sync client today sit on the day it was taken
 * rather than on the day it landed.
 */
export function itemFromRow(row: RawMediaRow): GalleryItem | null {
  const path = canonicalPath(row.path);
  if (!path) return null;
  if (row.pending || row.trashed) return null;
  if (isHiddenPath(path)) return null;
  const cut = path.lastIndexOf("/");
  const name = cut >= 0 ? path.slice(cut + 1) : path;
  if (name.length === 0) return null;
  const folder = cut > 0 ? path.slice(0, cut) : "";
  const ext = extOf(name);
  const kind = rowKind(row, ext);
  const modified = rowDate(row);
  const item: GalleryItem = {
    path,
    name,
    kind,
    ext,
    size: row.size ?? 0,
    ...(modified === null ? {} : { modified }),
    folder,
    folderName: folder.slice(folder.lastIndexOf("/") + 1),
  };
  if (typeof row.width === "number" && row.width > 0) item.width = row.width;
  if (typeof row.height === "number" && row.height > 0) item.height = row.height;
  if (typeof row.duration === "number" && row.duration > 0) item.duration = row.duration;
  return item;
}

/**
 * Kind for an index row. MEDIA_TYPE_NONE (0) is the indexer saying "this file
 * is not media here" -- it sits under a `.nomedia` folder, or the scanner has
 * not classified it. Samsung Gallery shows none of those, so neither does the
 * roll: such a row is never image, video or audio whatever its MIME or
 * extension says, though it stays a plain file for Files and Search. A row the
 * indexer did call a picture or a clip counts even when its MIME is one this
 * app cannot decode -- parity with the phone's own gallery.
 */
function rowKind(row: RawMediaRow, ext: string): FileKind {
  if (row.mediaType === MEDIA_TYPE_NONE) {
    const k = kindForExt(ext);
    return k === "image" || k === "video" || k === "audio" ? "binary" : k;
  }
  // The indexer's verdict outranks the MIME string: a clip the scanner filed
  // as video with an `audio/mp4` MIME is on Samsung Gallery's roll, so it is
  // on this one. MIME and extension only speak when MEDIA_TYPE is silent.
  if (row.mediaType === MEDIA_TYPE_IMAGE) return "image";
  if (row.mediaType === MEDIA_TYPE_VIDEO) return "video";
  if (row.mediaType === MEDIA_TYPE_AUDIO) return "audio";
  return kindFromMime(row.mime, row.mediaType) ?? kindForExt(ext);
}

/**
 * A path with a dot-prefixed segment: WhatsApp's `.Statuses`, Samsung's
 * `Android/.Trash`, Google's `.gs`, any `.thumbnails`, or a file named `.N.jpg`.
 * Hidden on every platform, hidden in Samsung Gallery, hidden here -- in the
 * roll, in Files and in Search alike.
 */
export function isHiddenPath(path: string): boolean {
  for (const seg of path.split("/")) {
    if (seg.length > 1 && seg.startsWith(".")) return true;
  }
  return false;
}

/**
 * MediaStore reports the primary volume as `/storage/emulated/0`; every root
 * this app walks, every cached row and every trash folder says `/sdcard`. One
 * spelling, or the same photograph shows up twice.
 */
export function canonicalPath(p: string): string {
  const s = p.replace(/\\/g, "/");
  if (s.startsWith("/storage/emulated/0/")) return `/sdcard/${s.slice("/storage/emulated/0/".length)}`;
  if (s === "/storage/emulated/0") return "/sdcard";
  return s;
}

const MEDIA_TYPE_NONE = 0;
const MEDIA_TYPE_IMAGE = 1;
const MEDIA_TYPE_AUDIO = 2;
const MEDIA_TYPE_VIDEO = 3;

function kindFromMime(mime: string | undefined, mediaType: number | undefined): FileKind | null {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (mediaType === MEDIA_TYPE_IMAGE) return "image";
  if (mediaType === MEDIA_TYPE_VIDEO) return "video";
  if (mediaType === MEDIA_TYPE_AUDIO) return "audio";
  if (m === "application/pdf" || m.startsWith("text/") || m === "application/epub+zip") return "document";
  return null;
}

/** Roughly the year 2000 -- older capture dates are a camera with no clock. */
const OLDEST_PLAUSIBLE = 946_684_800_000;

function rowDate(row: RawMediaRow): number | null {
  const soon = Date.now() + 86_400_000;
  const taken = row.taken;
  if (typeof taken === "number" && taken > OLDEST_PLAUSIBLE && taken < soon) return taken;
  if (typeof row.modified === "number" && row.modified > 0) return row.modified;
  if (typeof row.added === "number" && row.added > 0) return row.added;
  return null;
}

/**
 * One line of the persisted index: `[path, size, mtime-or-null, kind?]`.
 *
 * The fourth slot is written only when the kind cannot be re-derived from the
 * extension -- a MediaStore row whose MIME said "picture" about a file with
 * an unusual or missing extension. Everything else stays three fields wide.
 */
export type CacheRow = readonly [string, number, number | null, FileKind?];

export function toCacheRow(it: GalleryItem): CacheRow {
  const derived = kindForExt(it.ext);
  return derived === it.kind
    ? [it.path, it.size ?? 0, it.modified ?? null]
    : [it.path, it.size ?? 0, it.modified ?? null, it.kind];
}

/**
 * The persisted index back into items.
 *
 * Only path, size and mtime are stored — name, folder and kind are all
 * derivable from the path, and deriving them keeps the cache at about a third
 * of the size, which matters because it lives in localStorage and the full
 * index can be twenty thousand rows. The derivations must agree with what the
 * Rust scan reports for the same file, or a cached launch and a scanned launch
 * would disagree about grouping; both sides define folder as "the path up to
 * the last slash" and folderName as its last segment.
 */
export function itemsFromCache(rows: readonly CacheRow[]): GalleryItem[] {
  const items: GalleryItem[] = [];
  for (const row of rows) {
    const [path, size, modified, kind] = row;
    if (typeof path !== "string" || path.length === 0) continue;
    const cut = path.lastIndexOf("/");
    const name = cut >= 0 ? path.slice(cut + 1) : path;
    const folder = cut > 0 ? path.slice(0, cut) : "";
    const ext = extOf(name);
    items.push({
      path,
      name,
      kind: typeof kind === "string" ? kind : kindForExt(ext),
      ext,
      size,
      ...(modified === null || modified === undefined ? {} : { modified }),
      folder,
      folderName: folder.slice(folder.lastIndexOf("/") + 1),
    });
  }
  return items;
}

/** Local-midnight key for an epoch-ms timestamp. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * What to call a day.
 *
 * The near past gets words and the far past gets a date, which is how people
 * actually refer to their own photos. The one-week window for weekday names is
 * the point past which "Tuesday" stops being useful and starts being a riddle.
 */
function dayLabel(ms: number, now: number): string {
  const then = new Date(ms);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.floor((midnight - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86_400_000);

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  if (then.getFullYear() === today.getFullYear()) {
    return then.toLocaleDateString(undefined, { day: "numeric", month: "long" });
  }
  return then.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Items → day sections, preserving the newest-first order.
 *
 * Undated files land in one section at the end rather than being dropped or
 * being given "now" as a guess. A file with no mtime is rare and is usually
 * something restored or copied oddly, and putting it at the top of Today —
 * which is what a `?? Date.now()` fallback does — makes the newest section a
 * lie every time it happens.
 */
export function byDay(items: readonly GalleryItem[], now = Date.now()): DaySection[] {
  const sections: DaySection[] = [];
  let current: DaySection | null = null;
  const undated: GalleryItem[] = [];

  for (const item of items) {
    if (item.modified === undefined) {
      undated.push(item);
      continue;
    }
    const key = dayKey(item.modified);
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(item.modified, now), items: [] };
      sections.push(current);
    }
    current.items.push(item);
  }

  if (undated.length > 0) {
    sections.push({ key: "undated", label: "No date", items: undated });
  }
  return sections;
}

/**
 * Items → albums, newest album first.
 *
 * Folders holding a single stray image are kept rather than merged into an
 * "Other" bucket: on a phone that single file is usually a wallpaper or a
 * download someone is looking for, and an album list that silently omits things
 * is one you stop trusting. They sort to the bottom naturally, by date.
 */
export function byAlbum(items: readonly GalleryItem[]): Album[] {
  const map = new Map<string, Album>();

  for (const item of items) {
    let album = map.get(item.folder);
    if (!album) {
      album = {
        id: item.folder,
        name: albumName(item.folder, item.folderName),
        path: item.folder,
        count: 0,
        cover: null,
        newest: 0,
      };
      map.set(item.folder, album);
    }
    album.count += 1;
    // `items` arrives newest-first, so the first one seen for a folder is its
    // newest — no comparison needed, and no second pass.
    if (album.cover === null) {
      album.cover = item;
      album.newest = item.modified ?? 0;
    }
  }

  const albums = [...map.values()].sort((a, b) => b.newest - a.newest);
  disambiguate(albums);
  return albums;
}

/**
 * Give same-named albums enough of their path to tell them apart.
 *
 * WhatsApp keeps `WhatsApp Images/Sent` and `WhatsApp Video/Sent`, and a
 * `.Private` under each of those as well. Named by their own last segment —
 * which is the right answer for every other folder on the device — the albums
 * list showed "Sent" twice and "Private" twice with different covers and no way
 * to tell which was which without opening one.
 *
 * Done here rather than as more rows in KNOWN_FOLDERS because the clash is not
 * a WhatsApp fact: any two apps that both save to a folder called `Sent` create
 * it, and a table of special cases only ever covers the ones already seen. Only
 * the names that actually collide are touched, so the common case — every album
 * uniquely named — keeps the short label it had.
 */
function disambiguate(albums: readonly Album[]): void {
  const groups = new Map<string, Album[]>();
  for (const album of albums) {
    const group = groups.get(album.name);
    if (group) group.push(album);
    else groups.set(album.name, [album]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    for (const album of group) {
      const segs = album.path.split("/").filter(Boolean);
      const parent = segs[segs.length - 2];
      if (parent !== undefined && parent !== "") album.name = `${parent} · ${album.name}`;
    }

    // One ancestor settles every real case seen so far, but it is not
    // guaranteed to — `a/Media/Sent` and `b/Media/Sent` are still both
    // "Media · Sent". At that point the full path is the only honest label
    // left, and a long label beats a wrong one.
    const seen = new Set<string>();
    const clashes = group.some((album) => {
      if (seen.has(album.name)) return true;
      seen.add(album.name);
      return false;
    });
    if (clashes) for (const album of group) album.name = album.path;
  }
}

/** `142` → `"2:22"`, `3700` → `"1:01:40"`. Blank when the duration is unknown. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => `${n}`.padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
