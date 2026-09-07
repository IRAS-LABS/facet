/**
 * In-memory FsAdapter.
 *
 * Exists so the shell, the canvas and every view can be built and demoed
 * before the Tauri filesystem plugin lands — and so UI work never depends on
 * the machine's real folder contents. Deterministic: same path always yields
 * the same listing, which makes visual regressions obvious.
 *
 * Swapping in the real adapter is one line in main.ts.
 */

import type {
  CachedThumb,
  MediaAccess,
  MediaPulse,
  MoveResult,
  RawMediaHit,
  RawMediaPage,
  RawMediaRow,
  RawMediaScan,
} from "./tauri-fs";
import {
  extOf,
  kindForExt,
  type DirListing,
  type FileEntry,
  type FsAdapter,
  type Place,
} from "./types";

/** Mulberry32 — small, fast, and stable across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const FOLDERS = [
  "Camera Roll", "Screenshots", "Projects", "Exports", "Recordings",
  "Reference", "Archive 2025", "LUTs", "Raw", "Client Work",
];

const FILES: ReadonlyArray<readonly [string, number, number]> = [
  // name, min bytes, max bytes
  ["IMG_{n}.jpg", 1_800_000, 7_400_000],
  ["DSC_{n}.dng", 22_000_000, 48_000_000],
  ["clip_{n}.mp4", 40_000_000, 900_000_000],
  ["screen_{n}.mkv", 90_000_000, 2_100_000_000],
  ["voice_memo_{n}.m4a", 900_000, 32_000_000],
  ["mixdown_{n}.wav", 30_000_000, 260_000_000],
  ["notes_{n}.md", 900, 42_000],
  ["report_{n}.pdf", 200_000, 9_000_000],
  ["metrics_{n}.csv", 12_000, 4_000_000],
  ["scan_{n}.glb", 3_000_000, 120_000_000],
  ["bundle_{n}.zip", 5_000_000, 400_000_000],
  ["teal_orange_{n}.cube", 40_000, 800_000],
];

const NOW = 1_755_216_000_000; // 2026-08-15T00:00:00Z — fixed so listings are stable.

function makeEntry(dir: string, r: () => number): FileEntry {
  const tpl = FILES[Math.floor(r() * FILES.length)]!;
  const name = tpl[0].replace("{n}", String(1000 + Math.floor(r() * 8999)));
  const size = Math.floor(tpl[1] + r() * (tpl[2] - tpl[1]));
  const ext = extOf(name);
  const kind = kindForExt(ext);
  const entry: FileEntry = {
    path: `${dir}/${name}`,
    name,
    kind,
    ext,
    size,
    modified: NOW - Math.floor(r() * 400 * 86_400_000),
  };
  if (kind === "video" || kind === "audio") {
    entry.duration = Math.round(4 + r() * 5400);
  }
  if (kind === "image" || kind === "video") {
    const landscape = r() > 0.35;
    entry.width = landscape ? 3840 : 2160;
    entry.height = landscape ? 2160 : 3840;
  }
  return entry;
}

export class MockFs implements FsAdapter {
  async list(path: string): Promise<DirListing> {
    const r = rng(hash(path));
    const entries: FileEntry[] = [];

    // Depth-limited so the tree stays walkable rather than infinite.
    const depth = path.split(/[\\/]/).filter(Boolean).length;
    const folderCount = depth >= 4 ? 0 : 2 + Math.floor(r() * 5);
    const used = new Set<string>();
    for (let i = 0; i < folderCount; i++) {
      const name = FOLDERS[Math.floor(r() * FOLDERS.length)]!;
      if (used.has(name)) continue;
      used.add(name);
      entries.push({
        path: `${path}/${name}`,
        name,
        kind: "folder",
        ext: "",
        modified: NOW - Math.floor(r() * 200 * 86_400_000),
      });
    }

    const fileCount = 18 + Math.floor(r() * 90);
    for (let i = 0; i < fileCount; i++) {
      entries.push(makeEntry(path, r));
    }
    return { path, entries };
  }

  async roots(): Promise<Place[]> {
    return [
      { id: "home", name: "Home", icon: "home", path: "C:/Users/me", pinned: true },
      { id: "pictures", name: "Pictures", icon: "image", path: "C:/Users/me/Pictures", pinned: true },
      { id: "videos", name: "Videos", icon: "video", path: "C:/Users/me/Videos", pinned: true },
      { id: "music", name: "Music", icon: "audio", path: "C:/Users/me/Music", pinned: true },
      { id: "docs", name: "Documents", icon: "doc", path: "C:/Users/me/Documents", pinned: true },
      { id: "recent", name: "Recent", icon: "clock", query: { since: NOW - 7 * 86_400_000 }, pinned: true },
      { id: "media", name: "All Media", icon: "sparkle", query: { kinds: ["image", "video", "audio"] }, pinned: false },
    ];
  }

  async thumbnail(): Promise<string | null> {
    // No real pixels to hand back. The card falls through to its kind glyph,
    // which is exactly the path a real file with no decodable preview takes —
    // so that branch gets exercised during development instead of at ship.
    return null;
  }

  // ── The rest of `PhoneFs` ──────────────────────────────────────────────
  //
  // Present so the phone shell runs in a browser tab. Where there is nothing
  // truthful to return these answer empty rather than plausible: a made-up
  // path has no bytes behind it, and a preview that falls back to its card is
  // exactly what a real undecodable file does.

  /**
   * The same synthetic tree `list()` builds, walked instead of listed.
   *
   * Deterministic for the same reason `list()` is — the gallery, the albums
   * and the counts under each category are identical on every reload, so a
   * screenshot from one run is comparable with a screenshot from the next.
   */
  async scanMedia(
    roots: readonly string[],
    exts: readonly string[],
    opts: { maxDepth?: number; limit?: number; budgetMs?: number } = {},
  ): Promise<RawMediaScan> {
    const maxDepth = opts.maxDepth ?? 6;
    const limit = opts.limit ?? 20000;
    const want = new Set(exts.map((e) => e.toLowerCase()));
    const hits: RawMediaHit[] = [];
    const seen = new Set<string>();
    let dirsVisited = 0;
    let truncated = false;

    const queue: Array<{ path: string; depth: number }> =
      roots.map((path) => ({ path, depth: 0 }));

    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next.path)) continue;
      seen.add(next.path);
      dirsVisited++;
      const { entries } = await this.list(next.path);
      for (const entry of entries) {
        if (entry.kind === "folder") {
          if (next.depth + 1 <= maxDepth) {
            queue.push({ path: entry.path, depth: next.depth + 1 });
          }
          continue;
        }
        // An empty extension list means "everything", the way Downloads asks.
        if (want.size > 0 && !want.has(entry.ext)) continue;
        if (hits.length >= limit) { truncated = true; queue.length = 0; break; }
        hits.push({
          name: entry.name,
          path: entry.path,
          size: entry.size ?? 0,
          modified: entry.modified ?? null,
          folder: next.path,
          folderName: next.path.split("/").filter(Boolean).pop() ?? next.path,
        });
      }
    }
    return { hits, dirsVisited, truncated };
  }

  /** Constant: nothing outside the process can change a generated tree. */
  async watchStamp(): Promise<string> {
    return "mock";
  }

  // ── A stand-in for the phone's MediaStore ─────────────────────────────────
  //
  // Off by default, so every harness that predates it still sees a desktop:
  // `mediaQuery` answers null and the store walks. A harness that flips
  // `indexSupported` on gets a mutable index with a change counter, which is
  // the whole push path -- a file "arriving" in a folder the walk never
  // visits, a delete, a burst -- without a phone in the room.

  /** When true, `mediaQuery` pages `mediaRows`; when false it answers `null`. */
  indexSupported = false;
  /** Rows the fake index holds, any order. `id` must be unique and positive. */
  mediaRows: RawMediaRow[] = [];
  /** What the fake index says the app may see. */
  mediaAccess: MediaAccess = "full";
  /** Bumped by every mutation below, exactly like the Kotlin AtomicLong. */
  mediaGen = 1;
  private mediaNextId = 1;
  /** Every `mediaQuery` page served, for asserting on paging. */
  mediaQueries = 0;

  async mediaQuery(beforeId: number, limit = 1000): Promise<RawMediaPage | null> {
    if (!this.indexSupported) return null;
    this.mediaQueries += 1;
    const sorted = [...this.mediaRows].sort((a, b) => b.id - a.id);
    const from = beforeId > 0 ? sorted.filter((r) => r.id < beforeId) : sorted;
    const rows = from.slice(0, limit);
    const last = rows[rows.length - 1];
    const next = rows.length < limit || last === undefined ? -1 : last.id;
    return { rows, next, access: this.mediaAccess };
  }

  async mediaGeneration(): Promise<MediaPulse> {
    return { gen: this.indexSupported ? this.mediaGen : 0, changed: 0 };
  }

  /**
   * "Open with FACET", faked. A browser tab has no intents, so this is empty
   * until a test calls `handOff`.
   */
  async openPending(): Promise<string[]> {
    const out = this.pendingOpens;
    this.pendingOpens = [];
    return out;
  }

  private pendingOpens: string[] = [];

  /** Queue paths as though Android had just delivered an intent. */
  handOff(...paths: string[]): void {
    this.pendingOpens.push(...paths);
  }

  /** A file the system just indexed. Returns the row so a test can point at it. */
  indexFile(path: string, extra: Partial<Omit<RawMediaRow, "id" | "path">> = {}): RawMediaRow {
    const row: RawMediaRow = { id: this.mediaNextId++, path, size: 1_000_000, modified: NOW, ...extra };
    this.mediaRows.push(row);
    this.mediaGen += 1;
    return row;
  }

  /** A file the system noticed was gone. */
  unindexFile(path: string): void {
    const before = this.mediaRows.length;
    this.mediaRows = this.mediaRows.filter((r) => r.path !== path);
    if (this.mediaRows.length !== before) this.mediaGen += 1;
  }

  async thumbCached(): Promise<CachedThumb | null> { return null; }
  async thumbBatch(entries: FileEntry[]): Promise<(CachedThumb | null)[]> {
    return entries.map(() => null);
  }
  async thumbStore(): Promise<void> {}

  async readHead(): Promise<number[]> { return []; }
  async readRange(): Promise<number[]> { return []; }
  async readTail(): Promise<[number[], number]> { return [[], 0]; }
  async fileUrl(): Promise<string> { return ""; }

  async frameAt(): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error("no video to decode without a native backend");
  }

  // Refusing is the point. A browser session that believed it had saved,
  // moved or shared a file would be worse than one that cannot.
  async moveFile(): Promise<MoveResult> { throw new Error("read-only mock filesystem"); }
  async writeFile(): Promise<string> { throw new Error("read-only mock filesystem"); }
  async emptyTrash(): Promise<void> { throw new Error("read-only mock filesystem"); }
  async shareFiles(): Promise<void> { throw new Error("sharing needs the native shell"); }
}
