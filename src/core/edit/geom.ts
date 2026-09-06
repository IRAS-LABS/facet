/**
 * Crop, rotate, mirror and resize, as one transform rather than four edits.
 *
 * The obvious way to build these is to bake each one into a new bitmap: crop
 * makes a smaller picture, rotate makes a turned one, and the editor carries on
 * with the result. That is wrong here for two reasons.
 *
 * The first is the blur regions. They are stored in normalised *source*
 * coordinates, so a baked crop would leave every existing blur pointing at the
 * wrong part of the picture, and the fix — remapping every region through the
 * crop on every transform — has to be right for rectangles, ellipses, brush
 * strokes and their feather radii, four times over, for every operation. Kept
 * as a transform instead, the regions never move: they are drawn onto the
 * source, and the source is what gets turned. Blur a face, rotate the photo,
 * and the blur rotates with the face because it is part of it.
 *
 * The second is undo. Baking is destructive — a crop followed by an undo needs
 * the pre-crop bitmap kept alive, and on a 45 MP phone photo that is a hundred
 * and eighty megabytes per step. A transform is six numbers.
 *
 * So the pipeline is: source -> blur composite (at source size) -> geometry ->
 * screen. Only the last step changes the canvas dimensions, and it is the same
 * step for preview and for export, so what you see is what lands on disk.
 *
 * Order within the transform is crop, then mirror, then rotate, then scale.
 * That is the order people say them in, and it is the only order where the
 * numbers stay meaningful: a crop rectangle drawn on screen refers to what was
 * on screen at the time, and rotating first would make "the top left quarter"
 * mean a different quarter depending on how the picture happened to be turned.
 */

import type { Point } from "./blur";

/** Quarter turns clockwise. */
export type Turns = 0 | 1 | 2 | 3;

export interface Geom {
  /**
   * The kept rectangle, in normalised source coordinates.
   *
   * Normalised rather than in pixels so it survives the source being swapped
   * for a different decode of the same file — the phone opens a downscaled
   * bitmap for the preview and the full one for export.
   */
  crop: { x: number; y: number; w: number; h: number };
  turns: Turns;
  /** Mirror left-to-right, in the source's own frame. */
  flipX: boolean;
  /** Mirror top-to-bottom, in the source's own frame. */
  flipY: boolean;
  /** Output size as a fraction of the crop. 1 is untouched. */
  scale: number;
  /**
   * Straighten, in degrees clockwise, small. Optional so every geometry written
   * before it existed still reads as the same picture.
   *
   * Applied last, in the output frame, and the picture is enlarged just enough
   * that the tilted frame still covers the whole output — so straightening a
   * horizon never shows the canvas behind the corners. `outSize` is therefore
   * unaffected by it; only where each source pixel lands is.
   */
  tilt?: number;
}

export const IDENTITY: Geom = {
  crop: { x: 0, y: 0, w: 1, h: 1 },
  turns: 0,
  flipX: false,
  flipY: false,
  scale: 1,
};

export function identity(): Geom {
  return { ...IDENTITY, crop: { ...IDENTITY.crop } };
}

/** True when this geometry would not change a single pixel. */
export function isIdentity(g: Geom): boolean {
  return (
    g.turns === 0 &&
    (g.tilt ?? 0) === 0 &&
    !g.flipX &&
    !g.flipY &&
    Math.abs(g.scale - 1) < 1e-6 &&
    Math.abs(g.crop.x) < 1e-6 &&
    Math.abs(g.crop.y) < 1e-6 &&
    Math.abs(g.crop.w - 1) < 1e-6 &&
    Math.abs(g.crop.h - 1) < 1e-6
  );
}

/** The crop in source pixels, clamped to at least one pixel each way. */
function cropPx(g: Geom, srcW: number, srcH: number): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const x = Math.max(0, Math.min(1, g.crop.x));
  const y = Math.max(0, Math.min(1, g.crop.y));
  const w = Math.max(1 / Math.max(1, srcW), Math.min(1 - x, g.crop.w));
  const h = Math.max(1 / Math.max(1, srcH), Math.min(1 - y, g.crop.h));
  return { x: x * srcW, y: y * srcH, w: w * srcW, h: h * srcH };
}

/**
 * The tilt as radians and the enlargement that keeps it covering the frame.
 *
 * A w×h frame turned by θ needs the picture behind it scaled by
 * cos θ + sin θ · max(w/h, h/w) before the frame's corners stop poking out.
 */
export function tiltFor(g: Geom, frame: { w: number; h: number }): { rad: number; grow: number } {
  const deg = g.tilt ?? 0;
  if (deg === 0) return { rad: 0, grow: 1 };
  const rad = (deg * Math.PI) / 180;
  const a = Math.abs(rad);
  const ratio = Math.max(frame.w / Math.max(1, frame.h), frame.h / Math.max(1, frame.w));
  return { rad, grow: Math.cos(a) + Math.sin(a) * ratio };
}

/** Output dimensions in pixels, rotation included. */
export function outSize(g: Geom, srcW: number, srcH: number): { w: number; h: number } {
  const c = cropPx(g, srcW, srcH);
  const w = Math.max(1, Math.round(c.w * g.scale));
  const h = Math.max(1, Math.round(c.h * g.scale));
  return g.turns % 2 === 1 ? { w: h, h: w } : { w, h };
}

/**
 * Draw `src` into `dst` through `g`, resizing `dst` to suit.
 *
 * `src` is whatever the blur pass produced — a canvas the size of the original
 * picture. Nothing here knows about regions; by this point they are pixels.
 */
export function applyGeom(
  dst: HTMLCanvasElement,
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  g: Geom,
): void {
  const c = cropPx(g, srcW, srcH);
  const w = Math.max(1, Math.round(c.w * g.scale));
  const h = Math.max(1, Math.round(c.h * g.scale));
  const size = outSize(g, srcW, srcH);

  if (dst.width !== size.w || dst.height !== size.h) {
    dst.width = size.w;
    dst.height = size.h;
  }
  const ctx = dst.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, dst.width, dst.height);

  // Canvas applies these inside-out: the last call listed is the first thing
  // that happens to the image. So this reads bottom-up as flip, then rotate,
  // then move to the middle of the output — which is the order the doc comment
  // above promises.
  ctx.save();
  ctx.translate(dst.width / 2, dst.height / 2);
  const tilt = tiltFor(g, size);
  if (tilt.rad !== 0) {
    ctx.rotate(tilt.rad);
    ctx.scale(tilt.grow, tilt.grow);
  }
  ctx.rotate((g.turns * Math.PI) / 2);
  ctx.scale(g.flipX ? -1 : 1, g.flipY ? -1 : 1);
  // Smoothing on: this is the resize path, and a downscaled photo without it
  // is a field of aliasing. The blur pass has already done its own sampling.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, c.x, c.y, c.w, c.h, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/**
 * A point on the output, mapped back to where it came from on the source.
 *
 * The editor is handed finger positions in output space — normalised against
 * the canvas box, which is the rotated, cropped, resized picture — and every
 * blur region it stores is in source space. Without this, drawing a box over
 * someone's face on a rotated photo puts the blur somewhere else entirely.
 *
 * Not clamped. A finger just outside the crop maps to a point just outside the
 * source, and the region code already tolerates that; clamping here would
 * instead pile strokes up against the edge.
 */
export function toSource(g: Geom, srcW: number, srcH: number, p: Point): Point {
  const c = cropPx(g, srcW, srcH);
  const w = Math.max(1, Math.round(c.w * g.scale));
  const h = Math.max(1, Math.round(c.h * g.scale));
  const size = outSize(g, srcW, srcH);

  // Output pixels, measured from the middle, because that is the point the
  // forward transform rotates about.
  let ox = p.x * size.w - size.w / 2;
  let oy = p.y * size.h - size.h / 2;

  // Undo the straighten first: it was the last thing applied on the way out.
  const tilt = tiltFor(g, size);
  if (tilt.rad !== 0) {
    const cs = Math.cos(tilt.rad);
    const sn = Math.sin(tilt.rad);
    const ux = (ox * cs + oy * sn) / tilt.grow;
    const uy = (-ox * sn + oy * cs) / tilt.grow;
    ox = ux;
    oy = uy;
  }

  // Undo the rotation. Exact quarter turns rather than sin/cos of a multiple of
  // pi/2, which comes back as 6.12e-17 instead of zero and drifts the mapping.
  let rx: number;
  let ry: number;
  switch (g.turns) {
    case 1: rx = oy; ry = -ox; break;
    case 2: rx = -ox; ry = -oy; break;
    case 3: rx = -oy; ry = ox; break;
    default: rx = ox; ry = oy; break;
  }

  if (g.flipX) rx = -rx;
  if (g.flipY) ry = -ry;

  // Still centred, still scaled: move to the crop's top-left, then undo scale.
  const px = (rx + w / 2) / g.scale;
  const py = (ry + h / 2) / g.scale;

  return { x: (c.x + px) / srcW, y: (c.y + py) / srcH };
}

/**
 * Compose a new crop expressed in *output* coordinates onto an existing one.
 *
 * Cropping twice has to mean cropping the thing you can see, not the thing the
 * file started as. The rectangle comes off the screen, so it is in whatever
 * frame the current geometry produces; the corners are mapped back to source
 * space and the result becomes the new crop. Rotation and mirroring are left
 * alone — they still describe how to present what is now kept.
 */
export function cropTo(
  g: Geom,
  srcW: number,
  srcH: number,
  rect: { x: number; y: number; w: number; h: number },
): Geom {
  const a = toSource(g, srcW, srcH, { x: rect.x, y: rect.y });
  const b = toSource(g, srcW, srcH, { x: rect.x + rect.w, y: rect.y + rect.h });

  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(1, Math.max(a.x, b.x));
  const y1 = Math.min(1, Math.max(a.y, b.y));

  // A crop smaller than this is a mis-tap, not an instruction. Returning the
  // geometry unchanged is better than leaving someone staring at four pixels.
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return g;

  return { ...g, crop: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** Turn a quarter clockwise. */
export function rotate(g: Geom, quarters = 1): Geom {
  return { ...g, turns: (((g.turns + quarters) % 4) + 4) % 4 as Turns };
}

/**
 * Mirror, in the frame the person is looking at.
 *
 * On a picture turned on its side, "mirror left to right" means the left and
 * right of the *screen*, which is the source's top and bottom. Swapping the
 * axis for odd turns is what makes the button do what it says.
 */
export function mirror(g: Geom, axis: "x" | "y"): Geom {
  const onX = g.turns % 2 === 0 ? axis === "x" : axis === "y";
  return onX ? { ...g, flipX: !g.flipX } : { ...g, flipY: !g.flipY };
}

/**
 * The forward map: a source point to where it lands on the output.
 *
 * Only the selection outline needs this — everything else in the editor works
 * in source space and lets `applyGeom` do the moving. Because the rotations are
 * exact quarter turns, an axis-aligned rectangle stays axis-aligned, so mapping
 * two opposite corners and re-normalising is enough to place the outline.
 */
export function toOutput(g: Geom, srcW: number, srcH: number, p: Point): Point {
  const c = cropPx(g, srcW, srcH);
  const w = Math.max(1, Math.round(c.w * g.scale));
  const h = Math.max(1, Math.round(c.h * g.scale));
  const size = outSize(g, srcW, srcH);

  const px = (p.x * srcW - c.x) * g.scale - w / 2;
  const py = (p.y * srcH - c.y) * g.scale - h / 2;

  const fx = g.flipX ? -px : px;
  const fy = g.flipY ? -py : py;

  let ox: number;
  let oy: number;
  switch (g.turns) {
    case 1: ox = -fy; oy = fx; break;
    case 2: ox = -fx; oy = -fy; break;
    case 3: ox = fy; oy = -fx; break;
    default: ox = fx; oy = fy; break;
  }

  const tilt = tiltFor(g, size);
  if (tilt.rad !== 0) {
    const cs = Math.cos(tilt.rad);
    const sn = Math.sin(tilt.rad);
    const tx = (ox * cs - oy * sn) * tilt.grow;
    const ty = (ox * sn + oy * cs) * tilt.grow;
    ox = tx;
    oy = ty;
  }

  return { x: (ox + size.w / 2) / size.w, y: (oy + size.h / 2) / size.h };
}
