/**
 * SVG in, plain path geometry out.
 *
 * Two features need this and they need the same thing: importing a signature
 * someone else vectorised, and importing a watermark or logo. Both end up drawn
 * three ways — on a canvas via `Path2D`, into an exported SVG, and into a PDF
 * via pdf-lib's `drawSvgPath` — and the three disagree about almost everything
 * an SVG file can contain.
 *
 * So this module reduces an arbitrary SVG to the smallest thing all three
 * render identically: **absolute `M`, `L`, `C` and `Z` only**, with every
 * transform already multiplied into the coordinates.
 *
 * That means, concretely:
 *
 * - `H`/`V` become `L`, `S`/`T` become `C`, `Q` becomes `C`, and `A` becomes a
 *   chain of cubics. pdf-lib's path parser is a small one and does not
 *   implement arcs at all; a signature that silently loses its curves in the
 *   PDF but looks right on screen is the worst possible failure here.
 * - `transform` attributes are baked in. pdf-lib ignores them, so a logo
 *   exported from Illustrator — which nests transformed groups as a matter of
 *   habit — would otherwise land in the wrong place and the wrong size.
 * - Relative commands become absolute, because a transformed relative command
 *   is only correct if the matrix has no translation.
 *
 * **Safety.** The file is parsed with `DOMParser` and never inserted into the
 * page. Nothing is executed: `<script>`, event attributes, `<foreignObject>`
 * and external references are not read at all, because only geometry elements
 * are visited. An imported SVG is untrusted input — it arrives from a file
 * picker — and the only defensible handling is to take the numbers and leave
 * the document behind.
 *
 * **What is deliberately dropped.** Fill and stroke colour, gradients, filters,
 * clip paths, masks, text, and images. A watermark is stamped in one colour at
 * one opacity by design, and a signature is ink. Keeping colour would imply
 * gradient support that pdf-lib cannot honour, and a half-supported gradient is
 * worse than an honest single colour.
 */

/** `[a, b, c, d, e, f]`, the usual SVG matrix. */
export type Mat = readonly [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Parse an SVG `transform` attribute — the whole grammar, left to right. */
export function parseTransform(spec: string): Mat {
  let m: Mat = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  for (let hit = re.exec(spec); hit; hit = re.exec(spec)) {
    const name = hit[1];
    const nums = (hit[2] ?? "")
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const n = (i: number, fallback = 0): number => nums[i] ?? fallback;

    switch (name) {
      case "matrix":
        if (nums.length >= 6) m = mul(m, [n(0), n(1), n(2), n(3), n(4), n(5)]);
        break;
      case "translate":
        m = mul(m, [1, 0, 0, 1, n(0), n(1)]);
        break;
      case "scale": {
        const sx = n(0, 1);
        // `scale(2)` means both axes. Defaulting sy to 0 would collapse the art.
        m = mul(m, [sx, 0, 0, nums.length > 1 ? n(1, 1) : sx, 0, 0]);
        break;
      }
      case "rotate": {
        const a = (n(0) * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        if (nums.length >= 3) {
          // rotate(a, cx, cy) is translate(c) · rotate(a) · translate(-c).
          m = mul(m, [1, 0, 0, 1, n(1), n(2)]);
          m = mul(m, [cos, sin, -sin, cos, 0, 0]);
          m = mul(m, [1, 0, 0, 1, -n(1), -n(2)]);
        } else {
          m = mul(m, [cos, sin, -sin, cos, 0, 0]);
        }
        break;
      }
      case "skewX":
        m = mul(m, [1, 0, Math.tan((n(0) * Math.PI) / 180), 1, 0, 0]);
        break;
      case "skewY":
        m = mul(m, [1, Math.tan((n(0) * Math.PI) / 180), 0, 1, 0, 0]);
        break;
    }
  }
  return m;
}

/* ──────────────────────────────────────────────────────────── path parse ── */

/** The reduced instruction set everything is normalised to. */
type Seg =
  | { k: "M"; x: number; y: number }
  | { k: "L"; x: number; y: number }
  | { k: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { k: "Z" };

/** Split a `d` attribute into commands and numbers, tolerating SVG's laxity. */
function tokens(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  for (let hit = re.exec(d); hit; hit = re.exec(d)) {
    if (hit[1]) out.push(hit[1]);
    else if (hit[2] !== undefined) out.push(parseFloat(hit[2]));
  }
  return out;
}

/**
 * Normalise a `d` attribute to absolute `M`/`L`/`C`/`Z`.
 *
 * Written as a hand-rolled state machine rather than a table because the
 * awkward parts — an implicit `L` after `M`, the reflected control point of
 * `S`/`T`, `Z` restoring the subpath start as the current point — are all
 * special cases that a table would need to special-case anyway.
 */
function parsePath(d: string): Seg[] {
  const t = tokens(d);
  const segs: Seg[] = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Last cubic/quadratic control point, for S and T reflection.
  let cx = 0;
  let cy = 0;
  let qx = 0;
  let qy = 0;

  const num = (): number => {
    const v = t[i++];
    return typeof v === "number" ? v : 0;
  };

  while (i < t.length) {
    const tok = t[i];
    if (typeof tok === "string") {
      cmd = tok;
      i++;
      // A bare `Z` carries no numbers, so handle it before the argument loop.
      if (cmd === "Z" || cmd === "z") {
        segs.push({ k: "Z" });
        x = startX;
        y = startY;
        continue;
      }
    } else if (cmd === "") {
      i++;
      continue;
    } else if (cmd === "M") {
      // Repeated pairs after an M are implicit L, per the spec.
      cmd = "L";
    } else if (cmd === "m") {
      cmd = "l";
    }

    const rel = cmd >= "a" && cmd <= "z";
    const bx = rel ? x : 0;
    const by = rel ? y : 0;

    switch (cmd.toUpperCase()) {
      case "M": {
        x = bx + num();
        y = by + num();
        startX = x;
        startY = y;
        segs.push({ k: "M", x, y });
        cx = x;
        cy = y;
        qx = x;
        qy = y;
        break;
      }
      case "L": {
        x = bx + num();
        y = by + num();
        segs.push({ k: "L", x, y });
        cx = x;
        cy = y;
        qx = x;
        qy = y;
        break;
      }
      case "H": {
        x = bx + num();
        segs.push({ k: "L", x, y });
        cx = x;
        cy = y;
        break;
      }
      case "V": {
        y = by + num();
        segs.push({ k: "L", x, y });
        cx = x;
        cy = y;
        break;
      }
      case "C": {
        const x1 = bx + num();
        const y1 = by + num();
        const x2 = bx + num();
        const y2 = by + num();
        x = bx + num();
        y = by + num();
        segs.push({ k: "C", x1, y1, x2, y2, x, y });
        cx = x2;
        cy = y2;
        qx = x;
        qy = y;
        break;
      }
      case "S": {
        // Reflect the previous cubic's second control point about the current
        // point; if the previous segment was not a cubic, the reflection is the
        // current point itself.
        const x1 = 2 * x - cx;
        const y1 = 2 * y - cy;
        const x2 = bx + num();
        const y2 = by + num();
        x = bx + num();
        y = by + num();
        segs.push({ k: "C", x1, y1, x2, y2, x, y });
        cx = x2;
        cy = y2;
        qx = x;
        qy = y;
        break;
      }
      case "Q": {
        const px = bx + num();
        const py = by + num();
        const ex = bx + num();
        const ey = by + num();
        segs.push(quadToCubic(x, y, px, py, ex, ey));
        qx = px;
        qy = py;
        x = ex;
        y = ey;
        cx = x;
        cy = y;
        break;
      }
      case "T": {
        const px = 2 * x - qx;
        const py = 2 * y - qy;
        const ex = bx + num();
        const ey = by + num();
        segs.push(quadToCubic(x, y, px, py, ex, ey));
        qx = px;
        qy = py;
        x = ex;
        y = ey;
        cx = x;
        cy = y;
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const ex = bx + num();
        const ey = by + num();
        for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey)) segs.push(c);
        x = ex;
        y = ey;
        cx = x;
        cy = y;
        qx = x;
        qy = y;
        break;
      }
      default:
        // Unknown command: consume one number so a malformed file cannot spin.
        i++;
        break;
    }
  }
  return segs;
}

function quadToCubic(x0: number, y0: number, px: number, py: number, x: number, y: number): Seg {
  // A quadratic is exactly a cubic whose controls sit two-thirds of the way
  // from each endpoint to the quadratic's single control point. No error.
  return {
    k: "C",
    x1: x0 + (2 / 3) * (px - x0),
    y1: y0 + (2 / 3) * (py - y0),
    x2: x + (2 / 3) * (px - x),
    y2: y + (2 / 3) * (py - y),
    x,
    y,
  };
}

/**
 * Elliptical arc to a chain of cubics.
 *
 * Endpoint parameterisation is converted to centre parameterisation (SVG spec
 * appendix F.6), then split so no piece spans more than 90°. A cubic
 * approximates a quarter arc to about one part in 10⁴, which is far below a
 * printed dot; a half arc in one cubic is visibly wrong on a circle.
 */
function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
  x: number,
  y: number,
): Seg[] {
  // Degenerate radii mean a straight line, per the spec.
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-9 || ry < 1e-9 || (x0 === x && y0 === y)) return [{ k: "L", x, y }];

  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);

  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1 = cos * dx2 + sin * dy2;
  const y1 = -sin * dx2 + cos * dy2;

  // Scale the radii up if they are too small to reach — the spec's F.6.6.
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sq = Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) /
    (rx * rx * y1 * y1 + ry * ry * x1 * x1));
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(sq);
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;

  const cxm = cos * cx1 - sin * cy1 + (x0 + x) / 2;
  const cym = sin * cx1 + cos * cy1 + (y0 + y) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };

  const theta = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / steps;
  // Magic constant for approximating a circular arc of `step` radians.
  const k = (4 / 3) * Math.tan(step / 4);

  const out: Seg[] = [];
  let px = x0;
  let py = y0;
  for (let n = 0; n < steps; n++) {
    const a0 = theta + n * step;
    const a1 = a0 + step;
    const at = (a: number): { x: number; y: number; dx: number; dy: number } => {
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      return {
        x: cxm + rx * ca * cos - ry * sa * sin,
        y: cym + rx * ca * sin + ry * sa * cos,
        dx: -rx * sa * cos - ry * ca * sin,
        dy: -rx * sa * sin + ry * ca * cos,
      };
    };
    const p0 = at(a0);
    const p1 = at(a1);
    out.push({
      k: "C",
      x1: px + k * p0.dx,
      y1: py + k * p0.dy,
      x2: p1.x - k * p1.dx,
      y2: p1.y - k * p1.dy,
      x: n === steps - 1 ? x : p1.x,
      y: n === steps - 1 ? y : p1.y,
    });
    px = p1.x;
    py = p1.y;
  }
  return out;
}

/** Serialise segments through a matrix, rounded to `dp` places. */
function segsToPath(segs: readonly Seg[], m: Mat, dp: number): string {
  const f = (v: number): string => {
    const s = v.toFixed(dp);
    return (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s) || "0";
  };
  let out = "";
  for (const s of segs) {
    switch (s.k) {
      case "M": {
        const p = apply(m, s.x, s.y);
        out += `M${f(p.x)} ${f(p.y)}`;
        break;
      }
      case "L": {
        const p = apply(m, s.x, s.y);
        out += `L${f(p.x)} ${f(p.y)}`;
        break;
      }
      case "C": {
        const a = apply(m, s.x1, s.y1);
        const b = apply(m, s.x2, s.y2);
        const c = apply(m, s.x, s.y);
        out += `C${f(a.x)} ${f(a.y)} ${f(b.x)} ${f(b.y)} ${f(c.x)} ${f(c.y)}`;
        break;
      }
      case "Z":
        out += "Z";
        break;
    }
  }
  return out;
}

/** Apply a matrix to an existing path string, normalising it on the way. */
export function transformPath(d: string, m: Mat, dp = 3): string {
  return segsToPath(parsePath(d), m, dp);
}

/* ────────────────────────────────────────────────────────────── document ── */

export interface SvgGeometry {
  /** Normalised `M`/`L`/`C`/`Z` paths, in viewBox coordinates. */
  paths: string[];
  /** `[minX, minY, width, height]`. */
  viewBox: [number, number, number, number];
}

/** Basic shapes rewritten as path data. */
function shapeToPath(el: Element): string | null {
  const n = (name: string, fallback = 0): number => {
    const v = parseFloat(el.getAttribute(name) ?? "");
    return Number.isFinite(v) ? v : fallback;
  };

  switch (el.tagName.toLowerCase()) {
    case "path":
      return el.getAttribute("d");
    case "rect": {
      const x = n("x");
      const y = n("y");
      const w = n("width");
      const h = n("height");
      if (w <= 0 || h <= 0) return null;
      // Rounded corners are arcs, and parsePath turns those into cubics — so a
      // rounded rect survives the trip to a PDF intact.
      let rx = n("rx", NaN);
      let ry = n("ry", NaN);
      if (!Number.isFinite(rx) && !Number.isFinite(ry)) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      rx = Math.min(Number.isFinite(rx) ? rx : ry, w / 2);
      ry = Math.min(Number.isFinite(ry) ? ry : rx, h / 2);
      return (
        `M${x + rx} ${y}h${w - 2 * rx}a${rx} ${ry} 0 0 1 ${rx} ${ry}` +
        `v${h - 2 * ry}a${rx} ${ry} 0 0 1 ${-rx} ${ry}` +
        `h${-(w - 2 * rx)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}` +
        `v${-(h - 2 * ry)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}Z`
      );
    }
    case "circle": {
      const r = n("r");
      if (r <= 0) return null;
      const cx = n("cx");
      const cy = n("cy");
      return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
    }
    case "ellipse": {
      const rx = n("rx");
      const ry = n("ry");
      if (rx <= 0 || ry <= 0) return null;
      const cx = n("cx");
      const cy = n("cy");
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case "line":
      return `M${n("x1")} ${n("y1")}L${n("x2")} ${n("y2")}`;
    case "polyline":
    case "polygon": {
      const pts = (el.getAttribute("points") ?? "").trim();
      if (!pts) return null;
      const nums = pts.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
      if (nums.length < 4) return null;
      let d = `M${nums[0]} ${nums[1]}`;
      for (let i = 2; i + 1 < nums.length; i += 2) d += `L${nums[i]} ${nums[i + 1]}`;
      return el.tagName.toLowerCase() === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

/**
 * Parse an SVG document into flat geometry.
 *
 * Returns `null` rather than throwing when the file is not an SVG or contains
 * no drawable geometry, because both of those are things a user can do by
 * picking the wrong file and neither deserves an exception.
 */
export function parseSvg(text: string): SvgGeometry | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "image/svg+xml");
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;
  // DOMParser reports XML errors as a <parsererror> element rather than by
  // throwing, so it has to be checked explicitly.
  if (doc.getElementsByTagName("parsererror").length > 0) return null;

  const paths: string[] = [];

  const walk = (el: Element, m: Mat): void => {
    const tag = el.tagName.toLowerCase();
    // Never descend into anything that can carry markup, script, or an external
    // reference. These are skipped whole, children included.
    if (tag === "script" || tag === "foreignobject" || tag === "style" || tag === "defs") return;
    // <use>, <image> and <text> are dropped: resolving them means either
    // executing a reference or rasterising a font, and both are out of scope.
    if (tag === "use" || tag === "image" || tag === "text") return;

    const local = el.getAttribute("transform");
    const here = local ? mul(m, parseTransform(local)) : m;

    // `display:none` geometry is invisible in the source and should stay
    // invisible after import.
    const style = el.getAttribute("style") ?? "";
    if (el.getAttribute("display") === "none" || /display\s*:\s*none/.test(style)) return;

    const d = shapeToPath(el);
    if (d) {
      const norm = segsToPath(parsePath(d), here, 3);
      if (norm) paths.push(norm);
    }

    for (const child of Array.from(el.children)) walk(child, here);
  };

  for (const child of Array.from(root.children)) walk(child, IDENTITY);
  if (paths.length === 0) return null;

  return { paths, viewBox: viewBoxOf(root, paths) };
}

/**
 * The box the paths live in.
 *
 * A declared `viewBox` wins, then `width`/`height`, then a computed bound. The
 * fallback matters more than it looks: plenty of real SVGs — anything exported
 * from a plotter or traced from a scan — have neither attribute, and without a
 * box there is no way to place or scale the art.
 */
function viewBoxOf(root: Element, paths: readonly string[]): [number, number, number, number] {
  const vb = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every((v) => Number.isFinite(v))) {
    const [a, b, w, h] = vb as [number, number, number, number];
    if (w > 0 && h > 0) return [a, b, w, h];
  }
  const w = parseFloat(root.getAttribute("width") ?? "");
  const h = parseFloat(root.getAttribute("height") ?? "");
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return [0, 0, w, h];
  return boundsOfPaths(paths);
}

/**
 * Bounding box of normalised paths.
 *
 * Control points are included rather than solving each curve, which can
 * overstate the box slightly on a strongly curved path. That is the right trade
 * for a placement box: a little too much whitespace is invisible, whereas a box
 * that clips the art is a bug the user sees immediately.
 */
export function boundsOfPaths(paths: readonly string[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const d of paths) {
    const nums = d.match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
    if (!nums) continue;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = parseFloat(nums[i] ?? "");
      const y = parseFloat(nums[i + 1] ?? "");
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return [0, 0, 1, 1];
  return [x0, y0, Math.max(1e-6, x1 - x0), Math.max(1e-6, y1 - y0)];
}

/** Fit art into a box, preserving aspect. Returns the matrix to draw it with. */
export function fitMatrix(
  viewBox: readonly [number, number, number, number],
  box: { x: number; y: number; w: number; h: number },
): Mat {
  const [vx, vy, vw, vh] = viewBox;
  const k = Math.min(box.w / vw, box.h / vh);
  return [k, 0, 0, k, box.x - vx * k + (box.w - vw * k) / 2, box.y - vy * k + (box.h - vh * k) / 2];
}
