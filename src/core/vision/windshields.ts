/**
 * The windscreen of a detected vehicle, as a box to cover.
 *
 * There is no windscreen detector and this file does not pretend there is one.
 * It takes the vehicle boxes the COCO pass already found -- the same ones the
 * plate stage uses to decide where to look -- and works out where the glass
 * must be from the shape of the box.
 *
 * **Why geometry rather than OCR.** The things on a windscreen that identify a
 * car are the VIN plate at the base of the glass on the driver's side, the tax
 * or inspection disc, the residents' parking permit and the toll tag. All of
 * them are a few millimetres of text photographed through raked glass from
 * several metres away, usually with the sky reflected in it. Tesseract will
 * not read any of that, so a text rule aimed at it detects nothing and quietly
 * reports success -- the worst possible outcome, because the person moves on
 * believing the picture is safe. Covering the whole band is crude and it
 * actually works.
 *
 * **Why a band and not a quadrilateral.** A car photographed head-on, in
 * three-quarter view and side-on puts its glass in three quite different
 * places, and nothing in the box says which of the three this is. The band
 * below is sized to contain the windscreen in all of them, which means it
 * takes some roof and some bonnet in each. That is the right way to be wrong:
 * a cover that is too big spoils a photograph, and a cover that is too small
 * hands over a VIN.
 *
 * Front and rear screens are not distinguished, for the same reason -- and it
 * does not matter, because the rear screen carries the permits and stickers
 * just as often.
 */

import type { Det } from "./onnx";

export interface WindshieldOptions {
  /**
   * Ignore vehicles whose short edge is under this many source pixels.
   *
   * A car 40 px across in a street scene has a windscreen of perhaps 12 px,
   * and there is nothing legible in 12 px to protect. Covering it anyway would
   * pepper a photograph of traffic with black rectangles for no gain, which is
   * how people learn to leave auto-blur switched off.
   */
  minVehicle: number;
  /** Detector confidence floor for a vehicle to count. */
  conf: number;
}

export const WINDSHIELD_DEFAULTS: WindshieldOptions = { minVehicle: 72, conf: 0.3 };

/**
 * Where the glass sits inside a vehicle's box, as fractions of it.
 *
 * Measured off photographs rather than derived: on a car seen head-on the
 * screen occupies roughly the top third and nearly the full width; in
 * three-quarter view it slides back and shrinks; side-on it is a wedge in the
 * upper middle. `TOP` starts just under the roofline and `BOTTOM` ends at the
 * scuttle, which is where the VIN plate lives — the single most important
 * thing on the whole car to cover, and the lowest, so the band is generous
 * downward rather than upward.
 */
const TOP = 0.12;
const BOTTOM = 0.58;
const INSET = 0.06;

/**
 * A cover box for each vehicle worth covering.
 *
 * Motorcycles are dropped: COCO counts them as vehicles, they have no
 * windscreen worth the name and no VIN on display, and a black bar across the
 * upper half of a motorbike is pure vandalism of the photograph.
 */
export function windshieldBoxes(
  vehicles: readonly Det[],
  width: number,
  height: number,
  moto: number,
  opts: Partial<WindshieldOptions> = {},
): Det[] {
  const o = { ...WINDSHIELD_DEFAULTS, ...opts };
  const out: Det[] = [];
  for (const v of vehicles) {
    if (v.cls === moto) continue;
    if (v.score < o.conf) continue;
    if (Math.min(v.w, v.h) < o.minVehicle) continue;
    const x = v.x + v.w * INSET;
    const w = v.w * (1 - INSET * 2);
    const y = v.y + v.h * TOP;
    const h = v.h * (BOTTOM - TOP);
    // Clamped to the picture: a vehicle box may legally hang off the edge, and
    // a region that does the same makes its handles unreachable in the editor.
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(width, x + w);
    const y1 = Math.min(height, y + h);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: v.score, cls: v.cls });
  }
  return out;
}
