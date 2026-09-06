/**
 * The ink engine — raw pointer samples in, a smooth variable-width outline out.
 *
 * This exists because a signature is the one drawing in the app where the
 * *input device is the problem*. A finger on the reference phone emits ~120 clean samples
 * a second across 450 dpi; a desktop mouse emits jerky integer-pixel steps and
 * the hand driving it has no wrist rotation to speak of. The same code has to
 * make both produce something a person will put on a contract, so every stage
 * below is written to be re-tuned per input rather than tuned once for a
 * touchscreen and left to embarrass itself on a mouse.
 *
 * The pipeline, in order:
 *
 *   raw samples → stabilise → resample → widths → outline → path
 *
 * **Why stabilise with a spring rather than a moving average.** An average of
 * the last N points rounds corners symmetrically, which turns the sharp
 * reversals in a signature into loops. A spring — the brush chases the pointer
 * instead of tracking it — kills jitter without touching the corner, because
 * the brush simply arrives at the corner slightly late and then catches up. It
 * is the same trick Illustrator and Krita call a "stabiliser", and it is the
 * single largest quality win available on a mouse.
 *
 * **Why widths are normalised against the stroke's own speed.** Real pens lay
 * more ink where the nib moves slowly. Every signature pad copies that with an
 * absolute velocity threshold, and that is exactly why drawing slowly with a
 * mouse produces a uniform sausage: every sample falls under the threshold, so
 * every sample gets maximum width. Here the modulation is relative to the
 * median speed of the stroke being drawn, so a signature drawn over eight
 * seconds gets the same expressive range as one drawn over two. That is the
 * whole reason you can now draw as slowly as you like.
 *
 * Everything here is pure and framework-free: numbers in, numbers out, no DOM,
 * no canvas. The pad renders it, the PDF writer renders it, and a future export
 * to SVG renders it, all from the same outline.
 */

/** One raw sample. `t` is milliseconds; `p` is 0..1 pressure when the device reports it. */
export interface InkPoint {
  x: number;
  y: number;
  t: number;
  p?: number;
}

/** A single continuous press-drag-release. */
export interface InkStroke {
  points: InkPoint[];
}

/**
 * How the ink behaves. All of it is user-facing — this is the object the
 * signature pad's sliders write to, and the object saved with a signature so
 * it can be re-rendered later at any size.
 */
export interface InkSettings {
  /**
   * How hard the brush lags the pointer, 0..1. 0 tracks exactly (and shows
   * every tremor); 0.9 feels like drawing through honey and is what makes a
   * mouse usable. Defaults differ by device — see {@link defaultsFor}.
   */
  stabilise: number;
  /** Base stroke width, in the same units as the points. */
  thickness: number;
  /**
   * Extra weight, 0.5..2.5. Multiplies thickness *after* speed modulation, so
   * turning boldness up thickens the whole signature without flattening the
   * thick/thin contrast the way raising thickness alone does.
   */
  boldness: number;
  /**
   * How much speed thins the line, 0..1. 0 is a constant-width felt tip; 1 is a
   * fountain pen with a lot of contrast. Relative to the stroke's own median
   * speed, never absolute.
   */
  contrast: number;
  /** Curve tension for the Catmull-Rom fit, 0..1. Higher is rounder. */
  smoothing: number;
  /** How far the ends taper to a point, 0..1. 0 is a blunt cap. */
  taper: number;
  /** Floor on width as a fraction of thickness, so fast strokes never vanish. */
  minRatio: number;
  /** Use device pressure when the hardware reports it. Ignored on mouse/finger. */
  usePressure: boolean;
}

export const DEFAULT_INK: InkSettings = {
  stabilise: 0.55,
  thickness: 3.2,
  boldness: 1,
  contrast: 0.55,
  smoothing: 0.5,
  taper: 0.6,
  minRatio: 0.35,
  usePressure: true,
};

/**
 * Sensible starting points per input device.
 *
 * These are defaults, not a lock — the pad exposes every one of them. The
 * split matters because the right stabilisation for a mouse (a lot) makes a
 * finger feel disconnected and laggy, and the right amount for a finger (a
 * little) leaves a mouse drawing visibly polygonal.
 */
export function defaultsFor(pointer: "mouse" | "touch" | "pen"): InkSettings {
  switch (pointer) {
    case "mouse":
      // A mouse has no wrist and reports integer pixels. Lag it hard, thin it
      // less (there is no natural speed variation to read), and taper less
      // because the user cannot control lift-off speed.
      return { ...DEFAULT_INK, stabilise: 0.78, contrast: 0.4, taper: 0.45, thickness: 3.4 };
    case "pen":
      // A stylus reports real pressure and real tilt-free velocity. Get out of
      // the way and let the hardware do the expression.
      return { ...DEFAULT_INK, stabilise: 0.25, contrast: 0.7, taper: 0.75, usePressure: true };
    case "touch":
    default:
      // A finger is steady but blunt: light smoothing, generous width.
      return { ...DEFAULT_INK, stabilise: 0.42, contrast: 0.55, taper: 0.6, thickness: 4.2 };
  }
}

/* ────────────────────────────────────────────────────────────── stabilise ── */

/**
 * Pull the brush along behind the pointer.
 *
 * Two passes. The first is a short symmetric median-ish smooth that removes
 * single-sample spikes (a mouse dropping a pixel, a finger's first contact
 * frame landing off-centre); the second is the spring. Doing the spike removal
 * first matters, because a spring fed a spike converts it into a long slow
 * excursion rather than rejecting it.
 *
 * The spring is run to convergence at the end of the stroke so the ink actually
 * reaches where the pointer stopped. Without that the signature ends a few
 * pixels short of the lift point, which reads as a stroke that "gives up".
 */
export function stabilise(points: readonly InkPoint[], amount: number): InkPoint[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));

  const k = clamp(1 - amount, 0.04, 1);

  // Pass one: 3-tap spike rejection, endpoints preserved.
  const clean: InkPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    if (!cur) continue;
    const prev = points[i - 1];
    const next = points[i + 1];
    if (!prev || !next) {
      clean.push({ ...cur });
      continue;
    }
    clean.push({
      ...cur,
      x: (prev.x + cur.x * 2 + next.x) / 4,
      y: (prev.y + cur.y * 2 + next.y) / 4,
    });
  }

  // Pass two: the spring.
  const first = clean[0];
  if (!first) return clean;
  const out: InkPoint[] = [{ ...first }];
  let bx = first.x;
  let by = first.y;

  for (let i = 1; i < clean.length; i++) {
    const p = clean[i];
    if (!p) continue;
    bx += (p.x - bx) * k;
    by += (p.y - by) * k;
    out.push({ ...p, x: bx, y: by });
  }

  // Let the brush catch up to the true final position, or the stroke stops
  // short of where the user lifted.
  //
  // The iteration budget has to scale with the lag: at `stabilise` 0.95 the
  // brush closes 5% of the gap per step, so a fixed two dozen steps leaves the
  // stroke ending a visible distance short — which is exactly the setting
  // someone drawing with a mouse would pick. Solved for the geometric decay
  // and capped, rather than guessed.
  const last = clean[clean.length - 1];
  if (last) {
    const budget = Math.min(400, Math.ceil(Math.log(0.002) / Math.log(1 - k)) + 4);
    for (let i = 0; i < budget; i++) {
      const dx = last.x - bx;
      const dy = last.y - by;
      if (Math.hypot(dx, dy) < 0.05) break;
      bx += dx * k;
      by += dy * k;
      out.push({ ...last, x: bx, y: by });
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────── resample ── */

/**
 * Re-space the points evenly along the curve.
 *
 * Width modulation and outline generation both assume roughly uniform spacing;
 * fed raw samples they produce fat clumps wherever the hand slowed down, which
 * is precisely where a signature has its detail. Timestamps are interpolated
 * too, because the width pass still needs to know how fast the hand was moving
 * through each resampled point.
 */
export function resample(points: readonly InkPoint[], spacing: number): InkPoint[] {
  const first = points[0];
  if (!first || points.length < 2) return points.map((p) => ({ ...p }));
  const step = Math.max(0.25, spacing);

  const out: InkPoint[] = [{ ...first }];
  let carry = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg <= 1e-6) continue;

    let travelled = carry;
    while (travelled + step <= seg) {
      travelled += step;
      const u = travelled / seg;
      out.push({
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        t: a.t + (b.t - a.t) * u,
        ...(a.p !== undefined && b.p !== undefined ? { p: a.p + (b.p - a.p) * u } : {}),
      });
    }
    carry = travelled - seg;
  }

  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (last && tail && Math.hypot(last.x - tail.x, last.y - tail.y) > step * 0.4) {
    out.push({ ...last });
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────── widths ── */

/**
 * Width at every point, in the same units as the coordinates.
 *
 * The speed term is the interesting one. `speed[i] / median` is dimensionless,
 * so a slow careful signature and a fast scrawl both land around 1.0 and get
 * the same range of thick and thin. Absolute thresholds — what most pads use —
 * are what make slow drawing look dead, and slow drawing is the entire point of
 * this feature.
 */
export function widths(points: readonly InkPoint[], s: InkSettings): number[] {
  const n = points.length;
  if (n === 0) return [];

  const base = Math.max(0.2, s.thickness) * clamp(s.boldness, 0.3, 3);
  if (n < 3) return new Array<number>(n).fill(base);

  // Instantaneous speed, in units per millisecond.
  const speed: number[] = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const dt = Math.max(1, b.t - a.t);
    speed[i] = Math.hypot(b.x - a.x, b.y - a.y) / dt;
  }
  const head = speed[1];
  if (head !== undefined) speed[0] = head;

  // Median, not mean: one flick across the pad while repositioning the hand
  // would drag a mean far enough to wash out the whole stroke.
  const sorted = [...speed].filter((v) => v > 0).sort((a, b) => a - b);
  const median = sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0;

  const out: number[] = new Array<number>(n).fill(base);
  const floor = clamp(s.minRatio, 0.05, 1);

  for (let i = 0; i < n; i++) {
    let w = base;

    if (median > 1e-9 && s.contrast > 0) {
      // Faster than usual → thinner. Ratio is clamped so a single fast frame
      // cannot punch a hole in the line.
      const rel = clamp((speed[i] ?? 0) / median, 0.25, 3);
      const thin = 1 / (1 + (rel - 1) * 0.85);
      w *= 1 - s.contrast + s.contrast * clamp(thin, floor, 1.6);
    }

    if (s.usePressure) {
      const pr = points[i]?.p;
      // 0.5 is the value browsers invent for devices with no pressure, so it
      // has to be a no-op rather than "half width".
      if (pr !== undefined && pr > 0 && Math.abs(pr - 0.5) > 0.01) {
        w *= 0.55 + pr * 0.9;
      }
    }

    out[i] = Math.max(base * floor, w);
  }

  // Taper the ends. Applied last so it survives the clamps above — a taper that
  // gets floored is not a taper.
  if (s.taper > 0) {
    const span = Math.min(Math.floor(n * 0.22), Math.max(2, Math.round(n * 0.18)));
    for (let i = 0; i < span; i++) {
      const u = span <= 1 ? 1 : i / (span - 1);
      const f = 1 - s.taper * (1 - u) ** 1.7;
      const a = out[i];
      const b = out[n - 1 - i];
      if (a !== undefined) out[i] = a * f;
      if (b !== undefined) out[n - 1 - i] = b * f;
    }
  }

  // One light smoothing pass, or the width steps are visible as banding on a
  // thick signature.
  const sm: number[] = out.slice();
  for (let i = 1; i < n - 1; i++) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if (a !== undefined && b !== undefined && c !== undefined) sm[i] = (a + b * 2 + c) / 4;
  }
  return sm;
}

/* ──────────────────────────────────────────────────────────────── outline ── */

export interface Vec {
  x: number;
  y: number;
}

/**
 * The filled outline of a stroke: up one side, round the end, back the other.
 *
 * Variable width cannot be drawn with `lineWidth` — canvas has one width per
 * path — so the ink is a *filled polygon* built by offsetting the centreline by
 * half the local width along the local normal. This is also what makes the
 * signature exportable as a single SVG path and drawable by pdf-lib, which has
 * no variable-width stroke either.
 */
export function outline(points: readonly InkPoint[], w: readonly number[]): Vec[] {
  const n = points.length;
  if (n === 0) return [];

  const only = points[0];
  if (n === 1 && only) {
    // A tap is a dot. Without this a single-sample stroke renders as nothing,
    // which reads as the app having missed the touch.
    const r = Math.max(0.3, (w[0] ?? 1) / 2);
    const ring: Vec[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ring.push({ x: only.x + Math.cos(a) * r, y: only.y + Math.sin(a) * r });
    }
    return ring;
  }

  const left: Vec[] = [];
  const right: Vec[] = [];

  for (let i = 0; i < n; i++) {
    const cur = points[i];
    if (!cur) continue;
    const prev = points[i - 1] ?? cur;
    const next = points[i + 1] ?? cur;

    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty);
    if (len < 1e-9) {
      tx = 1;
      ty = 0;
    } else {
      tx /= len;
      ty /= len;
    }

    const half = Math.max(0.15, (w[i] ?? 1) / 2);
    // Normal is the tangent rotated 90°.
    const nx = -ty * half;
    const ny = tx * half;

    left.push({ x: cur.x + nx, y: cur.y + ny });
    right.push({ x: cur.x - nx, y: cur.y - ny });
  }

  const startCap = cap(points[0], points[1], w[0] ?? 1, true);
  const endCap = cap(points[n - 1], points[n - 2], w[n - 1] ?? 1, false);

  return [...left, ...endCap, ...right.reverse(), ...startCap];
}

/** Half-circle round cap, so ends read as ink rather than as cut tube. */
function cap(at: InkPoint | undefined, toward: InkPoint | undefined, width: number, start: boolean): Vec[] {
  if (!at) return [];
  const r = Math.max(0.15, width / 2);
  const dx = (toward?.x ?? at.x) - at.x;
  const dy = (toward?.y ?? at.y) - at.y;
  const len = Math.hypot(dx, dy);
  const ang = len < 1e-9 ? 0 : Math.atan2(dy, dx);
  const base = start ? ang : ang + Math.PI;

  const pts: Vec[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = base - Math.PI / 2 + (i / 8) * Math.PI;
    pts.push({ x: at.x + Math.cos(a) * r, y: at.y + Math.sin(a) * r });
  }
  return start ? pts.reverse() : pts;
}

/* ─────────────────────────────────────────────────────────────────── path ── */

/**
 * A closed SVG path through the outline, smoothed with quadratic midpoints.
 *
 * Midpoint smoothing rather than a full spline fit: it is one pass, it cannot
 * overshoot (every control point is an original vertex), and on an outline —
 * where the vertices are already dense and evenly spaced — the difference from
 * a proper fit is invisible. Overshoot on a signature outline shows up as tiny
 * bulges on the outside of tight curves, which is exactly where an eye looking
 * at a signature is looking.
 */
export function toSvgPath(poly: readonly Vec[], smoothing = 0.5, dp = 2): string {
  if (poly.length === 0) return "";
  const f = (v: number): string => {
    const s = v.toFixed(dp);
    // Trim "12.00" → "12" and "-0" → "0"; on a 400-point outline this is a
    // meaningful fraction of the stored bytes.
    return s.replace(/\.?0+$/, "") || "0";
  };

  const head = poly[0];
  if (!head) return "";
  if (poly.length < 3 || smoothing <= 0) {
    return `M${f(head.x)} ${f(head.y)}` + poly.slice(1).map((p) => `L${f(p.x)} ${f(p.y)}`).join("") + "Z";
  }

  let d = `M${f((head.x + (poly[poly.length - 1]?.x ?? head.x)) / 2)} ${f(
    (head.y + (poly[poly.length - 1]?.y ?? head.y)) / 2,
  )}`;
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const next = poly[(i + 1) % poly.length];
    if (!cur || !next) continue;
    d += `Q${f(cur.x)} ${f(cur.y)} ${f((cur.x + next.x) / 2)} ${f((cur.y + next.y) / 2)}`;
  }
  return `${d}Z`;
}

/* ──────────────────────────────────────────────────────────────── compose ── */

/** A stroke reduced to the one thing every renderer needs. */
export interface InkPath {
  d: string;
  poly: Vec[];
}

/**
 * Run the whole pipeline for one stroke.
 *
 * `scale` exists so the pad can capture at CSS pixels and the exporter can ask
 * for the same signature at PDF points without re-deriving anything: widths are
 * in coordinate units, so both the points and the settings scale together.
 */
export function buildStroke(stroke: InkStroke, s: InkSettings, scale = 1): InkPath {
  const settings: InkSettings = scale === 1 ? s : { ...s, thickness: s.thickness * scale };
  const pts =
    scale === 1
      ? stroke.points
      : stroke.points.map((p) => ({ ...p, x: p.x * scale, y: p.y * scale }));

  const smooth = stabilise(pts, clamp(settings.stabilise, 0, 0.95));
  // Spacing tracks thickness: a hairline needs dense samples to look curved, a
  // fat stroke does not, and oversampling a fat stroke just costs bytes.
  const spaced = resample(smooth, Math.max(0.6, settings.thickness * 0.42));
  const w = widths(spaced, settings);
  const poly = outline(spaced, w);
  return { d: toSvgPath(poly, settings.smoothing), poly };
}

/** Every stroke of a signature, as one path each. */
export function buildAll(strokes: readonly InkStroke[], s: InkSettings, scale = 1): InkPath[] {
  return strokes.map((st) => buildStroke(st, s, scale));
}

/* ────────────────────────────────────────────────────────────────── bounds ── */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tight box around rendered ink. Empty strokes give a zero box, never NaN. */
export function boundsOf(paths: readonly InkPath[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of paths) {
    for (const v of p.poly) {
      if (v.x < x0) x0 = v.x;
      if (v.y < y0) y0 = v.y;
      if (v.x > x1) x1 = v.x;
      if (v.y > y1) y1 = v.y;
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Move strokes so the ink sits at the origin, and scale it to a target height.
 *
 * Signatures are captured on a big pad and stamped small. Trimming the
 * whitespace at capture time — rather than storing the pad's dimensions — is
 * what lets the same signature drop into a 40 pt PDF field and a 2000 px image
 * without carrying a margin that changes with how much of the pad was used.
 */
export function trimAndScale(strokes: readonly InkStroke[], s: InkSettings, targetHeight: number): {
  strokes: InkStroke[];
  settings: InkSettings;
} {
  const box = boundsOf(buildAll(strokes, s));
  if (box.h <= 1e-6 || targetHeight <= 0) {
    return { strokes: strokes.map((st) => ({ points: st.points.map((p) => ({ ...p })) })), settings: { ...s } };
  }
  const k = targetHeight / box.h;
  return {
    strokes: strokes.map((st) => ({
      points: st.points.map((p) => ({ ...p, x: (p.x - box.x) * k, y: (p.y - box.y) * k })),
    })),
    settings: { ...s, thickness: s.thickness * k },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
