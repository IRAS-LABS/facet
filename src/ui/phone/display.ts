/**
 * Display-sized copies of originals, for the viewer.
 *
 * A 12 MP JPEG is 48 MB of texture once decoded, and the viewer had three of
 * them on compositor layers during a swipe -- the picture and both neighbour
 * panes -- with every step of a pinch re-rasterising the one under the
 * fingers. The screen is 1080 px wide. So each original is decoded *once*, in
 * the thumbnail worker with the codec scaling it down as it goes, re-encoded
 * to fit the screen exactly (see `displayBox` for why exactly), and handed
 * back as a blob URL. That
 * copy is what gets swiped and pinched; the original is fetched only when a
 * zoom goes past what the copy can honour (see `wantsOriginal`).
 *
 * The copies are kept by path in a small LRU so paging back and forth does
 * not decode the same picture twice, and the URL is revoked when a copy falls
 * out. Every failure path resolves to the original URL, so the worst case is
 * exactly the old behaviour.
 */

import type { FileEntry } from "@core/explorer/types";
import { DISPLAY_KEEP, Lru, displayBox } from "@core/phone/display";
import type { DisplayBox } from "@core/phone/display";
import { SNIFF, isAnimated } from "@core/phone/animated";
import { perf } from "@core/phone/mark";

/** A picture the viewer can put on stage. */
export interface DisplayCopy {
  /** What to swipe and pinch: a blob URL sized for the screen, or the original if none could be made. */
  display: string;
  /** The original, for a deep zoom and for the editor. */
  original: string;
  /** True when `display` is a copy this cache owns and must revoke. */
  owned: boolean;
  /**
   * True when nothing in the WebView can decode `original`, so `display` is
   * the only picture there will ever be. The viewer must not swap the
   * original in for a deep zoom: it would replace a photograph with nothing.
   */
  foreign: boolean;
}

interface Host {
  fileUrl(path: string): Promise<string>;
  /**
   * One frame, decoded natively and returned as JPEG. Optional so the
   * harness can hand in a bare `fileUrl`; on the device it is always there,
   * and it is the only route to HEIC, DNG, TIFF and JXL — the platform
   * thumbnailer and ffmpeg read them, `createImageBitmap` does not.
   */
  frameAt?(path: string, at: number, width: number): Promise<Uint8Array>;
}

/**
 * What the WebView itself can decode.
 *
 * Everything else in `kind === "image"` reaches the stage only through the
 * native decoder. Kept here rather than imported so this file has no opinion
 * about the grid's tables: the question "can `<img>` show this" is local.
 */
const WEB_IMAGE = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "avifs",
  "bmp", "svg", "ico",
]);

/**
 * Can this phone's WebView read that format at all?
 *
 * Asked by the viewer when a picture has failed to load, because the two
 * failures need different words. A `.jxl` nothing on the device can decode is
 * a format problem and there is nothing to be done about it here; a `.png`
 * that fails is a damaged file, and telling someone their phone cannot read
 * PNG is simply false.
 */
export function webCanDecode(ext: string): boolean {
  return WEB_IMAGE.has(ext.toLowerCase());
}

export class DisplayCache {
  private worker: Worker | null = null;
  private workerDead = false;
  private nextId = 1;
  private waiting = new Map<number, (blob: Blob | null) => void>();
  private ready: Lru<DisplayCopy>;
  private pending = new Map<string, Promise<DisplayCopy | null>>();
  /** The box copies are fitted to, in device pixels. */
  box: DisplayBox;

  /** `box`: a number is a square box of that side, for a harness. */
  constructor(private readonly host: Host, box?: number | DisplayBox) {
    this.box = typeof box === "number"
      ? { w: box, h: box }
      : box ?? displayBox(window.innerWidth, window.innerHeight, window.devicePixelRatio);
    this.ready = new Lru<DisplayCopy>(DISPLAY_KEEP, (c) => {
      if (c.owned) URL.revokeObjectURL(c.display);
    });
    try {
      if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
        this.worker = new Worker(new URL("./thumb-worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (ev: MessageEvent<{ id: number; blob?: Blob }>) => {
          const done = this.waiting.get(ev.data.id);
          if (!done) return;
          this.waiting.delete(ev.data.id);
          done(ev.data.blob ?? null);
        };
        this.worker.onerror = () => {
          this.workerDead = true;
          for (const done of this.waiting.values()) done(null);
          this.waiting.clear();
        };
      }
    } catch {
      this.worker = null;
    }
  }

  /** The copy for `entry` if it is already made; never starts work. */
  peek(entry: FileEntry): DisplayCopy | null {
    return this.ready.get(entry.path) ?? null;
  }

  /**
   * Make (or fetch) the copy for `entry`. Resolves null only when even the
   * original's URL could not be had.
   */
  get(entry: FileEntry): Promise<DisplayCopy | null> {
    const hit = this.ready.get(entry.path);
    if (hit) return Promise.resolve(hit);
    const already = this.pending.get(entry.path);
    if (already) return already;
    const job = this.make(entry).finally(() => { this.pending.delete(entry.path); });
    this.pending.set(entry.path, job);
    return job;
  }

  /** Let everything go, revoking what this cache owns. */
  clear(): void {
    this.ready.clear();
  }

  /**
   * The screen changed shape (a rotation): copies fitted to the old box are
   * the wrong size for the new one, so they go. Returns true when it did.
   */
  fitTo(w: number, h: number, dpr: number): boolean {
    const next = displayBox(w, h, dpr);
    if (next.w === this.box.w && next.h === this.box.h) return false;
    this.box = next;
    this.clear();
    return true;
  }

  private async make(entry: FileEntry): Promise<DisplayCopy | null> {
    const t0 = performance.now();
    let original: string;
    try {
      original = await this.host.fileUrl(entry.path);
    } catch {
      return null;
    }
    const t1 = performance.now();
    const fallback: DisplayCopy = { display: original, original, owned: false, foreign: false };

    // A format the WebView cannot decode never goes near the worker: it would
    // spend a fetch of the whole file to learn what the extension already
    // says. The grid has been showing these correctly all along — it asks the
    // platform thumbnailer — and the viewer asking the same question is the
    // difference between a photograph and a black screen.
    if (entry.kind === "image" && !WEB_IMAGE.has(entry.ext)) {
      const native = await this.native(entry, original);
      if (native) {
        this.ready.set(entry.path, native);
        perf(`display ${entry.name} native in ${Math.round(performance.now() - t0)}ms`);
        return native;
      }
      // Fall through: some WebViews decode more than the table admits, and a
      // wasted fetch beats a blank stage.
    }

    if (!this.worker || this.workerDead) {
      this.ready.set(entry.path, fallback);
      return fallback;
    }
    try {
      const blob = await (await fetch(original)).blob();
      const t2 = performance.now();

      // A GIF, an APNG, an animated WebP: the copy is made by drawing one
      // decoded frame into a canvas, and a canvas has no second frame. Every
      // animation in the app came out of here as a still, which read as the
      // file being broken rather than the viewer throwing the rest away.
      // There is no shrinking an animation, so it goes to the <img> whole and
      // the WebView plays it -- the size these files come in is the size they
      // have to be.
      if (isAnimated(new Uint8Array(await blob.slice(0, SNIFF).arrayBuffer()))) {
        perf(`display ${entry.name} animated, kept whole (${Math.round(blob.size / 1024)}k)`);
        this.ready.set(entry.path, fallback);
        return fallback;
      }

      const small = await this.shrink(blob);
      const t3 = performance.now();
      if (!small) {
        // The worker threw, which for a still means `createImageBitmap`
        // refused it. Ask the platform before handing back bytes the <img>
        // will refuse for exactly the same reason.
        const native = await this.native(entry, original);
        if (native) {
          this.ready.set(entry.path, native);
          return native;
        }
        this.ready.set(entry.path, fallback);
        return fallback;
      }
      // The worker hands the input back when the picture was already small
      // enough; a blob URL over it is still cheaper than a second fetch.
      const copy: DisplayCopy = { display: URL.createObjectURL(small), original, owned: true, foreign: false };
      this.ready.set(entry.path, copy);
      perf(
        `display ${entry.name} url ${Math.round(t1 - t0)}ms fetch ${Math.round(t2 - t1)}ms ` +
        `(${Math.round(blob.size / 1024)}k) shrink ${Math.round(t3 - t2)}ms -> ${Math.round(small.size / 1024)}k`,
      );
      return copy;
    } catch {
      const native = await this.native(entry, original);
      if (native) {
        this.ready.set(entry.path, native);
        return native;
      }
      this.ready.set(entry.path, fallback);
      return fallback;
    }
  }

  /**
   * The picture as the phone itself sees it: one JPEG out of the native
   * decoder, sized for the screen.
   *
   * `frame_at` is the same call the grid's stills lane makes for HEIC and raw
   * (thumbs.ts), and on Android it lands in the platform thumbnailer, which
   * has codecs for everything the camera can write. Bounded, because a hung
   * decode must cost one picture and not the viewer.
   */
  private async native(entry: FileEntry, original: string): Promise<DisplayCopy | null> {
    const frameAt = this.host.frameAt;
    if (!frameAt) return null;
    const px = Math.max(this.box.w, this.box.h);
    try {
      const bytes = await Promise.race([
        frameAt.call(this.host, entry.path, 0, px),
        new Promise<null>((r) => window.setTimeout(() => r(null), 15_000)),
      ]);
      if (!bytes || bytes.byteLength === 0) return null;
      const jpeg = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
      return { display: URL.createObjectURL(jpeg), original, owned: true, foreign: true };
    } catch {
      return null;
    }
  }

  private shrink(blob: Blob): Promise<Blob | null> {
    const worker = this.worker;
    if (!worker || this.workerDead) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<Blob | null>((resolve) => {
      // Bounded: a worker that never answers must not hold a swipe hostage.
      const timer = window.setTimeout(() => {
        if (this.waiting.delete(id)) resolve(null);
      }, 8000);
      this.waiting.set(id, (out) => {
        window.clearTimeout(timer);
        resolve(out);
      });
      const box = this.box;
      worker.postMessage({ id, blob, px: Math.max(box.w, box.h), box, display: true });
    });
  }
}
