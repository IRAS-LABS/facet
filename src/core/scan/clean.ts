/**
 * Making a warped page look like a scan instead of a photograph.
 *
 * A flattened photograph of a page is still a photograph: the paper is grey
 * rather than white, one side is a stop darker than the other because that is
 * where the window is, and there is a shadow of the phone across the middle.
 * None of that is information. All of it survives JPEG badly, makes the file
 * three times larger than it needs to be, and is exactly what people mean when
 * they say a phone photo of a document looks unprofessional.
 *
 * The fix everyone reaches for first is a global threshold, and it is wrong
 * for the same reason: a single cutoff that keeps the text on the bright side
 * of the page floods the dim side solid black. The lighting varies across the
 * page, so the correction has to vary across the page too.
 *
 * So: estimate the paper's brightness *locally*, and divide by it. Where the
 * paper is dim the divisor is small and the paper comes back to white; where
 * there is text the divisor is still the paper around it, so the text stays
 * dark. This is the same idea as dodging a print, done per pixel.
 */

/** What a cleaned page should look like. */
export type ScanLook =
  /** Leave it alone. For photographs, stamps, anything where colour is the point. */
  | "photo"
  /** Whiten the paper, keep the ink's colour. The default: signatures stay blue. */
  | "colour"
  /** Whiten the paper, drop to grey. Smaller files, no colour fringing on text. */
  | "grey"
  /** Two levels. What a fax is, and the smallest a page of text ever gets. */
  | "mono";

/** The full set, in the order a picker should offer them. */
export const LOOKS: readonly ScanLook[] = ["photo", "colour", "grey", "mono"];

/** What each look is called where a person can read it. */
export const LOOK_NAMES: Readonly<Record<ScanLook, string>> = {
  photo: "Photo",
  colour: "Colour",
  grey: "Greyscale",
  mono: "Black & white",
};

export interface CleanOptions {
  readonly look?: ScanLook;
  /**
   * How hard to push the whites, 0..1. Above the paper estimate everything is
   * paper, so this is really "how much of the dim end counts as paper".
   */
  readonly brightness?: number;
  /** Contrast applied after whitening, 0..1 either side of 0.5. */
  readonly contrast?: number;
}

/** Rec.601 luma. The same weights `quad.ts` uses, for the same reason. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * The local brightness of the paper, as a full-size single-channel map.
 *
 * A box blur wide enough to swallow a paragraph. Wide is the whole point: the
 * window has to be bigger than the largest dark thing on the page, or that
 * thing pulls its own estimate down, the division brightens it back up, and a
 * heading comes out grey while the body text around it comes out black. A
 * sixteenth of the long side clears headings and most photographs on a page.
 *
 * Done as two one-dimensional passes with a running sum, so the cost does not
 * depend on how wide the window is -- a 250 px box over an 8 MP scan is the
 * same work as a 3 px one. The naive version is minutes.
 */
export function paperMap(src: ImageData, radius?: number): Float32Array {
  const w = src.width;
  const h = src.height;
  const px = src.data;
  const r = Math.max(1, radius ?? Math.round(Math.max(w, h) / 16));

  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = luma(px[p]!, px[p + 1]!, px[p + 2]!);
  }

  // Horizontal, into `tmp`. The running sum drops the column leaving the
  // window and adds the one entering it; edges clamp, which is what stops the
  // margins of the page from being estimated against a half-empty window and
  // coming out darker than the middle.
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += lum[row + Math.min(w - 1, Math.max(0, x))]!;
    const n = 2 * r + 1;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n;
      sum -= lum[row + Math.min(w - 1, Math.max(0, x - r))]!;
      sum += lum[row + Math.min(w - 1, Math.max(0, x + r + 1))]!;
    }
  }

  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
    const n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x]!;
      sum += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x]!;
    }
  }

  return out;
}

/**
 * Clean a warped page in place-safe fashion, returning a new `ImageData`.
 *
 * `photo` returns a copy and nothing else, deliberately: it is not a no-op
 * caller-side, because the caller still wants one object it owns either way.
 */
export function clean(src: ImageData, opts: CleanOptions = {}): ImageData {
  const look = opts.look ?? "colour";
  const out = new ImageData(src.width, src.height);
  out.data.set(src.data);
  if (look === "photo") return out;

  const bright = Math.min(1, Math.max(0, opts.brightness ?? 0.5));
  const contrast = Math.min(1, Math.max(0, opts.contrast ?? 0.5));

  const paper = paperMap(src);
  const dst = out.data;

  // `bright` slides the divisor. Below 1 it treats the paper as darker than
  // measured, so less of the mid-tones reach white; above 1 the paper estimate
  // is treated as brighter, and the dim end is pushed to white harder. Clamped
  // low so a near-black region cannot divide by nothing and blow up.
  const gain = 0.75 + bright * 0.5;

  // Contrast pivots around the mid-point rather than around zero, so pushing
  // it does not also darken the page. 0.5 is a straight line through.
  const k = contrast <= 0.5 ? contrast * 2 : 1 + (contrast - 0.5) * 8;

  for (let i = 0, p = 0; i < paper.length; i++, p += 4) {
    const base = Math.max(24, paper[i]! * gain);

    let r = (dst[p]! / base) * 255;
    let g = (dst[p + 1]! / base) * 255;
    let b = (dst[p + 2]! / base) * 255;

    if (look !== "colour") {
      const y = luma(r, g, b);
      r = g = b = y;
    }

    if (look === "mono") {
      // After the division the paper is at 255 by construction, so the cutoff
      // is not a guess about the photograph -- it is a fixed fraction of white.
      // Ink lands well under it; paper texture and JPEG mush land over it.
      const v = luma(r, g, b) < 190 ? 0 : 255;
      dst[p] = dst[p + 1] = dst[p + 2] = v;
      continue;
    }

    dst[p] = clamp8((r - 128) * k + 128);
    dst[p + 1] = clamp8((g - 128) * k + 128);
    dst[p + 2] = clamp8((b - 128) * k + 128);
  }

  return out;
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
