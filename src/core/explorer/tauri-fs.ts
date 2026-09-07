/**
 * The real filesystem, on desktop.
 *
 * Implements the same `FsAdapter` the mock does, so the shell above it never
 * learns which one it got. Everything platform-shaped stays behind this file:
 * drive letters, the `asset://` thumbnail protocol, `explorer.exe` hand-off.
 *
 * Classification is done here rather than in Rust on purpose. The Android
 * adapter will get its listings from Kotlin/SAF, and if the extension→kind
 * rules lived in the native layer they would have to be written twice and would
 * drift. Rust returns facts (name, size, date, is-directory); the meaning is
 * applied once, in TypeScript, for both platforms.
 */

import {
  extOf,
  kindForExt,
  type DirListing,
  type FileEntry,
  type FsAdapter,
  type Place,
} from "./types";

interface RawEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modified: number | null;
  hidden: boolean;
}

interface RawListing {
  path: string;
  parent: string | null;
  entries: RawEntry[];
}

interface RawPlace {
  id: string;
  name: string;
  path: string;
  icon: string;
}

/** One hit from `scan_media`. Mirrors `MediaHit` in `fsx.rs`. */
export interface RawMediaHit {
  name: string;
  path: string;
  size: number;
  modified: number | null;
  /** The directory it was found in — what the Albums tab groups by. */
  folder: string;
  folderName: string;
}

export interface RawMediaScan {
  hits: RawMediaHit[];
  dirsVisited: number;
  /** A cap stopped the walk. The UI must not claim this is everything. */
  truncated: boolean;
  /**
   * Contents of any `.facet-trash` folders the walk passed. Optional so a
   * frontend built after this field can still read a scan from a binary built
   * before it — the one skew direction a hot-reload dev loop actually produces.
   */
  trash?: RawMediaHit[];
}

/** One row of the phone's MediaStore index. Mirrors `MediaBridge.query`. */
export interface RawMediaRow {
  id: number;
  path: string;
  size?: number;
  /** Milliseconds since the epoch (MediaStore keeps seconds; the bridge scales). */
  added?: number;
  modified?: number;
  /** EXIF capture time, milliseconds. Only pictures and clips carry one. */
  taken?: number;
  mime?: string;
  /** MediaStore.Files.FileColumns.MEDIA_TYPE: 0 none, 1 image, 2 audio, 3 video, 4 playlist, 5 subtitle, 6 document. */
  mediaType?: number;
  /** IS_PENDING: a file another app is still writing. Not shown. */
  pending?: boolean;
  /** IS_TRASHED: in the system trash (Android 11+). Not shown. */
  trashed?: boolean;
  width?: number;
  height?: number;
  /** Seconds. */
  duration?: number;
  bucket?: string;
}

export type MediaAccess = "full" | "partial" | "none";

export interface RawMediaPage {
  rows: RawMediaRow[];
  /** Cursor for the next page, -1 when this was the last one. */
  next: number;
  access: MediaAccess;
  error?: string;
}

/** The change counter behind `media_generation`. `gen` 0 means no index here. */
export interface MediaPulse {
  gen: number;
  changed: number;
}

type Invoke = <T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  opts?: { headers?: Record<string, string> },
) => Promise<T>;

let invokeFn: Invoke | null = null;
let convertFn: ((path: string, protocol?: string) => string) | null = null;

async function core(): Promise<void> {
  if (invokeFn) return;
  const mod = await import("@tauri-apps/api/core");
  invokeFn = mod.invoke as Invoke;
  convertFn = mod.convertFileSrc;
}

async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  opts?: { headers?: Record<string, string> },
): Promise<T> {
  await core();
  if (!invokeFn) throw new Error("native bridge unavailable");
  return invokeFn<T>(cmd, args, opts);
}

/**
 * One framed thumbnail record as `thumbs.rs` writes it: flag, key,
 * orientation, then the JPEG. Null when the record is too short to be one.
 */
function asBytes(raw: ArrayBuffer | number[] | Uint8Array): Uint8Array {
  // Copied into a fresh buffer rather than viewed in place: the IPC may hand
  // back a Uint8Array over a SharedArrayBuffer, which `Blob` will not accept.
  if (raw instanceof Uint8Array) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  return new Uint8Array(raw);
}

function parseThumb(buf: Uint8Array): CachedThumb | null {
  if (buf.length < THUMB_HEAD) return null;
  return {
    exact: buf[0] === 1,
    key: new TextDecoder().decode(buf.subarray(1, THUMB_HEAD - 1)),
    orientation: Math.min(8, Math.max(1, buf[THUMB_HEAD - 1] || 1)),
    blob: buf.length > THUMB_HEAD
      ? new Blob([buf.slice(THUMB_HEAD) as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })
      : null,
  };
}

/**
 * Split a `thumb_batch` reply into its records: `[u32 LE length][record]`
 * repeated, one per request in order. A zero length is a null slot. A
 * truncated tail (which should never happen) ends the list rather than
 * throwing, so the tiles that did arrive still paint.
 */
export function splitBatch(buf: Uint8Array, count: number): (CachedThumb | null)[] {
  const out: (CachedThumb | null)[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 0;
  while (out.length < count && at + 4 <= buf.length) {
    const len = view.getUint32(at, true);
    at += 4;
    if (at + len > buf.length) break;
    out.push(len === 0 ? null : parseThumb(buf.subarray(at, at + len)));
    at += len;
  }
  while (out.length < count) out.push(null);
  return out;
}

/** A request in a `thumbBatch`; `video` picks the native fallback decoder. */
export interface ThumbWant {
  path: string;
  mtime: number;
  video: boolean;
}

/**
 * Extensions a webview can actually decode.
 *
 * `kindForExt` calls a .dng an image because it *is* one — but Chromium cannot
 * paint it, and pointing an `<img>` at one yields a broken-image glyph, which
 * looks like a bug rather than an unsupported format. Those fall through to the
 * kind icon until the RAW decoder module lands.
 */
const WEB_IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "ico"]);
const WEB_VIDEO = new Set(["mp4", "webm", "m4v", "mov", "ogv"]);

/**
 * Media the browser reads with Range requests rather than in one piece —
 * exactly the shape the Android asset protocol cannot serve (see `fileUrl`).
 */
const STREAMED = new Set([
  "mp4", "webm", "m4v", "mov", "ogv", "mkv", "3gp",
  "mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav",
]);

const ANDROID = /android/i.test(navigator.userAgent);

/** One flag byte, a 16-character key, one orientation byte -- must match
 *  `HEAD` in `thumbs.rs`. */
const THUMB_HEAD = 18;

export interface CachedThumb {
  /** False for the EXIF thumbnail: show it, then replace it. */
  exact: boolean;
  /** Pass back to `thumbStore` alongside the proper thumbnail. */
  key: string;
  /**
   * EXIF orientation of the source file, 1–8; 1 means upright. The embedded
   * EXIF thumbnail is a bare JPEG with no orientation of its own, so a blob
   * arriving with `exact: false` and orientation > 1 must be rotated before it
   * is shown — the camera stored it sideways.
   */
  orientation: number;
  /** Null when the native side had a key but no picture to go with it. */
  blob: Blob | null;
}

export class TauriFs implements FsAdapter {
  /** Cached because probing 26 drive letters can stall on empty card readers. */
  private rootsCache: Place[] | null = null;

  async list(path: string): Promise<DirListing> {
    const raw = await invoke<RawListing>("list_dir", { path });
    return {
      path: raw.path,
      entries: raw.entries.map(toEntry),
    };
  }

  async roots(): Promise<Place[]> {
    if (this.rootsCache) return this.rootsCache;
    const [drives, homes] = await Promise.all([
      invoke<RawPlace[]>("list_roots"),
      invoke<RawPlace[]>("home_places"),
    ]);
    // Home folders first: nobody starts their day at D:\.
    this.rootsCache = [...homes, ...drives].map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      path: p.path,
      pinned: true,
    }));
    return this.rootsCache;
  }

  /**
   * A URL the card can put straight into `src`.
   *
   * There is no thumbnail *generation* here — the asset protocol streams the
   * original and the browser scales it. For a 200 px card off a 45 MP JPEG that
   * is wasteful, and a real decode-and-cache pass is the next step; but it is
   * correct, it needs no cache directory, and it never shows a stale tile after
   * an edit. `px` is accepted now so that swap is invisible to callers.
   */
  async thumbnail(entry: FileEntry, _px: number): Promise<string | null> {
    if (entry.kind === "folder") return null;
    const usable =
      (entry.kind === "image" && WEB_IMAGE.has(entry.ext)) ||
      (entry.kind === "video" && WEB_VIDEO.has(entry.ext));
    if (!usable) return null;
    await core();
    return convertFn ? convertFn(entry.path) : null;
  }

  /**
   * A ready-made thumbnail, if one exists without decoding the whole file.
   *
   * `exact: false` marks the JPEG the camera embedded in the file's EXIF block.
   * It is soft at tile size and it arrives in milliseconds; the caller should
   * paint it and build the proper one behind it.
   *
   * Videos come through here too, and always miss on the embedded-thumbnail
   * step -- but the key comes back, and that is the point: a poster frame costs
   * between four and seventeen seconds to pull out of an mp4 on this device, so
   * it is the one thumbnail in the app that absolutely must only ever be made
   * once.
   */
  async thumbCached(entry: FileEntry): Promise<CachedThumb | null> {
    // Any picture or clip, not just the extensions the *WebView* can decode.
    //
    // This used to gate on WEB_IMAGE/WEB_VIDEO, which was a real bug and an
    // expensive one: the native side is format-agnostic -- it hands back a key
    // and whatever is in the disk cache -- but returning null here meant the
    // caller got no key, so `thumbStore` was never called and the entry was
    // never written. Every .mkv, .avi, .3gp, .heic and .heif therefore paid a
    // full decode on every single launch, forever, with a cache sitting right
    // there unable to hold the answer. The EXIF raid behind this is already
    // self-gating: it bails on anything not starting with FFD8.
    if (entry.kind !== "image" && entry.kind !== "video") return null;
    // No mtime means no stable key, so a cached tile could outlive an edit of
    // the file it came from. Skip rather than key on the path alone.
    if (entry.modified === undefined) return null;

    const raw = await invoke<ArrayBuffer | number[] | Uint8Array>("thumb_cached", {
      path: entry.path,
      mtime: Math.floor(entry.modified),
    });
    return parseThumb(asBytes(raw));
  }

  /**
   * Thumbnails for a whole band of tiles in one round trip.
   *
   * Each entry goes disk cache, then the platform's own thumbnail service
   * (MediaStore on Android, the same pictures the system gallery scrolls on),
   * then the EXIF raid -- and whatever the platform hands back is written to
   * the disk cache on the way past, so it is paid for once. Results come back
   * in request order; `exact: true` means the blob is the finished tile and
   * nothing further needs decoding. With `bytes` false the JPEGs stay on the
   * native side and only the flags travel: that is the warm pass.
   *
   * Entries that are not pictures or clips, or have no mtime, get a null
   * without ever reaching the native side.
   */
  async thumbBatch(entries: FileEntry[], px: number, bytes = true): Promise<(CachedThumb | null)[]> {
    const slots: number[] = [];
    const wants: ThumbWant[] = [];
    entries.forEach((e, i) => {
      if ((e.kind !== "image" && e.kind !== "video") || e.modified === undefined) return;
      slots.push(i);
      wants.push({ path: e.path, mtime: Math.floor(e.modified), video: e.kind === "video" });
    });
    const out: (CachedThumb | null)[] = entries.map(() => null);
    if (wants.length === 0) return out;
    const raw = await invoke<ArrayBuffer | number[] | Uint8Array>("thumb_batch", {
      wants,
      px: Math.round(px),
      bytes,
    });
    const got = splitBatch(asBytes(raw), wants.length);
    slots.forEach((slot, j) => { out[slot] = got[j] ?? null; });
    return out;
  }

  /** Put a timing line where `logcat` can see it. */
  mark(what: string): void {
    void invoke<null>("mark", { what }).catch(() => {});
  }

  /** Keep a thumbnail the front end has just built. Failure is not worth a throw. */
  async thumbStore(key: string, blob: Blob): Promise<void> {
    try {
      // Raw body plus a header, not `{ key, bytes: [...] }`: as a JSON array
      // a 30 KB JPEG was 120 KB of decimal text, built here and parsed there,
      // once per tile.
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await invoke<boolean>("thumb_store", bytes, { headers: { "x-thumb-key": key } });
    } catch {
      // A cache that did not persist costs a slower next launch, nothing more.
    }
  }

  /** Full-resolution source for the viewer and the editors. */
  async fileUrl(path: string): Promise<string> {
    await core();
    if (!convertFn) throw new Error("native bridge unavailable");
    // Android's WebView re-applies a request's Range offset to the asset
    // protocol's already-sliced body, so any mid-file read fails and a video
    // dies at the demuxer's first seek. Streamable media goes to the app's
    // loopback server instead (media_server.rs); images are fetched whole and
    // stay on the asset protocol.
    if (ANDROID && STREAMED.has(extOf(path))) {
      try {
        return await invoke<string>("media_url", { path });
      } catch {
        // Server failed to start — the asset URL at least shows a first frame.
      }
    }
    return convertFn(path);
  }

  /** Hand off to the OS for anything FACET cannot open yet. */
  openExternal(path: string): Promise<void> {
    return invoke("open_external", { path });
  }

  revealInShell(path: string): Promise<void> {
    return invoke("reveal", { path });
  }

  /**
   * A user-defined action (item 39): run `program` with an argument vector the
   * front end has already split and substituted.
   *
   * The vector is the point — see `run_program` in `src-tauri/src/fsx.rs`. There
   * is no string here for a shell to re-interpret, so a file called
   * `holiday & co.jpg` is one argument rather than two commands.
   */
  runProgram(program: string, args: readonly string[], cwd?: string): Promise<void> {
    return invoke("run_program", { program, args, cwd: cwd ?? null });
  }

  /**
   * The OS share sheet, on the selection.
   *
   * Rejects rather than resolving quietly when there is no sheet to show — on
   * Windows the target list is UWP-only and can legitimately be empty, and a
   * share button that appears to work and does nothing is worse than one that
   * says what happened. The caller offers `copyFiles` alongside it for that
   * reason.
   */
  shareFiles(paths: readonly string[]): Promise<void> {
    return invoke("share_files", { paths });
  }

  /**
   * The files themselves onto the clipboard, as `CF_HDROP`.
   *
   * Not `copy path` — this is what Explorer's own Ctrl+C puts there, so it
   * pastes as files into a folder, a mail draft, or a chat box.
   */
  copyFiles(paths: readonly string[]): Promise<void> {
    return invoke("copy_files", { paths });
  }

  // ── ffmpeg (items 4, 5, 12) ────────────────────────────────────────────
  //
  // The front end never assembles a command line; it hands over a typed job and
  // Rust builds the graph. See `src-tauri/src/ffmpeg.rs` for why the split falls
  // there rather than one function further up.

  probeMedia(path: string): Promise<unknown> {
    return invoke("probe_media", { path });
  }

  keyframes(path: string, from: number, to: number): Promise<number[]> {
    return invoke("keyframes", { path, from, to });
  }

  /**
   * A poster frame as raw bytes.
   *
   * The command returns `tauri::ipc::Response`, so this arrives as an
   * `ArrayBuffer` rather than the JSON number array it used to be. Normalized
   * the same way `thumbCached` does it -- copied into a fresh buffer, because
   * the IPC may hand back a view over a `SharedArrayBuffer` that `Blob` refuses.
   */
  async frameAt(
    path: string,
    at: number,
    width: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const raw = await invoke<ArrayBuffer | number[] | Uint8Array>("frame_at", {
      path,
      at,
      width,
    });
    // The explicit `ArrayBuffer` parameter is not decoration: a plain
    // `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which may be backed by a
    // `SharedArrayBuffer` and is therefore not a `BlobPart`. The copy below
    // makes that true as well as typed.
    const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    const out = new Uint8Array(new ArrayBuffer(src.byteLength));
    out.set(src);
    return out;
  }

  runJob(job: unknown): Promise<number> {
    return invoke("run_job", { job });
  }

  cancelJob(id: number): Promise<void> {
    return invoke("cancel_job", { id });
  }

  runAudioJob(job: unknown): Promise<number> {
    return invoke("run_audio_job", { job });
  }

  /**
   * The shape of a file's audio, as one peak per bucket.
   *
   * Scanned in Rust rather than with `decodeAudioData` here: the browser route
   * has to hold the decoded file in memory, which is fine for a song and
   * hopeless for a two-hour recording — and this way anything ffmpeg can open
   * can be drawn, not just what the WebView can play.
   */
  peaks(path: string, buckets: number): Promise<number[]> {
    return invoke("peaks", { path, buckets });
  }

  /**
   * Subscribe to an encoder event. Returns a promise of the unsubscribe.
   *
   * Progress arrives as events rather than as a resolved promise because an
   * export runs for minutes and the interesting part is what happens during it —
   * a command that only answers at the end cannot drive a progress bar or a
   * cancel button.
   */
  async onEvent<T>(name: string, cb: (payload: T) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(name, (e) => cb(e.payload));
  }

  /**
   * Every media file under `roots`, newest first, in one hop (`scan_media`).
   *
   * The gallery's primitive. A folder listing answers "what is in this
   * directory"; a gallery has to answer "what have I got", which spans DCIM,
   * Pictures, Download and a folder per app that ever saved an image. Doing
   * that by walking with `list()` costs one IPC round-trip per directory.
   *
   * Kind is not returned by Rust for the same reason it is not returned by
   * `list_dir` — see the file header. The caller applies `kindForExt`.
   */
  scanMedia(
    roots: readonly string[],
    exts: readonly string[],
    opts: { maxDepth?: number; limit?: number; budgetMs?: number } = {},
  ): Promise<RawMediaScan> {
    return invoke("scan_media", {
      roots,
      exts,
      maxDepth: opts.maxDepth ?? 6,
      limit: opts.limit ?? 20000,
      budgetMs: opts.budgetMs ?? 8000,
    });
  }

  readHead(path: string, max = 65536): Promise<number[]> {
    return invoke("read_head", { path, max });
  }

  /** Bytes from an arbitrary offset — RAW previews, zip members. */
  readRange(path: string, offset: number, len: number): Promise<number[]> {
    return invoke("read_range", { path, offset, len });
  }

  /**
   * The tail of a file plus its total size. Both come back together because a
   * zip reader needs the size to resolve the central-directory offset, and
   * splitting that into two calls would leave a window where they disagree.
   */
  readTail(path: string, len: number): Promise<[number[], number]> {
    return invoke("read_tail", { path, len });
  }

  writeFile(path: string, bytes: Uint8Array, overwrite = false): Promise<string> {
    // Tauri's IPC serialises a Uint8Array as an object with numeric keys, not
    // as an array, and serde then rejects it. Converting explicitly is the
    // difference between "saves" and "fails with a type error at the boundary".
    return invoke("write_file", { path, bytes: Array.from(bytes), overwrite });
  }

  /**
   * Extend a file we already own, and answer with its new length.
   *
   * The recorder writes a take one chunk at a time rather than once at stop,
   * so an hour-long capture never sits in the webview's heap and a crash at
   * minute fifty-nine leaves fifty-nine minutes on disk. See `append_file` in
   * `fsx.rs` for why that produces a valid file rather than a truncated one.
   */
  appendFile(path: string, bytes: Uint8Array): Promise<number> {
    return invoke("append_file", { path, bytes: Array.from(bytes) });
  }

  /**
   * Move or rename. `copied` comes back true when the destination was on a
   * different drive: the bytes are there and **the original is still where it
   * was**, because deleting it would be a permanent delete performed by a
   * background rule. The caller says so rather than pretending it moved.
   */
  moveFile(from: string, to: string, overwrite = false): Promise<MoveResult> {
    return invoke("move_file", { from, to, overwrite });
  }

  /**
   * Copy a file or a whole folder, leaving the original where it is.
   *
   * The other half of a drag. Same shape as `moveFile` on purpose, so the drop
   * handler picks one of the two up front and does not branch again afterwards.
   */
  /**
   * A file path to the image shown under the cursor during an OS drag.
   *
   * Asked for rather than known, because the icon lives inside the executable
   * and the drag API wants somewhere on disk. Cached by the caller — the
   * answer never changes within a run.
   */
  dragIcon(): Promise<string> {
    return invoke("drag_icon");
  }

  copyFile(from: string, to: string, overwrite = false): Promise<MoveResult> {
    return invoke("copy_file", { from, to, overwrite });
  }

  /**
   * Permanently dispose of files already sitting in a `.facet-trash` folder.
   * Rust refuses any path outside one — this command is the only permanent
   * delete in the app and the path check is what keeps it that way. On Windows
   * "permanent" still means the OS Recycle Bin.
   */
  emptyTrash(paths: readonly string[]): Promise<void> {
    return invoke("empty_trash", { paths });
  }

  /**
   * One hash over the mtimes of the given directories. A directory's mtime
   * changes when a file is created, deleted or renamed inside it, so polling
   * this stamp is how the gallery notices a new screenshot without a rescan
   * button — the poor man's ContentObserver, since the WebView cannot register
   * a real one and inotify is unreliable across Android's FUSE mounts.
   */
  watchStamp(paths: readonly string[]): Promise<string> {
    return invoke("watch_stamp", { paths });
  }

  /**
   * One page of the phone's own media index (MediaStore), newest first, or
   * `null` where there is no such index (desktop). Every indexed row comes
   * back -- pictures, clips, documents, APKs -- so a folder the walk never
   * reaches is still seen the moment the system indexes it.
   */
  async mediaQuery(beforeId: number, limit = 1000): Promise<RawMediaPage | null> {
    const raw = await invoke<string | null>("media_query", { beforeId, limit });
    if (raw === null || raw === undefined) return null;
    try {
      const page = JSON.parse(raw) as Partial<RawMediaPage>;
      return {
        rows: Array.isArray(page.rows) ? page.rows : [],
        next: typeof page.next === "number" ? page.next : -1,
        access: page.access === "partial" || page.access === "none" ? page.access : "full",
        ...(page.error ? { error: page.error } : {}),
      };
    } catch {
      return { rows: [], next: -1, access: "full", error: "unreadable page" };
    }
  }

  /** The MediaStore change counter: cheap enough to ask once a second. */
  mediaGeneration(): Promise<MediaPulse> {
    return invoke("media_generation");
  }
}

/**
 * What the phone shell actually asks a filesystem for.
 *
 * Narrower than `TauriFs` on purpose: the phone uses sixteen of its forty-odd
 * methods, and naming those sixteen is what lets `MockFs` stand in for it in a
 * browser tab. Every phone layout bug before this one reached the user first
 * because the only way to see the phone UI was to install it.
 */
export type PhoneFs = Pick<
  TauriFs,
  | "list" | "roots" | "thumbnail"
  | "thumbCached" | "thumbBatch" | "thumbStore" | "frameAt"
  | "fileUrl" | "readHead" | "readRange" | "readTail"
  | "scanMedia" | "watchStamp" | "mediaQuery" | "mediaGeneration"
  | "moveFile" | "writeFile" | "emptyTrash" | "shareFiles"
>;

export interface MoveResult {
  path: string;
  copied: boolean;
}

function toEntry(r: RawEntry): FileEntry {
  const ext = r.isDir ? "" : extOf(r.name);
  const e: FileEntry = {
    path: r.path,
    name: r.name,
    kind: r.isDir ? "folder" : kindForExt(ext),
    ext,
    hidden: r.hidden,
  };
  // Assigned conditionally because tsconfig runs exactOptionalPropertyTypes:
  // `size: undefined` is not the same type as an absent `size`.
  if (r.size !== null) e.size = r.size;
  if (r.modified !== null) e.modified = r.modified;
  return e;
}

/**
 * Whether the bundled ffmpeg and ffprobe can actually be run.
 *
 * Not the same question as `IS_NATIVE`. The binaries ship for exactly one ABI
 * (`src-tauri/android-binaries/arm64-v8a`), so on any other device -- or a
 * desktop with nothing on PATH -- they are simply absent, and a tool offered
 * as enabled that fails at spawn time is worse than one greyed out with a
 * reason. Answered by Rust, cached here, and false until the first answer
 * lands so nothing is promised before it is known.
 */
export function mediaReady(): boolean {
  return mediaOk;
}

let mediaOk = false;

/** Ask once, at startup. Resolves to the same value `mediaReady()` will report. */
export async function probeMediaTools(): Promise<boolean> {
  if (!IS_NATIVE) return false;
  try {
    mediaOk = (await invoke("media_ready")) === true;
  } catch {
    mediaOk = false;
  }
  return mediaOk;
}

/** True inside the Tauri webview, false in a plain browser tab. */
export const IS_NATIVE: boolean =
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
