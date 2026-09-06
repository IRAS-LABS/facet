/**
 * Where a fling is going to stop, while it is still going.
 *
 * The grid mounts and asks for tiles around wherever the scroller *is*, and a
 * hard fling moves several screens in its last few hundred milliseconds -- so
 * the tiles the user actually lands on are asked for last, and the screen
 * settles on chips for the better part of a second. This predicts the resting
 * position from the scroll velocity so those tiles can be asked for first,
 * while the momentum is still running.
 *
 * The curve is empirical. Two flings were recorded on the reference phone (Chrome 151
 * WebView, DPR 2.81) with a scroll listener sampling `scrollTop`; the
 * distance still to travel against the velocity at that moment fits
 *
 *     remaining = K · v^1.4         (v in physical px/ms)
 *
 * to within about 25 % over the whole decay, which neither a constant
 * deceleration (v^2) nor an exponential (v^1) does. Twenty-five percent is
 * plenty: the prediction is refreshed every frame and shrinks with the
 * remaining distance, and the caller asks for a band, not a point. `K` is
 * also nudged after every fling toward what actually happened, so a device
 * with a different curve converges in a few flicks.
 */

/** Exponent of the fitted curve. */
export const FLING_EXP = 1.4;
/** Fitted constant, physical pixels. `remaining = K · v^EXP`, v in px/ms. */
export const FLING_K = 238;
/** Below this speed (CSS px/ms) the scroller is as good as stopped. */
const SLOW = 0.35;
/** Velocity is read over at least this many milliseconds, to ride out event coalescing. */
const WINDOW_MS = 40;
/** A sample older than this is a previous gesture, not this one. */
const STALE_MS = 250;
const HISTORY = 8;

export class FlingModel {
  k = FLING_K;
  private samples: [t: number, y: number][] = [];
  /** The strongest prediction of the gesture in progress, for `settle`. */
  private best: { t: number; y: number; dest: number; v: number } | null = null;

  constructor(private readonly dpr: number = 1) {}

  /** One scroll frame: time in ms and the scroller's offset. */
  sample(t: number, y: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t - last[0] > STALE_MS) this.samples.length = 0;
    this.samples.push([t, y]);
    if (this.samples.length > HISTORY) this.samples.shift();
  }

  /** Signed speed in CSS px/ms over the last `WINDOW_MS`, 0 when unknown. */
  velocity(): number {
    const n = this.samples.length;
    if (n < 2) return 0;
    const [tN, yN] = this.samples[n - 1]!;
    let i = n - 2;
    while (i > 0 && tN - this.samples[i]![0] < WINDOW_MS) i -= 1;
    const [t0, y0] = this.samples[i]!;
    const dt = tN - t0;
    if (dt < 8) return 0;
    return (yN - y0) / dt;
  }

  /** Distance still to travel (CSS px, signed) at speed `v` (CSS px/ms). */
  remaining(v: number): number {
    const phys = Math.abs(v) * this.dpr;
    const d = (this.k * Math.pow(phys, FLING_EXP)) / this.dpr;
    return v < 0 ? -d : d;
  }

  /**
   * Predicted resting `scrollTop`, or null while the scroller is slow enough
   * that the ordinary look-ahead already covers it.
   */
  predict(): number | null {
    const v = this.velocity();
    if (Math.abs(v) < SLOW) return null;
    const [t, y] = this.samples[this.samples.length - 1]!;
    const dest = y + this.remaining(v);
    if (!this.best || Math.abs(v) > Math.abs(this.best.v)) this.best = { t, y, dest, v };
    return dest;
  }

  /**
   * The scroller stopped at `y`: pull `K` toward what this fling did.
   *
   * Damped and bounded -- a fling that was interrupted by a finger, or that hit
   * the end of the list, must not swing the constant. Only the strongest
   * prediction of the gesture is trusted, taken close to where the finger
   * lifted, and only when it was a real fling, not a nudge.
   */
  settle(t: number, y: number): void {
    const b = this.best;
    this.best = null;
    this.samples.length = 0;
    if (!b) return;
    const predicted = b.dest - b.y;
    const actual = y - b.y;
    if (t - b.t > 3000) return;
    if (Math.abs(predicted) < 400 || Math.sign(actual) !== Math.sign(predicted)) return;
    const ratio = Math.min(1.4, Math.max(0.7, actual / predicted));
    this.k = Math.min(FLING_K * 3, Math.max(FLING_K / 3, this.k * Math.sqrt(ratio)));
  }
}
