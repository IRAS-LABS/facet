/**
 * The blur engine.
 *
 * Blur is the centre of gravity for this app, so it is not a filter — it is a
 * list of *regions*, each with its own kind, strength, colour and edge, layered
 * bottom-to-top and re-rendered from the original pixels every time. Nothing is
 * ever baked. Deleting a region ten edits later restores exactly what was under
 * it, because "what was under it" was never overwritten.
 *
 * Geometry is stored **normalised to 0..1** against the image box. That is what
 * lets the same region list drive a 400 px preview, a 45 MP export, and a video
 * frame at a different resolution, and it is why `feather` and `amount` are
 * expressed relative to the image's short edge rather than in device pixels —
 * a 20 px feather tuned on a preview would be a hairline on the export.
 *
 * Everything here is pure: canvases in, canvas out, no DOM outside the 2D
 * context. The same file will run against an OffscreenCanvas in a worker for
 * batch, and against a video frame for tracked blur, without changes.
 */

export type BlurKind =
  /** Ordinary soft blur. The default, and what people mean by "blur". */
  | "gaussian"
  /** Cheap square-kernel blur. Harsher; useful when you want it to read as an effect. */
  | "box"
  /** Big hard squares. The one that reads as "this was deliberately censored". */
  | "pixelate"
  /** Pixelate on a triangular/diamond lattice — softer, less clinical. */
  | "mosaic"
  /** Directional smear. `angle` drives it. */
  | "motion"
  /** Spin smear around the region centre. */
  | "radial"
  /** Blur plus fine noise — frosted glass rather than out-of-focus. */
  | "frosted"
  /** No blur at all: a flat fill. Cosmetic — see `redact` for the safe one. */
  | "solid"
  /**
   * Redaction proper: an opaque fill that cannot be undone by anyone, ever.
   *
   * Every other kind on this list is cosmetic, and three of them are actively
   * dangerous if you mistake them for this one:
   *
   * - a gaussian or box blur is a linear convolution, so it can be
   *   deconvolved; and for *text* it is worse than that, because an attacker
   *   can render candidate strings, blur them the same way, and match;
   * - `pixelate` and `mosaic` are recoverable outright when the font is
   *   guessable, which for a screenshot, a terminal or a card number it
   *   always is;
   * - and any of them at opacity below 1 is one division away from the
   *   original, since `out = orig × (1 − a)`.
   *
   * So this kind does not merely default to safe values, it *refuses* the
   * unsafe ones: `renderBlur` forces feather to 0, opacity to 1 and the tint
   * off before it draws, whatever the region or a restored session asks for,
   * and the mask edge is stroked to full alpha so not even the one-pixel
   * antialiased border lets the original through. There is no slider that can
   * weaken it and no saved file that can arrive weakened.
   */
  | "redact";

export type ShapeKind =
  /** Corner-handled box. `corners` rounds it. */
  | "rect"
  /** Inscribed in the same box, so the same handles drive it. */
  | "ellipse"
  /** Arbitrary lasso. Click to place points, drag any point after. */
  | "polygon"
  /** Painted mask. Free-form, variable width, what a finger does naturally. */
  | "brush"
  /** Band across the frame — tilt-shift. Falls off on both sides of the line. */
  | "linear"
  /** Circle of sharpness in a blurred frame, or the reverse. */
  | "radial"
  /** The entire image. The base layer for "blur everything, then punch holes". */
  | "full";

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  /** Normalised width against the image short edge. */
  width: number;
  points: Point[];
  /** Painted or erased. Erasing is how you claw back an over-painted edge. */
  erase: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlurRegion {
  id: string;
  enabled: boolean;
  /** Free-text so the layer list is readable: "his face", "plate", "window". */
  label: string;

  shape: ShapeKind;
  kind: BlurKind;

  /** rect | ellipse | radial | full — normalised. */
  rect: Rect;
  /** polygon only. */
  points: Point[];
  /** brush only. */
  strokes: Stroke[];
  /** Degrees. `linear` band orientation, and `motion`/`radial` direction. */
  angle: number;
  /** Rounded corners for `rect`, as a fraction of the shorter side (0..0.5). */
  corners: number;

  /** Blur strength, as a fraction of the image short edge. 0.02 ≈ visible. */
  amount: number;
  /** Edge softness, same units. 0 gives a hard cut — right for redaction bars. */
  feather: number;
  /** Master strength of the whole region. Lets you dial a blur back to a haze. */
  opacity: number;

  /** Tint laid over the blurred pixels, or the fill colour when kind is solid. */
  color: string;
  /** 0 = untinted blur, 1 = flat colour. Anything between is a coloured blur. */
  colorAmount: number;

  /** Protect the region instead of blurring it: everything *else* is affected. */
  invert: boolean;
}

/** A region with every field at a sane default. Callers patch what they mean. */
export function newRegion(shape: ShapeKind, id: string): BlurRegion {
  return {
    id,
    enabled: true,
    label: shape,
    shape,
    kind: "gaussian",
    rect: shape === "full" ? { x: 0, y: 0, w: 1, h: 1 } : { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
    points: [],
    strokes: [],
    angle: 0,
    corners: 0,
    amount: 0.03,
    feather: 0.01,
    opacity: 1,
    color: "#000000",
    colorAmount: 0,
    invert: false,
  };
}

// ── Scratch canvases ───────────────────────────────────────────────────────
//
// Allocating three full-size canvases per frame is the difference between a
// slider that tracks the pointer and one that stutters, so they are kept and
// resized in place. Module-level rather than per-instance because only one
// render runs at a time on the main thread.

interface Scratch {
  effect: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  layer: HTMLCanvasElement;
}

let scratch: Scratch | null = null;

function scratchFor(w: number, h: number): Scratch {
  if (!scratch) {
    scratch = {
      effect: document.createElement("canvas"),
      mask: document.createElement("canvas"),
      layer: document.createElement("canvas"),
    };
  }
  for (const c of [scratch.effect, scratch.mask, scratch.layer]) {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }
  return scratch;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext("2d", { willReadFrequently: false });
  if (!g) throw new Error("2D canvas unavailable");
  return g;
}

/**
 * A colour with any transparency taken off it.
 *
 * `#rgba` and `#rrggbbaa` are valid CSS and would paint a see-through
 * redaction bar, so the alpha digits are simply dropped. Anything this does
 * not recognise — a named colour, `rgb()`, `color-mix()` — is returned as it
 * came, because those cannot carry alpha in the forms the pickers produce,
 * and refusing to draw would be a worse failure than drawing.
 */
export function opaque(color: string): string {
  const hex = color.trim();
  if (/^#[0-9a-f]{4}$/i.test(hex)) return hex.slice(0, 4);
  if (/^#[0-9a-f]{8}$/i.test(hex)) return hex.slice(0, 7);
  if (/^rgba?\(/i.test(hex)) {
    const n = hex.replace(/^rgba?\(|\)$/gi, "").split(/[\s,/]+/).filter(Boolean);
    if (n.length >= 3) return `rgb(${n[0]}, ${n[1]}, ${n[2]})`;
  }
  return hex;
}

/**
 * A redaction region with every dial that could weaken it pinned shut.
 *
 * Enforced here, at the one place that draws, rather than at the places that
 * *make* regions: a region can arrive from a saved session, an undo step, a
 * batch job, a config file a user edited by hand, or a future caller nobody
 * has written yet. Checking at the source means checking in six places and
 * hoping for the seventh. `renderBlur` is the only way pixels ever change, so
 * it is the only place the guarantee has to hold.
 */
function harden(r: BlurRegion): BlurRegion {
  if (r.kind !== "redact") return r;
  return { ...r, feather: 0, opacity: 1, colorAmount: 0, color: opaque(r.color), invert: r.invert };
}

function clear(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = ctx2d(c);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.filter = "none";
  g.clearRect(0, 0, c.width, c.height);
  return g;
}

// ── The effect pass ────────────────────────────────────────────────────────

/**
 * Paint `src` into `dst` with the region's effect applied to the whole frame.
 * Masking happens afterwards — doing it the other way round bleeds the sharp
 * surroundings into the blurred area at the mask edge, which is exactly the
 * artefact that makes cheap blur tools look cheap.
 */
function drawEffect(
  dst: CanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  r: BlurRegion,
): void {
  const unit = Math.min(w, h);
  const px = Math.max(0, r.amount * unit);

  switch (r.kind) {
    case "solid":
      dst.fillStyle = r.color;
      dst.fillRect(0, 0, w, h);
      return;

    case "redact":
      // `globalAlpha` is reset and the colour is forced opaque rather than
      // trusted: `r.color` is free-text that reaches here from a restored
      // session, and "#00000080" would paint a bar you can read straight
      // through. A redaction that is 50% transparent is not a redaction.
      dst.globalAlpha = 1;
      dst.fillStyle = opaque(r.color);
      dst.fillRect(0, 0, w, h);
      return;

    case "pixelate": {
      // Downscale then upscale with smoothing off. `max(1, …)` matters: a
      // zero-width intermediate throws in Chromium rather than no-oping.
      // The cell is capped so the region always spans at least six of them.
      // Sized off the frame alone, a small region fell inside one or two cells
      // and came out as two flat colours instead of as pixelation.
      const cell = Math.max(2, Math.min(px, regionSpan(w, h, r) / 6));
      const cells = Math.max(1, Math.round(unit / cell));
      const sw = Math.max(1, Math.round((w / unit) * cells));
      const sh = Math.max(1, Math.round((h / unit) * cells));
      const tmp = document.createElement("canvas");
      tmp.width = sw;
      tmp.height = sh;
      const tg = ctx2d(tmp);
      // Smoothed going down so each cell is the average of what it covers.
      // Unsmoothed, a cell took one pixel: text on white came out as a white
      // box with a few stray black squares, and shimmered as a slider moved.
      tg.imageSmoothingEnabled = true;
      tg.imageSmoothingQuality = "high";
      tg.drawImage(src, 0, 0, sw, sh);
      dst.imageSmoothingEnabled = false;
      dst.drawImage(tmp, 0, 0, w, h);
      dst.imageSmoothingEnabled = true;
      return;
    }

    case "mosaic": {
      // Flat diamond tiles on two interleaved lattices. A smoothed upscale
      // (what this used to be) is just a blur with a softer name, and hides
      // less than one. Tile colours come from a grid at half the lattice
      // step, so every diamond centre lands on its own sample.
      let step = Math.max(4, Math.min(px, regionSpan(w, h, r) / 6));
      // Keep the tile count bounded on big photos; a few hundred thousand
      // path fills is where a phone starts to hitch.
      const most = 240_000;
      if ((2 * w * h) / (step * step) > most) step = Math.sqrt((2 * w * h) / most);
      const half = step / 2;
      const sw = Math.max(1, Math.ceil(w / half) + 1);
      const sh = Math.max(1, Math.ceil(h / half) + 1);
      const tmp = document.createElement("canvas");
      tmp.width = sw;
      tmp.height = sh;
      const tg = ctx2d(tmp);
      tg.imageSmoothingEnabled = true;
      tg.drawImage(src, 0, 0, sw * half, sh * half, 0, 0, sw, sh);
      const data = tg.getImageData(0, 0, sw, sh).data;
      // Grout is the picture's own average, a shade darker. Black lines read
      // as a crude wireframe over a light photo; this reads as tiles.
      let sr = 0, sg = 0, sb = 0;
      for (let i = 0; i < data.length; i += 4) { sr += data[i] ?? 0; sg += data[i + 1] ?? 0; sb += data[i + 2] ?? 0; }
      const cells = Math.max(1, data.length / 4);
      const shade = (v: number): number => Math.round((v / cells) * 0.72);
      dst.fillStyle = `rgb(${shade(sr)},${shade(sg)},${shade(sb)})`;
      dst.fillRect(0, 0, w, h);
      const grout = Math.max(0.5, step * 0.04);
      const d = half - grout;
      // Row index counts half-steps; odd rows are the offset lattice.
      for (let gy = 0; gy < sh; gy++) {
        for (let gx = gy % 2; gx < sw; gx += 2) {
          const i = (Math.min(gy, sh - 1) * sw + Math.min(gx, sw - 1)) * 4;
          const cx = gx * half;
          const cy = gy * half;
          dst.fillStyle = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
          dst.beginPath();
          dst.moveTo(cx, cy - d);
          dst.lineTo(cx + d, cy);
          dst.lineTo(cx, cy + d);
          dst.lineTo(cx - d, cy);
          dst.closePath();
          dst.fill();
        }
      }
      return;
    }

    case "motion": {
      // Canvas has no directional blur, so it is built from stacked offset
      // copies along the angle. The smear is at least half the region wide:
      // sized off the frame alone, a 30 px smear over a label left every word
      // readable. Copy k is drawn at alpha 1/k, which is an exact running
      // average and ends fully opaque — a flat 1/taps per copy only reached
      // ~65% cover, so the sharp original showed through the rest.
      const len = Math.max(px * 2, regionSpan(w, h, r) * 0.5);
      const taps = Math.max(12, Math.min(40, Math.round(len / 3)));
      const rad = (r.angle * Math.PI) / 180;
      const dx = Math.cos(rad) * len;
      const dy = Math.sin(rad) * len;
      // An unshifted copy first, so the frame edge a shifted copy uncovers
      // is still opaque.
      dst.drawImage(src, 0, 0, w, h);
      for (let k = 0; k < taps; k++) {
        const t = k / (taps - 1) - 0.5;
        dst.globalAlpha = 1 / (k + 2);
        dst.drawImage(src, dx * t, dy * t, w, h);
      }
      dst.globalAlpha = 1;
      return;
    }

    case "radial": {
      // Spin: copies rotated about the region centre and averaged like motion.
      // A pure spin (or zoom) leaves the centre itself untouched, so a face
      // right in the middle stayed readable; the copies are taken from a
      // softly blurred frame, which hides the centre and costs nothing extra
      // at the rim. The rim travels at least half the region's size.
      const span = regionSpan(w, h, r);
      const len = Math.max(px * 2, span * 0.5);
      const taps = Math.max(12, Math.min(40, Math.round(len / 3)));
      const cx = (r.rect.x + r.rect.w / 2) * w;
      const cy = (r.rect.y + r.rect.h / 2) * h;
      const sweep = Math.min(1.2, Math.max(0.35, len / Math.max(1, span / 2)));
      const base = document.createElement("canvas");
      base.width = w;
      base.height = h;
      blurClamped(ctx2d(base), src, w, h, Math.max(px * 0.5, span * 0.03), 1);
      // Unrotated first, so corners a rotated copy uncovers stay opaque.
      dst.drawImage(base, 0, 0, w, h);
      for (let k = 0; k < taps; k++) {
        const a = (k / (taps - 1) - 0.5) * sweep;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        dst.globalAlpha = 1 / (k + 2);
        dst.setTransform(c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy);
        dst.drawImage(base, 0, 0, w, h);
      }
      dst.setTransform(1, 0, 0, 1, 0, 0);
      dst.globalAlpha = 1;
      return;
    }

    case "frosted": {
      blurClamped(dst, src, w, h, px * 0.7, 1);
      // Grain on top: small specks from a seeded generator, so the grain
      // holds still while a slider moves and every redraw matches the last.
      const grains = Math.round((w * h) / 900);
      dst.globalAlpha = 0.05;
      dst.fillStyle = "#ffffff";
      let seed = 0x9e3779b9 ^ (w * 73856093) ^ (h * 19349663);
      const rnd = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (let i = 0; i < grains; i++) {
        dst.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
      }
      dst.globalAlpha = 1;
      return;
    }

    case "box":
      // Two passes of a smaller radius approximates a box kernel's flatter,
      // harsher falloff well enough to be visibly different from gaussian.
      blurClamped(dst, src, w, h, px * 0.6, 2);
      return;

    case "gaussian":
    default:
      blurClamped(dst, src, w, h, px, 1);
      return;
  }
}

let padA: HTMLCanvasElement | null = null;
let padB: HTMLCanvasElement | null = null;

/**
 * Blur `src` into `dst` as if the picture carried on past its edges.
 *
 * A canvas blur treats everything outside the frame as transparent, so the
 * result fades out towards the border. That fade became mask alpha, and the
 * sharp original showed through it: with a whole-picture or inverted blur at
 * full strength, headings and captions along the edge stayed readable. The
 * frame is drawn onto a larger canvas with its outermost rows and columns
 * stretched into the margin, blurred there, and the middle copied back, so
 * every output pixel averages real picture and stays opaque.
 */
function blurClamped(
  dst: CanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  sigma: number,
  passes: number,
): void {
  if (sigma < 0.5) {
    dst.drawImage(src, 0, 0, w, h);
    return;
  }
  // Three sigma per pass holds all but a sliver of the kernel; the cap keeps a
  // full-strength slider drag from allocating a canvas several times the photo.
  const pad = Math.min(Math.ceil(sigma * 3 * Math.sqrt(passes)), 480);
  const pw = w + pad * 2;
  const ph = h + pad * 2;
  if (!padA) padA = document.createElement("canvas");
  if (!padB) padB = document.createElement("canvas");
  for (const c of [padA, padB]) {
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
  }
  let from = padA;
  let to = padB;
  const a = clear(from);
  a.imageSmoothingEnabled = false;
  a.drawImage(src, 0, 0, w, h, pad, pad, w, h);
  // Edges from the copy just placed: one-pixel strips stretched outwards, then
  // the corners filled from the corner pixels.
  a.drawImage(from, pad, pad, w, 1, pad, 0, w, pad);
  a.drawImage(from, pad, pad + h - 1, w, 1, pad, pad + h, w, pad);
  a.drawImage(from, pad, 0, 1, ph, 0, 0, pad, ph);
  a.drawImage(from, pad + w - 1, 0, 1, ph, pad + w, 0, pad, ph);
  a.imageSmoothingEnabled = true;
  for (let i = 0; i < passes; i++) {
    const b = clear(to);
    b.filter = `blur(${sigma}px)`;
    b.drawImage(from, 0, 0);
    b.filter = "none";
    [from, to] = [to, from];
  }
  dst.drawImage(from, pad, pad, w, h, 0, 0, w, h);
}

// ── The mask pass ──────────────────────────────────────────────────────────

/**
 * The short side of what this region actually covers, in destination pixels.
 *
 * Every strength in a `BlurRegion` is a fraction of the *image* short edge, so
 * that a look set on a 900 px preview survives export at 4000 px. That is the
 * right unit for choosing a strength and the wrong one for applying it, and
 * the difference only shows on a region much smaller than the frame:
 *
 *   * A feather of 0.01 on a 1080 px frame is an 11 px blur of the mask. Run
 *     over a 40 px region -- a face in a wide shot, a phone number, a name on
 *     an envelope -- the alpha at the centre never reaches 1. The region is
 *     seen through, and the way it looked from the outside was "I have to
 *     select much larger than the thing I want to cover". On a **solid**
 *     region that is a redaction bar you can read through, which is the worst
 *     thing in this file.
 *   * Pixelate sizes its grid off the frame too, so a 40 px region landed
 *     inside one or two 33 px cells and came out as two flat colours rather
 *     than as pixelation.
 *
 * Both are the same mistake and this is the number that fixes them: callers
 * clamp against the region, so a strength can never be wider than the thing
 * it is applied to.
 */
function regionSpan(w: number, h: number, r: BlurRegion): number {
  const unit = Math.min(w, h);
  switch (r.shape) {
    case "full":
      return unit;

    case "brush": {
      // A stroke is as wide as the pen, however long the line is.
      let widest = 0;
      for (const st of r.strokes) widest = Math.max(widest, st.width * unit);
      return widest > 0 ? widest : unit * 0.05;
    }

    case "polygon": {
      if (r.points.length === 0) return unit;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of r.points) {
        x0 = Math.min(x0, p.x * w); x1 = Math.max(x1, p.x * w);
        y0 = Math.min(y0, p.y * h); y1 = Math.max(y1, p.y * h);
      }
      return Math.max(1, Math.min(x1 - x0, y1 - y0));
    }

    default:
      // rect, ellipse, linear, radial -- all carry a normalised bounding rect.
      return Math.max(1, Math.min(r.rect.w * w, r.rect.h * h));
  }
}

/**
 * White where the effect applies, transparent where it does not.
 *
 * Feather is a blur of the mask itself, which is why the edge quality is the
 * same for a rectangle, a lasso and a brush stroke — they all become alpha
 * before anything soft happens to them.
 */
function drawMask(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  r: BlurRegion,
): void {
  const unit = Math.min(w, h);
  // Never soften by more than a quarter of the region's own short side. Past
  // that the falloff meets itself in the middle, the centre stops reaching
  // full alpha, and the region is see-through however hard the blur under it
  // is working. See `regionSpan`.
  const feather = Math.min(r.feather * unit, regionSpan(w, h, r) * 0.25);
  // A redaction seals its own outline. Canvas antialiases every filled edge,
  // so the boundary pixels of a bar come out at part alpha and the original
  // shows through them — one pixel deep, but one pixel of a character is more
  // than none, and "no loopholes" has to mean none. Stroking the same path at
  // full alpha afterwards covers that ring, and errs outward: a redaction that
  // hides a hair more than asked is the failure you want.
  const seal = r.kind === "redact" && !r.invert;
  const R = { x: r.rect.x * w, y: r.rect.y * h, w: r.rect.w * w, h: r.rect.h * h };

  g.fillStyle = "#ffffff";
  g.strokeStyle = "#ffffff";

  // Feathering by blurring the mask pulls alpha *inward* from the shape edge.
  // Drawn at its handles, a heavily feathered box was only ~70% opaque a short
  // way in from the edge — enough to read text straight through the blur. So
  // the shape grows by 2.5 sigma first: everything inside the handles stays
  // at 98%+ cover and the softness spills outward instead. Inverted, the
  // hidden part is outside the shape, so the shape shrinks instead.
  if (feather > 0.5) g.filter = `blur(${feather}px)`;
  const grow = feather > 0.5 ? feather * 2.5 : 0;
  const inset = r.invert ? -grow : grow;

  switch (r.shape) {
    case "full":
      g.fillRect(-feather * 3, -feather * 3, w + feather * 6, h + feather * 6);
      break;

    case "rect": {
      const rx = Math.max(1, R.w + inset * 2);
      const ry = Math.max(1, R.h + inset * 2);
      const radius = Math.max(0, Math.min(R.w, R.h) * Math.max(0, Math.min(0.5, r.corners)) + inset);
      g.beginPath();
      g.roundRect(R.x + (R.w - rx) / 2, R.y + (R.h - ry) / 2, rx, ry, Math.min(radius, rx / 2, ry / 2));
      g.fill();
      if (seal) { g.lineWidth = 2; g.stroke(); }
      break;
    }

    case "ellipse":
      g.beginPath();
      g.ellipse(R.x + R.w / 2, R.y + R.h / 2, Math.max(0.5, R.w / 2 + inset), Math.max(0.5, R.h / 2 + inset), 0, 0, Math.PI * 2);
      g.fill();
      if (seal) { g.lineWidth = 2; g.stroke(); }
      break;

    case "polygon": {
      if (r.points.length < 3) break;
      g.beginPath();
      r.points.forEach((p, i) => {
        const x = p.x * w;
        const y = p.y * h;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
      g.fill();
      // Growing a freehand outline is a fat stroke along it. Shrinking one has
      // no cheap equivalent, so an inverted lasso keeps its drawn edge.
      if (!r.invert && (grow > 0 || seal)) {
        g.lineJoin = "round";
        g.lineWidth = Math.max(seal ? 2 : 0, grow * 2);
        g.stroke();
      }
      break;
    }

    case "brush": {
      g.lineCap = "round";
      g.lineJoin = "round";
      for (const s of r.strokes) {
        if (s.points.length === 0) continue;
        // Erase strokes cut alpha back out of the mask. Doing it inside the
        // same pass means an erase can soften an edge the paint made hard.
        g.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
        // Paint grows like a shape does; an erase shrinks by the same amount
        // so it never uncovers more than the eraser was dragged across.
        const pad = r.invert ? 0 : s.erase ? -grow : grow;
        g.lineWidth = Math.max(1, s.width * unit + pad * 2);
        g.beginPath();
        s.points.forEach((p, i) => {
          const x = p.x * w;
          const y = p.y * h;
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        // A single-point stroke is a tap; stroke() alone would draw nothing.
        if (s.points.length === 1) g.lineTo(s.points[0]!.x * w + 0.01, s.points[0]!.y * h);
        g.stroke();
      }
      g.globalCompositeOperation = "source-over";
      break;
    }

    case "linear": {
      // A band centred on the rect, perpendicular to `angle`, fading out both
      // ways. Feather is folded into the gradient stops rather than the blur
      // filter — a gradient is already soft, and blurring it too washes the
      // band out entirely at high feather.
      g.filter = "none";
      const rad = (r.angle * Math.PI) / 180;
      const cx = (r.rect.x + r.rect.w / 2) * w;
      const cy = (r.rect.y + r.rect.h / 2) * h;
      const half = Math.max(1, (r.rect.h * h) / 2);
      const soft = Math.max(0.001, Math.min(0.499, r.feather * 4));
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);
      const grad = g.createLinearGradient(
        cx - dx * half * 2,
        cy - dy * half * 2,
        cx + dx * half * 2,
        cy + dy * half * 2,
      );
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.5 - soft, "rgba(255,255,255,1)");
      grad.addColorStop(0.5 + soft, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      break;
    }

    case "radial": {
      g.filter = "none";
      const cx = (r.rect.x + r.rect.w / 2) * w;
      const cy = (r.rect.y + r.rect.h / 2) * h;
      const rr = Math.max(1, (Math.min(r.rect.w * w, r.rect.h * h)) / 2);
      const soft = Math.max(0.02, Math.min(0.98, 1 - r.feather * 8));
      const grad = g.createRadialGradient(cx, cy, rr * soft, cx, cy, rr);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      break;
    }
  }

  g.filter = "none";

  if (r.invert) {
    // Keep everything the shape did *not* cover — "blur the room, not her".
    // Done by stashing the shape, repainting the mask as solid white, then
    // punching the stash back out. Feather survives it: alpha is inverted per
    // pixel, so a soft edge stays soft, just facing the other way.
    const flip = document.createElement("canvas");
    flip.width = w;
    flip.height = h;
    ctx2d(flip).drawImage(g.canvas, 0, 0);

    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "destination-out";
    g.drawImage(flip, 0, 0);
    g.globalCompositeOperation = "source-over";
  }
}

// ── Composite ──────────────────────────────────────────────────────────────

/**
 * Render `src` through `regions` into `dst`.
 *
 * `dst` is sized to the source, not the viewport — the preview scales the
 * canvas with CSS. That keeps one code path for preview and export, so what is
 * on screen is what lands on disk, which is the only way "what you see" can be
 * trusted at a different zoom level.
 */
export function renderBlur(
  dst: HTMLCanvasElement,
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  regions: readonly BlurRegion[],
): void {
  if (dst.width !== srcW || dst.height !== srcH) {
    dst.width = srcW;
    dst.height = srcH;
  }
  const out = clear(dst);
  out.drawImage(src, 0, 0, srcW, srcH);

  const active = regions.filter((r) => r.enabled);
  if (active.length === 0) return;

  const s = scratchFor(srcW, srcH);

  for (const raw of active) {
    const r = harden(raw);
    // Each region samples the *accumulated* result rather than the original,
    // so stacking a pixelate over a gaussian does what stacking implies. The
    // alternative — every region reading the pristine source — makes the top
    // layer silently erase the ones beneath it wherever they overlap.
    const eff = clear(s.effect);
    drawEffect(eff, dst, srcW, srcH, r);

    if (r.colorAmount > 0) {
      eff.globalAlpha = Math.min(1, r.colorAmount);
      eff.fillStyle = r.color;
      eff.fillRect(0, 0, srcW, srcH);
      eff.globalAlpha = 1;
    }

    const mask = clear(s.mask);
    drawMask(mask, srcW, srcH, r);

    // effect ∩ mask → layer, then layer over the accumulator.
    const layer = clear(s.layer);
    layer.drawImage(s.effect, 0, 0);
    layer.globalCompositeOperation = "destination-in";
    layer.drawImage(s.mask, 0, 0);
    layer.globalCompositeOperation = "source-over";

    out.globalAlpha = Math.max(0, Math.min(1, r.opacity));
    out.drawImage(s.layer, 0, 0);
    out.globalAlpha = 1;
  }
}

/** Hit-test in normalised space, topmost first, for click-to-select. */
export function regionAt(regions: readonly BlurRegion[], p: Point): BlurRegion | null {
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]!;
    if (!r.enabled) continue;
    if (r.shape === "full") return r;
    const { x, y, w, h } = r.rect;
    if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return r;
  }
  return null;
}

// ── Video: blur layers over time ─────────────────────────────────────────────
//
// A still has regions; a clip has *layers*. A layer is one region whose
// rectangle may move across a stretch of the clip's own timeline. It carries
// the same look as a still region (shape, kind, amount, feather, opacity…) in
// `region`, and its *where* is a list of keyframes — position and size at a
// time — interpolated linearly between. Everything in normalised 0..1 frame
// coordinates, seconds into the SOURCE clip (never the export: trim and speed
// are applied after the blur; see the note in `ffmpeg.rs`).
//
// This type is shared: the manual video-blur workspace edits it, the tracker
// appends keyframes to it, and automatic detection (faces, plates, screens)
// produces it. Keep it stable — add fields with defaults rather than renaming.

/** Where a layer's box is at one instant. */
export interface BlurKeyframe {
  /** Seconds into the source clip. */
  t: number;
  /** Normalised 0..1 frame coordinates. */
  rect: Rect;
  /**
   * How the keyframe came to be. `user` keyframes are anchors the tracker
   * re-aligns to and never overwrites; `track` ones can be regenerated;
   * `detect` ones came from a detector and behave like `track`.
   */
  origin: "user" | "track" | "detect";
}

export interface BlurLayer {
  id: string;
  /** Short label shown in the layers list: "plate", "screen 2", "face 1"… */
  name: string;
  enabled: boolean;
  /**
   * The look and the shape. `region.rect` is *not* consulted for position —
   * that comes from the keyframes — but brush strokes and polygon points are
   * kept in the region, in frame coordinates, for the preview.
   */
  region: BlurRegion;
  /** Seconds into the source where the layer starts and ends (inclusive). */
  from: number;
  to: number;
  /** Cover the whole clip regardless of `from`/`to`. */
  wholeClip: boolean;
  /** Sorted by `t`; at least one. */
  keys: BlurKeyframe[];
  /**
   * Set when a tracker stopped following the object before `to` because it
   * lost confidence. The UI shows a marker at that time; the user can drop a
   * keyframe there to re-anchor.
   */
  lostAt?: number;
  /** Who made this layer. Detectors set their own tag; hand-drawn is `manual`. */
  source: "manual" | "face" | "auto";
}

let layerSeq = 0;

/** A fresh layer at `t`, covering [t, to] with a single user keyframe. */
export function newLayer(
  shape: ShapeKind,
  t: number,
  to: number,
  rect: Rect,
  opts: Partial<Pick<BlurLayer, "name" | "source" | "id">> & { region?: Partial<BlurRegion> } = {},
): BlurLayer {
  const id = opts.id ?? `layer-${++layerSeq}`;
  const region = { ...newRegion(shape, id), ...opts.region, rect: { ...rect } };
  return {
    id,
    name: opts.name ?? shape,
    enabled: true,
    region,
    from: t,
    to: Math.max(t, to),
    wholeClip: false,
    keys: [{ t, rect: { ...rect }, origin: "user" }],
    source: opts.source ?? "manual",
  };
}

/** Insert or replace the keyframe at `t` (within 1 ms), keeping order. */
export function setKeyframe(layer: BlurLayer, key: BlurKeyframe): void {
  const i = layer.keys.findIndex((k) => Math.abs(k.t - key.t) < 0.001);
  if (i >= 0) layer.keys[i] = key;
  else {
    layer.keys.push(key);
    layer.keys.sort((a, b) => a.t - b.t);
  }
}

/** Drop the keyframe at `t`, but never the last one. */
export function removeKeyframe(layer: BlurLayer, t: number): boolean {
  if (layer.keys.length <= 1) return false;
  const i = layer.keys.findIndex((k) => Math.abs(k.t - t) < 0.001);
  if (i < 0) return false;
  layer.keys.splice(i, 1);
  return true;
}

/** The keyframe at exactly `t`, if there is one. */
export function keyframeAt(layer: BlurLayer, t: number, tol = 0.02): BlurKeyframe | null {
  return layer.keys.find((k) => Math.abs(k.t - t) <= tol) ?? null;
}

/** Whether the layer covers time `t` of the source at all. */
export function layerLive(layer: BlurLayer, t: number): boolean {
  if (!layer.enabled) return false;
  if (layer.wholeClip) return true;
  return t >= layer.from - 1e-6 && t <= layer.to + 1e-6;
}

/**
 * The box at time `t`: linear between neighbouring keyframes, held flat
 * before the first and after the last. `t` outside [from, to] still answers
 * (callers use `layerLive` to gate) so previews of the handles work.
 */
export function rectAt(layer: BlurLayer, t: number): Rect {
  const ks = layer.keys;
  if (ks.length === 0) return { ...layer.region.rect };
  if (t <= ks[0]!.t) return { ...ks[0]!.rect };
  const last = ks[ks.length - 1]!;
  if (t >= last.t) return { ...last.rect };
  let i = 1;
  while (i < ks.length && ks[i]!.t < t) i++;
  const a = ks[i - 1]!;
  const b = ks[i]!;
  const span = b.t - a.t;
  const f = span > 1e-9 ? (t - a.t) / span : 0;
  return {
    x: a.rect.x + (b.rect.x - a.rect.x) * f,
    y: a.rect.y + (b.rect.y - a.rect.y) * f,
    w: a.rect.w + (b.rect.w - a.rect.w) * f,
    h: a.rect.h + (b.rect.h - a.rect.h) * f,
  };
}

/**
 * The still regions to draw at time `t` — the layer's look, placed at its
 * interpolated box. Brush strokes and polygon points are offset by the
 * difference between the drawn keyframe's box and the current one, so a
 * tracked brush stroke rides along with the object.
 */
export function regionsAt(layers: readonly BlurLayer[], t: number): BlurRegion[] {
  const out: BlurRegion[] = [];
  for (const l of layers) {
    if (!layerLive(l, t)) continue;
    const rect = rectAt(l, t);
    const base = l.region.rect;
    const dx = rect.x - base.x;
    const dy = rect.y - base.y;
    const r: BlurRegion = { ...l.region, id: l.id, rect, label: l.name };
    if (l.region.shape === "brush" && (dx !== 0 || dy !== 0)) {
      r.strokes = l.region.strokes.map((s) => ({
        ...s,
        points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      }));
    } else if (l.region.shape === "polygon" && (dx !== 0 || dy !== 0)) {
      r.points = l.region.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    out.push(r);
  }
  return out;
}

/** Deep copy for undo snapshots and duplication. */
export function cloneLayer(l: BlurLayer, id?: string): BlurLayer {
  return {
    ...l,
    id: id ?? l.id,
    region: {
      ...l.region,
      id: id ?? l.id,
      rect: { ...l.region.rect },
      points: l.region.points.map((p) => ({ ...p })),
      strokes: l.region.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
    },
    keys: l.keys.map((k) => ({ ...k, rect: { ...k.rect } })),
  };
}

/** A fresh id for a layer, unique within this session. */
export function nextLayerId(): string {
  return `layer-${++layerSeq}`;
}
