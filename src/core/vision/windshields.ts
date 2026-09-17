/**
 * The VIN corner of a detected vehicle's windscreen, as a box to cover.
 *
 * There is no windscreen detector and this file does not pretend there is one.
 * It takes the vehicle boxes the COCO pass already found -- the same ones the
 * plate stage uses to decide where to look -- and works out where the glass
 * must be from the shape of the box.
 *
 * **Why geometry rather than OCR.** The VIN plate sits at the base of the
 * glass on the driver's side: a few millimetres of text photographed through
 * raked glass from several metres away, usually with the sky reflected in it. Tesseract will
 * not read any of that, so a text rule aimed at it detects nothing and quietly
 * reports success -- the worst possible outcome, because the person moves on
 * believing the picture is safe. A patch placed by geometry is crude and it
 * actually lands.
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
 * Where the VIN corner sits inside a vehicle's box, as fractions of it.
 *
 * Measured on `fixtures/_autoblurcheck/autoblur-car.jpg`: the saloon's box
 * runs x 104..989, y 100..555, and its windscreen x 0.40..0.77, y 0.05..0.24
 * of that box. The VIN plate is on the dashboard at the glass's bottom-right
 * corner, which is where the patch goes -- not a band across the whole
 * windscreen. The band covered the glass, the roof and a slice of sky, which
 * spoiled the photo to hide a plate a few centimetres wide, and a first
 * corner patch half the glass wide was still far bigger than the plate.
 *
 * The box does not say which way the car faces, so a head-on or reversed car
 * can put the corner elsewhere. The patch is an ordinary region: it can be
 * moved, resized or restyled in the editor like any other.
 */
const LEFT = 0.64;
const RIGHT = 0.76;
const TOP = 0.19;
const BOTTOM = 0.28;

/**
 * A cover box for each vehicle worth covering.
 *
 * Motorcycles are dropped: COCO counts them as vehicles, they have no
 * windscreen worth the name and no VIN on display, and a black bar across the
 * upper half of a motorbike is pure vandalism of the photograph.
 *
 * So is a vehicle with over 40% of it inside a bigger one's box. That is a
 * car parked behind another, and the detector boxes only the part that shows -- on the
 * test picture, the nose of the car behind the saloon. The corner of a
 * fragment is not the corner of the glass: it put the patch on a headlight.
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
    if (vehicles.some((u) => u !== v && u.cls !== moto && u.w * u.h > v.w * v.h && inside(v, u) > 0.4)) continue;
    const x = v.x + v.w * LEFT;
    const w = v.w * (RIGHT - LEFT);
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

/** How much of `a`'s area lies inside `b`, 0..1. */
function inside(a: Det, b: Det): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / (a.w * a.h) : 0;
}
