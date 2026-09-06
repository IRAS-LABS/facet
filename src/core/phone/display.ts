/**
 * The arithmetic behind the viewer's display-sized copies.
 *
 * The viewer used to point the stage and both swipe panes at the original
 * file -- three 12 MP layers moved by the compositor, and re-rasterised at
 * every step of a pinch. What the screen can show is a fraction of that, so
 * the viewer swipes and pinches a copy sized for the screen and fetches the
 * original only once a zoom has gone past what the copy can honour.
 *
 * Pure, so a harness can pin the numbers down.
 */

/** Ceiling on the display copy's long edge, whatever the screen. */
export const DISPLAY_MAX_PX = 2400;

/**
 * Past this zoom the display copy is being stretched more than its extra
 * resolution covers, and the original goes on stage. The copy is the size of
 * the screen exactly (see `displayBox`), so anything past ~1.25x is a visible
 * upscale on a 450 dpi panel.
 */
export const FULL_ZOOM = 1.25;

/** How long a zoom has to hold past `FULL_ZOOM` before the original is fetched. */
export const FULL_SETTLE_MS = 250;

/** Display copies kept by path, decoded bytes not counted. */
export const DISPLAY_KEEP = 12;

/** The box a display copy is fitted into, in device pixels. */
export interface DisplayBox {
  w: number;
  h: number;
}

/**
 * The box for a screen of `w` x `h` CSS px at `dpr`: the screen itself in
 * device pixels, the long edge capped. On a 384x853 screen at 2.8125 that is
 * 1080x2400.
 *
 * Exactly the screen, not the screen's long edge squared, and on purpose. A
 * copy that is drawn at a scale other than 1 is decoded *again* by the
 * compositor at raster time, at the drawn size, on the thread the swipe is
 * waiting for -- the `decode()` the preloader did was for the full size and
 * counts for nothing. Measured on the reference phone as 200-280 ms freezes in the glide
 * of a swipe between two already-warm pictures. A copy that fits the screen
 * is drawn at 1:1, the one decode is the one used, and a zoom past 1 reuses
 * it too, because an upscale is drawn from the full-size decode.
 */
export function displayBox(w: number, h: number, dpr: number): DisplayBox {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  let bw = Math.max(1, Math.ceil(w * d));
  let bh = Math.max(1, Math.ceil(h * d));
  const long = Math.max(bw, bh);
  if (long > DISPLAY_MAX_PX) {
    const k = DISPLAY_MAX_PX / long;
    bw = Math.max(1, Math.round(bw * k));
    bh = Math.max(1, Math.round(bh * k));
  }
  return { w: bw, h: bh };
}

/** True when a zoom of `scale` should be looking at the original. */
export function wantsOriginal(scale: number): boolean {
  return scale > FULL_ZOOM;
}

/**
 * A small least-recently-used map. `onDrop` runs for whatever falls off the
 * end, which is where a blob URL gets revoked.
 */
export class Lru<V> {
  private map = new Map<string, V>();

  constructor(private readonly keep: number, private readonly onDrop: (v: V) => void) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, v: V): void {
    const old = this.map.get(key);
    if (old !== undefined && old !== v) this.onDrop(old);
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.keep) {
      const first = this.map.keys().next();
      if (first.done) break;
      const gone = this.map.get(first.value);
      this.map.delete(first.value);
      if (gone !== undefined) this.onDrop(gone);
    }
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.map.delete(key);
    this.onDrop(v);
  }

  clear(): void {
    for (const v of this.map.values()) this.onDrop(v);
    this.map.clear();
  }
}
