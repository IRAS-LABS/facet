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
  /** Zoom/spin smear radiating from the region centre. */
  | "radial"
  /** Blur plus fine noise — frosted glass rather than out-of-focus. */
  | "frosted"
  /** No blur at all: a flat fill. The redaction bar. */
  | "solid";

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

    case "pixelate":
    case "mosaic": {
      // Downscale then upscale with smoothing off. `max(1, …)` matters: a
      // zero-width intermediate throws in Chromium rather than no-oping.
      const cells = Math.max(1, Math.round(unit / Math.max(2, px)));
      const sw = Math.max(1, Math.round((w / unit) * cells));
      const sh = Math.max(1, Math.round((h / unit) * cells));
      const tmp = document.createElement("canvas");
      tmp.width = sw;
      tmp.height = sh;
      const tg = ctx2d(tmp);
      tg.imageSmoothingEnabled = r.kind === "mosaic";
      tg.drawImage(src, 0, 0, sw, sh);
      dst.imageSmoothingEnabled = r.kind === "mosaic";
      dst.drawImage(tmp, 0, 0, w, h);
      dst.imageSmoothingEnabled = true;
      return;
    }

    case "motion": {
      // Canvas has no directional blur, so it is built from stacked offset
      // copies along the angle. 12 taps is where banding stops being visible
      // at ordinary strengths without the cost of a real convolution.
      const taps = 12;
      const rad = (r.angle * Math.PI) / 180;
      const dx = (Math.cos(rad) * px) / taps;
      const dy = (Math.sin(rad) * px) / taps;
      dst.globalAlpha = 1 / taps;
      for (let i = -taps / 2; i < taps / 2; i++) {
        dst.drawImage(src, dx * i, dy * i, w, h);
      }
      dst.globalAlpha = 1;
      return;
    }

    case "radial": {
      // Same trick, but each tap is scaled about the region centre instead of
      // translated — a zoom smear rather than a linear one.
      const taps = 12;
      const cx = (r.rect.x + r.rect.w / 2) * w;
      const cy = (r.rect.y + r.rect.h / 2) * h;
      const step = (px / unit) * 0.5;
      dst.globalAlpha = 1 / taps;
      for (let i = 0; i < taps; i++) {
        const s = 1 + (step * i) / taps;
        dst.setTransform(s, 0, 0, s, cx * (1 - s), cy * (1 - s));
        dst.drawImage(src, 0, 0, w, h);
      }
      dst.setTransform(1, 0, 0, 1, 0, 0);
      dst.globalAlpha = 1;
      return;
    }

    case "frosted": {
      dst.filter = `blur(${px * 0.7}px)`;
      dst.drawImage(src, 0, 0, w, h);
      dst.filter = "none";
      // Grain on top. Deterministic per-pixel noise would need an ImageData
      // pass; short random strokes are cheaper and read the same at size.
      const grains = Math.round((w * h) / 900);
      dst.globalAlpha = 0.05;
      dst.fillStyle = "#ffffff";
      for (let i = 0; i < grains; i++) {
        dst.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
      }
      dst.globalAlpha = 1;
      return;
    }

    case "box":
      // Two passes of a smaller radius approximates a box kernel's flatter,
      // harsher falloff well enough to be visibly different from gaussian.
      dst.filter = `blur(${px * 0.6}px)`;
      dst.drawImage(src, 0, 0, w, h);
      dst.drawImage(dst.canvas, 0, 0, w, h);
      dst.filter = "none";
      return;

    case "gaussian":
    default:
      dst.filter = `blur(${px}px)`;
      dst.drawImage(src, 0, 0, w, h);
      dst.filter = "none";
      return;
  }
}

// ── The mask pass ──────────────────────────────────────────────────────────

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
  const feather = r.feather * unit;
  const R = { x: r.rect.x * w, y: r.rect.y * h, w: r.rect.w * w, h: r.rect.h * h };

  g.fillStyle = "#ffffff";
  g.strokeStyle = "#ffffff";

  // Feathering by blurring the mask pulls alpha *inward* from the shape edge,
  // so a hard-edged fill would end up smaller than the handles promise. The
  // filter is applied to the fill itself and the shape is not inset; the
  // handles then mark the 50% point of the falloff, which is what feels right
  // when you drag a corner tight to a face.
  if (feather > 0.5) g.filter = `blur(${feather}px)`;

  switch (r.shape) {
    case "full":
      g.fillRect(-feather * 2, -feather * 2, w + feather * 4, h + feather * 4);
      break;

    case "rect": {
      const radius = Math.min(R.w, R.h) * Math.max(0, Math.min(0.5, r.corners));
      g.beginPath();
      g.roundRect(R.x, R.y, R.w, R.h, radius);
      g.fill();
      break;
    }

    case "ellipse":
      g.beginPath();
      g.ellipse(R.x + R.w / 2, R.y + R.h / 2, R.w / 2, R.h / 2, 0, 0, Math.PI * 2);
      g.fill();
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
        g.lineWidth = Math.max(1, s.width * unit);
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

  for (const r of active) {
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
