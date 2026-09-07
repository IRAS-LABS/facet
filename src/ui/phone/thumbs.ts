/**
 * Thumbnails, at a size a phone can survive.
 *
 * `TauriFs.thumbnail()` hands back an `asset://` URL to the *original* file and
 * lets the browser scale it. On a desktop, with eight cards on screen, that is
 * merely wasteful. On a 384 px phone showing four columns of a camera roll it is
 * the whole problem: thirty-odd tiles on screen, each one a 12-megapixel JPEG
 * decoded to a 48 MB RGBA surface, is well over a gigabyte of bitmap for a grid
 * whose tiles are 94 px wide. The WebView does not gracefully degrade under
 * that — it drops decoded images and re-decodes them on scroll, which is what
 * "flickering grey squares that never settle" looks like from the outside.
 *
 * So this sits in front of it and does three things the raw URL cannot:
 *
 *  1. **Decodes small.** `createImageBitmap` with `resizeWidth` lets the codec
 *     scale during decode, so the full-size surface is never allocated. The
 *     result is re-encoded to a small blob and *that* is what the tile gets.
 *  2. **Bounds memory.** An LRU with a hard entry count, revoking object URLs on
 *     eviction. Without the revoke the blobs leak for the lifetime of the tab,
 *     which on a long scroll is the same crash by a slower route.
 *  3. **Cancels.** A tile scrolled past before its decode started is dropped
 *     from the queue rather than decoded for nobody. This is the difference
 *     between a fast flick settling immediately and settling forty tiles later.
 *
 * Video posters go through ffmpeg's `frame_at` rather than the browser, because
 * an `<img>` pointed at an mp4 renders nothing at all — which is why video tiles
 * were blank rectangles. That path only exists on builds where the ffmpeg
 * sidecar is present; where it is not, the tile falls back to its extension.
 */

import type { CachedThumb, PhoneFs } from "@core/explorer/tauri-fs";
import { docThumb, docThumbKind } from "@core/preview/doc-thumb";
import type { FileEntry } from "@core/explorer/types";
import { mark } from "@core/phone/mark";

/**
 * Decode width. Tiles are at most ~192 px on a 3-column phone grid; 2× that
 * covers a 450 dpi screen's device pixels, and going beyond it buys nothing a
 * thumb-sized picture can show.
 */
const DECODE_PX = 384;

/**
 * How many tiles' worth of decoded blob to keep.
 *
 * Roughly ten screens at four columns. Small enough that the resident set stays
 * in the low tens of megabytes at this decode size; large enough that scrolling
 * back up a few screens is instant, which is most of what scrolling back up is.
 */
/*
 * Blob URLs held at once.
 *
 * This has to comfortably exceed the number of tiles the gallery keeps mounted
 * around the viewport, and the two numbers drifting apart is what produced
 * "boxes that never load". At 320 against a band of four hundred cells, every
 * newly decoded picture revoked the URL of one that was still on screen: the
 * `<img>` went empty, `dataset.loaded` still said the tile was finished, and
 * the observer had long since fired -- so nothing ever asked for it again. The
 * top of the screen stayed blank while the bottom painted, forever, with the
 * decode lanes completely idle.
 *
 * The retain count below is the real fix; this is headroom so that scrolling
 * back a screen is still a cache hit. A 384 px JPEG is about 25 kB, so this is
 * roughly 26 MB of blobs — the price of scrolling several screens back and
 * forth with no visible reload, which is the "instantaneous" was asked
 * for on 2026-08-31.
 */
const CACHE_MAX = 1024;
/**
 * Pinned probes outstanding at most: one batch. The landing band is asked for
 * every frame of the fling and the prediction moves with it; pinning more than
 * a round trip's worth only puts guesses ahead of the tiles that are on screen.
 */
const PIN_MAX = 16;

/** Concurrent decodes. Above about four the queue stops helping and the main
 *  thread starts losing frames to blob encoding. */
const LANES = 4;

/** How long the grid must be still before the background warm resumes. */
const QUIET_MS = 1000;

/*
 * There is deliberately no cap on queue length, and the attempt to add one is
 * worth recording. Dropping the head of an overfull lane livelocked: an evicted
 * tile that was still on screen retried, re-queued at the tail, and evicted
 * somebody else, so the lanes spent their time shuffling rather than decoding.
 * Measured at slow=8527 against done=3328 -- more than two admissions per tile
 * finished. The backlog is bounded at the source instead, by the observer's
 * `rootMargin` and by `cancel` dropping what scrolls past.
 */

/**
 * Tiles per native round trip, and round trips in flight.
 *
 * The probe used to be one IPC call per tile, twelve wide. Measured on the
 * phone after a fling that was still the whole problem: 500 ms after the
 * scroll stopped, not one of the two dozen visible tiles had a picture, and
 * three seconds later most still did not -- each tile was paying its own
 * ~15 ms of IPC plus its own turn in a gate, and the misses among them each
 * paid a full WebView decode on top. Now a screenful goes across in one call
 * (`thumbBatch`), the native side fans it over its own threads and answers
 * with the operating system's thumbnails, and the reply is one buffer.
 *
 * Sixteen is about two-thirds of a screen at four columns: small enough that
 * an on-screen batch is not held up by look-ahead work in the same call, large
 * enough that a screen is two calls, not twenty. Three in flight keeps the
 * native side busy while the WebView is turning a reply into blob URLs.
 */
const BATCH = 16;
const BATCHES = 3;

/** How long the batch reply may take before every tile in it is treated as a
 *  miss. Generous, because one batch can hold a few video frames the platform
 *  has to decode -- see `deadline` for why it must exist at all. */
const BATCH_MS = 15_000;

/**
 * Tiles per warm round trip. Smaller than `BATCH` because a warm batch cannot
 * be cancelled once sent, and a scroll that starts while one is out shares the
 * decoder threads with it until it lands.
 */
const WARM_BATCH = 12;

/**
 * Resolved instead of `null` when a job is dropped because its tile scrolled
 * away.
 *
 * `null` is a real answer -- this file has no picture, draw the extension chip
 * -- and the painter treats it as final. A skipped job is not that, and giving
 * both the same value is what left flicked-past tiles permanently blank.
 */
const SKIPPED = Symbol("skipped");

export type Painted = string | null | typeof SKIPPED;

/**
 * `promise`, or `fallback` if it has not settled within `ms`.
 *
 * Every slot in this file — the probe gate, the decode lanes, the warm loop —
 * is released in a `finally` that only runs when the awaited native call
 * settles. On 2026-08-31 a fling burst lost twelve `thumb_cached` responses in
 * the WebView↔Rust IPC and none of those promises ever settled: the probe gate
 * wedged at capacity, every later request (and every SKIPPED retry) parked
 * behind it forever, and everything outside the in-memory cache stayed blank
 * for the life of the process — while the warm loop, which skips the gate, ran
 * on and proved the native side was fine. A lost response must cost one tile
 * one retry, never the session.
 *
 * Rejections pass through untouched: `videoPoster` tells a broken clip from a
 * missing ffmpeg binary by the rejection message, and swallowing it here would
 * disable that latch.
 */
function deadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { window.clearTimeout(timer); resolve(v); },
      (e: unknown) => { window.clearTimeout(timer); reject(e); },
    );
  });
}

/** Extensions the WebView can actually decode. Anything else takes the ffmpeg
 *  path if it is video, and the extension chip if it is not. */
const WEB_IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"]);

/**
 * Is this file drawn by `docThumb` rather than decoded as a picture?
 *
 * One predicate, used by the lane chooser, the queue and the decoder, because
 * three hand-rolled variants of it disagreed about SVG -- whose `kind` is
 * `image` but whose picture only exists once we have drawn it.
 *
 * `docThumbKind` already returns null for every extension the picture pipeline
 * owns, so the `kind` test is only a guard against a mislabelled extension.
 */
function drawn(entry: FileEntry): boolean {
  // A folder has an icon and no extension, and "no extension" is not a picture
  // extension -- without this it would be handed a card with "FILE" on it.
  if (entry.kind === "folder" || entry.kind === "video") return false;
  return docThumbKind(entry.ext) !== null;
}

/** How wide a document thumbnail is rendered. Matches the tile grid at 3x,
 *  which is the density of the phone this is built for. */
const DOC_PX = 384;

/**
 * Bake an EXIF orientation into the pixels of a bare JPEG.
 *
 * The thumbnail embedded in a camera JPEG is stored the way the sensor saw the
 * scene — a portrait shot arrives as landscape pixels plus an orientation tag
 * on the *parent* file. The full-size image is fine everywhere because every
 * decoder applies the tag; the embedded thumb has no tag of its own, so shown
 * raw it is the sideways tile a user photographs sideways. Rust hands
 * the parent's tag alongside the blob and this rotates the pixels once, after
 * which the corrected copy goes into the disk cache and the tag is never
 * needed again.
 *
 * Orientation values are the eight of EXIF: 2 mirror, 3 upside-down, 4 flip,
 * 5–8 the transposed four. On any failure the original blob comes back — a
 * sideways picture beats a blank tile.
 */
async function upright(blob: Blob, orientation: number): Promise<Blob> {
  if (orientation <= 1 || orientation > 8) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const w = bmp.width;
    const h = bmp.height;
    const swap = orientation >= 5;
    const canvas = new OffscreenCanvas(swap ? h : w, swap ? w : h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    const m: Record<number, [number, number, number, number, number, number]> = {
      2: [-1, 0, 0, 1, w, 0],
      3: [-1, 0, 0, -1, w, h],
      4: [1, 0, 0, -1, 0, h],
      5: [0, 1, 1, 0, 0, 0],
      6: [0, 1, -1, 0, h, 0],
      7: [0, -1, -1, 0, h, w],
      8: [0, -1, 1, 0, 0, w],
    };
    const t = m[orientation];
    if (!t) return blob;
    ctx.setTransform(...t);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  } catch {
    return blob;
  }
}

/** One tile waiting for the next `thumbBatch` round trip. */
interface Probe {
  key: string;
  entry: FileEntry;
  urgent: boolean;
  /** Distance from the viewport in pixels, direction-weighted; 0 on screen. */
  dist: number;
  /** Asked for by the fling predictor: goes first and cannot be cancelled. */
  pinned: boolean;
  resolve: (c: CachedThumb | null) => void;
}

interface Job {
  key: string;
  entry: FileEntry;
  /** What the cache probe already found: a key with no picture, or nothing. */
  cached: CachedThumb | null;
  resolve: (url: Painted) => void;
  /** Flipped when the tile leaves the viewport before we got to it. */
  cancelled: boolean;
  /** On screen when asked for, as opposed to merely inside the look-ahead. */
  urgent: boolean;
}

/**
 * One queue per medium.
 *
 * Photographs and videos are not the same job with a different file extension.
 * A cached photograph resolves in about ten milliseconds; pulling a poster
 * frame out of an mp4 through the WebView's decoder was measured on this phone
 * at four to seventeen seconds. Sharing one four-wide queue between them meant
 * four videos near the top of the roll took every lane and held it: the log
 * shows twenty photographs, all of them cache hits worth ten milliseconds each,
 * waiting behind two videos and arriving thirteen seconds late.
 *
 * So videos get their own lane -- exactly one, because the phone has a small
 * fixed number of hardware decoders -- and photographs get all four of theirs.
 */
interface Lane {
  queue: Job[];
  active: number;
  width: number;
}

export class Thumbs {
  private cache = new Map<string, string>();
  private pending = new Map<string, Promise<Painted>>();
  /** Keys whose blob is currently the `src` of a mounted tile. */
  private live = new Map<string, number>();
  /** Keys whose tile left the viewport while its cache probe was still out. */
  private unwanted = new Set<string>();
  /**
   * Keys the fling predictor asked for. Immune to `cancel` until their probe
   * answers: the observer reports every tile it flicks past as gone, and
   * these are exactly the tiles it is about to flick *to*.
   */
  private pinned = new Set<string>();
  /** Probes collected since the last flush -- see `probe`. */
  private probeQueue: Probe[] = [];
  private probeFlushQueued = false;
  private batchesOut = 0;
  private batchN = 0;
  private batchMs = 0;
  private batchTiles = 0;
  /**
   * Which way the grid is moving: +1 down, -1 up. Set by the loader; used to
   * order a flush so the tiles about to arrive come before the ones just left.
   */
  direction = 1;
  private stills: Lane = { queue: [], active: 0, width: LANES };
  private clips: Lane = { queue: [], active: 0, width: 4 };
  /**
   * Documents and app packages (item 3).
   *
   * Two wide, and a third lane rather than a share of the stills lane, for the
   * reason the clips lane exists: these are not the same job. A PDF page render
   * spins up the pdfjs worker and parses a cross-reference table; an APK icon
   * is three ranged reads and an inflate. Neither is slow enough to deserve the
   * clips lane's serialisation, and both are slow enough that four of them
   * sitting in the stills queue would hold up a screenful of cache hits worth
   * ten milliseconds each -- which is precisely the failure the clips lane was
   * split out to fix, and there is no reason to reintroduce it under a new file
   * extension.
   */
  private docs: Lane = { queue: [], active: 0, width: 2 };
  private ffmpegOk = true;
  private shrinker: Shrinker | null = null;
  /** Video posters go one at a time -- see `videoFrame`. */
  private videoLane: Promise<unknown> = Promise.resolve();
  private done = 0;
  private hits = 0;
  private exif = 0;
  private slow = 0;
  /** Wall time and count of the misses only, split by medium. A gallery that
   *  feels slow is slow in exactly one of these two numbers, and the old
   *  two-line summary could not say which. */
  /** The background poster warm -- see `warm`. */
  private warmList: readonly FileEntry[] = [];
  private warmAt = 0;
  private warmed = 0;
  private warming = false;
  /** When the foreground last had work in flight -- see `warmLoop`. */
  private lastBusyAt = 0;
  private disposed = false;
  private vidN = 0;
  private vidMs = 0;
  private imgN = 0;
  private imgMs = 0;

  constructor(private readonly fs: PhoneFs) {
    this.shrinker = Shrinker.tryCreate();
  }

  /**
   * A thumbnail URL for `entry`, or null if it cannot be drawn.
   *
   * Resolving to null is a normal outcome, not a failure: a .dng, a .heic on a
   * WebView without the codec, or a video on a build with no ffmpeg all end up
   * here, and the caller draws the extension chip. What must never happen is a
   * rejected promise, because a tile whose decode threw should be a plain tile,
   * not an unhandled rejection in the console on every scroll.
   */
  get(entry: FileEntry, urgent = false, dist = 0): Promise<Painted> {
    const key = this.keyOf(entry);
    this.unwanted.delete(key);

    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // Re-insert so the LRU sees the touch.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }

    const already = this.pending.get(key);
    if (already) {
      // The tile left the viewport and came back before the queue reached it.
      //
      // This is the blank-tile bug. `cancel()` only sets a flag; the job stays
      // queued, and `pump()` later sees the flag, resolves `null` and deletes
      // the pending entry. Both awaiters get that `null` -- including this one,
      // which is a tile that is on screen right now. It then never asks again,
      // because the observer has already fired for it and will not fire a
      // second time while it stays intersecting. One flick that scrolled a tile
      // out and back left it permanently empty, which is why a fast scroll
      // produced screens of blanks and a slow one produced none.
      for (const lane of this.lanes) {
        for (let i = 0; i < lane.queue.length; i += 1) {
          const job = lane.queue[i];
          if (!job || job.key !== key) continue;
          job.cancelled = false;
          // Back on screen means back to the top of the LIFO as well.
          if (urgent) job.urgent = true;
          if (urgent && i !== lane.queue.length - 1) {
            lane.queue.splice(i, 1);
            lane.queue.push(job);
          }
          break;
        }
      }
      return already;
    }

    const promise = this.begin(entry, key, urgent, dist);
    this.pending.set(key, promise);
    return promise;
  }

  /**
   * Ask for a band of tiles before any of them is mounted.
   *
   * On a cold launch the grid's first screens are known the moment the store
   * emits its seed -- some hundreds of milliseconds before the tiles exist,
   * intersect, and ask. Asking now moves those round trips ahead of layout,
   * so the first paint of the grid is a paint of pictures. Anything already
   * cached or in flight is left alone; `dist` grows with position so the
   * flush orders the top of the roll first.
   */
  prefetch(entries: readonly FileEntry[], pin = false): void {
    // A pinned band is *the* landing band: the one the fling is predicted to
    // stop on right now. Pins from the previous frame's prediction are stale
    // the moment a new band is named, and stale pins that could not be
    // cancelled are how a long fast scroll starved the tiles actually on
    // screen -- so every new band starts by releasing the old one, and only
    // one batch's worth of the new one is ever pinned.
    if (pin) this.unpin();
    let pins = 0;
    entries.forEach((entry, i) => {
      if (entry.kind !== "image" && entry.kind !== "video") return;
      const key = this.keyOf(entry);
      if (this.cache.has(key)) return;
      const doPin = pin && pins < PIN_MAX;
      if (this.pending.has(key)) {
        // Already asked for -- by a tile the fling has since passed, most
        // likely, and marked unwanted on the way. Pinning un-marks it.
        if (doPin) {
          pins += 1;
          this.pinned.add(key);
          this.unwanted.delete(key);
          for (const p of this.probeQueue) if (p.key === key) p.pinned = true;
        }
        return;
      }
      if (doPin) {
        pins += 1;
        this.pinned.add(key);
      }
      void this.get(entry, false, 1 + i);
    });
  }

  /**
   * Release every pin. What was pinned stays queued as an ordinary probe, so
   * a `cancel` from the observer now takes effect on it like on any other.
   */
  unpin(): void {
    if (this.pinned.size === 0) return;
    this.pinned.clear();
    for (const p of this.probeQueue) p.pinned = false;
  }

  /**
   * Probe the cache wide, decode narrow.
   *
   * The cheap half goes out in `thumbBatch` round trips of `BATCH` and answers
   * most tiles outright -- from the disk cache or from the platform's own
   * thumbnails. Only a genuine miss is admitted to a decode lane, so a
   * screenful of cached pictures is never held up behind uncached ones.
   */
  private async begin(entry: FileEntry, key: string, urgent: boolean, dist: number): Promise<Painted> {
    /*
     * Documents, before the picture rules turn them away (item 3).
     *
     * These skip the native probe entirely and go straight to a lane. The probe
     * asks Rust's thumbnail cache about a media file; a PDF was never put in it
     * and never will be, so probing one spends a slot in a batch that could
     * have carried a photograph, to be told no. The in-memory cache above has
     * already answered for anything drawn this session, which is the case that
     * actually matters on a scroll back up.
     */
    const doc = drawn(entry);
    if (doc) {
      this.slow += 1;
      const lane = this.docs;
      return await new Promise<Painted>((resolve) => {
        this.enqueue(lane, urgent, {
          key,
          entry,
          cached: null,
          resolve,
          cancelled: this.unwanted.has(key),
          urgent,
        });
        this.pump(lane);
      });
    }

    if (entry.kind !== "image" && entry.kind !== "video") {
      this.pending.delete(key);
      return null;
    }
    // A HEIC, a DNG, a TIFF: the WebView decodes none of them, which is why
    // this used to be an outright refusal and why a phone full of HEIC shots
    // showed a wall of chips. ffmpeg is on the device for video posters and
    // reads all three off the path; `decode` below sends them that way. Only
    // when ffmpeg is missing is refusing still the honest answer.
    if (entry.kind === "image" && !WEB_IMAGE.has(entry.ext) && !this.ffmpegOk) {
      this.pending.delete(key);
      this.pinned.delete(key);
      return null;
    }

    let cached: CachedThumb | null = null;
    try {
      cached = await this.probe(entry, key, urgent, dist);
    } catch {
      cached = null;
    }
    this.pinned.delete(key);

    // Scrolled away while the batch was out, and nothing brought it back:
    // release the tile now rather than parking a cancelled job in a lane.
    // `get` clears the flag when the tile returns, so this is exact.
    if (!cached?.blob && this.unwanted.has(key)) {
      this.unwanted.delete(key);
      this.pending.delete(key);
      return SKIPPED;
    }

    if (cached?.blob) {
      if (cached.exact) this.hits += 1;
      else this.exif += 1;
      let blob = cached.blob;
      // A fresh EXIF thumbnail from a rotated shot arrives sideways; bake the
      // parent file's orientation in and cache the corrected pixels, so every
      // later probe is an exact hit that needs no rotating. Rust deliberately
      // refuses to write these through unrotated — this is the other half.
      if (!cached.exact && cached.orientation > 1) {
        blob = await upright(blob, cached.orientation);
        void deadline(this.fs.thumbStore(cached.key, blob), 10_000, undefined).catch(() => {});
      }
      const url = URL.createObjectURL(blob);
      this.remember(key, url);
      this.pending.delete(key);
      this.tally(entry, 0);
      return url;
    }

    this.slow += 1;
    const lane = this.laneFor(entry);
    return await new Promise<Painted>((resolve) => {
      this.enqueue(lane, urgent, {
        key,
        entry,
        cached,
        resolve,
        // A tile can leave the viewport during the probe, and `cancel` had
        // nothing to mark while the job did not exist yet.
        cancelled: this.unwanted.has(key),
        urgent,
      });
      this.pump(lane);
    });
  }

  /**
   * One tile's share of the next batch.
   *
   * Every request made in the same task -- and an IntersectionObserver hands
   * over a whole row or screen of them in one callback -- lands in the queue
   * and goes out together at the next microtask. See `flush` for the order.
   */
  private probe(entry: FileEntry, key: string, urgent: boolean, dist: number): Promise<CachedThumb | null> {
    return new Promise<CachedThumb | null>((resolve) => {
      this.probeQueue.push({ key, entry, urgent, dist, pinned: this.pinned.has(key), resolve });
      if (!this.probeFlushQueued) {
        this.probeFlushQueued = true;
        queueMicrotask(() => {
          this.probeFlushQueued = false;
          this.flush();
        });
      }
    });
  }

  /**
   * Send what is waiting, most wanted first, up to `BATCHES` at a time.
   *
   * Order: on-screen tiles, then by distance -- with tiles behind the scroll
   * direction pushed back (see `ThumbLoader`), because the tiles the user is
   * about to see are worth more than the ones they just flicked past. Tiles
   * that left the viewport while waiting are dropped here, before they cost
   * a round trip; `begin` turns their null into SKIPPED.
   */
  private flush(): void {
    if (this.disposed) {
      for (const p of this.probeQueue) p.resolve(null);
      this.probeQueue.length = 0;
      return;
    }
    // Drop what scrolled away first, so a fling's leftovers never make a batch.
    const keep: Probe[] = [];
    for (const p of this.probeQueue) {
      if (this.unwanted.has(p.key) && !p.pinned) p.resolve(null);
      else keep.push(p);
    }
    this.probeQueue = keep;
    while (this.batchesOut < BATCHES && this.probeQueue.length > 0) {
      // The fling's landing band first: during the fling, the on-screen tiles
      // are the ones streaming past, and a batch spent on them is a batch
      // whose answers arrive for tiles that have already been unmounted.
      this.probeQueue.sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || Number(b.urgent) - Number(a.urgent) || a.dist - b.dist,
      );
      const batch = this.probeQueue.splice(0, BATCH);
      this.batchesOut += 1;
      void this.send(batch);
    }
  }

  private async send(batch: Probe[]): Promise<void> {
    const t0 = performance.now();
    let got: (CachedThumb | null)[] = [];
    try {
      got = await deadline(
        this.fs.thumbBatch(batch.map((p) => p.entry), DECODE_PX, true),
        BATCH_MS,
        [],
      );
    } catch {
      got = [];
    }
    const ms = performance.now() - t0;
    this.batchN += 1;
    this.batchMs += ms;
    this.batchTiles += batch.length;
    if (this.batchN === 4 || this.batchN % 32 === 0) {
      mark(
        `batch #${this.batchN} tiles=${this.batchTiles} last=${batch.length}@${Math.round(ms)}ms` +
          ` avg=${Math.round(this.batchMs / this.batchN)}ms`,
      );
    }
    batch.forEach((p, i) => p.resolve(got[i] ?? null));
    this.batchesOut -= 1;
    this.lastBusyAt = performance.now();
    this.flush();
  }

  /**
   * This tile is off screen — do not bother.
   *
   * Only meaningful before the job starts; a decode already in flight is left to
   * finish and populate the cache, since cancelling it mid-way wastes the work
   * already done and the user may well scroll back.
   */
  cancel(entry: FileEntry): void {
    const key = this.keyOf(entry);
    if (this.pinned.has(key)) return;
    // The job may still be inside its cache probe and not yet queued, so the
    // intent is recorded by key as well as flipped on any queued job.
    if (this.pending.has(key)) this.unwanted.add(key);
    for (const job of this.laneFor(entry).queue) {
      if (job.key === key) job.cancelled = true;
    }
  }

  /**
   * Fill the disk cache for clips nobody has looked at yet.
   *
   * A poster frame costs ffmpeg about 350 ms on this phone, once, ever -- but
   * "once, ever" is no comfort if it is spent while you are scrolling past the
   * tile. Seven hundred clips is four minutes of work that the device is
   * otherwise idle for, so it gets done in the background and the gallery is
   * simply never slow again.
   *
   * Deliberately outside the lane machinery: nothing here holds a blob URL or
   * touches the in-memory cache, because warming a thousand tiles into a cache
   * sized for three hundred would evict the ones actually on screen. It writes
   * to disk and drops the bytes. It also yields to real work -- one item at a
   * time, and only while both lanes are empty -- so a scroll always wins.
   */
  warm(entries: readonly FileEntry[]): void {
    // The whole roll, not just clips. A photograph with no EXIF thumbnail
    // costs a real decode the first time it is seen, and on a fling that
    // decode is exactly the dark tile the user is looking at. The probe below
    // skips everything that already has a picture in the disk cache -- EXIF
    // carriers included -- so after one full pass, ever, every tile anywhere
    // in the roll is a ~15 ms cache hit and the gallery scrolls with no
    // visible loading at all. Entries arrive newest-first, which is also the
    // order the user scrolls, so cover grows in the direction it is needed.
    this.warmList = entries.filter(
      (e) => (e.kind === "video" || e.kind === "image") && e.modified !== undefined,
    );
    if (!this.warming) void this.warmLoop();
  }

  private async warmLoop(): Promise<void> {
    this.warming = true;
    try {
      while (this.warmAt < this.warmList.length) {
        if (this.disposed) return;
        // Quiet for a full second before touching the CPU again. Checking
        // `busy` alone was not enough: a fling empties the lanes for a few
        // milliseconds between rows, the warm pass took that as permission,
        // and a poster started then still owns a core when the next row of
        // tiles arrives. Measured on the phone at vid=41@830ms during a fast
        // scroll against about 310 ms for the same work unopposed.
        //
        // The wait belongs on the blocked branch only. Sleeping before every
        // item capped the pass at four a second even when it was doing nothing
        // but skipping clips already in the cache -- and after one full pass
        // almost every item is a skip, so it never reached the work again.
        if (this.busy || performance.now() - this.lastBusyAt < QUIET_MS) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        await new Promise((r) => setTimeout(r, 0));

        // One round trip settles a dozen tiles: everything already on disk
        // comes back `exact` and is skipped, and everything the platform can
        // thumbnail itself is written to disk on the way past -- which on
        // Android is nearly the whole roll, so the pass that used to take a
        // slow decode per tile now takes one call per dozen. Only what the
        // platform could not make falls through to the per-tile work below.
        const band = this.warmList.slice(this.warmAt, this.warmAt + WARM_BATCH);
        this.warmAt += band.length;
        if (band.length === 0) continue;
        let flags: (CachedThumb | null)[] = [];
        try {
          flags = await deadline(this.fs.thumbBatch(band, DECODE_PX, false), BATCH_MS, []);
        } catch {
          flags = [];
        }
        this.warmed += flags.filter((f) => f?.exact).length;
        if (this.warmed - this.warmedMarked >= 200) {
          this.warmedMarked = this.warmed;
          mark(`warm ${this.warmed}/${this.warmList.length}`);
        }
        for (let i = 0; i < band.length; i += 1) {
          if (flags[i]?.exact) continue;
          if (this.disposed) return;
          if (this.busy || performance.now() - this.lastBusyAt < QUIET_MS) {
            await new Promise((r) => setTimeout(r, 250));
          }
          await this.warmOne(band[i]);
        }
      }
      if (this.warmed > 0) mark(`warm done ${this.warmed}`);
    } finally {
      this.warming = false;
    }
  }

  private warmedMarked = 0;

  /** The old per-tile warm: for what the platform thumbnailer could not make. */
  private async warmOne(entry: FileEntry | undefined): Promise<void> {
    if (!entry) return;
    try {
      // Each await bounded for the same reason as `probe`: one lost IPC
      // response must skip one clip, not silently end the warm pass.
      const cached = await deadline(this.fs.thumbCached(entry), 8_000, null);
      if (!cached) return;
      if (cached.blob) {
        // An EXIF thumbnail carrying a rotation is not yet on disk — Rust
        // won't write it sideways. Normalize it here so the whole roll is
        // upright after one warm pass, not only the tiles somebody viewed.
        if (!cached.exact && cached.orientation > 1) {
          const fixed = await upright(cached.blob, cached.orientation);
          await deadline(this.fs.thumbStore(cached.key, fixed), 10_000, undefined);
          this.warmed += 1;
        }
        return;
      }
      // `posterAt` is for clips only -- on a still, seeking to one second
      // asks ffmpeg for a frame the file does not have.
      const at = entry.kind === "video" ? this.posterAt(entry) : 0;
      const bytes = await deadline(
        this.fs.frameAt(entry.path, at, DECODE_PX),
        20_000,
        null,
      );
      if (bytes && bytes.byteLength > 0) {
        await deadline(
          this.fs.thumbStore(cached.key, new Blob([bytes], { type: "image/jpeg" })),
          10_000,
          undefined,
        );
        this.warmed += 1;
      }
    } catch (e) {
      if (String(e).includes("could not be started")) {
        this.ffmpegOk = false;
        this.warmAt = this.warmList.length;
      }
    }
  }

  /** True while anything on screen is waiting for a picture. */
  private get busy(): boolean {
    return this.lanes.some((l) => l.active > 0 || l.queue.length > 0);
  }

  private get lanes(): readonly Lane[] {
    return [this.stills, this.clips, this.docs];
  }

  private laneFor(entry: FileEntry): Lane {
    if (entry.kind === "video") return this.clips;
    if (drawn(entry)) return this.docs;
    return this.stills;
  }

  /** Drop everything and release the blobs. Called when the shell unmounts. */
  dispose(): void {
    this.disposed = true;
    this.warmList = [];
    this.pinned.clear();
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.pending.clear();
    for (const lane of this.lanes) {
      for (const job of lane.queue) job.resolve(SKIPPED);
      lane.queue.length = 0;
    }
  }

  /**
   * Path plus mtime plus size.
   *
   * mtime alone is not enough — some tools preserve it across a rewrite — and
   * path alone means an edited photo keeps showing the picture it used to be,
   * which in an app whose whole purpose is redaction is the one stale-cache bug
   * that actually matters.
   */
  private keyOf(entry: FileEntry): string {
    return `${entry.path}|${entry.modified ?? 0}|${entry.size ?? 0}`;
  }

  /**
   * Two priorities in one LIFO. A tile that is on screen right now goes on
   * top and is popped next; one that merely entered the look-ahead margin
   * goes underneath every waiting on-screen tile, so a fling that brings two
   * screens of margin along cannot push what the user is looking at behind
   * what they might look at.
   */
  private enqueue(lane: Lane, urgent: boolean, job: Job): void {
    if (urgent) {
      lane.queue.push(job);
      return;
    }
    // Under the urgent ones, above older margin work: newest margin first.
    let i = lane.queue.length;
    while (i > 0 && lane.queue[i - 1]?.urgent) i -= 1;
    lane.queue.splice(i, 0, job);
  }

  private pump(lane: Lane): void {
    while (lane.active < lane.width && lane.queue.length > 0) {
      // LIFO: the newest request is the one nearest the viewport, because the
      // observer fires for tiles as they arrive. Draining oldest-first on a
      // fast scroll paints the screen you have already left.
      const job = lane.queue.pop();
      if (!job) return;
      if (job.cancelled) {
        this.unwanted.delete(job.key);
        this.pending.delete(job.key);
        job.resolve(SKIPPED);
        continue;
      }
      lane.active += 1;
      this.lastBusyAt = performance.now();
      void this.run(lane, job);
    }
  }

  private async run(lane: Lane, job: Job): Promise<void> {
    let url: string | null = null;
    const t0 = performance.now();
    try {
      url = await this.decode(job.entry, job.cached);
    } catch (e) {
      // Unreadable file, revoked permission, a codec that lied about support.
      // All of them are "no picture", none of them are worth a console trace on
      // a scroll that may produce hundreds of them.
      url = null;
      this.noteNull(job.entry, `threw ${String(e).slice(0, 80)}`);
    }

    const ms = performance.now() - t0;
    this.tally(job.entry, ms);
    if (this.done === 16 || this.done % 64 === 0) {
      const avg = (n: number, total: number) => (n ? Math.round(total / n) : 0);
      mark(
        `thumb #${this.done} last=${Math.round(ms)}ms` +
          ` cache=${this.hits} exif=${this.exif} slow=${this.slow}` +
          ` vid=${this.vidN}@${avg(this.vidN, this.vidMs)}ms` +
          ` img=${this.imgN}@${avg(this.imgN, this.imgMs)}ms`,
      );
    }

    if (url !== null) this.remember(job.key, url);
    this.pending.delete(job.key);
    job.resolve(url);

    this.lastBusyAt = performance.now();
    lane.active -= 1;
    this.pump(lane);
  }

  /** First two dozen decode-path nulls, with where they came from. Diagnostic
   *  for the 2026-08-31 stuck-viewport hunt: a tile that resolves null again
   *  and again is failing somewhere specific, and the tally cannot say where. */
  private nullMarks = 0;
  private noteNull(entry: FileEntry, why: string): void {
    if (this.nullMarks >= 24) return;
    this.nullMarks += 1;
    mark(`nul ${why} ${entry.kind}.${entry.ext} ${entry.size ?? 0}b …${entry.path.slice(-36)}`);
  }

  /** Count one finished tile. Misses only for the averages: folding cache hits
   *  in drags every figure toward ten milliseconds and hides the tiles that are
   *  actually costing the scroll. */
  private tally(entry: FileEntry, ms: number): void {
    this.done += 1;
    if (ms <= 40) return;
    if (entry.kind === "video") {
      this.vidN += 1;
      this.vidMs += ms;
    } else {
      this.imgN += 1;
      this.imgMs += ms;
    }
  }

  private remember(key: string, url: string): void {
    this.cache.set(key, url);
    if (this.cache.size <= CACHE_MAX) return;

    // Oldest first, but never one that a mounted tile is showing. Revoking a
    // URL out from under a live `<img>` empties that tile on screen and nothing
    // asks again, because as far as the loader is concerned it is painted. The
    // cache is therefore allowed to run over the cap by however much the
    // viewport band is holding, which is bounded by the band, not by the roll.
    for (const k of Array.from(this.cache.keys())) {
      if (this.cache.size <= CACHE_MAX) break;
      if (k === key || (this.live.get(k) ?? 0) > 0) continue;
      const dead = this.cache.get(k);
      if (dead !== undefined) URL.revokeObjectURL(dead);
      this.cache.delete(k);
    }
  }

  /** This entry's picture is on screen: hold its blob. */
  retain(entry: FileEntry): void {
    const key = this.keyOf(entry);
    this.live.set(key, (this.live.get(key) ?? 0) + 1);
  }

  /** The tile showing this entry has been unmounted. */
  release(entry: FileEntry): void {
    const key = this.keyOf(entry);
    const n = (this.live.get(key) ?? 0) - 1;
    if (n > 0) this.live.set(key, n);
    else this.live.delete(key);
  }

  /** Throw away a URL that would not decode, so the next ask re-makes it. */
  drop(entry: FileEntry): void {
    const key = this.keyOf(entry);
    const url = this.cache.get(key);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      this.cache.delete(key);
    }
    this.live.delete(key);
  }

  /**
   * Everything the cache could not answer.
   *
   * The native probe has already run in `begin` -- it is cheap and belongs
   * outside the lanes -- so `cached` here is either null or a key with no
   * picture attached, and this method is only ever the expensive path.
   */
  private async decode(
    entry: FileEntry,
    cached: CachedThumb | null,
  ): Promise<string | null> {
    if (entry.kind === "video") {
      const poster = await this.videoPoster(entry);
      if (poster && cached) void this.keepPoster(cached.key, poster);
      if (!poster) this.noteNull(entry, `poster ffmpeg=${this.ffmpegOk}`);
      return poster;
    }

    // A PDF cover, a text page, or an APK's launcher icon (item 3). Bounded for
    // the same reason every other await in this file is: a document that hangs
    // -- a PDF whose xref sends pdfjs chasing its tail, a corrupt zip -- must
    // cost one tile its picture, never a lane for the life of the process.
    if (drawn(entry)) {
      const blob = await deadline(docThumb(this.fs, entry.path, entry.ext, DOC_PX), 8_000, null);
      if (!blob) {
        this.noteNull(entry, "doc");
        return null;
      }
      return URL.createObjectURL(blob);
    }

    // A photograph carrying no embedded thumbnail is the expensive case, and it
    // is not rare -- screenshots, anything re-encoded by a messenger, and most
    // PNGs have no EXIF block to raid. The three lines below hand the *whole
    // original* across the IPC boundary, eight megabytes for a 12 MP frame, so
    // the WebView can decode it a second time and throw all but 384 px away.
    //
    // ffmpeg is already on the device for video posters and reads a still just
    // as happily, straight off the path, returning only the few kilobytes that
    // survive the scale. Gated on size because spawning a process costs tens of
    // milliseconds and a small file loses that race; past a megabyte the copy
    // dominates and ffmpeg wins by a wide margin.
    // GIF ignores the size threshold on purpose. The gate above is a bet that
    // a small file loses the race against process spawn, and for a small JPEG
    // that is true. A GIF is the one format where it is false at every size:
    // it never carries an EXIF thumbnail so it always lands here, and the
    // WebView path does not decode one frame of it -- it decodes and composes
    // the whole animation, every frame, at full size, only to throw all but a
    // 384 px still away. ffmpeg reads frame zero and stops.
    const animated = entry.ext === "gif";
    // A format the WebView cannot decode at all -- HEIC, DNG, TIFF -- ignores
    // the size threshold for the same reason GIF does: the gate is a bet that
    // a small file loses the race against process spawn, and that bet is only
    // meaningful when there is a second route that could win it.
    const foreign = entry.kind === "image" && !WEB_IMAGE.has(entry.ext);
    if (this.ffmpegOk && (animated || foreign || (entry.size ?? 0) > 1_000_000)) {
      try {
        // Bounded: this await holds a decode lane, and four hung `frame_at`
        // responses would take the stills lane down exactly the way the probe
        // gate went down. A timeout falls through to the WebView path below.
        const bytes = await deadline(this.fs.frameAt(entry.path, 0, DECODE_PX), 15_000, null);
        if (bytes && bytes.byteLength > 0) {
          const jpeg = new Blob([bytes], { type: "image/jpeg" });
          if (cached) void this.fs.thumbStore(cached.key, jpeg);
          return URL.createObjectURL(jpeg);
        }
      } catch (e) {
        if (String(e).includes("could not be started")) this.ffmpegOk = false;
      }
    }

    const src = await this.fs.thumbnail(entry, DECODE_PX);
    if (!src) {
      this.noteNull(entry, "nosrc");
      return null;
    }

    const blob = await (await fetch(src)).blob();

    // Off-thread when the worker started, on-thread when it did not. The
    // fallback is not a formality: a worker is one more thing that can fail to
    // load, and a slow gallery is a far better outcome than an empty one.
    let small: Blob | null = null;
    if (this.shrinker) {
      // Bounded: a worker that loads but never answers would hold a decode
      // lane forever. On timeout the tile draws its chip; the main-thread
      // fallback still exists for the case where the worker declares itself
      // dead.
      small = await deadline(this.shrinker.shrink(blob, DECODE_PX), 10_000, null);
      if (!small) {
        if (!this.shrinker.dead) {
          this.noteNull(entry, "shrink-worker-timeout");
          return null;
        }
        this.shrinker = null;
      }
    }
    if (!small) small = await this.shrink(blob);
    if (!small) {
      this.noteNull(entry, "shrink");
      return null;
    }

    // Not awaited: the tile has its picture and the write is for the next
    // launch, not this one. A failure in there is swallowed by `thumbStore`.
    if (cached) void this.fs.thumbStore(cached.key, small);
    return URL.createObjectURL(small);
  }

  /**
   * Put a poster frame in the cache.
   *
   * The blob URL is already made and handed to the tile, so this reads it back
   * rather than threading the blob out of four levels of promise. A fetch of a
   * `blob:` URL is a memory copy, and it happens once per video ever -- against
   * the four to seventeen seconds the frame cost to extract, it does not
   * register.
   */
  private async keepPoster(key: string, url: string): Promise<void> {
    try {
      await this.fs.thumbStore(key, await (await fetch(url)).blob());
    } catch {
      // Same as any other cache write: a miss next launch, nothing worse.
    }
  }

  /**
   * Blob → small blob, scaled during decode.
   *
   * The `resizeWidth`/`resizeHeight` pair is left one-sided on purpose:
   * supplying only the long edge preserves the aspect ratio, and the tile crops
   * with `object-fit: cover`, so a thumbnail that is square-cropped here would
   * throw away the pixels a portrait tile wants.
   */
  private async shrink(blob: Blob): Promise<Blob | null> {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob, {
        resizeWidth: DECODE_PX,
        resizeQuality: "medium",
      });
    } catch {
      // Some WebViews reject the resize options rather than ignoring them.
      // Falling back to a full decode is still better than a blank tile; the
      // LRU keeps the damage bounded.
      bmp = await createImageBitmap(blob);
    }

    // Already small enough that re-encoding costs more than it saves.
    if (bmp.width <= DECODE_PX && blob.size < 96_000) {
      bmp.close();
      return blob;
    }

    const scale = Math.min(1, DECODE_PX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close();
      return null;
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();

    const out = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.78);
    });
    canvas.width = 0;
    canvas.height = 0;

    return out;
  }

  /**
   * One frame, via ffmpeg.
   *
   * Taken a second in rather than at zero: the first frame of a phone video is
   * very often the shutter's black frame or an autoexposure flash, and a wall of
   * black rectangles is indistinguishable from a wall of failed thumbnails.
   * Clips shorter than that fall back to the midpoint.
   *
   * `ffmpegOk` latches off after the first failure. On a build without the
   * sidecar every video would otherwise pay a full IPC round trip to be told no,
   * once per tile, forever.
   */
  private posterAt(entry: FileEntry): number {
    return entry.duration !== undefined && entry.duration < 2 ? entry.duration / 2 : 1;
  }

  private async videoPoster(entry: FileEntry): Promise<string | null> {
    const at = this.posterAt(entry);

    // ffmpeg first. The comment that used to sit here said there was no ffmpeg
    // on Android, so this tried the WebView first and fell back to the binary.
    // That stopped being true when ffmpeg started shipping as
    // `jniLibs/arm64-v8a/libffmpeg.so` (see `native_lib_dir` in ffmpeg.rs), and
    // leaving the order alone cost the whole gallery: the WebView path has to
    // attach an element, wait for metadata, seek, wait for `seeked`, paint a
    // canvas and encode it -- four to seventeen seconds a clip on this phone --
    // while ffmpeg seeks with `-ss` ahead of `-i` and writes one already-scaled
    // JPEG in a few hundred milliseconds.
    //
    // The fallback still earns its place: a codec ffmpeg was not built with is
    // sometimes one the phone has in hardware, so a clip ffmpeg cannot open is
    // still worth handing to the WebView.
    if (this.ffmpegOk) {
      try {
        // Bounded — holds the clips lane; a timeout falls back to the WebView
        // decoder, which carries its own two-second metadata timer.
        const bytes = await deadline(this.fs.frameAt(entry.path, at, DECODE_PX), 15_000, null);
        if (bytes && bytes.byteLength > 0) {
          return URL.createObjectURL(
            new Blob([bytes], { type: "image/jpeg" }),
          );
        }
      } catch (e) {
        // Two unrelated failures arrive here as one rejection, because the Rust
        // side returns `Err` for both. A clip with no decodable frame at this
        // offset is that clip's problem. A binary that will not spawn is every
        // clip's problem, and only that one is worth latching off. Telling them
        // apart by message is unlovely, but the alternative is one unreadable
        // video putting the entire gallery back on the slow path for the life
        // of the process -- which is the exact bug this reordering fixes.
        if (String(e).includes("could not be started")) this.ffmpegOk = false;
      }
    }

    return await this.videoFrame(entry, at);
  }

  /**
   * One frame, decoded by the WebView's own video pipeline.
   *
   * Serialised through `videoLane` rather than run at `LANES` width: a phone
   * has a small fixed number of hardware video decoders -- four is typical --
   * and asking for a fifth does not queue, it fails. Four video tiles arriving
   * together would take every decoder in the device, including the one the
   * viewer needs if the user taps a clip while the grid is still filling.
   */
  private videoFrame(entry: FileEntry, at: number): Promise<string | null> {
    const run = this.videoLane.then(() => this.grabFrame(entry, at));
    // The lane has to survive a failure, or one unreadable clip poisons every
    // video thumbnail queued behind it.
    this.videoLane = run.catch(() => null);
    return run.catch(() => null);
  }

  private async grabFrame(entry: FileEntry, at: number): Promise<string | null> {
    const src = await this.fs.thumbnail(entry, DECODE_PX);
    if (!src) return null;

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    // Off screen but in the document and laid out. A decoder is allowed to skip
    // producing output for an element that was never attached, which comes back
    // as an all-black canvas rather than as an error.
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.append(video);

    try {
      return await new Promise<string | null>((resolve) => {
        // A clip whose metadata never arrives -- a truncated download, a codec
        // this device does not have -- must not hold the single lane open.
        //
        // Two seconds, not four. This lane is serialised, so the timeout is
        // paid in full by every clip queued behind the one that is failing:
        // measured at vid=8@6500ms across a long scroll, where the same work
        // through ffmpeg costs about 300 ms. Metadata for a file on local
        // storage either arrives promptly or is not coming.
        const timer = window.setTimeout(() => finish(null), 2000);

        const finish = (url: string | null): void => {
          window.clearTimeout(timer);
          video.removeAttribute("src");
          video.load();
          resolve(url);
        };

        const draw = (): void => {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          if (vw === 0 || vh === 0) {
            finish(null);
            return;
          }

          const scale = Math.min(1, DECODE_PX / Math.max(vw, vh));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(vw * scale));
          canvas.height = Math.max(1, Math.round(vh * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            finish(null);
            return;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (out) => {
              canvas.width = 0;
              canvas.height = 0;
              finish(out ? URL.createObjectURL(out) : null);
            },
            "image/jpeg",
            0.78,
          );
        };

        video.onerror = () => { finish(null); };
        video.onloadeddata = () => {
          // Seeking past the end leaves `seeked` unfired on some decoders, so
          // the target is clamped inside the clip.
          const want = Number.isFinite(video.duration) && video.duration > 0
            ? Math.min(at, Math.max(0, video.duration - 0.05))
            : 0;
          if (Math.abs(video.currentTime - want) < 0.01) draw();
          else {
            video.onseeked = draw;
            video.currentTime = want;
          }
        };

        video.src = src;
      });
    } finally {
      video.remove();
    }
  }
}

/**
 * The worker that does the decoding, wrapped in one promise per request.
 *
 * `tryCreate` returns null rather than throwing when workers or OffscreenCanvas
 * are unavailable, because the caller has a working -- if slower -- main-thread
 * path, and an exception here would take the whole gallery down with it.
 */
class Shrinker {
  static tryCreate(): Shrinker | null {
    try {
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
      const worker = new Worker(new URL("./thumb-worker.ts", import.meta.url), { type: "module" });
      return new Shrinker(worker);
    } catch {
      return null;
    }
  }

  /** Set when the worker failed in a way that means it will keep failing. */
  dead = false;

  private next = 1;
  private waiting = new Map<number, (blob: Blob | null) => void>();

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<{ id: number; blob?: Blob }>) => {
      const done = this.waiting.get(ev.data.id);
      if (!done) return;
      this.waiting.delete(ev.data.id);
      done(ev.data.blob ?? null);
    };
    worker.onerror = () => {
      // A worker that failed to load never answers, so every request already
      // in flight has to be released or those tiles wait forever.
      this.dead = true;
      for (const done of this.waiting.values()) done(null);
      this.waiting.clear();
    };
  }

  shrink(blob: Blob, px: number): Promise<Blob | null> {
    if (this.dead) return Promise.resolve(null);
    const id = this.next++;
    return new Promise<Blob | null>((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ id, blob, px });
    });
  }
}

/**
 * Draw thumbnails into tiles as they approach the viewport.
 *
 * One observer for the whole grid rather than one per tile: a camera roll can
 * mount a few thousand tiles, and a few thousand `IntersectionObserver`s is
 * itself the jank. `rootMargin` runs a screen and a half ahead so a normal
 * scroll never outruns the decode.
 */
export class ThumbLoader {
  private io: IntersectionObserver;
  private bound = new WeakMap<Element, FileEntry>();

  private readonly root: Element | null;
  private lastTop = 0;

  constructor(private readonly thumbs: Thumbs, root: Element | null) {
    this.root = root;
    this.io = new IntersectionObserver(
      (entries) => {
        this.noteDirection();
        for (const record of entries) {
          const entry = this.bound.get(record.target);
          if (!entry) continue;
          const host = record.target as HTMLElement;
          if (record.isIntersecting) {
            this.inRange.add(host);
            void this.paint(host, entry);
          } else {
            this.inRange.delete(host);
            this.thumbs.cancel(entry);
          }
        }
      },
      // One screen ahead. Half a screen was the anti-backlog setting from the
      // era when a probe held a decode lane and every miss was a full decode;
      // with the probe pool split out and the whole-roll warm pass filling the
      // disk cache, the common case is a ~15 ms cache hit, and asking for it a
      // screen early is what makes a tile already painted by the time it
      // scrolls on. Cancel still discards what a fling passes, so the backlog
      // stays bounded at twice the old margin, not thousands.
      { root, rootMargin: "100% 0px", threshold: 0 },
    );
  }

  /** Watch `host` (a tile), and fill its `<img>` when it comes near. */
  observe(host: HTMLElement, entry: FileEntry): void {
    this.bound.set(host, entry);
    this.io.observe(host);
  }

  /** Stop watching a tile that is being unmounted. */
  forget(host: HTMLElement): void {
    this.io.unobserve(host);
    this.inRange.delete(host);
    const entry = this.bound.get(host);
    if (entry && this.painted.delete(host)) this.thumbs.release(entry);
    this.bound.delete(host);
  }

  disconnect(): void {
    this.io.disconnect();
  }

  /** Tiles whose `<img>` currently holds a retained blob. */
  private painted = new WeakSet<HTMLElement>();
  /** Tiles the observer currently reports inside root plus margin. */
  private inRange = new Set<HTMLElement>();

  /** Is this tile on screen, give or take half a screen? */
  private nearViewport(host: HTMLElement): boolean {
    const r = host.getBoundingClientRect();
    const h = window.innerHeight || 1;
    return r.bottom > -h / 2 && r.top < h * 1.5;
  }

  /**
   * Which way the grid moved since the last callback. One scroll-offset read
   * per observer callback, not per frame; the sign is all `Thumbs.flush` uses.
   */
  private noteDirection(): void {
    const top = this.root ? this.root.scrollTop : window.scrollY;
    if (top > this.lastTop) this.thumbs.direction = 1;
    else if (top < this.lastTop) this.thumbs.direction = -1;
    this.lastTop = top;
  }

  /**
   * How far a tile is from the viewport, in pixels, 0 when it is on screen.
   *
   * Tiles behind the direction of travel count three times as far: after a
   * fling downward the look-ahead margin holds a screen of tiles above the
   * viewport that the user has just left, and they must not be sent for
   * before the ones about to arrive from below.
   */
  private distance(r: DOMRect): number {
    const h = window.innerHeight || 1;
    if (r.width <= 0) return h * 8;
    if (r.bottom > 0 && r.top < h) return 0;
    const below = r.top >= h;
    const d = below ? r.top - h : -r.bottom;
    const behind = below ? this.thumbs.direction < 0 : this.thumbs.direction > 0;
    return behind ? d * 3 : d;
  }

  /**
   * A skipped tile asks again -- but only once it is close to the screen.
   *
   * The previous retry re-requested from wherever the tile was, every half
   * second, for as long as it stayed inside the observer's margin. After a
   * fling that is two screens of tiles nobody is looking at, each re-entering
   * the decode queue on a timer and each cancelled again by the next scroll:
   * the worker was saturated with work that never painted. Now a far tile
   * only checks its position (one rect read, no queueing) and asks for the
   * picture when it is about to matter; leaving the margin stops the timer.
   */
  private retryWhenNear(host: HTMLElement, entry: FileEntry): void {
    const tick = (): void => {
      if (this.bound.get(host) !== entry || !this.inRange.has(host)) return;
      if (this.nearViewport(host)) {
        void this.paint(host, entry);
        return;
      }
      window.setTimeout(tick, 250);
    };
    window.setTimeout(tick, this.nearViewport(host) ? 80 : 250);
  }

  private async paint(host: HTMLElement, entry: FileEntry): Promise<void> {
    const img = host.querySelector("img");
    if (!img || img.dataset.loaded === "1") return;

    const dist = this.distance(host.getBoundingClientRect());
    const url = await this.thumbs.get(entry, dist === 0, dist);
    // The tile may have been recycled onto a different file while we waited.
    if (this.bound.get(host) !== entry) return;

    // Skipped, not undrawable. The job was dropped -- either this tile left the
    // viewport, or it fell off the end of an overfull queue -- but the observer
    // will not fire for it a second time while it stays intersecting, so if
    // nobody asks again the tile stays empty for good.
    //
    // On a timer rather than `requestAnimationFrame`, and slower when the tile
    // is nowhere near the screen. A frame-rate retry is a busy loop that fights
    // the very decodes it is waiting for, and after the queue cap went in there
    // can be a lot of tiles retrying at once. On screen: about twelve tries a
    // second, which is far quicker than a decode. Off screen: twice a second,
    // enough to be correct and too little to matter.
    if (url === SKIPPED) {
      this.retryWhenNear(host, entry);
      return;
    }
    if (!url) {
      // Null is a real answer -- draw the chip -- but only from a file that
      // could never have a picture. From a decodable one it is nearly always
      // a casualty instead: a deadline fired, or the asset fetch died in the
      // same IPC burst that once took the probe gate down, and since the
      // observer never fires twice for a tile that stays intersecting, an
      // unretried null is a tile blank for the life of the mount -- the
      // August 17 screenful of 2026-08-31, stuck while every freshly mounted
      // neighbour painted. Bounded and backing off, so a genuinely corrupt
      // file costs three quiet retries and then its chip, not a spin.
      const decodable =
        entry.kind === "video" ||
        entry.kind === "image" ||
        // A document null is usually as final as an unsupported extension --
        // an APK with no recognisable icon, a PDF that will not parse -- but
        // not always: the render can also lose an IPC response or trip the
        // deadline above, and those are the exact casualties this retry exists
        // for. Three quiet attempts, then the chip.
        drawn(entry);
      if (!decodable) return;
      const tries = Number(img.dataset.nullTries ?? "0") + 1;
      if (tries > 3) return;
      img.dataset.nullTries = String(tries);
      window.setTimeout(() => void this.paint(host, entry), 2000 * tries);
      return;
    }

    img.dataset.loaded = "1";
    img.src = url;
    this.painted.add(host);
    this.thumbs.retain(entry);
    // `.ready` is the opacity fade in phone.css — set on decode rather than on
    // assignment so the tile does not flash a half-painted image.
    img.decode().then(
      () => img.classList.add("ready"),
      () => {
        // A blob that will not decode is nearly always one that was revoked
        // while it was still on screen, and the old code simply faded in an
        // empty box and called the tile finished. Drop it and ask again.
        // Bounded, because a genuinely undecodable picture must not spin.
        const tries = Number(img.dataset.tries ?? "0") + 1;
        img.dataset.tries = String(tries);
        if (tries > 3) {
          // Out of retries, and the blob still will not decode. `.ready` must
          // NOT go on here: it is the opacity fade, but it is also what hides
          // `.ph-cell-fallback` (`img.ready ~ .ph-cell-fallback` in phone.css),
          // so setting it faded in a transparent img over the tile's own
          // background and took the chip away with it -- a plain black square
          // that says nothing, which is exactly what a wall of undecodable
          // DNG/TIFF/HEIC/JXL looked like on the phone. Give the src back and
          // let the extension chip stand: "DNG" is the honest answer.
          img.removeAttribute("src");
          // `loaded` stays set. It is the "do not ask again" flag `paint`
          // reads on entry, and a file that has now failed to decode four
          // times must not re-fetch its bytes every time the tile scrolls
          // back into view. A recycled cell gets a fresh `<img>` and its own
          // four tries, which is the retry that is actually worth having.
          this.painted.delete(host);
          this.thumbs.release(entry);
          this.thumbs.drop(entry);
          return;
        }
        img.dataset.loaded = "";
        this.painted.delete(host);
        this.thumbs.release(entry);
        this.thumbs.drop(entry);
        window.setTimeout(() => void this.paint(host, entry), 60);
      },
    );
  }
}
