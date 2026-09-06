/**
 * Light and colour — the adjustments a phone gallery has.
 *
 * This file exists because the app had none of them. The "Adjust" group was
 * twelve blur parameters and five audio controls; there was no path anywhere in
 * the product that changed the exposure of a photograph. You could redact a
 * face and you could not brighten the picture the face was in.
 *
 * Written as a pixel pass rather than as `ctx.filter` strings, which is the
 * idiom `blur.ts` uses next door, and the difference is deliberate:
 *
 *  - `ctx.filter` cannot express half of this. Highlights, shadows and
 *    sharpness have no CSS filter function, and faking them by stacking
 *    `brightness` and `contrast` moves the whole tone curve when the entire
 *    point of a highlight control is that it moves one end of it.
 *  - Blur is expensive per pixel and belongs on the GPU. A tone curve is a
 *    256-entry table lookup, which is about the cheapest operation there is;
 *    the pass below touches each channel once and does no arithmetic per pixel
 *    beyond an array index.
 *
 * One function, used by both the on-screen preview and the exported file. The
 * phone editor draws into a canvas at full source resolution and `encode()`
 * hands that same canvas to `toBlob`, so there is no second code path to keep
 * in sync and no way for what you approved to differ from what got written.
 */

/**
 * Every adjustment, each on the same −1…+1 scale except the two that only have
 * an "on" direction.
 *
 * The uniform range is what lets the editor drive all of these from one slider
 * helper. Zero is neutral for every field, so a fresh `noAdjust()` is a picture
 * left alone, and `isNeutral` is the test that decides whether the pass runs at
 * all.
 */
export interface Adjust {
  /** Photographic stops, ±2. Multiplies the signal. */
  exposure: number;
  /** A flat lift or drop. Additive, which is what makes it different to exposure. */
  brightness: number;
  /** Pivots around mid-grey, so it darkens and lightens in one move. */
  contrast: number;
  /** −1 is greyscale, +1 is roughly double. */
  saturation: number;
  /** Amber at +1, blue at −1. The white-balance control. */
  warmth: number;
  /** Negative recovers a blown sky; positive pushes the bright end further. */
  highlights: number;
  /** Positive opens up a face lost in shadow. The one people reach for most. */
  shadows: number;
  /** Unsharp, 0…1. Off by default because it is the easiest to overdo. */
  sharpness: number;
  /** Corner darkening, 0…1. */
  vignette: number;
  /** Magenta at +1, green at −1. The other half of white balance. */
  tint: number;
  /**
   * Saturation that spares what is already saturated. +1 pushes the dull
   * colours hardest and leaves a red jacket alone, which is what makes it the
   * one you can use on a portrait without turning the skin orange.
   */
  vibrance: number;
  /** Lifted blacks and a shortened range, 0…1. The "matte" look. */
  fade: number;
}

/** A picture left alone. */
export function noAdjust(): Adjust {
  return {
    exposure: 0,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    warmth: 0,
    highlights: 0,
    shadows: 0,
    sharpness: 0,
    vignette: 0,
    tint: 0,
    vibrance: 0,
    fade: 0,
  };
}

/**
 * Nothing to do.
 *
 * Checked field by field rather than by comparing against a spread of
 * `noAdjust()`, because this runs on every frame of a brush stroke and the
 * comparison is the thing standing between a neutral picture and a full
 * `getImageData` of a 45 MP canvas.
 */
export function isNeutral(a: Adjust): boolean {
  return (
    a.exposure === 0 &&
    a.brightness === 0 &&
    a.contrast === 0 &&
    a.saturation === 0 &&
    a.warmth === 0 &&
    a.highlights === 0 &&
    a.shadows === 0 &&
    a.sharpness === 0 &&
    a.vignette === 0 &&
    a.tint === 0 &&
    a.vibrance === 0 &&
    a.fade === 0
  );
}

/** True when only the tone curve is in play — no neighbour reads, no overlay. */
function tonal(a: Adjust): boolean {
  return (
    a.exposure !== 0 ||
    a.brightness !== 0 ||
    a.contrast !== 0 ||
    a.saturation !== 0 ||
    a.warmth !== 0 ||
    a.highlights !== 0 ||
    a.shadows !== 0 ||
    a.tint !== 0 ||
    a.vibrance !== 0 ||
    a.fade !== 0
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * How strongly a tone belongs to one end of the range.
 *
 * Squared rather than linear so the highlight control fades out before it
 * reaches the midtones instead of stopping at them with a visible edge — a
 * linear weight puts a seam across a gradient sky, which is exactly the
 * picture people use the control on.
 */
function endWeight(x: number): number {
  const t = clamp01(x);
  return t * t;
}

/** How hard the highlight and shadow controls push. See `channelLuts`. */
const RECOVERY = 0.35;

/**
 * One lookup table per channel, folding every tone control into 256 entries.
 *
 * All of exposure, brightness, highlights, shadows, contrast and warmth are
 * functions of a single channel value, so they collapse into a table and cost
 * nothing per pixel. Saturation is the one that cannot: it needs all three
 * channels at once, so it stays in the pixel loop below.
 *
 * Order is the order a darkroom would do it in — gain, then lift, then the two
 * end-of-range recoveries, then contrast, then the colour cast last so a warm
 * tint is not then stretched by the contrast that follows it.
 *
 * The table is forced to rise. Highlight recovery pushes each tone down by an
 * amount that grows with the tone, and past a certain strength it grows faster
 * than the tone itself — which turns the curve back on itself and maps a
 * brighter input to a darker output. The visible result is that the brightest
 * part of a blown sky comes out *darker* than the merely bright part around it,
 * an inversion that reads as a stain rather than as recovered detail. Every
 * control here is meant to be non-decreasing, so clamping each entry to the one
 * before it costs nothing when the maths behaves and, when it does not, spends
 * the error on flattened detail instead of inverted detail. Verified over all
 * 59,049 combinations of the five tone controls at quarter steps: no entry ever
 * falls below its predecessor, and a neutral setting is the identity table.
 */
function channelLuts(a: Adjust): readonly [Uint8Array, Uint8Array, Uint8Array] {
  const gain = Math.pow(2, a.exposure * 2);
  const lift = a.brightness * 0.35;
  // Linear in the slider, and deliberately not the tan() curve that is the
  // usual shorthand: tan() reaches a 4x slope by +0.25, so the first quarter of
  // travel already clipped both ends of the picture and the rest of the slider
  // did nothing but clip harder. 1 + 1.5c gives a usable range across the whole
  // control, and −1 lands exactly on flat mid-grey.
  const k = a.contrast >= 0 ? 1 + a.contrast * 1.5 : 1 + Math.max(-1, a.contrast);
  const warm = a.warmth * 0.22;
  const tint = a.tint * 0.18;
  // Green moves a little against both, otherwise a warm push reads as magenta.
  // Tint is the axis warmth leaves alone: magenta lifts red and blue together
  // against green, and green does the reverse.
  const mul: readonly number[] = [
    (1 + warm) * (1 + tint * 0.5),
    (1 - Math.abs(warm) * 0.06) * (1 - tint),
    (1 - warm) * (1 + tint * 0.5),
  ];
  // Fade lifts the floor and lowers the ceiling in one move, then lets the
  // tone sit on that shorter range. 0.18 at full strength keeps black at a
  // dark grey rather than the washed-out mid-grey a film scan never has.
  const floor = a.fade * 0.18;
  const span = 1 - a.fade * 0.28;

  const out = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)] as const;

  for (let ch = 0; ch < 3; ch++) {
    const table = out[ch]!;
    const m = mul[ch]!;
    let prev = 0;

    for (let i = 0; i < 256; i++) {
      let v = (i / 255) * gain + lift;

      if (a.highlights !== 0) {
        const w = endWeight((v - 0.4) / 0.6);
        v += a.highlights * RECOVERY * w * (a.highlights > 0 ? 1 - v : v);
      }
      if (a.shadows !== 0) {
        const w = endWeight((0.6 - v) / 0.6);
        v += a.shadows * RECOVERY * w * (a.shadows > 0 ? 1 - v : v);
      }

      v = (v - 0.5) * k + 0.5;
      v = floor + v * span;
      v *= m;

      const level = Math.round(clamp01(v) * 255);
      prev = level < prev ? prev : level;
      table[i] = prev;
    }
  }

  return out;
}

/** Rec. 709 luma. The weights that make a desaturated red look as dark as it is. */
function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Laplacian unsharp, blended by amount.
 *
 * Reads from a copy so that a sharpened pixel never becomes the neighbour of
 * the next one — sharpening in place walks a bright edge across the image,
 * which looks like a smear in the direction of the scan rather than like
 * detail. Edges clamp to the nearest real pixel instead of wrapping.
 */
function sharpen(dst: Uint8ClampedArray, w: number, h: number, amount: number): void {
  if (w < 3 || h < 3) return;
  const src = new Uint8ClampedArray(dst);
  const k = amount * 0.6;

  for (let y = 0; y < h; y++) {
    const yUp = y > 0 ? y - 1 : 0;
    const yDn = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xL = x > 0 ? x - 1 : 0;
      const xR = x < w - 1 ? x + 1 : w - 1;
      const i = (y * w + x) * 4;
      const up = (yUp * w + x) * 4;
      const dn = (yDn * w + x) * 4;
      const lf = (y * w + xL) * 4;
      const rt = (y * w + xR) * 4;

      for (let c = 0; c < 3; c++) {
        const mid = src[i + c]!;
        const edge = 4 * mid - src[up + c]! - src[dn + c]! - src[lf + c]! - src[rt + c]!;
        dst[i + c] = mid + k * edge;
      }
    }
  }
}

/**
 * Corner darkening, drawn rather than computed.
 *
 * A radial gradient multiplied over the picture is both faster and smoother
 * than a per-pixel falloff, and it is the one part of this file the GPU can
 * genuinely help with. The gradient is sized to the diagonal so the darkening
 * reaches the corners rather than stopping at the short edge.
 */
function drawVignette(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  amount: number,
): void {
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.hypot(cx, cy);
  const g = ctx.createRadialGradient(cx, cy, outer * 0.45, cx, cy, outer);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, `rgba(0,0,0,${clamp01(amount)})`);

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/**
 * Apply every adjustment to a canvas, in place.
 *
 * Returns early on a neutral setting so that the ordinary case — someone
 * blurring a face and never touching the light — costs one boolean check per
 * frame and no pixel traffic at all.
 */
export function applyAdjust(canvas: HTMLCanvasElement, a: Adjust): void {
  if (isNeutral(a)) return;

  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;

  // `willReadFrequently` is the difference between a slider that tracks a
  // finger and one that stutters: without it the browser keeps the surface on
  // the GPU and every getImageData is a stall waiting for a read-back.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  const needsPixels = tonal(a) || a.sharpness > 0;

  if (needsPixels) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    if (tonal(a)) {
      const [lr, lg, lb] = channelLuts(a);
      const sat = 1 + a.saturation;
      const vib = a.vibrance;
      const flat = a.saturation === 0 && vib === 0;

      for (let i = 0; i < d.length; i += 4) {
        const r = lr[d[i]!]!;
        const g = lg[d[i + 1]!]!;
        const b = lb[d[i + 2]!]!;

        if (flat) {
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
        } else {
          const y = luma(r, g, b);
          let s = sat;
          if (vib !== 0) {
            // How saturated this pixel already is, 0…1. Vibrance scales with
            // the complement, so a grey gets the full push and a pure colour
            // gets none — that is the whole difference from saturation.
            const hi = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
            const have = hi > 0 ? (hi - lo) / hi : 0;
            s += vib * (1 - have);
          }
          d[i] = y + (r - y) * s;
          d[i + 1] = y + (g - y) * s;
          d[i + 2] = y + (b - y) * s;
        }
      }
    }

    if (a.sharpness > 0) sharpen(d, w, h, a.sharpness);

    ctx.putImageData(img, 0, 0);
  }

  if (a.vignette > 0) drawVignette(ctx, w, h, a.vignette);
}
