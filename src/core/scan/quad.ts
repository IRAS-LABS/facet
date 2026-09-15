/**
 * Finding the four corners of a document in a photograph.
 *
 * A phone photograph of a page is never square-on. The page is a quadrilateral
 * somewhere in the frame, usually darker at one edge than the other, usually
 * on a desk that is not a uniform colour. Getting from that to a flat scan is
 * two jobs: find the quadrilateral (here) and warp it flat (`warp.ts`).
 *
 * The method is edge lines rather than contours. A contour finder wants a
 * closed boundary, and the boundary of a white page on a light desk is broken
 * in at least one place in most real photographs -- one bad corner and the
 * whole contour is lost. Lines do not care: a page edge that is clear along
 * two thirds of its length still votes for exactly the right line, and the
 * corner comes from intersecting two lines rather than from having seen it.
 *
 * Everything here works on a small copy of the image. A page edge is a
 * hundreds-of-pixels-long straight line; it survives being scaled to 384 px
 * intact, and everything that does not survive is noise we would have had to
 * suppress anyway.
 */

import type { Point } from "@core/edit/blur";

/**
 * A document's four corners, normalised against the image so that a quad found
 * on a preview still means the same thing on the full-resolution original.
 *
 * The order is fixed and it matters: `warp` maps `tl` to the top-left of the
 * output, so a quad in the wrong order produces a scan that is upside down or
 * mirrored. `orderQuad` is the only thing that should ever build one.
 */
export interface Quad {
  tl: Point;
  tr: Point;
  br: Point;
  bl: Point;
}

/** The whole frame, in quad form. What a caller falls back to. */
export const FULL_QUAD: Quad = {
  tl: { x: 0, y: 0 },
  tr: { x: 1, y: 0 },
  br: { x: 1, y: 1 },
  bl: { x: 0, y: 1 },
};

export function quadPoints(q: Quad): Point[] {
  return [q.tl, q.tr, q.br, q.bl];
}

/**
 * Put four corners in `tl, tr, br, bl` order, whatever order they arrived in.
 *
 * By angle around the centroid rather than by comparing x and y. The obvious
 * rule -- smallest x+y is the top-left -- is right for a rectangle and wrong
 * for a page photographed at an angle, where the true top-left corner can sit
 * further right than the top-right one. Angles are indifferent to that: going
 * round the centroid visits the corners in their actual cyclic order every
 * time, and all that is left is choosing where to start.
 */
export function orderQuad(pts: readonly Point[]): Quad | null {
  if (pts.length !== 4) return null;

  const cx = (pts[0]!.x + pts[1]!.x + pts[2]!.x + pts[3]!.x) / 4;
  const cy = (pts[0]!.y + pts[1]!.y + pts[2]!.y + pts[3]!.y) / 4;

  // Screen coordinates run down, so this sweeps clockwise starting from the
  // direction of "up and to the left".
  const byAngle = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );

  // Start at the corner nearest the top-left of the bounding box. Among four
  // corners in cyclic order this picks the same one on every rotation of the
  // same quad, which is what makes the result stable frame to frame.
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = byAngle[i]!;
    const d = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
    const score = Math.atan2(p.y - cy, p.x - cx);
    // Prefer the corner closest to pointing up-left (-135 degrees).
    const target = -Math.PI * 0.75;
    let diff = Math.abs(score - target);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const rank = diff * 1000 - d * 0.0001;
    if (rank < best) {
      best = rank;
      start = i;
    }
  }

  const o = (i: number): Point => byAngle[(start + i) % 4]!;
  return { tl: o(0), tr: o(1), br: o(2), bl: o(3) };
}

/** Twice the signed area. Positive is clockwise in screen coordinates. */
function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * True when no corner folds back through the shape.
 *
 * Four intersecting lines always give four points, and two of them can easily
 * be the wrong pair -- that produces a bow tie, which warps into a scan folded
 * over itself. Cheaper to reject here than to explain in the output.
 */
export function isConvex(q: Quad): boolean {
  const p = quadPoints(q);
  let neg = false;
  let pos = false;
  for (let i = 0; i < 4; i++) {
    const c = cross(p[i]!, p[(i + 1) % 4]!, p[(i + 2) % 4]!);
    if (c < -1e-9) neg = true;
    if (c > 1e-9) pos = true;
  }
  return !(neg && pos);
}

/** Area of the quad as a fraction of the frame, for quads in 0..1 space. */
export function quadArea(q: Quad): number {
  const p = quadPoints(q);
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % 4]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

// ── The image, small and grey ───────────────────────────────────────────────

/** A greyscale copy at working size. */
export interface Grey {
  data: Float32Array;
  w: number;
  h: number;
}

/**
 * Downscale to `max` on the long side and drop to luma.
 *
 * Box-averaged rather than nearest-sampled. Nearest sampling of a 4000 px
 * photograph down to 384 px throws away 99 per cent of the pixels and keeps
 * whichever ones happened to land on the grid, which turns a smooth page edge
 * into a staircase -- and a staircase votes for a dozen slightly different
 * lines instead of one strong one.
 */
export function toGrey(src: ImageData, max = 384): Grey {
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Float32Array(w * h);

  const sx = src.width / w;
  const sy = src.height / h;
  const px = src.data;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1 && xx < src.width; xx++, i += 4) {
          // Rec. 601 luma. The exact weights matter less than using some, but
          // green carrying the most is why a green desk does not read as an edge.
          sum += 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
          n++;
        }
      }
      out[y * w + x] = n > 0 ? sum / n : 0;
    }
  }

  return { data: out, w, h };
}

/** In-place 3x3 box blur. One pass is enough to stop single pixels voting. */
function blur3(g: Grey): Grey {
  const { data, w, h } = g;
  const out = new Float32Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += data[yy * w + xx]!;
          n++;
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return { data: out, w, h };
}

// ── Lines ──────────────────────────────────────────────────────────────────

/**
 * A line in normal form: `x cos(theta) + y sin(theta) = rho`.
 *
 * Not slope and intercept, which cannot represent a vertical line -- and one
 * edge of a document is vertical in about a quarter of all photographs.
 */
export interface Line {
  /** Radians, 0 to PI. The direction of the line's normal. */
  theta: number;
  /** Distance from the origin along that normal. May be negative. */
  rho: number;
  /** How much gradient voted for it. Only meaningful against its own image. */
  weight: number;
}

/** Where two lines meet, or null if they are parallel. */
export function intersect(a: Line, b: Line): Point | null {
  const ca = Math.cos(a.theta);
  const sa = Math.sin(a.theta);
  const cb = Math.cos(b.theta);
  const sb = Math.sin(b.theta);
  const det = ca * sb - sa * cb;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.rho * sb - b.rho * sa) / det,
    y: (ca * b.rho - cb * a.rho) / det,
  };
}

/** Smallest angle between two line orientations, 0 to PI/2. */
function angleGap(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

const THETA_STEPS = 180;
const RHO_STEP = 2;

/**
 * Straight lines in the image, strongest first.
 *
 * A Hough transform, with one deviation from the textbook: an edge pixel votes
 * only for the handful of orientations near the one its own gradient implies,
 * instead of for all 180. The gradient direction at an edge *is* the normal of
 * the line through it, so the other 170-odd votes are known to be wrong before
 * they are cast. Dropping them costs nothing in recall and takes most of the
 * haze out of the accumulator, which is what makes peak-picking reliable on a
 * cluttered desk.
 */
export function findLines(grey: Grey, want = 12): Line[] {
  const g = blur3(grey);
  const { data, w, h } = g;

  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = data[i - w - 1]!, t = data[i - w]!, tr = data[i - w + 1]!;
      const l = data[i - 1]!, r = data[i + 1]!;
      const bl = data[i + w - 1]!, b = data[i + w]!, br = data[i + w + 1]!;
      const dx = tr + 2 * r + br - tl - 2 * l - bl;
      const dy = bl + 2 * b + br - tl - 2 * t - tr;
      gx[i] = dx;
      gy[i] = dy;
      mag[i] = Math.hypot(dx, dy);
    }
  }

  // Keep the strongest edges only, by percentile rather than by a fixed
  // number: a well-lit page and a dim one have completely different gradient
  // scales, and a fixed threshold finds every edge in one and none in the other.
  const sorted = Float32Array.from(mag).sort();
  const cut = sorted[Math.floor(sorted.length * 0.92)] ?? 0;
  const floor = Math.max(cut, 1e-4);

  const rhoMax = Math.hypot(w, h);
  const rhoBins = Math.ceil((rhoMax * 2) / RHO_STEP) + 1;
  const acc = new Float32Array(THETA_STEPS * rhoBins);

  const SPREAD = 2; // +/- 2 degrees around the gradient's own direction

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i]!;
      if (m < floor) continue;

      // atan2 gives -PI..PI; a line's normal is defined only up to sign, so
      // fold onto 0..PI.
      let a = Math.atan2(gy[i]!, gx[i]!);
      if (a < 0) a += Math.PI;
      const centre = Math.round((a / Math.PI) * THETA_STEPS) % THETA_STEPS;

      for (let d = -SPREAD; d <= SPREAD; d++) {
        const ti = (centre + d + THETA_STEPS) % THETA_STEPS;
        const th = (ti / THETA_STEPS) * Math.PI;
        const rho = x * Math.cos(th) + y * Math.sin(th);
        const ri = Math.round((rho + rhoMax) / RHO_STEP);
        if (ri < 0 || ri >= rhoBins) continue;
        acc[ti * rhoBins + ri] = acc[ti * rhoBins + ri]! + m;
      }
    }
  }

  // Peaks, with suppression around each one so that a single strong edge does
  // not fill the answer with eleven copies of itself one bin apart.
  const out: Line[] = [];
  const T_SUPPRESS = 6;   // degrees
  const R_SUPPRESS = 8;   // bins, so 16 px

  for (let n = 0; n < want; n++) {
    let bi = -1;
    let bv = 0;
    for (let i = 0; i < acc.length; i++) {
      const v = acc[i]!;
      if (v > bv) { bv = v; bi = i; }
    }
    if (bi < 0 || bv <= 0) break;

    const ti = Math.floor(bi / rhoBins);
    const ri = bi % rhoBins;
    out.push({
      theta: (ti / THETA_STEPS) * Math.PI,
      rho: ri * RHO_STEP - rhoMax,
      weight: bv,
    });

    for (let dt = -T_SUPPRESS; dt <= T_SUPPRESS; dt++) {
      const raw = ti + dt;
      const tt = (raw + THETA_STEPS) % THETA_STEPS;
      // Theta wraps at 180 degrees but rho does not: crossing that boundary
      // turns the normal around, so the *same* line is written down with rho
      // negated. Suppressing the same rho bin on the far side blanks an
      // unrelated part of the accumulator and leaves the twin standing -- which
      // is how one near-vertical page edge came back as two lines, at 2 and at
      // 179 degrees, and then got picked as if it were two opposite edges.
      const centreR = raw < 0 || raw >= THETA_STEPS ? rhoBins - 1 - ri : ri;
      for (let dr = -R_SUPPRESS; dr <= R_SUPPRESS; dr++) {
        const rr = centreR + dr;
        if (rr < 0 || rr >= rhoBins) continue;
        acc[tt * rhoBins + rr] = 0;
      }
    }
  }

  return out;
}

// ── Putting a page together ────────────────────────────────────────────────

/** How far from square-on a page may be before we stop believing it. */
const MIN_CORNER_ANGLE = Math.PI / 5; // 36 degrees
/** A page smaller than this fraction of the frame is probably not the subject. */
const MIN_AREA = 0.12;

/**
 * The document in this image, or null when there is not one worth trusting.
 *
 * Null is a real answer and callers must handle it. A wrong quad is worse than
 * no quad: it silently crops away half of what the person photographed, and
 * they find out when they read the scan later. The UI's job on a null is to
 * show the frame with draggable corners and let a person place them, which is
 * a fine outcome and takes four taps.
 */
export function findQuad(src: ImageData): Quad | null {
  const grey = toGrey(src);
  if (grey.w < 16 || grey.h < 16) return null;

  const lines = findLines(grey, 14);
  if (lines.length < 4) return null;

  // Two families of edges, perpendicular to each other. The strongest line
  // sets the reference; every other line is either roughly with it or roughly
  // across it. A page has two of each and nothing has three.
  const ref = lines[0]!.theta;
  const withRef: Line[] = [];
  const across: Line[] = [];
  for (const l of lines) {
    const gap = angleGap(l.theta, ref);
    if (gap < Math.PI / 5) withRef.push(l);
    else if (gap > Math.PI / 2 - Math.PI / 5) across.push(l);
  }
  if (withRef.length < 2 || across.length < 2) return null;

  const centre = { x: grey.w / 2, y: grey.h / 2 };

  /**
   * How far the image centre sits from a line, signed, with the line's normal
   * turned to face the same way as `ref`'s.
   *
   * The turning is the whole point. rho is signed against the normal, and two
   * near-parallel lines can be recorded with normals pointing opposite ways --
   * one at 2 degrees and one at 179 -- in which case their rho values, and
   * their centre distances, have opposite signs. Subtract those and one page
   * edge looks like two edges a page apart. Aligned first, the subtraction
   * means what it says.
   */
  const distFrom = (l: Line, ref: number): number => {
    const flip = angleGap(ref, l.theta) !== Math.abs(ref - l.theta);
    const theta = flip ? l.theta + Math.PI : l.theta;
    const rho = flip ? -l.rho : l.rho;
    return rho - (centre.x * Math.cos(theta) + centre.y * Math.sin(theta));
  };

  // One edge of a page is one line, but the accumulator does not know that: a
  // slightly tilted edge peaks two or three times, a degree or two apart and a
  // few pixels apart in rho. Left in, those near-twins are what the pairing
  // below picks -- the outermost twin of one edge against the outermost twin of
  // the other -- and the quad ends up a little wider than the page every time.
  // Strongest first, drop anything that is really a line already kept.
  const NEAR = Math.min(grey.w, grey.h) * 0.05;
  const thin = (fam: Line[]): Line[] => {
    const kept: Line[] = [];
    for (const l of fam) {
      const twin = kept.some(
        (k) => Math.abs(distFrom(l, k.theta) - distFrom(k, k.theta)) < NEAR,
      );
      if (!twin) kept.push(l);
    }
    return kept;
  };

  // Opposite edges of a page are the two lines of a family furthest apart.
  // Picking the two *strongest* instead finds the ink on the page: a band of
  // text is a shorter line than a page edge but a much sharper one, and it
  // wins on strength while sitting well inside the sheet.
  const pair = (fam: Line[]): [Line, Line] | null => {
    let best: [Line, Line] | null = null;
    let bestGap = 0;
    for (let i = 0; i < fam.length; i++) {
      for (let j = i + 1; j < fam.length; j++) {
        const a = fam[i]!;
        const b = fam[j]!;
        const gap = Math.abs(distFrom(a, a.theta) - distFrom(b, a.theta));
        if (gap > bestGap) { bestGap = gap; best = [a, b]; }
      }
    }
    // A page has to be wider than a few pixels in both directions.
    return best && bestGap > Math.min(grey.w, grey.h) * 0.15 ? best : null;
  };

  const a = pair(thin(withRef));
  const b = pair(thin(across));
  if (!a || !b) return null;

  const corners: Point[] = [];
  for (const la of a) {
    for (const lb of b) {
      const p = intersect(la, lb);
      if (!p) return null;
      // A corner well outside the frame means these lines are not the page.
      // A little outside is normal and fine -- a page can run off the edge.
      if (p.x < -grey.w * 0.5 || p.x > grey.w * 1.5) return null;
      if (p.y < -grey.h * 0.5 || p.y > grey.h * 1.5) return null;
      corners.push({ x: p.x / grey.w, y: p.y / grey.h });
    }
  }

  const quad = orderQuad(corners);
  if (!quad) return null;
  if (!isConvex(quad)) return null;
  if (quadArea(quad) < MIN_AREA) return null;

  // A real page's corners are corners. Anything much flatter than 36 degrees
  // is two nearly-collinear edges pretending, which warps into a smear.
  const p = quadPoints(quad);
  for (let i = 0; i < 4; i++) {
    const prev = p[(i + 3) % 4]!;
    const cur = p[i]!;
    const next = p[(i + 1) % 4]!;
    const v1 = Math.atan2(prev.y - cur.y, prev.x - cur.x);
    const v2 = Math.atan2(next.y - cur.y, next.x - cur.x);
    let d = Math.abs(v1 - v2);
    if (d > Math.PI) d = Math.PI * 2 - d;
    if (d < MIN_CORNER_ANGLE || d > Math.PI - MIN_CORNER_ANGLE) return null;
  }

  return quad;
}
