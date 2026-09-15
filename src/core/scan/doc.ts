/**
 * A scan in progress: several pages, each a photograph plus a decision about
 * where its edges are and how it should look.
 *
 * Kept apart from the view on purpose. Every question worth asking about a
 * multi-page scan -- does deleting page 2 renumber the rest, does reordering
 * survive a re-crop, does exporting three pages produce three pages in the
 * right order -- is a question about this file, and none of them need a camera,
 * a canvas or a screen to answer.
 *
 * Pages hold their *source* pixels and their quad separately rather than
 * holding a warped result. That is what makes "adjust the corners of page 2
 * after shooting page 5" possible at all: the crop is a decision you can take
 * back, not something baked into the only copy of the pixels.
 */

import type { Quad } from "./quad";
import { FULL_QUAD, findQuad } from "./quad";
import type { ScanLook, CleanOptions } from "./clean";
import { clean } from "./clean";
import { warp } from "./warp";

/** One page of a scan. */
export interface ScanPage {
  /** Stable for the life of the page. Reordering must not change it. */
  readonly id: string;
  /** The photograph, untouched. */
  readonly source: ImageData;
  /** Where the page is in that photograph, normalised 0..1. */
  quad: Quad;
  /** Quarter turns clockwise applied after the warp, 0..3. */
  turns: number;
  look: ScanLook;
  brightness: number;
  contrast: number;
  /**
   * True when `quad` came from `findQuad` and no one has touched it since.
   * Worth knowing: a page the detector was sure about needs no confirmation,
   * and one that fell back to the whole frame is asking to be adjusted.
   */
  detected: boolean;
}

/** The defaults a freshly shot page gets. */
export const PAGE_DEFAULTS = {
  turns: 0,
  look: "colour" as ScanLook,
  brightness: 0.5,
  contrast: 0.5,
};

let seq = 0;

/**
 * Take a photograph into a page, finding its corners.
 *
 * Detection failing is not an error and does not throw: it means the page
 * covers the whole frame as far as we can tell, which is the right answer for
 * a document shot on a matching background and the right *starting point* for
 * one where the finder simply lost the edge. Either way there are corners on
 * screen to drag.
 */
export function makePage(source: ImageData, quad?: Quad): ScanPage {
  const found = quad ?? findQuad(source);
  return {
    id: `p${++seq}`,
    source,
    quad: found ?? FULL_QUAD,
    detected: quad === undefined && found !== null,
    ...PAGE_DEFAULTS,
  };
}

/** Reset the id counter. For harnesses that assert on page ids. */
export function resetIds(): void {
  seq = 0;
}

/**
 * The pages of a scan, in order, with the edits that only make sense on the
 * list rather than on a page.
 *
 * Immutable operations returning a new array: a scan is a thing people undo,
 * and an undo stack over arrays you mutate in place is an undo stack that
 * lies.
 */
export function movePage(pages: readonly ScanPage[], from: number, to: number): ScanPage[] {
  const out = pages.slice();
  if (from < 0 || from >= out.length) return out;
  const clampedTo = Math.min(out.length - 1, Math.max(0, to));
  const [page] = out.splice(from, 1);
  if (page) out.splice(clampedTo, 0, page);
  return out;
}

export function removePage(pages: readonly ScanPage[], id: string): ScanPage[] {
  return pages.filter((p) => p.id !== id);
}

export function indexOfPage(pages: readonly ScanPage[], id: string): number {
  return pages.findIndex((p) => p.id === id);
}

/**
 * Apply one page's settings to every page.
 *
 * The single most-wanted button in any scanner: you shot twelve pages of the
 * same document under the same light, you fixed the look on the first one, and
 * doing that eleven more times by hand is the reason people stop using an app.
 * Corners are deliberately *not* copied -- every photograph framed the page
 * differently, and pasting page 1's corners onto page 7 crops it wrong.
 */
export function applyLookToAll(pages: readonly ScanPage[], from: ScanPage): ScanPage[] {
  return pages.map((p) => ({
    ...p,
    look: from.look,
    brightness: from.brightness,
    contrast: from.contrast,
  }));
}

/** Turn every page a quarter, for a document photographed sideways throughout. */
export function turnAll(pages: readonly ScanPage[], by: number): ScanPage[] {
  return pages.map((p) => ({ ...p, turns: (((p.turns + by) % 4) + 4) % 4 }));
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Rotate `ImageData` by whole quarter turns.
 *
 * Whole turns only, and done by index rather than through a canvas, because at
 * 90° there is nothing to interpolate: every output pixel is exactly one input
 * pixel. Going through `ctx.rotate` would resample 8 megapixels of text for no
 * reason and soften every stroke doing it.
 */
export function turn(src: ImageData, quarters: number): ImageData {
  const n = (((quarters % 4) + 4) % 4);
  if (n === 0) {
    const same = new ImageData(src.width, src.height);
    same.data.set(src.data);
    return same;
  }

  const w = src.width;
  const h = src.height;
  const swap = n % 2 === 1;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new ImageData(ow, oh);
  const s = src.data;
  const d = out.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ox: number;
      let oy: number;
      if (n === 1) { ox = h - 1 - y; oy = x; }
      else if (n === 2) { ox = w - 1 - x; oy = h - 1 - y; }
      else { ox = y; oy = w - 1 - x; }

      const si = (y * w + x) * 4;
      const di = (oy * ow + ox) * 4;
      d[di] = s[si]!;
      d[di + 1] = s[si + 1]!;
      d[di + 2] = s[si + 2]!;
      d[di + 3] = s[si + 3]!;
    }
  }
  return out;
}

/**
 * A page as it will be saved: warped flat, cleaned, turned.
 *
 * That order, and it is not arbitrary. Cleaning before the warp would estimate
 * the paper's brightness across the *photograph*, including the desk, and the
 * desk is not paper -- a dark table under one edge drags the estimate down and
 * bleaches that side of the page. Turning last is free, because the turn does
 * not resample.
 *
 * `cap` bounds the long side. It is passed through rather than fixed here
 * because a thumbnail and an export want wildly different answers and both go
 * through this function -- one code path, so what you previewed is what you
 * get.
 */
export function renderPage(page: ScanPage, cap = 4000): ImageData | null {
  const flat = warp(page.source, page.quad, { cap });
  if (!flat) return null;

  const opts: CleanOptions = {
    look: page.look,
    brightness: page.brightness,
    contrast: page.contrast,
  };
  return turn(clean(flat, opts), page.turns);
}

/**
 * How big a rendered page will be, without rendering it.
 *
 * For laying out a page list before the work is done: the strip can reserve
 * the right shape for twelve pages immediately instead of reflowing twelve
 * times as each finishes.
 */
export function renderSize(page: ScanPage, cap = 4000): { w: number; h: number } {
  const w = page.source.width;
  const h = page.source.height;
  const pts = [page.quad.tl, page.quad.tr, page.quad.br, page.quad.bl].map((p) => ({
    x: p.x * w,
    y: p.y * h,
  }));
  const side = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.hypot(a.x - b.x, a.y - b.y);

  let ow = Math.max(1, Math.round(Math.max(side(pts[0]!, pts[1]!), side(pts[3]!, pts[2]!))));
  let oh = Math.max(1, Math.round(Math.max(side(pts[0]!, pts[3]!), side(pts[1]!, pts[2]!))));

  const s = Math.min(1, cap / Math.max(ow, oh));
  ow = Math.max(1, Math.round(ow * s));
  oh = Math.max(1, Math.round(oh * s));

  return page.turns % 2 === 1 ? { w: oh, h: ow } : { w: ow, h: oh };
}

/** A filename for a scan, dated, without a extension. */
export function scanName(when: Date, prefix = "scan"): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${prefix}-${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}` +
    `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  );
}
