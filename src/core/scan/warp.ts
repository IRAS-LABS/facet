/**
 * Flattening a photographed page.
 *
 * `quad.ts` finds four corners. This takes those corners and the original
 * pixels and produces a rectangle: the page as if the camera had been square
 * on to it. That is a perspective transform, and unlike a rotate or a crop it
 * cannot be done by moving whole pixels around -- every output pixel lands
 * between four input pixels and has to be mixed from them.
 *
 * The direction matters. Mapping *forward* (walk the input, write where each
 * pixel lands) leaves holes: a stretched region has more output pixels than
 * input ones and nothing writes to the gaps. So we go backwards -- walk the
 * output, ask where in the input each pixel came from, and sample there. Every
 * output pixel gets written exactly once and there are no holes by
 * construction.
 */

import type { Point } from "@core/edit/blur";
import type { Quad } from "./quad";
import { quadPoints } from "./quad";

/**
 * A 3x3 perspective transform in row-major order.
 *
 * Homogeneous: a point `(x, y)` is carried as `(x, y, 1)`, multiplied, and
 * divided by the third component at the end. That last division is the whole
 * reason perspective works and an affine matrix cannot do this job -- it is
 * what makes the far edge of the page shorter than the near one.
 */
export type Matrix = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

/** Apply a matrix to a point. Returns `null` if the point maps to infinity. */
export function apply(m: Matrix, p: Point): Point | null {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (Math.abs(w) < 1e-12) return null;
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / w,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / w,
  };
}

/**
 * Solve a dense linear system by Gaussian elimination with partial pivoting.
 *
 * Eight equations and eight unknowns is small enough that the textbook method
 * is the right one -- but only with pivoting. Without it, a page whose top
 * edge happens to be exactly horizontal puts a zero on the diagonal and the
 * whole solve divides by it. That is not a rare degenerate case; it is a
 * photograph taken carefully.
 *
 * `a` is `n` rows of `n + 1` numbers: the coefficients then the right-hand
 * side. Returns `null` when the system has no single answer, which for us
 * means three of the four corners are in a line.
 */
export function solve(a: number[][], n: number): number[] | null {
  for (let col = 0; col < n; col++) {
    let best = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[best]![col]!)) best = r;
    }
    if (Math.abs(a[best]![col]!) < 1e-10) return null;
    if (best !== col) {
      const t = a[col]!;
      a[col] = a[best]!;
      a[best] = t;
    }

    const pivot = a[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / pivot[col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) a[r]![c]! -= f * pivot[c]!;
    }
  }

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a[i]![n]! / a[i]![i]!;
  return out;
}

/**
 * The matrix taking four source points to four destination points.
 *
 * Eight unknowns, because the ninth entry is fixed at 1: a homography is only
 * defined up to scale, and pinning `m[8]` is how you stop the solver from
 * returning the all-zeros answer. Each corner gives two equations, so four
 * corners is exactly enough and there is nothing to fit or average.
 */
export function homography(from: readonly Point[], to: readonly Point[]): Matrix | null {
  if (from.length !== 4 || to.length !== 4) return null;

  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const s = from[i]!;
    const d = to[i]!;
    a.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y, d.x]);
    a.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y, d.y]);
  }

  const h = solve(a, 8);
  if (!h) return null;
  if (h.some((v) => !Number.isFinite(v))) return null;
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** Distance between two points. */
function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * How big the flattened page should be, in pixels.
 *
 * Take the longer of each opposite pair of edges. The shorter one is the one
 * further from the camera, and sizing to it would throw away the detail the
 * near edge actually recorded -- you would be downscaling the sharpest part of
 * the photograph to match the blurriest.
 */
export function scanSize(q: Quad, w: number, h: number): { w: number; h: number } {
  const tl = { x: q.tl.x * w, y: q.tl.y * h };
  const tr = { x: q.tr.x * w, y: q.tr.y * h };
  const br = { x: q.br.x * w, y: q.br.y * h };
  const bl = { x: q.bl.x * w, y: q.bl.y * h };

  return {
    w: Math.max(1, Math.round(Math.max(dist(tl, tr), dist(bl, br)))),
    h: Math.max(1, Math.round(Math.max(dist(tl, bl), dist(tr, br)))),
  };
}

/**
 * The largest output that fits in `cap` pixels, keeping the shape.
 *
 * A 12 MP photograph of a page warps to something around 10 MP, and four of
 * those in a batch is 160 MB of `ImageData` live at once -- which on a phone
 * is how the tab dies. 4000 px on the long side is more than any scan needs
 * (that is 480 dpi across A4) and it is bounded.
 */
function capped(w: number, h: number, cap: number): { w: number; h: number } {
  const s = Math.min(1, cap / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** How the edges of the source are treated when a sample lands outside it. */
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Warp the quad out of `src` into a flat rectangle.
 *
 * Bilinear sampling, which is the right trade here and not just the easy one.
 * Nearest-neighbour on text is the worst case for it: a stroke one pixel wide
 * either survives or vanishes depending on where the grid falls, so a warped
 * line of 9 pt type comes out with random letters half missing. Bicubic would
 * be sharper still, but it rings on the hard black-to-white edge of printed
 * text -- a light halo around every letter, which is exactly what the cleanup
 * pass then has to decide whether to keep.
 *
 * Returns `null` only when the corners do not describe a solvable transform.
 */
export function warp(
  src: ImageData,
  q: Quad,
  opts: { readonly width?: number; readonly height?: number; readonly cap?: number } = {},
): ImageData | null {
  const want = scanSize(q, src.width, src.height);
  const sized = capped(
    opts.width ?? want.w,
    opts.height ?? want.h,
    opts.cap ?? 4000,
  );
  const ow = sized.w;
  const oh = sized.h;

  // Destination corners are the output rectangle; source corners are the quad
  // in real pixels. We solve output -> input, because that is the direction
  // the sampling loop walks.
  const to = quadPoints(q).map((p) => ({ x: p.x * src.width, y: p.y * src.height }));
  const from: Point[] = [
    { x: 0, y: 0 },
    { x: ow, y: 0 },
    { x: ow, y: oh },
    { x: 0, y: oh },
  ];

  const m = homography(from, to);
  if (!m) return null;

  const out = new ImageData(ow, oh);
  const dst = out.data;
  const sp = src.data;
  const sw = src.width;
  const sh = src.height;

  for (let y = 0; y < oh; y++) {
    // The row is a straight line in the output, so it is a straight line in
    // the input too -- the homography is linear in homogeneous coordinates.
    // Stepping the three components along the row instead of re-multiplying
    // per pixel turns nine multiplies into three adds. On a 3000 px-wide scan
    // that is the difference between a warp you wait for and one you do not.
    const cy = y + 0.5;
    let nx = m[0] * 0.5 + m[1] * cy + m[2];
    let ny = m[3] * 0.5 + m[4] * cy + m[5];
    let nw = m[6] * 0.5 + m[7] * cy + m[8];

    for (let x = 0; x < ow; x++, nx += m[0], ny += m[3], nw += m[6]) {
      const o = (y * ow + x) * 4;
      if (Math.abs(nw) < 1e-12) continue;

      const fx = nx / nw;
      const fy = ny / nw;

      // A quad found on a downscaled preview can put a corner a fraction of a
      // pixel outside the full-size frame. Clamping keeps the edge column
      // rather than punching a transparent line down the side of the scan.
      const gx = clamp(fx - 0.5, 0, sw - 1);
      const gy = clamp(fy - 0.5, 0, sh - 1);

      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const ax = gx - x0;
      const ay = gy - y0;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;

      for (let c = 0; c < 4; c++) {
        dst[o + c] =
          sp[i00 + c]! * w00 +
          sp[i10 + c]! * w10 +
          sp[i01 + c]! * w01 +
          sp[i11 + c]! * w11;
      }
    }
  }

  return out;
}
