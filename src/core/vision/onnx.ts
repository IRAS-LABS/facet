/**
 * Pure pre- and post-processing for the ONNX detectors: letterbox, tensor
 * layout, box decoding and NMS. No runtime import here — the runtime lives in
 * `onnx-worker.ts` and this file is what makes every model's numbers checkable
 * without it, from synthetic tensors in `autoblurcheck`.
 *
 * Every decoder returns boxes in *letterboxed input* pixels; `unletterbox`
 * takes them back to the source image. Letterboxing is top-left aligned (no
 * centring) so the mapping is a single divide by the ratio, which is also
 * exactly what the reference implementations of all three models do.
 */

/** A detection in pixel coordinates of whatever space produced it. */
export interface Det {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** Class index for multi-class models; 0 for single-class ones. */
  cls: number;
}

export type ChannelOrder = "rgb" | "bgr";

export interface Letterboxed {
  /** CHW float32, 1 × 3 × size × size. */
  data: Float32Array;
  size: number;
  /** Source-to-input scale (input = source × ratio). */
  ratio: number;
  /** Source pixels actually covered (before the fill). */
  scaledW: number;
  scaledH: number;
}

/**
 * Resize an RGBA buffer to fit `size`×`size`, top-left aligned, filling the
 * rest with `fill`, into a CHW float tensor. `scale` multiplies every value
 * (1 keeps 0..255, 1/255 normalises). Bilinear when shrinking less than 2×,
 * box-average beyond that so a 4000-px photo does not alias into noise at 416.
 */
export function letterbox(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  size: number,
  opts: { fill?: number; order?: ChannelOrder; scale?: number } = {},
): Letterboxed {
  const fill = opts.fill ?? 114;
  const order = opts.order ?? "rgb";
  const scale = opts.scale ?? 1;
  const ratio = Math.min(size / width, size / height);
  const sw = Math.max(1, Math.round(width * ratio));
  const sh = Math.max(1, Math.round(height * ratio));
  const plane = size * size;
  const data = new Float32Array(3 * plane).fill(fill * scale);
  const c0 = order === "rgb" ? 0 : 2;
  const c2 = order === "rgb" ? 2 : 0;
  const inv = 1 / ratio;
  const box = inv > 2;
  const half = Math.max(1, Math.floor(inv / 2));
  for (let y = 0; y < sh; y++) {
    const sy = (y + 0.5) * inv - 0.5;
    for (let x = 0; x < sw; x++) {
      const sx = (x + 0.5) * inv - 0.5;
      let r = 0, g = 0, b = 0;
      if (box) {
        // Average a (2·half+1)² neighbourhood around the sample point.
        const cx = Math.round(sx), cy = Math.round(sy);
        let n = 0;
        for (let yy = cy - half; yy <= cy + half; yy++) {
          if (yy < 0 || yy >= height) continue;
          for (let xx = cx - half; xx <= cx + half; xx++) {
            if (xx < 0 || xx >= width) continue;
            const i = (yy * width + xx) * 4;
            r += rgba[i]!;
            g += rgba[i + 1]!;
            b += rgba[i + 2]!;
            n++;
          }
        }
        if (n > 0) { r /= n; g /= n; b /= n; }
      } else {
        const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
        const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
        const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
        const i00 = (y0 * width + x0) * 4, i10 = (y0 * width + x1) * 4;
        const i01 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        r = rgba[i00]! * w00 + rgba[i10]! * w10 + rgba[i01]! * w01 + rgba[i11]! * w11;
        g = rgba[i00 + 1]! * w00 + rgba[i10 + 1]! * w10 + rgba[i01 + 1]! * w01 + rgba[i11 + 1]! * w11;
        b = rgba[i00 + 2]! * w00 + rgba[i10 + 2]! * w10 + rgba[i01 + 2]! * w01 + rgba[i11 + 2]! * w11;
      }
      const o = y * size + x;
      data[c0 * plane + o] = r * scale;
      data[plane + o] = g * scale;
      data[c2 * plane + o] = b * scale;
    }
  }
  return { data, size, ratio, scaledW: sw, scaledH: sh };
}

/** Map a detection from letterboxed input pixels back to source pixels, clamped. */
export function unletterbox(d: Det, ratio: number, width: number, height: number): Det {
  const x0 = Math.max(0, d.x / ratio);
  const y0 = Math.max(0, d.y / ratio);
  const x1 = Math.min(width, (d.x + d.w) / ratio);
  const y1 = Math.min(height, (d.y + d.h) / ratio);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), score: d.score, cls: d.cls };
}

/** Intersection over union of two boxes. */
export function iou(a: Det, b: Det): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Greedy non-maximum suppression, highest score first. `perClass` keeps a tv
 * and a laptop that overlap (the model is unsure which it is — we blur both
 * anyway, so callers pass false and merge).
 */
export function nms(dets: readonly Det[], threshold = 0.45, perClass = false): Det[] {
  const order = [...dets].sort((a, b) => b.score - a.score);
  const keep: Det[] = [];
  for (const d of order) {
    let dup = false;
    for (const k of keep) {
      if (perClass && k.cls !== d.cls) continue;
      if (iou(k, d) > threshold) { dup = true; break; }
    }
    if (!dup) keep.push(d);
  }
  return keep;
}

// ── YOLOX ────────────────────────────────────────────────────────────────────

/** The 80 COCO class names in YOLOX's output order. */
export const COCO = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
  "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
  "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
  "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
  "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
  "scissors", "teddy bear", "hair drier", "toothbrush",
] as const;

export const YOLOX_STRIDES = [8, 16, 32] as const;

/** Rows the YOLOX head emits for an input of `size` (3549 at 416). */
export function yoloxRows(size: number): number {
  let n = 0;
  for (const s of YOLOX_STRIDES) n += (size / s) * (size / s);
  return n;
}

/**
 * Decode YOLOX's raw `[1, rows, 5 + classes]` output. Rows are the three
 * stride grids in order; each row is `cx, cy, log w, log h, objectness,
 * class scores…` relative to its grid cell. Score = objectness × best class.
 * Returns boxes in input pixels, above `conf`, NMS applied.
 */
export function decodeYolox(
  out: Float32Array,
  size: number,
  numClasses = 80,
  conf = 0.3,
  nmsIou = 0.45,
  classes?: ReadonlySet<number>,
): Det[] {
  const stride = 5 + numClasses;
  const dets: Det[] = [];
  let row = 0;
  for (const s of YOLOX_STRIDES) {
    const n = size / s;
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++, row++) {
        const o = row * stride;
        const obj = out[o + 4]!;
        if (obj * 1 < conf) continue; // class score ≤ 1, so obj alone bounds the product
        let best = -1, bi = 0;
        for (let c = 0; c < numClasses; c++) {
          if (classes && !classes.has(c)) continue;
          const v = out[o + 5 + c]!;
          if (v > best) { best = v; bi = c; }
        }
        const score = obj * best;
        if (score < conf) continue;
        const cx = (out[o]! + gx) * s;
        const cy = (out[o + 1]! + gy) * s;
        const w = Math.exp(out[o + 2]!) * s;
        const h = Math.exp(out[o + 3]!) * s;
        dets.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, cls: bi });
      }
    }
  }
  return nms(dets, nmsIou, false);
}

// ── YuNet ────────────────────────────────────────────────────────────────────

export const YUNET_STRIDES = [8, 16, 32] as const;

/** The per-stride output tensors YuNet 2023mar emits. */
export interface YunetOutputs {
  cls: Float32Array;
  obj: Float32Array;
  bbox: Float32Array;
}

/**
 * Decode YuNet's per-stride heads. Score is √(cls × obj) as in OpenCV's
 * FaceDetectorYN; the box is `(grid + dx, grid + dy) × stride` centre and
 * `exp(dw, dh) × stride` size. Landmarks are ignored — a blur needs a box.
 */
export function decodeYunet(
  outputs: Partial<Record<(typeof YUNET_STRIDES)[number], YunetOutputs>>,
  size: number,
  conf = 0.6,
  nmsIou = 0.3,
): Det[] {
  const dets: Det[] = [];
  for (const s of YUNET_STRIDES) {
    const o = outputs[s];
    if (!o) continue;
    const n = size / s;
    const rows = n * n;
    for (let i = 0; i < rows; i++) {
      const c = Math.min(1, Math.max(0, o.cls[i]!));
      const ob = Math.min(1, Math.max(0, o.obj[i]!));
      const score = Math.sqrt(c * ob);
      if (score < conf) continue;
      const gx = i % n;
      const gy = Math.floor(i / n);
      const cx = (gx + o.bbox[i * 4]!) * s;
      const cy = (gy + o.bbox[i * 4 + 1]!) * s;
      const w = Math.exp(o.bbox[i * 4 + 2]!) * s;
      const h = Math.exp(o.bbox[i * 4 + 3]!) * s;
      dets.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, cls: 0 });
    }
  }
  return nms(dets, nmsIou);
}

// ── Plates (YOLOv9 end2end) ──────────────────────────────────────────────────

/**
 * Decode the end-to-end plate model's `[n, 7]` rows: batch, x1, y1, x2, y2,
 * class, score. NMS already happened inside the graph, so this is a filter.
 */
export function decodePlates(out: Float32Array, conf = 0.4): Det[] {
  const dets: Det[] = [];
  for (let o = 0; o + 7 <= out.length; o += 7) {
    const score = out[o + 6]!;
    if (!(score >= conf)) continue;
    const x1 = out[o + 1]!, y1 = out[o + 2]!, x2 = out[o + 3]!, y2 = out[o + 4]!;
    if (!(x2 > x1) || !(y2 > y1)) continue;
    dets.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score, cls: out[o + 5]! | 0 });
  }
  return dets.sort((a, b) => b.score - a.score);
}

// ── Helpers shared by the category modules ───────────────────────────────────

/** Grow a box by `pad` × its short edge on every side, clamped to the frame. */
export function padDet(d: Det, pad: number, width: number, height: number): Det {
  const p = Math.min(d.w, d.h) * pad;
  const x0 = Math.max(0, d.x - p);
  const y0 = Math.max(0, d.y - p);
  const x1 = Math.min(width, d.x + d.w + p);
  const y1 = Math.min(height, d.y + d.h + p);
  return { ...d, x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Crop an RGBA buffer to an integer box. */
export function cropRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  box: { x: number; y: number; w: number; h: number },
): { data: Uint8ClampedArray; width: number; height: number; x: number; y: number } {
  const x0 = Math.min(width - 1, Math.max(0, Math.floor(box.x)));
  const y0 = Math.min(height - 1, Math.max(0, Math.floor(box.y)));
  const w = Math.max(1, Math.min(width - x0, Math.floor(box.w)));
  const h = Math.max(1, Math.min(height - y0, Math.floor(box.h)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * width + x0) * 4;
    out.set(rgba.subarray(src, src + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h, x: x0, y: y0 };
}
