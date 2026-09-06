/**
 * Auto-blur over a clip: sample frames, detect on each, link the detections
 * into tracks, emit one `BlurLayer` per object.
 *
 * Five monitors in a sixty-second clip come out as five layers whose
 * keyframes are the detector's samples; the layer's box between samples is
 * the interpolation `rectAt` already does, and with `wholeClip` on the layer
 * is held at its first/last known box for the rest of the clip — which is
 * what "blur all of them throughout the video" means for a monitor that is
 * still there when the detector happens to miss a frame.
 *
 * The frame supplier is a callback so this works over anything: the video
 * workspace's ffmpeg sampler, a `<video>` element seeked in the harness, or
 * a synthetic sequence in the tests.
 */

import { newLayer, type BlurLayer } from "@core/edit/blur";
import { detectAll, type DetectInput, type DetectOptions, type Detection } from "./autoblur";
import { AUTO_CATEGORIES, type AutoBlurConfig, type AutoCategory } from "./autoblur-config";
import { track } from "./faces";
import { padDet, type Det } from "./onnx";

/** One sampled frame. `width`/`height` are the frame's own pixels; `scale` maps them to the source. */
export interface SampledFrame extends DetectInput {
  t: number;
}

export interface FrameDetections {
  t: number;
  width: number;
  height: number;
  detections: Detection[];
}

export interface VideoDetectOptions extends DetectOptions {
  /** Return false to stop early (keeps what was found so far). */
  onFrame?: (i: number, total: number, found: FrameDetections) => boolean | void;
}

/** Sample times for a clip at the configured rate, capped. */
export function autoSampleTimes(duration: number, fps: number, max = 240): number[] {
  const rate = Math.min(4, Math.max(0.5, fps));
  const step = 1 / rate;
  const n = Math.max(1, Math.min(max, Math.floor(duration / step) + 1));
  const s = n > 1 ? duration / (n - 1) : 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.min(duration, i * s));
  return out;
}

/** Detect on every sampled frame. Cancelled via `opts.signal` or `onFrame` returning false. */
export async function detectVideo(
  sample: (t: number) => Promise<SampledFrame | null>,
  times: readonly number[],
  categories: readonly AutoCategory[],
  opts: VideoDetectOptions,
): Promise<{ frames: FrameDetections[]; notes: string[]; msPerFrame: number }> {
  const frames: FrameDetections[] = [];
  const notes = new Set<string>();
  let ms = 0;
  for (let i = 0; i < times.length; i++) {
    if (opts.signal?.aborted) break;
    const t = times[i]!;
    const f = await sample(t);
    if (!f) continue;
    const t0 = performance.now();
    const { onProgress: _p, onFrame: _f, ...rest } = opts;
    const r = await detectAll(f, categories, rest);
    ms += performance.now() - t0;
    for (const n of r.notes) notes.add(n);
    const found = { t, width: f.width, height: f.height, detections: r.detections };
    frames.push(found);
    opts.onProgress?.((i + 1) / times.length, `Frame ${i + 1} of ${times.length}`);
    if (opts.onFrame?.(i, times.length, found) === false) break;
  }
  return { frames, notes: [...notes], msPerFrame: frames.length ? ms / frames.length : 0 };
}

export interface LayerOptions {
  /** Overlap needed to link a detection to a track (IoU). */
  join: number;
  /** Seconds a track survives without a detection. */
  gap: number;
  /** Seconds added before the first and after the last sample. */
  hold: number;
  /** Tracks with fewer samples than this are noise. */
  minSamples: number;
}

export const LAYER_DEFAULTS: LayerOptions = { join: 0.25, gap: 1.5, hold: 0.4, minSamples: 1 };

/** Group detections by category + label so a "phone" never joins a "screen" track. */
function keyOf(d: Detection): string {
  return `${d.category}/${d.label}`;
}

/**
 * Tracks → layers. Frames may be at a different scale from the source; the
 * layer's keyframes are normalised so it does not matter. Layer names are
 * "plate", "screen 1", "screen 2"… and `source` is "auto" (faces keep "face").
 */
export function layersFromDetections(
  frames: readonly FrameDetections[],
  duration: number,
  config: AutoBlurConfig,
  opts: Partial<LayerOptions> = {},
): BlurLayer[] {
  const o = { ...LAYER_DEFAULTS, ...opts };
  const out: BlurLayer[] = [];
  // Every frame's boxes are normalised to 0..1 first so tracking is scale-free.
  const keys = new Set<string>();
  for (const f of frames) for (const d of f.detections) keys.add(keyOf(d));
  const ordered = [...keys].sort((a, b) => {
    const ca = AUTO_CATEGORIES.indexOf(a.split("/")[0] as AutoCategory);
    const cb = AUTO_CATEGORIES.indexOf(b.split("/")[0] as AutoCategory);
    return ca - cb || a.localeCompare(b);
  });
  for (const key of ordered) {
    const [category, label] = key.split("/") as [AutoCategory, string];
    const cc = config.categories[category];
    const series = frames.map((f) => ({
      t: f.t,
      boxes: f.detections
        .filter((d) => keyOf(d) === key)
        .map((d) => {
          const p = padDet(d.box, cc.pad, f.width, f.height);
          return { x: p.x / f.width, y: p.y / f.height, w: p.w / f.width, h: p.h / f.height, score: d.box.score };
        }),
    }));
    const tracks = track(series, { join: o.join, gap: o.gap }).filter((t) => t.samples.length >= o.minSamples);
    let n = 0;
    for (const tr of tracks) {
      n++;
      const first = tr.samples[0]!;
      const rect = { x: first.box.x, y: first.box.y, w: first.box.w, h: first.box.h };
      const layer = newLayer(category === "faces" ? "ellipse" : "rect", Math.max(0, tr.from - o.hold), Math.min(duration, tr.to + o.hold), rect, {
        name: tracks.length > 1 ? `${label} ${n}` : label,
        source: category === "faces" ? "face" : "auto",
        region: { kind: cc.kind, amount: cc.amount, feather: category === "faces" ? 0.02 : 0.005 },
      });
      layer.keys = tr.samples.map((s) => ({
        t: s.t,
        rect: { x: s.box.x, y: s.box.y, w: s.box.w, h: s.box.h },
        origin: "detect" as const,
      }));
      layer.wholeClip = config.video.wholeClip;
      out.push(layer);
    }
  }
  return out;
}

/** The union of a list of boxes, for callers that want one still box per track. */
export function unionBox(boxes: readonly Det[]): Det | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: Math.max(...boxes.map((b) => b.score)), cls: 0 };
}
