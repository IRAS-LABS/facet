/**
 * Finding small things in big pictures.
 *
 * Every model here takes a fixed square: YuNet 640, YOLOX 416, the plate net
 * 384. The frame is letterboxed down into that square, so on a 4,000 px photo
 * a 120 px number plate arrives at the plate model about twelve pixels wide
 * and is not there to be found. That is the whole of the "it missed the faces
 * in the background" bug, and it applies to plates, screens and terminals in
 * exactly the same way -- the model never saw them.
 *
 * The fix is the one `plates.ts` already used for cars and `codes.ts` already
 * used for QR codes: look again, closer. The frame is cut into overlapping
 * tiles, each tile is fetched at the source's own resolution rather than from
 * the already-shrunken working copy, and each is run through the same model.
 * A face that was twelve pixels in the whole frame is thirty-six in a third of
 * it.
 *
 * The full frame is still run first, because a tile cannot find something
 * larger than itself, and the results are merged by overlap with the best
 * score winning -- the same merge the plate stage does between its own passes.
 *
 * Cost is honest and bounded: one run plus one per tile, at most nine tiles,
 * and only when the source is actually big enough for the downscale to have
 * thrown detail away. A 1,200 px photo tiles into nothing and costs what it
 * always did.
 */

import { iou, type Det } from "./onnx";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pixels {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Pixels for a rectangle of the source, given in working-copy coordinates and
 * returned at the source's own resolution. Null when the source is gone or the
 * rectangle is empty.
 */
export type CropFn = (r: Rect) => Pixels | null;

export interface Frame extends Pixels {
  /** Source pixels per working-copy pixel. 1 means nothing was thrown away. */
  scale?: number | undefined;
  crop?: CropFn | undefined;
}

/** Below this there is nothing to gain: the tile would be upscaled, not sharper. */
const MIN_GAIN = 1.4;
/**
 * Roughly the longest edge one tile should carry.
 *
 * 1400 was the first guess and it was one step too coarse. On a 4000 px photo
 * it gives a 3x3, each tile 1600 px into a 640 square, and a face pinned to the
 * wall in a photo of a wall came out 14 px -- under YuNet's smallest anchor and
 * therefore not found at all. 1100 gives a 4x4 on the same photo, the same face
 * arrives at 19 px, and it is found at the ordinary confidence. Measured on the
 * desktop fixture: 507 ms and one face at 3x3, 787 ms and two at 4x4.
 */
const TILE_SIDE = 1100;
/**
 * Four by four. Seventeen model runs, which is the ceiling worth paying: 5x5
 * costs another half again and bought one more marginal face on the fixture.
 */
const MAX_TILES = 4;

/**
 * How many tiles per side are worth running, from how much the working copy
 * gave up. One means "don't bother".
 */
export function tileCount(frame: Frame): number {
  if (!frame.crop) return 1;
  const scale = frame.scale ?? 1;
  if (scale < MIN_GAIN) return 1;
  const source = Math.max(frame.width, frame.height) * scale;
  return Math.max(1, Math.min(MAX_TILES, Math.round(source / TILE_SIDE)));
}

/**
 * An `n` by `n` grid over the frame, in working-copy coordinates.
 *
 * Tiles overlap, because a face on a seam is half a face in both neighbours
 * and a face in neither. The overlap is what the merge afterwards cleans up.
 */
export function tileGrid(width: number, height: number, n: number, overlap = 0.2): Rect[] {
  if (n <= 1) return [];
  const tw = Math.min(width, (width / n) * (1 + overlap));
  const th = Math.min(height, (height / n) * (1 + overlap));
  const out: Rect[] = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      out.push({
        x: (width - tw) * (ix / (n - 1)),
        y: (height - th) * (iy / (n - 1)),
        w: tw,
        h: th,
      });
    }
  }
  return out;
}

/** Merge overlapping boxes, best score first. */
export function mergeDets(found: readonly Det[], thr = 0.4, sameClass = true): Det[] {
  const keep: Det[] = [];
  for (const d of [...found].sort((a, b) => b.score - a.score)) {
    if (keep.some((k) => (!sameClass || k.cls === d.cls) && iou(k, d) > thr)) continue;
    keep.push(d);
  }
  return keep;
}

/**
 * Run `model` over the whole frame and over each tile of it, and merge.
 *
 * `model` is handed plain pixels and returns boxes in those pixels; the
 * mapping back into working-copy coordinates is done here, so a detector does
 * not have to know it is being tiled.
 */
export async function sweep(
  frame: Frame,
  model: (p: Pixels) => Promise<Det[]>,
  opts: {
    overlap?: number | undefined;
    iou?: number | undefined;
    sameClass?: boolean | undefined;
    onStep?: ((done: number, total: number) => void) | undefined;
  } = {},
): Promise<Det[]> {
  const n = tileCount(frame);
  const rects = tileGrid(frame.width, frame.height, n, opts.overlap);
  const total = 1 + rects.length;
  const all: Det[] = await model(frame);
  opts.onStep?.(1, total);

  const crop = frame.crop;
  if (crop) {
    let done = 1;
    for (const r of rects) {
      const px = crop(r);
      if (px) {
        // Tile pixels back to working-copy pixels. The crop may have been
        // capped, so this is never assumed to be the scale factor.
        const kx = r.w / px.width;
        const ky = r.h / px.height;
        for (const d of await model(px)) {
          all.push({ ...d, x: d.x * kx + r.x, y: d.y * ky + r.y, w: d.w * kx, h: d.h * ky });
        }
      }
      opts.onStep?.(++done, total);
    }
  }

  return mergeDets(all, opts.iou ?? 0.4, opts.sameClass ?? true);
}
