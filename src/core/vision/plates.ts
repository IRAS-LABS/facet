/**
 * Licence plates: YOLOv9-t at 384 px from open-image-models (MIT), exported
 * "end2end" so NMS runs inside the graph and the output is a short list of
 * `[batch, x1, y1, x2, y2, class, score]` rows.
 *
 * 384 px across a whole photo makes a plate on a car twenty metres away about
 * six pixels wide, which the model cannot see. So when the COCO stage has
 * found vehicles, each one is cropped and run again at 384, and the crops'
 * boxes are merged with the full-frame pass. A close-up of one car costs one
 * extra run; a car park costs one per car, which is still a fraction of a
 * second on a laptop and a couple of seconds on a phone.
 */

import { decodePlates, iou, letterbox, unletterbox, cropRgba, type Det } from "./onnx";
import { MODEL_SIZE, type OnnxRunner } from "./onnx-runner";

export interface PlateOptions {
  conf: number;
  /** Vehicle boxes from the COCO stage, source pixels; each is re-scanned. */
  vehicles: readonly Det[];
  /** Skip vehicle crops whose short edge is under this many pixels. */
  minVehicle: number;
  /** Cap on vehicle crops per frame, largest first. */
  maxVehicles: number;
}

export const PLATE_DEFAULTS: PlateOptions = { conf: 0.4, vehicles: [], minVehicle: 96, maxVehicles: 8 };

async function runOnce(
  runner: OnnxRunner,
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  conf: number,
): Promise<{ dets: Det[]; ms: number }> {
  const size = MODEL_SIZE.plates;
  // RGB, 0..1, 114 fill — the open-image-models preprocessing.
  const lb = letterbox(rgba, width, height, size, { fill: 114, order: "rgb", scale: 1 / 255 });
  const { outputs, ms } = await runner.run("plates", { images: { data: lb.data, dims: [1, 3, size, size] } });
  const out = outputs["output0"];
  if (!out) throw new Error("plates: no output0 tensor");
  return { dets: decodePlates(out.data, conf).map((d) => unletterbox(d, lb.ratio, width, height)), ms };
}

/** Plates in source pixels: a full-frame pass plus one per vehicle crop. */
export async function detectPlates(
  runner: OnnxRunner,
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: Partial<PlateOptions> = {},
): Promise<{ plates: Det[]; ms: number; runs: number }> {
  const o = { ...PLATE_DEFAULTS, ...opts };
  const full = await runOnce(runner, rgba, width, height, o.conf);
  const found: Det[] = [...full.dets];
  let ms = full.ms;
  let runs = 1;
  const cars = [...o.vehicles]
    .filter((v) => Math.min(v.w, v.h) >= o.minVehicle)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, o.maxVehicles);
  for (const v of cars) {
    // A crop that is most of the frame gains nothing over the full pass.
    if (v.w * v.h > 0.6 * width * height) continue;
    const crop = cropRgba(rgba, width, height, v);
    const r = await runOnce(runner, crop.data, crop.width, crop.height, o.conf);
    ms += r.ms;
    runs++;
    for (const d of r.dets) found.push({ ...d, x: d.x + crop.x, y: d.y + crop.y });
  }
  // Merge duplicates between the passes, best score wins.
  found.sort((a, b) => b.score - a.score);
  const plates: Det[] = [];
  for (const d of found) if (!plates.some((k) => iou(k, d) > 0.4)) plates.push(d);
  return { plates, ms, runs };
}
