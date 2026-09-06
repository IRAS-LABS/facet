/**
 * Auto-blur glue for callers that hold pixels rather than tensors: the phone
 * editor (an ImageBitmap), the desktop viewer (an <img>), the batch runner
 * (bytes) and both video workspaces (frames from ffmpeg).
 *
 * Everything here is "get RGBA, hand it to `detectAll`, turn the result into
 * regions or layers". The detectors themselves never see a canvas.
 */

import { renderBlur, type BlurLayer, type BlurRegion } from "@core/edit/blur";
import type { Recogniser } from "@core/ocr/engine";
import type { OcrPage } from "@core/ocr/page";
import { detectAll, detectionsToRegions, type DetectInput, type DetectResult, type Detection } from "./autoblur";
import type { AutoBlurConfig, AutoCategory } from "./autoblur-config";
import { autoSampleTimes, detectVideo, layersFromDetections, type FrameDetections, type SampledFrame } from "./autoblur-video";
import type { OnnxRunner } from "./onnx-runner";

/** Longest side the detectors see. Models run at ≤ 640 anyway; OCR wants more, and gets it (see `ocrOf`). */
export const DETECT_SIDE = 1600;

export interface PreparedInput extends DetectInput {
  /** Source pixels per detect pixel. */
  scale: number;
  canvas: HTMLCanvasElement;
}

/**
 * Draw a source into a canvas no larger than `maxSide` and pull RGBA out.
 * The OCR callback reads the same canvas, so word boxes and model boxes
 * share one coordinate space.
 */
export function prepareInput(
  src: CanvasImageSource,
  width: number,
  height: number,
  opts: { maxSide?: number; mime?: string; ocr?: Recogniser | null; ocrLanguage?: string } = {},
): PreparedInput {
  const maxSide = opts.maxSide ?? DETECT_SIDE;
  const k = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(src, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out: PreparedInput = { rgba, width: w, height: h, scale: 1 / k, canvas };
  if (opts.mime) out.mime = opts.mime;
  const ocr = opts.ocr;
  if (ocr) out.ocr = () => ocrOf(ocr, canvas, opts.ocrLanguage);
  return out;
}

/** OCR the canvas; the engine upscales small pages itself and returns boxes in canvas pixels. */
export async function ocrOf(ocr: Recogniser, canvas: HTMLCanvasElement, language?: string): Promise<OcrPage | null> {
  try {
    const r = await ocr.read(canvas, language ? { language } : {});
    return r.page;
  } catch {
    return null;
  }
}

export interface AutoBlurImageResult {
  bytes: Uint8Array;
  found: Detection[];
  regions: BlurRegion[];
  result: DetectResult;
  width: number;
  height: number;
}

/**
 * Decode → detect → blur → encode, no UI. The batch runner's path, and so
 * the watch-folder path. `found` is empty when the file was looked at and
 * had nothing, in which case `bytes` is the input untouched.
 */
export async function autoBlurImage(
  bytes: Uint8Array,
  type: string,
  categories: readonly AutoCategory[],
  config: AutoBlurConfig,
  deps: { runner: OnnxRunner | null; ocr?: Recogniser | null; signal?: AbortSignal; onProgress?: (f: number, m: string) => void; quality?: number; outType?: string },
): Promise<AutoBlurImageResult | null> {
  const blob = new Blob([bytes as BlobPart], type ? { type } : {});
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const input = prepareInput(bitmap, width, height, { mime: type, ocr: deps.ocr ?? null });
    const opts = { runner: deps.runner, config, ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.onProgress ? { onProgress: deps.onProgress } : {}) };
    const result = await detectAll(input, categories, opts);
    const regions = detectionsToRegions(result.detections, input.width, input.height, config);
    if (regions.length === 0) return { bytes, found: result.detections, regions, result, width, height };
    const canvas = document.createElement("canvas");
    renderBlur(canvas, bitmap, width, height, regions);
    const out = deps.outType ?? (type === "image/jpeg" || type === "image/webp" ? type : "image/png");
    const encoded = await encode(canvas, out, deps.quality ?? 0.92);
    if (!encoded) return null;
    return { bytes: encoded, found: result.detections, regions, result, width, height };
  } finally {
    bitmap.close();
  }
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (b) => {
        if (!b) resolve(null);
        else void b.arrayBuffer().then((a) => resolve(new Uint8Array(a)));
      },
      type,
      quality,
    );
  });
}

/** Width of the frames the clip scanner asks ffmpeg for. */
export const CLIP_FRAME_WIDTH = 640;

export interface ClipScanOptions {
  /** A frame at `t` seconds, `width` px wide, as JPEG or PNG bytes. */
  frameAt: (t: number, width: number) => Promise<Uint8Array>;
  media: { width: number; height: number; duration: number };
  categories: readonly AutoCategory[];
  config: AutoBlurConfig;
  runner: OnnxRunner | null;
  /** OCR is per frame and slow; off unless a text category is asked for and the caller supplies an engine. */
  ocr?: Recogniser | null;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
  /** Override the configured sample rate (frames per second). */
  fps?: number;
}

export interface ClipScanResult {
  layers: BlurLayer[];
  frames: FrameDetections[];
  notes: string[];
  msPerFrame: number;
  /** Frames ffmpeg would not give back. */
  failed: number;
}

/**
 * Detect over sampled frames and answer with one `BlurLayer` per tracked
 * object. Five monitors in a sixty-second clip → five layers, each holding
 * the whole clip when the config says so.
 */
export async function scanClipAuto(o: ClipScanOptions): Promise<ClipScanResult> {
  const times = autoSampleTimes(o.media.duration, o.fps ?? o.config.video.fps);
  let failed = 0;
  const sample = async (t: number): Promise<SampledFrame | null> => {
    try {
      const bytes = await o.frameAt(t, Math.min(CLIP_FRAME_WIDTH, o.media.width));
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
      try {
        const p = prepareInput(bitmap, bitmap.width, bitmap.height, { ocr: o.ocr ?? null });
        return { ...p, t };
      } finally {
        bitmap.close();
      }
    } catch {
      failed++;
      return null;
    }
  };
  const opts = {
    runner: o.runner,
    config: o.config,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  };
  const r = await detectVideo(sample, times, o.categories, opts);
  const layers = layersFromDetections(r.frames, o.media.duration, o.config);
  return { layers, frames: r.frames, notes: r.notes, msPerFrame: r.msPerFrame, failed };
}
