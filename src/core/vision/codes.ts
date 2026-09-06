/**
 * QR codes and barcodes — boxes only, never decoded.
 *
 * Two paths. Where the platform has `BarcodeDetector` (Android WebView via
 * Play services, Chrome on macOS/Android) it is asked first and covers 1-D
 * barcodes too. Everywhere else, and as a second opinion, a pure-TS search
 * for QR finder patterns: the 1:1:3:1:1 black-white-black-white-black run
 * that marks three corners of every QR code. Three finders that agree on
 * module size and sit at a right angle become one box.
 *
 * Limits: the fallback only sees QR/Micro-QR-shaped things (a 1-D barcode has
 * no finder pattern); a code smaller than ~40 px across, or rotated past
 * ~30°, is missed; a heavily damaged or inverted code is missed.
 */

import type { Det } from "./onnx";

// ── BarcodeDetector, typed minimally — it is not in TypeScript's DOM lib ────

interface DetectedBarcode {
  boundingBox: { x: number; y: number; width: number; height: number };
  format: string;
}
interface BarcodeDetectorLike {
  detect(image: ImageData | ImageBitmap | HTMLCanvasElement): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

function platformDetector(): BarcodeDetectorCtor | null {
  const g = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return typeof g.BarcodeDetector === "function" ? g.BarcodeDetector : null;
}

/** Boxes from the platform detector, or null when there is none / it is empty. */
export async function platformCodes(image: ImageData): Promise<Det[] | null> {
  const Ctor = platformDetector();
  if (!Ctor) return null;
  try {
    const formats = await Ctor.getSupportedFormats();
    if (formats.length === 0) return null;
    const d = new Ctor({ formats });
    const found = await d.detect(image);
    return found.map((b) => ({
      x: b.boundingBox.x, y: b.boundingBox.y, w: b.boundingBox.width, h: b.boundingBox.height,
      score: 0.95, cls: b.format === "qr_code" ? 0 : 1,
    }));
  } catch {
    return null;
  }
}

// ── Pure-TS finder-pattern search ────────────────────────────────────────────

export interface Finder {
  x: number;
  y: number;
  /** Estimated module (smallest unit) size in pixels. */
  module: number;
}

/** Luminance → 0/1 (1 = dark) with a local-mean threshold, so shading and gradients do not matter. */
export function binarise(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, radius = 15): Uint8Array {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (rgba[p]! * 77 + rgba[p + 1]! * 150 + rgba[p + 2]! * 29) >> 8;
  // Integral image (width+1 × height+1).
  const W = width + 1;
  const integ = new Float64Array(W * (height + 1));
  for (let y = 1; y <= height; y++) {
    let row = 0;
    for (let x = 1; x <= width; x++) {
      row += gray[(y - 1) * width + (x - 1)]!;
      integ[y * W + x] = integ[(y - 1) * W + x]! + row;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1);
      const sum = integ[y1 * W + x1]! - integ[y0 * W + x1]! - integ[y1 * W + x0]! + integ[y0 * W + x0]!;
      const mean = sum / ((y1 - y0) * (x1 - x0));
      out[y * width + x] = gray[y * width + x]! < mean * 0.85 ? 1 : 0;
    }
  }
  return out;
}

/** Whether five run lengths look like 1:1:3:1:1. */
function ratioOk(r: number[]): boolean {
  const total = r[0]! + r[1]! + r[2]! + r[3]! + r[4]!;
  if (total < 7) return false;
  const m = total / 7;
  const tol = Math.max(1, m * 0.55);
  return (
    Math.abs(r[0]! - m) < tol && Math.abs(r[1]! - m) < tol &&
    Math.abs(r[2]! - 3 * m) < 3 * tol && Math.abs(r[3]! - m) < tol && Math.abs(r[4]! - m) < tol
  );
}

/** Run the 1:1:3:1:1 test along a column through (cx, cy); returns the centre y or -1. */
function crossVertical(bin: Uint8Array, width: number, height: number, cx: number, cy: number, module: number): number {
  const at = (x: number, y: number): number => bin[y * width + x]!;
  const runs = [0, 0, 0, 0, 0];
  let y = cy;
  // Up through the centre black, white, black.
  while (y >= 0 && at(cx, y) === 1) { runs[2]!++; y--; }
  while (y >= 0 && at(cx, y) === 0) { runs[1]!++; y--; }
  while (y >= 0 && at(cx, y) === 1) { runs[0]!++; y--; }
  if (runs[0] === 0) return -1;
  y = cy + 1;
  while (y < height && at(cx, y) === 1) { runs[2]!++; y++; }
  while (y < height && at(cx, y) === 0) { runs[3]!++; y++; }
  while (y < height && at(cx, y) === 1) { runs[4]!++; y++; }
  if (runs[4] === 0) return -1;
  if (!ratioOk(runs)) return -1;
  const total = runs.reduce((a, b) => a + b, 0);
  if (Math.abs(total / 7 - module) > module * 0.6) return -1;
  return y - runs[4]! - runs[3]! - runs[2]! / 2;
}

/** All finder-pattern centres in a binary image. */
export function findFinders(bin: Uint8Array, width: number, height: number): Finder[] {
  const found: Finder[] = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 400));
  for (let y = 0; y < height; y += step) {
    const runs: number[] = [];
    let colour = bin[y * width]!;
    let len = 0;
    const row = y * width;
    const flush = (xEnd: number): void => {
      runs.push(len);
      if (runs.length > 5) runs.shift();
      // Pattern must start with black: runs[0] black when the run that just
      // closed (runs[4]) is black, i.e. colour === 1.
      if (runs.length === 5 && colour === 1 && ratioOk(runs)) {
        const total = runs.reduce((a, b) => a + b, 0);
        const module = total / 7;
        const cx = Math.round(xEnd - runs[4]! - runs[3]! - runs[2]! / 2);
        const cy = crossVertical(bin, width, height, cx, y, module);
        if (cy >= 0) {
          // Re-centre horizontally on the row through the verified centre.
          const yy = Math.round(cy);
          let l = cx, r = cx;
          while (l > 0 && bin[yy * width + l - 1] === 1) l--;
          while (r < width - 1 && bin[yy * width + r + 1] === 1) r++;
          const fx = (l + r) / 2;
          const near = found.find((f) => Math.abs(f.x - fx) < module * 1.5 && Math.abs(f.y - cy) < module * 1.5);
          if (near) {
            near.x = (near.x + fx) / 2;
            near.y = (near.y + cy) / 2;
            near.module = (near.module + module) / 2;
          } else found.push({ x: fx, y: cy, module });
        }
      }
    };
    for (let x = 0; x < width; x++) {
      const c = bin[row + x]!;
      if (c === colour) len++;
      else {
        flush(x);
        colour = c;
        len = 1;
      }
    }
    flush(width);
  }
  return found;
}

/** Group finders into QR boxes: three at a right angle with matching module size. */
export function groupFinders(finders: readonly Finder[]): Det[] {
  const used = new Set<number>();
  const out: Det[] = [];
  const dist = (a: Finder, b: Finder): number => Math.hypot(a.x - b.x, a.y - b.y);
  for (let i = 0; i < finders.length; i++) {
    if (used.has(i)) continue;
    const a = finders[i]!;
    let best: { j: number; k: number; err: number } | null = null;
    for (let j = 0; j < finders.length; j++) {
      if (j === i || used.has(j)) continue;
      const b = finders[j]!;
      if (b.module / a.module > 1.6 || a.module / b.module > 1.6) continue;
      for (let k = j + 1; k < finders.length; k++) {
        if (k === i || used.has(k)) continue;
        const c = finders[k]!;
        if (c.module / a.module > 1.6 || a.module / c.module > 1.6) continue;
        const ab = dist(a, b), ac = dist(a, c);
        if (ab < a.module * 8 || ac < a.module * 8) continue;
        if (Math.abs(ab - ac) / Math.max(ab, ac) > 0.25) continue;
        const cos = ((b.x - a.x) * (c.x - a.x) + (b.y - a.y) * (c.y - a.y)) / (ab * ac);
        if (Math.abs(cos) > 0.3) continue;
        const err = Math.abs(ab - ac) / Math.max(ab, ac) + Math.abs(cos);
        if (!best || err < best.err) best = { j, k, err };
      }
    }
    if (!best) continue;
    const b = finders[best.j]!, c = finders[best.k]!;
    const d = { x: b.x + c.x - a.x, y: b.y + c.y - a.y };
    const m = (a.module + b.module + c.module) / 3;
    const xs = [a.x, b.x, c.x, d.x], ys = [a.y, b.y, c.y, d.y];
    const x0 = Math.min(...xs) - 3.5 * m, y0 = Math.min(...ys) - 3.5 * m;
    const x1 = Math.max(...xs) + 3.5 * m, y1 = Math.max(...ys) + 3.5 * m;
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: Math.max(0.5, 1 - best.err), cls: 0 });
    used.add(i); used.add(best.j); used.add(best.k);
  }
  return out;
}

/** The pure-TS path on its own. Boxes in source pixels. */
export function findQrBoxes(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Det[] {
  const bin = binarise(rgba, width, height);
  const finders = findFinders(bin, width, height);
  return groupFinders(finders).map((d) => ({
    ...d,
    x: Math.max(0, d.x), y: Math.max(0, d.y),
    w: Math.min(width - Math.max(0, d.x), d.w), h: Math.min(height - Math.max(0, d.y), d.h),
  }));
}

/** Platform detector when it works, finder search always; merged by overlap. */
export async function detectCodes(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: { platform?: boolean } = {},
): Promise<{ codes: Det[]; source: "platform+finder" | "finder" }> {
  const own = findQrBoxes(rgba, width, height);
  let plat: Det[] | null = null;
  if (opts.platform ?? true) {
    try {
      const copy = new Uint8ClampedArray(rgba.length);
      copy.set(rgba);
      const img = new ImageData(copy, width, height);
      plat = await platformCodes(img);
    } catch {
      plat = null;
    }
  }
  if (!plat) return { codes: own, source: "finder" };
  const merged = [...plat];
  for (const d of own) {
    const dup = merged.some((m) => {
      const ix = Math.max(0, Math.min(m.x + m.w, d.x + d.w) - Math.max(m.x, d.x));
      const iy = Math.max(0, Math.min(m.y + m.h, d.y + d.h) - Math.max(m.y, d.y));
      return ix * iy > 0.3 * Math.min(m.w * m.h, d.w * d.h);
    });
    if (!dup) merged.push(d);
  }
  return { codes: merged, source: "platform+finder" };
}
