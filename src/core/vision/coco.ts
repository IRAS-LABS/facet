/**
 * Screens, phones and vehicles from the COCO detector (YOLOX-Nano, 416 px).
 *
 * "Screen" here means tv, laptop and — when the user wants — cell phone: a
 * monitor on a desk is a `tv` to COCO, a laptop with its lid up is a `laptop`
 * even when only the screen shows. The nano model is the weakest of the YOLOX
 * family (25.8 mAP), which is fine for a monitor-sized object at a metre and
 * poor for a phone across a room; the pad hides the rest.
 *
 * Vehicles are returned too, because the plate detector is far better on a
 * crop of a car than on a whole street.
 */

import { COCO, decodeYolox, letterbox, unletterbox, type Det } from "./onnx";
import { MODEL_SIZE, type OnnxRunner } from "./onnx-runner";
import { sweep, type Frame } from "./tiles";

const IDX = (name: (typeof COCO)[number]): number => COCO.indexOf(name);

export const SCREEN_CLASSES = { tv: IDX("tv"), laptop: IDX("laptop"), phone: IDX("cell phone") } as const;
export const VEHICLE_CLASSES: ReadonlySet<number> = new Set([IDX("car"), IDX("motorcycle"), IDX("bus"), IDX("truck")]);

export interface CocoResult {
  /** tv + laptop (+ cell phone when asked), NMS-merged across those classes. */
  screens: Det[];
  /** Cars, trucks, buses, motorcycles — for the plate stage. */
  vehicles: Det[];
  /** Everything above `conf`, in case a caller wants keyboards or people. */
  all: Det[];
  ms: number;
}

/** Run the COCO detector once over an RGBA frame. Boxes in source pixels. */
export async function detectCoco(
  runner: OnnxRunner,
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: { conf?: number; phones?: boolean } = {},
): Promise<CocoResult> {
  const size = MODEL_SIZE.yolox;
  const conf = opts.conf ?? 0.35;
  // YOLOX (post-0.1.1) takes raw 0..255 BGR with no mean/std — checked against
  // the reference script: the normalised variant finds nothing.
  const lb = letterbox(rgba, width, height, size, { fill: 114, order: "bgr", scale: 1 });
  const { outputs, ms } = await runner.run("yolox", { images: { data: lb.data, dims: [1, 3, size, size] } });
  const out = outputs["output"];
  if (!out) throw new Error("yolox: no output tensor");
  // A lower floor for the raw pass so the vehicle stage sees marginal cars.
  const raw = decodeYolox(out.data, size, 80, Math.min(conf, 0.25), 0.45);
  const all = raw.map((d) => unletterbox(d, lb.ratio, width, height));
  return split(all, opts, ms);
}

/** The interesting classes, out of everything the model returned. */
function split(all: Det[], opts: { conf?: number; phones?: boolean }, ms: number): CocoResult {
  const conf = opts.conf ?? 0.35;
  const wanted = new Set<number>([SCREEN_CLASSES.tv, SCREEN_CLASSES.laptop]);
  if (opts.phones ?? true) wanted.add(SCREEN_CLASSES.phone);
  return {
    screens: all.filter((d) => wanted.has(d.cls) && d.score >= conf),
    vehicles: all.filter((d) => VEHICLE_CLASSES.has(d.cls)),
    all,
    ms,
  };
}

/**
 * The same detector, run over the frame and over overlapping pieces of it at
 * the source's own resolution.
 *
 * It matters twice over here. A television at the back of a room is a small
 * box in a big photo; and this is also the stage the plate and windscreen
 * stages are built on, so a car this pass misses costs its number plate and
 * its windscreen too -- both are derived from these boxes rather than found
 * on their own. On a frame small enough that nothing was thrown away this is
 * one run, exactly as before.
 */
export async function detectCocoTiled(
  runner: OnnxRunner,
  frame: Frame,
  opts: { conf?: number; phones?: boolean } = {},
  onStep?: ((done: number, total: number) => void) | undefined,
): Promise<CocoResult> {
  const t0 = performance.now();
  const all = await sweep(
    frame,
    (p) => detectCoco(runner, p.rgba, p.width, p.height, opts).then((r) => r.all),
    { sameClass: true, onStep },
  );
  return split(all, opts, performance.now() - t0);
}

/** "screen" or "phone" for a COCO class index. */
export function screenKind(cls: number): "screen" | "phone" {
  return cls === SCREEN_CLASSES.phone ? "phone" : "screen";
}
