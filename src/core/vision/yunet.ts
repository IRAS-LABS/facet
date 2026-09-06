/**
 * Faces with YuNet (OpenCV Zoo, MIT, 233 KB), exported at 640×640.
 *
 * The LBP cascade in `detect.ts` stays as the no-model fallback and is what
 * runs when the WASM runtime cannot start. YuNet is the upgrade: it finds
 * turned, tilted and partly covered faces the cascade walks past, at one
 * fixed cost per frame instead of a scale pyramid. Faces smaller than about
 * twelve pixels *at 640* are below its smallest anchor, so on a 4000-px group
 * photo a face has to be ~75 source pixels wide; the caller can tile if that
 * ever matters.
 */

import { decodeYunet, letterbox, unletterbox, type Det, type YunetOutputs, YUNET_STRIDES } from "./onnx";
import { MODEL_SIZE, type OnnxRunner } from "./onnx-runner";

export async function detectFacesNet(
  runner: OnnxRunner,
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: { conf?: number } = {},
): Promise<{ faces: Det[]; ms: number }> {
  const size = MODEL_SIZE.yunet;
  // OpenCV feeds YuNet raw BGR 0..255 with no mean/std; padding is black.
  const lb = letterbox(rgba, width, height, size, { fill: 0, order: "bgr", scale: 1 });
  const { outputs, ms } = await runner.run("yunet", { input: { data: lb.data, dims: [1, 3, size, size] } });
  const heads: Partial<Record<(typeof YUNET_STRIDES)[number], YunetOutputs>> = {};
  for (const s of YUNET_STRIDES) {
    const cls = outputs[`cls_${s}`];
    const obj = outputs[`obj_${s}`];
    const bbox = outputs[`bbox_${s}`];
    if (!cls || !obj || !bbox) throw new Error(`yunet: missing stride-${s} head`);
    heads[s] = { cls: cls.data, obj: obj.data, bbox: bbox.data };
  }
  const dets = decodeYunet(heads, size, opts.conf ?? 0.6, 0.3);
  return { faces: dets.map((d) => unletterbox(d, lb.ratio, width, height)), ms };
}
