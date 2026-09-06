/**
 * A small object tracker, so a blur drawn on one frame can follow the thing
 * it covers through the rest of the clip.
 *
 * Nothing learned, nothing downloaded: this is template matching by
 * normalised cross-correlation. The patch under the box on the frame it was
 * drawn on is the template; on each later sampled frame the template is slid
 * over a search window around where it was last seen, and the offset with the
 * highest correlation is where it went. A few candidate scales are tried at
 * that offset so a plate driving towards the camera keeps its box.
 *
 * Why NCC and not something cleverer: it is exact enough for the job (a blur
 * is padded anyway), it costs a millisecond per step at the sizes used, it
 * needs no model, and, the important part, it *knows when it is wrong*.
 * The correlation is a confidence. When it collapses the track stops and says
 * so, rather than sliding the blur off onto the wallpaper and leaving the
 * user to notice on the export.
 *
 * Everything here is pure and works on grey float frames, so the behaviour is
 * checked in `vblurcheck` against synthetic moving squares with known paths.
 */

import type { Rect } from "@core/edit/blur";

/** One frame reduced to luminance, row-major, 0..255 floats. */
export interface Gray {
  w: number;
  h: number;
  data: Float32Array;
}

export interface TrackerOptions {
  /**
   * How far (fraction of the frame's short edge) the object may move between
   * two sampled frames. At 6 fps and 0.15 that is ~90% of the frame per
   * second, which covers a hand-held pan.
   */
  search: number;
  /** Relative scales tried at the best offset; 1 is always included. */
  scales: number[];
  /** Correlation below which a step is "not found". NCC is in -1..1. */
  minScore: number;
  /** How many consecutive not-found steps end the track. */
  patience: number;
  /**
   * Template adaptation: 0 keeps the first patch forever (robust to drift,
   * fragile to appearance change), 1 replaces it every step (the opposite).
   * The blend keeps a slowly-changing appearance without walking away.
   */
  adapt: number;
  /** Longest template edge in pixels; larger boxes are sampled down to this. */
  templateMax: number;
}

export const TRACKER_DEFAULTS: TrackerOptions = {
  search: 0.15,
  scales: [0.92, 1, 1.08],
  minScore: 0.45,
  patience: 2,
  adapt: 0.15,
  templateMax: 48,
};

/** A step's result: where the box is now, and how sure the matcher was. */
export interface TrackStep {
  rect: Rect;
  score: number;
}

/** Luminance of an RGBA buffer. */
export function grayOf(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
  }
  return { w, h, data };
}

/** Bilinear sample with edge clamping. */
function at(g: Gray, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(g.w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(g.h - 1, Math.floor(y)));
  const x1 = Math.min(g.w - 1, x0 + 1);
  const y1 = Math.min(g.h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const d = g.data;
  const a = d[y0 * g.w + x0]! * (1 - fx) + d[y0 * g.w + x1]! * fx;
  const b = d[y1 * g.w + x0]! * (1 - fx) + d[y1 * g.w + x1]! * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * The patch of `g` under pixel box (x,y,w,h), resampled to tw by th, and
 * normalised to zero mean, unit norm, so a dot product with another such
 * patch *is* the normalised cross-correlation. Returns the norm (0 for a
 * flat patch, which correlates with nothing).
 */
function patch(
  g: Gray, x: number, y: number, w: number, h: number, tw: number, th: number, out: Float32Array,
): number {
  let sum = 0;
  for (let j = 0; j < th; j++) {
    const sy = y + ((j + 0.5) / th) * h - 0.5;
    for (let i = 0; i < tw; i++) {
      const sx = x + ((i + 0.5) / tw) * w - 0.5;
      const v = at(g, sx, sy);
      out[j * tw + i] = v;
      sum += v;
    }
  }
  const n = tw * th;
  const mean = sum / n;
  let ss = 0;
  for (let k = 0; k < n; k++) {
    const v = out[k]! - mean;
    out[k] = v;
    ss += v * v;
  }
  const norm = Math.sqrt(ss);
  if (norm < 1e-6) {
    out.fill(0);
    return 0;
  }
  for (let k = 0; k < n; k++) out[k] = out[k]! / norm;
  return norm;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k]! * b[k]!;
  return s;
}

/**
 * Follows one box through a sequence of frames. Stateful: `anchor()` sets the
 * template from a frame and a box (the drawn keyframe), `step()` finds it in
 * the next frame. Boxes are normalised 0..1 frame coordinates; frames may be
 * any size (and need not all be the same size).
 */
export class Tracker {
  private readonly o: TrackerOptions;
  private tw = 0;
  private th = 0;
  private template: Float32Array | null = null;
  private scratch: Float32Array = new Float32Array(0);
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private misses = 0;

  constructor(opts: Partial<TrackerOptions> = {}) {
    this.o = { ...TRACKER_DEFAULTS, ...opts };
  }

  /** Where the tracker believes the box is now. */
  get box(): Rect {
    return { ...this.rect };
  }

  /** Set (or reset) the template from `rect` on `g`. */
  anchor(g: Gray, rect: Rect): void {
    this.rect = { ...rect };
    const pw = Math.max(2, rect.w * g.w);
    const ph = Math.max(2, rect.h * g.h);
    const s = Math.min(1, this.o.templateMax / Math.max(pw, ph));
    this.tw = Math.max(4, Math.round(pw * s));
    this.th = Math.max(4, Math.round(ph * s));
    this.template = new Float32Array(this.tw * this.th);
    this.scratch = new Float32Array(this.tw * this.th);
    patch(g, rect.x * g.w, rect.y * g.h, pw, ph, this.tw, this.th, this.template);
    this.misses = 0;
  }

  /**
   * Look for the template in `g` near the last box. Returns the best match
   * and its correlation, or null once the track has been lost for
   * `patience` steps in a row. A found step moves the box; a miss leaves it.
   */
  step(g: Gray): TrackStep | null {
    const T = this.template;
    if (!T) return null;
    const o = this.o;
    const short = Math.min(g.w, g.h);
    const radius = Math.max(1, Math.round(o.search * short));
    const cx = this.rect.x * g.w;
    const cy = this.rect.y * g.h;
    const pw = this.rect.w * g.w;
    const ph = this.rect.h * g.h;

    // Coarse-to-fine: a stride of 2 over the window, then +-1 around the best.
    let best = -2;
    let bx = cx;
    let by = cy;
    const tryAt = (x: number, y: number): void => {
      patch(g, x, y, pw, ph, this.tw, this.th, this.scratch);
      const s = dot(T, this.scratch);
      if (s > best) {
        best = s;
        bx = x;
        by = y;
      }
    };
    const stride = radius > 6 ? 2 : 1;
    for (let dy = -radius; dy <= radius; dy += stride) {
      for (let dx = -radius; dx <= radius; dx += stride) tryAt(cx + dx, cy + dy);
    }
    if (stride > 1) {
      const fx = bx;
      const fy = by;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (dx || dy) tryAt(fx + dx, fy + dy);
      }
    }

    // Scale, about the box's centre.
    let bw = pw;
    let bh = ph;
    for (const sc of o.scales) {
      if (sc === 1) continue;
      const w2 = pw * sc;
      const h2 = ph * sc;
      const x2 = bx + (pw - w2) / 2;
      const y2 = by + (ph - h2) / 2;
      patch(g, x2, y2, w2, h2, this.tw, this.th, this.scratch);
      const s = dot(T, this.scratch);
      // Scale changes need a clear win; otherwise the box breathes on noise.
      if (s > best + 0.01) {
        best = s;
        bx = x2;
        by = y2;
        bw = w2;
        bh = h2;
      }
    }

    if (best < o.minScore) {
      this.misses++;
      if (this.misses >= o.patience) return null;
      return { rect: { ...this.rect }, score: best };
    }
    this.misses = 0;
    this.rect = { x: bx / g.w, y: by / g.h, w: bw / g.w, h: bh / g.h };
    if (o.adapt > 0) {
      patch(g, bx, by, bw, bh, this.tw, this.th, this.scratch);
      for (let k = 0; k < T.length; k++) T[k] = T[k]! * (1 - o.adapt) + this.scratch[k]! * o.adapt;
      // Re-normalise so the dot product stays a correlation.
      let mean = 0;
      for (let k = 0; k < T.length; k++) mean += T[k]!;
      mean /= T.length;
      let ss = 0;
      for (let k = 0; k < T.length; k++) {
        T[k] = T[k]! - mean;
        ss += T[k]! * T[k]!;
      }
      const norm = Math.sqrt(ss) || 1;
      for (let k = 0; k < T.length; k++) T[k] = T[k]! / norm;
    }
    return { rect: { ...this.rect }, score: best };
  }
}

/** A frame with the source time it was taken at. */
export interface TimedFrame {
  t: number;
  gray: Gray;
}

export interface FollowResult {
  /** Boxes at each frame the object was found in, in the order given. */
  found: { t: number; rect: Rect; score: number }[];
  /** Time of the first frame the tracker gave up at, if it did. */
  lostAt: number | null;
}

/**
 * Follow `rect` from `frames[0]` through the rest. Frames are consumed in the
 * order given, so passing them reversed tracks backwards. Stops at the first
 * loss; the caller decides what to do with the remainder.
 */
export function follow(
  frames: readonly TimedFrame[], rect: Rect, opts: Partial<TrackerOptions> = {},
): FollowResult {
  const out: FollowResult = { found: [], lostAt: null };
  if (frames.length === 0) return out;
  const tr = new Tracker(opts);
  tr.anchor(frames[0]!.gray, rect);
  out.found.push({ t: frames[0]!.t, rect: { ...rect }, score: 1 });
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i]!;
    const s = tr.step(f.gray);
    if (!s) {
      out.lostAt = f.t;
      break;
    }
    out.found.push({ t: f.t, rect: s.rect, score: s.score });
  }
  return out;
}

/**
 * The same, pulling frames one at a time from an async sampler, which is the
 * shape the video editor has, where each frame is a round trip to ffmpeg.
 * `times` includes the anchor time first. `onStep` lets the UI draw progress;
 * return false from it to cancel.
 */
export async function followAsync(
  times: readonly number[],
  sample: (t: number) => Promise<Gray | null>,
  rect: Rect,
  opts: Partial<TrackerOptions> = {},
  onStep?: (t: number, rect: Rect, score: number) => boolean | void,
): Promise<FollowResult> {
  const out: FollowResult = { found: [], lostAt: null };
  if (times.length === 0) return out;
  const first = await sample(times[0]!);
  if (!first) return out;
  const tr = new Tracker(opts);
  tr.anchor(first, rect);
  out.found.push({ t: times[0]!, rect: { ...rect }, score: 1 });
  for (let i = 1; i < times.length; i++) {
    const t = times[i]!;
    const g = await sample(t);
    if (!g) {
      out.lostAt = t;
      break;
    }
    const s = tr.step(g);
    if (!s) {
      out.lostAt = t;
      break;
    }
    out.found.push({ t, rect: s.rect, score: s.score });
    if (onStep && onStep(t, s.rect, s.score) === false) break;
  }
  return out;
}
