/**
 * Face detection.
 *
 * A Viola-Jones style cascade over local binary patterns, evaluated against
 * the model in `face-model.ts`. Everything here is ours; the model is data.
 *
 * Why this and not a neural detector: a 19 KB table and three hundred lines of
 * arithmetic run offline, forever, on any machine, with no runtime to install,
 * no model to download on first use, and no GPU to fall back off. A better
 * detector exists — YuNet would find profiles and tilted heads this one walks
 * past — but it needs an ONNX runtime, which is a hundred megabytes of native
 * dependency for a feature the user can finish by hand in four seconds. The
 * honest trade is: find the obvious faces instantly and reliably, hand every
 * one back as an *editable region*, and never pretend the list is complete.
 *
 * What it finds: faces looking roughly at the camera, upright, at least
 * `minSize` across. What it misses: profiles, heavy tilt, heavy occlusion, and
 * anything smaller than the window. Callers must say so in the UI.
 *
 * Pure: numbers in, boxes out. No DOM, no canvas, no clock — so the whole
 * thing is testable against a known image, and the same code runs in the
 * viewer, in a batch task, and over sampled video frames.
 */

import { FEAT, STAGE_LEN, STAGE_THR, WC_FEAT, WC_LEAF, WC_SUB, WIN } from "./face-model";

/** A detection in pixels of the image it was found in. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * How many overlapping raw windows agreed. Not a probability — a count. A
   * real face at a normal size is usually found a dozen times over adjacent
   * scales and positions; a false positive is typically found two or three.
   * That is the whole basis of `minNeighbours`.
   */
  score: number;
}

export interface DetectOptions {
  /**
   * Step between scales, > 1. 1.1 is thorough and slow, 1.25 is quick and
   * skips faces whose size falls between rungs. 1.15 is the default because
   * face blurring is not a search — a missed face is a privacy failure.
   */
  scaleStep: number;
  /**
   * Overlapping windows required before a cluster counts as a face. Lower
   * finds more faces and more walls; higher is clean and misses the small
   * ones. 3 is OpenCV's default and it is a sensible one.
   */
  minNeighbours: number;
  /** Smallest face to look for, in pixels of the source image. */
  minSize: number;
  /** Largest, in pixels. 0 means "up to the whole frame". */
  maxSize: number;
  /**
   * Longest side the detector will work at. Detection cost is quadratic in
   * resolution and a 45 MP photo would take minutes for no gain — faces do
   * not become more findable above about a thousand pixels, they just cost
   * more. Boxes are scaled back to source coordinates before they are
   * returned, so callers never see this.
   */
  workingSize: number;
}

export const DEFAULTS: DetectOptions = {
  scaleStep: 1.15,
  minNeighbours: 3,
  minSize: 32,
  maxSize: 0,
  workingSize: 1024,
};

/** Greyscale image the detector works on. `data` is one byte per pixel. */
export interface Gray {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Rec. 601 luma. Not an average of the channels: the eye is roughly six times
 * more sensitive to green than to blue, and a flat average turns a red jumper
 * and a blue wall into the same grey, which invents edges that are not there.
 */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = (rgba[p]! * 77 + rgba[p + 1]! * 150 + rgba[p + 2]! * 29) >> 8;
  }
  return { width, height, data };
}

/**
 * Box-filtered downscale.
 *
 * Nearest-neighbour would be three lines shorter and would wreck the
 * detector: dropping pixels turns fine texture into aliasing noise, and an LBP
 * feature is a comparison between neighbouring cell *averages*, which is
 * exactly what aliasing destroys. Averaging every source pixel that lands in a
 * destination pixel is the cheapest filter that does not lie.
 */
export function downscale(src: Gray, width: number, height: number): Gray {
  if (width === src.width && height === src.height) return src;
  const data = new Uint8ClampedArray(width * height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * sx)));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * src.width;
        for (let xx = x0; xx < x1; xx++) {
          sum += src.data[row + xx]!;
          n++;
        }
      }
      data[y * width + x] = n > 0 ? sum / n : 0;
    }
  }
  return { width, height, data };
}

/**
 * Summed-area table, one row and column larger than the image so that the sum
 * of any rectangle is four lookups with no bounds checks at the edges. Int32
 * is enough: the largest possible total is 255 * 1024 * 1024, comfortably
 * inside it, and a Float64Array here would double the memory traffic in the
 * hottest loop in the app.
 */
export function integral(g: Gray): { w: number; sum: Int32Array } {
  const w = g.width + 1;
  const sum = new Int32Array(w * (g.height + 1));
  for (let y = 0; y < g.height; y++) {
    let run = 0;
    const src = y * g.width;
    const cur = (y + 1) * w;
    const above = y * w;
    for (let x = 0; x < g.width; x++) {
      run += g.data[src + x]!;
      sum[cur + x + 1] = sum[above + x + 1]! + run;
    }
  }
  return { w, sum };
}

/**
 * One 45x45 window at (ox, oy) against the full cascade.
 *
 * The cascade's whole point is the early return. Stage 0 is six comparisons
 * and rejects the overwhelming majority of windows in an image; the expensive
 * later stages only ever see what survives. A version of this that scored
 * every stage and compared at the end would be correct and roughly forty times
 * slower.
 */
function windowPasses(sum: Int32Array, iw: number, ox: number, oy: number): boolean {
  let wc = 0;
  for (let s = 0; s < STAGE_LEN.length; s++) {
    let vote = 0;
    const end = wc + STAGE_LEN[s]!;
    for (; wc < end; wc++) {
      const f = WC_FEAT[wc]! << 2;
      const fx = ox + FEAT[f]!;
      const fy = oy + FEAT[f + 1]!;
      const fw = FEAT[f + 2]!;
      const fh = FEAT[f + 3]!;

      // The 4x4 grid of corners bounding the feature's 3x3 block of cells.
      const r0 = (fy + 0 * fh) * iw;
      const r1 = (fy + 1 * fh) * iw;
      const r2 = (fy + 2 * fh) * iw;
      const r3 = (fy + 3 * fh) * iw;
      const c0 = fx + 0 * fw;
      const c1 = fx + 1 * fw;
      const c2 = fx + 2 * fw;
      const c3 = fx + 3 * fw;

      const p0 = sum[r0 + c0]!, p1 = sum[r0 + c1]!, p2 = sum[r0 + c2]!, p3 = sum[r0 + c3]!;
      const p4 = sum[r1 + c0]!, p5 = sum[r1 + c1]!, p6 = sum[r1 + c2]!, p7 = sum[r1 + c3]!;
      const p8 = sum[r2 + c0]!, p9 = sum[r2 + c1]!, pa = sum[r2 + c2]!, pb = sum[r2 + c3]!;
      const pc = sum[r3 + c0]!, pd = sum[r3 + c1]!, pe = sum[r3 + c2]!, pf = sum[r3 + c3]!;

      // Centre cell, then its eight neighbours clockwise from the top-left.
      // `>=` rather than `>` matters: flat regions must code as all-ones, not
      // all-zeros, and the model was trained that way round.
      const c = p5 - p6 - p9 + pa;
      const code =
        (p0 - p1 - p4 + p5 >= c ? 128 : 0) |
        (p1 - p2 - p5 + p6 >= c ? 64 : 0) |
        (p2 - p3 - p6 + p7 >= c ? 32 : 0) |
        (p6 - p7 - pa + pb >= c ? 16 : 0) |
        (pa - pb - pe + pf >= c ? 8 : 0) |
        (p9 - pa - pd + pe >= c ? 4 : 0) |
        (p8 - p9 - pc + pd >= c ? 2 : 0) |
        (p4 - p5 - p8 + p9 >= c ? 1 : 0);

      const inSet = (WC_SUB[(wc << 3) + (code >> 5)]! & (1 << (code & 31))) !== 0;
      vote += WC_LEAF[(wc << 1) + (inSet ? 0 : 1)]!;
    }
    if (vote < STAGE_THR[s]!) return false;
  }
  return true;
}

/**
 * Find faces.
 *
 * The image is repeatedly shrunk and the window stays 45x45, rather than the
 * window growing over a fixed image. Growing the window means rounding every
 * feature rect at every scale, and those roundings compound into a model that
 * is subtly not the one that was trained. Shrinking the image keeps the model
 * exact and costs a resample that is cheaper than the search it feeds.
 */
export function detectFaces(gray: Gray, opts: Partial<DetectOptions> = {}): Box[] {
  const o = { ...DEFAULTS, ...opts };
  const longest = Math.max(gray.width, gray.height);

  // Work small, report large. `back` converts every box home at the end.
  const work =
    longest > o.workingSize
      ? downscale(
          gray,
          Math.max(1, Math.round((gray.width * o.workingSize) / longest)),
          Math.max(1, Math.round((gray.height * o.workingSize) / longest)),
        )
      : gray;
  const back = gray.width / work.width;

  const minSize = Math.max(WIN, o.minSize / back);
  const maxSize = o.maxSize > 0 ? o.maxSize / back : Math.min(work.width, work.height);
  if (o.scaleStep <= 1) throw new Error("scaleStep must be greater than 1");

  const raw: Box[] = [];
  // `factor` is how much bigger than the window the face we are hunting is, so
  // the image is divided by it and the window stays put.
  for (let factor = minSize / WIN; factor * WIN <= maxSize; factor *= o.scaleStep) {
    const sw = Math.round(work.width / factor);
    const sh = Math.round(work.height / factor);
    if (sw < WIN || sh < WIN) break;

    const level = downscale(work, sw, sh);
    const { w: iw, sum } = integral(level);
    // Two pixels at this level is 2 * factor at source resolution, so the step
    // scales with the face automatically. Below a factor of 2 that is finer
    // than it needs to be, but the small scales are also the cheap ones.
    const step = factor > 2 ? 1 : 2;
    const scale = factor * back;

    for (let y = 0; y + WIN < sh; y += step) {
      for (let x = 0; x + WIN < sw; x += step) {
        if (!windowPasses(sum, iw, x, y)) continue;
        raw.push({
          x: x * scale,
          y: y * scale,
          w: WIN * scale,
          h: WIN * scale,
          score: 1,
        });
      }
    }
  }

  return group(raw, o.minNeighbours);
}

/**
 * Collapse the pile of overlapping windows into one box per face.
 *
 * Plain non-maximum suppression — keep the best, drop everything it overlaps —
 * is wrong here, because every raw window is equally "best": they all just
 * passed. Averaging the cluster instead puts the box where the agreement is,
 * which is both more stable across video frames and visibly better centred
 * than any single window.
 */
export function group(boxes: Box[], minNeighbours: number): Box[] {
  if (boxes.length === 0) return [];

  // Union-find over "these two are the same face".
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (!similar(boxes[i]!, boxes[j]!)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    }
  }

  const bins = new Map<number, Box[]>();
  for (let i = 0; i < boxes.length; i++) {
    const root = find(i);
    const bin = bins.get(root);
    if (bin) bin.push(boxes[i]!);
    else bins.set(root, [boxes[i]!]);
  }

  const out: Box[] = [];
  for (const bin of bins.values()) {
    if (bin.length < minNeighbours) continue;
    let x = 0;
    let y = 0;
    let w = 0;
    let h = 0;
    for (const b of bin) {
      x += b.x;
      y += b.y;
      w += b.w;
      h += b.h;
    }
    const n = bin.length;
    out.push({ x: x / n, y: y / n, w: w / n, h: h / n, score: n });
  }

  // A big face is found at several scales and produces a cluster that survives
  // as its own box *and* smaller clusters sitting inside it — an eye and a
  // mouth can each look like a tiny face. Drop anything swallowed by a
  // stronger box; two people genuinely standing one behind the other do not
  // sit fully inside each other's heads.
  return out
    .filter((b, i) => !out.some((o, j) => j !== i && o.score >= b.score && contains(o, b)))
    .sort((a, b) => b.w * b.h - a.w * a.h);
}

/**
 * Two windows describe the same face when they are within a fifth of a face of
 * each other in both position and size. The tolerance is proportional, not
 * absolute: 12 px apart is the same face at 400 px across and two different
 * faces at 40.
 */
function similar(a: Box, b: Box): boolean {
  const tol = (a.w + b.w) * 0.5 * 0.2;
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.x + a.w - b.x - b.w) <= tol &&
    Math.abs(a.y + a.h - b.y - b.h) <= tol
  );
}

/** `outer` swallows `inner` — allowing a little slop at the edges. */
function contains(outer: Box, inner: Box): boolean {
  const slop = inner.w * 0.15;
  return (
    inner.x >= outer.x - slop &&
    inner.y >= outer.y - slop &&
    inner.x + inner.w <= outer.x + outer.w + slop &&
    inner.y + inner.h <= outer.y + outer.h + slop &&
    inner.w * inner.h < outer.w * outer.h
  );
}
