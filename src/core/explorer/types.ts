/**
 * Explorer domain types.
 *
 * The explorer is the shell — every module in Facet is entered from a file, so
 * these types are the app's front door. They are deliberately platform-free:
 * `FsAdapter` is implemented by Tauri/Rust on desktop, Kotlin SAF on Android,
 * and an in-memory mock during UI work. Nothing above this line knows which.
 */

import type { GroupKey } from "./grouping";

export type FileKind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "tabular"
  | "model3d"
  | "archive"
  | "code"
  | "binary";

/**
 * A card face. Deliberately a small closed union rather than "an image URL",
 * because most of a real folder is not photographs: a .ts file previews as its
 * own first lines, an album folder as the covers inside it, an mp3 as its
 * embedded art. Each variant is something a card can render with no further
 * decoding, and anything we cannot preview yet stays `null` and falls back to
 * the kind glyph rather than showing a broken tile.
 */
export type Preview =
  | { type: "image"; url: string }
  | { type: "text"; lines: string[] }
  | { type: "tiles"; urls: string[]; more: number }
  | { type: "none"; reason: string };

export interface FileEntry {
  /** Full platform path, or a content URI on Android. Stable identity. */
  path: string;
  name: string;
  kind: FileKind;
  /** Bytes. Undefined for folders and for entries not yet stat'd. */
  size?: number;
  /** Epoch ms. */
  modified?: number;
  /** Lowercase, no dot. Empty for extensionless files and folders. */
  ext: string;
  /** Populated lazily by the thumbnail service; never blocks a first paint. */
  thumb?: string;
  /**
   * What this file actually looks like, for the card face. Filled in lazily by
   * the preview service and left alone until the card is close enough to read —
   * a name and a glyph are not enough to find anything in a folder of 400 files.
   */
  preview?: Preview;
  /** Dotfile on POSIX, HIDDEN/SYSTEM attribute on Windows. Filtered by view. */
  hidden?: boolean;
  /** Media duration in seconds, when known. Drives the timeline scrub-on-zoom. */
  duration?: number;
  width?: number;
  height?: number;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

/** A left-rail destination: a real folder, a smart query, or a remote mount. */
export interface Place {
  id: string;
  name: string;
  icon: string;
  /** Absent for smart places, which resolve through `query` instead. */
  path?: string;
  query?: { kinds?: FileKind[]; since?: number; text?: string };
  pinned: boolean;
}

export type SortKey = "name" | "size" | "modified" | "kind";

export interface ViewConfig {
  sort: SortKey;
  ascending: boolean;
  /**
   * What the folder is split into, if anything. Independent of `sort`: a folder
   * grouped by type is still sorted by name inside each type, which is why this
   * is a second key and not a fifth `SortKey`. See `@core/explorer/grouping`.
   */
  group: GroupKey;
  foldersFirst: boolean;
  showHidden: boolean;
  /** World-space card width in px at scale 1. Card height follows the ratio. */
  cardSize: number;
  /**
   * How many lines a file name may occupy on a card, 1–6. Not cosmetic: at one
   * line most real names — a phone photo, a render pass, anything dated — are
   * cut off exactly where they start to differ from each other, which makes the
   * grid unreadable. The card grows to fit rather than the name shrinking.
   */
  nameLines: number;
  /**
   * Which columns the details list shows, and what a card says under the name —
   * both as comma-separated field ids (item 36). They live here rather than
   * being read from settings inside each view for the same reason the sort key
   * does: one object arrives at both views, so they cannot disagree about what
   * a folder is showing. See `@core/explorer/fields` for the ids.
   */
  columns: string;
  cardFields: string;
}

export interface FsAdapter {
  list(path: string): Promise<DirListing>;
  /** Platform roots — drives on Windows, storage volumes on Android. */
  roots(): Promise<Place[]>;
  /** Returns a URL usable in an <img>/<video> src, or null if unavailable. */
  thumbnail(entry: FileEntry, px: number): Promise<string | null>;
}

const EXT_KINDS: ReadonlyArray<readonly [FileKind, readonly string[]]> = [
  ["image", ["jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "avifs", "jxl", "bmp", "tif", "tiff", "heic", "heics", "heif", "svg", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef", "srw", "ico"]],
  ["video", ["mp4", "mkv", "mov", "webm", "avi", "m4v", "wmv", "flv", "f4v", "mts", "m2ts", "3gp", "3g2", "mpg", "mpeg", "m2v", "ogv", "vob", "divx", "insv"]],
  ["audio", ["mp3", "wav", "flac", "aac", "ogg", "opus", "m4a", "wma", "aiff", "mid", "midi", "amr", "ape", "wv", "mka", "oga", "3ga"]],
  ["document", ["pdf", "docx", "doc", "odt", "rtf", "txt", "md", "epub", "pptx", "ppt"]],
  ["tabular", ["csv", "tsv", "xlsx", "xls", "ods", "parquet", "json", "jsonl", "db", "sqlite", "duckdb"]],
  ["model3d", ["glb", "gltf", "obj", "fbx", "stl", "ply", "blend", "usdz", "usd", "3mf", "dae"]],
  ["archive", ["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "zst", "iso"]],
  ["code", ["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "kt", "c", "h", "cpp", "cs", "rb", "php", "sh", "ps1", "html", "css", "toml", "yaml", "yml", "xml"]],
];

/** Extension → kind. Content sniffing happens later, in the adapter. */
export function kindForExt(ext: string): FileKind {
  const e = ext.toLowerCase();
  for (const [kind, list] of EXT_KINDS) {
    if (list.includes(e)) return kind;
  }
  return "binary";
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function sortEntries(entries: FileEntry[], cfg: ViewConfig): FileEntry[] {
  const dir = cfg.ascending ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (cfg.foldersFirst && (a.kind === "folder") !== (b.kind === "folder")) {
      return a.kind === "folder" ? -1 : 1;
    }
    switch (cfg.sort) {
      case "size":
        return ((a.size ?? 0) - (b.size ?? 0)) * dir;
      case "modified":
        return ((a.modified ?? 0) - (b.modified ?? 0)) * dir;
      case "kind":
        return a.kind.localeCompare(b.kind) * dir || a.name.localeCompare(b.name);
      case "name":
      default:
        return a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
    }
  });
}
