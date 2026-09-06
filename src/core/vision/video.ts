/**
 * Faces in a video, turned into something ffmpeg can burn in (item 19).
 *
 * The gap this closes: `track()` produces a face's position at every sampled
 * instant, and ffmpeg's `overlay` takes a *static* rectangle gated by a time
 * range. Something has to decide where to cut a moving face's path into
 * stationary boxes, and how big each one has to be to still cover the face for
 * the whole time it is shown. That decision is here, and it is pure, because
 * "would this box really have covered her at 00:41?" is a question worth being
 * able to answer in a test rather than by watching an export.
 *
 * Every heuristic errs towards covering more. A blur that is slightly too big
 * for a moment is invisible; a blur that is slightly too small for a moment is
 * the frame that gets screenshotted.
 */

import { newLayer, rectAt, type BlurKeyframe, type BlurKind, type BlurLayer, type Rect } from "@core/edit/blur";
import type { Box } from "./detect";
import { FACE_DEFAULTS, unionAt, type Track } from "./faces";

/** One static rectangle, blurred for one stretch of the source's own timeline. */
export interface BlurSpan {
  /** Source pixels, integers — ffmpeg's crop and overlay take no fractions. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Seconds into the source. Not into the export: see the note in `ffmpeg.rs`. */
  from: number;
  to: number;
  kind: BlurKind;
  /** Strength as a fraction of the frame's short edge, as everywhere else. */
  amount: number;
}

export interface SpanOptions {
  /**
   * How long one static box may cover, in seconds.
   *
   * The tension is exact: short windows track a moving face tightly and produce
   * hundreds of overlay filters that ffmpeg has to evaluate per frame; long
   * ones produce a handful of boxes each big enough to cover everywhere the
   * person went, which over four seconds of walking is most of the frame.
   * 0.8 keeps a walking subject's box to roughly their own width.
   */
  step: number;
  /**
   * Seconds of blur before a track's first detection and after its last.
   *
   * A face is recognisable a moment before the detector is sure of it, and the
   * frames on either side of a track are exactly the ones where it was turning
   * towards or away from the camera — which is to say, the ones where it was
   * half-visible and the detector hesitated.
   */
  hold: number;
  /** Grown by this fraction of the box's width, as for stills. */
  pad: number;
  /** Extra downward growth, for the chin the cascade clips. */
  chin: number;
  kind: BlurKind;
  amount: number;
  /**
   * Hard ceiling on emitted spans.
   *
   * Each one is a crop and an overlay in the filter graph, and a graph with two
   * thousand overlays takes longer to parse than the encode takes to run. Over
   * the cap, tracks are collapsed to one box each rather than the export
   * silently taking an hour.
   */
  max: number;
}

export const SPAN_DEFAULTS: SpanOptions = {
  step: 0.8,
  hold: 0.4,
  pad: FACE_DEFAULTS.pad,
  chin: FACE_DEFAULTS.chin,
  kind: FACE_DEFAULTS.kind,
  amount: FACE_DEFAULTS.amount,
  max: 400,
};

export interface SpanResult {
  spans: BlurSpan[];
  /**
   * True when the cap forced one box per track instead of a moving one. The UI
   * says so, because the difference is visible in the export and a user who is
   * not told will read it as a bug.
   */
  coarsened: boolean;
}

/**
 * Cut tracks into static, time-gated boxes.
 *
 * `duration` clamps the hold at either end of the file, and `width`/`height`
 * clamp the padded boxes — an overlay hanging off the frame is not an error in
 * ffmpeg, it is a silently shifted rectangle, which is worse.
 */
export function spansFor(
  tracks: readonly Track[],
  width: number,
  height: number,
  duration: number,
  opts: Partial<SpanOptions> = {},
): SpanResult {
  const o = { ...SPAN_DEFAULTS, ...opts };
  if (width <= 0 || height <= 0 || tracks.length === 0) {
    return { spans: [], coarsened: false };
  }

  const fine = cut(tracks, width, height, duration, o, o.step);
  if (fine.length <= o.max) return { spans: fine, coarsened: false };

  // One box per track, covering everywhere that face went for as long as it was
  // there. Blunt, and honest about being blunt.
  const whole = cut(tracks, width, height, duration, o, Infinity);
  return { spans: whole, coarsened: true };
}

function cut(
  tracks: readonly Track[],
  width: number,
  height: number,
  duration: number,
  o: SpanOptions,
  step: number,
): BlurSpan[] {
  const out: BlurSpan[] = [];
  const end = duration > 0 ? duration : Infinity;

  for (const t of tracks) {
    const length = Math.max(t.to - t.from, 0);
    const windows = Number.isFinite(step) ? Math.max(1, Math.ceil(length / step)) : 1;
    const size = windows > 0 ? length / windows : length;

    for (let i = 0; i < windows; i++) {
      // The last window's end is the track's end exactly, so floating-point
      // drift over forty windows cannot leave the final samples unclaimed.
      const w0 = t.from + size * i;
      const w1 = i === windows - 1 ? t.to : t.from + size * (i + 1);
      const box = unionAt(t, w0, w1);
      if (!box) continue;

      const grown = grow(box, width, height, o);
      if (grown.w < 2 || grown.h < 2) continue;

      const from = Math.max(0, (i === 0 ? w0 - o.hold : w0));
      const to = Math.min(end, i === windows - 1 ? w1 + o.hold : w1);
      // A window whose padded end lands before its start is not a span; it is a
      // track with one sample and a zero-length interval, which the hold above
      // has already widened if it can be widened at all.
      if (to <= from) continue;

      const prev = out[out.length - 1];
      // Consecutive windows of the same track that came out identical are one
      // span. A stationary face over eight seconds should not cost ten overlays.
      if (prev && same(prev, grown) && Math.abs(prev.to - from) < 1e-6) {
        prev.to = to;
        continue;
      }
      out.push({ ...grown, from, to, kind: o.kind, amount: o.amount });
    }
  }
  return out;
}

/** The still-image padding rule, in pixels, clamped to the frame and rounded out. */
function grow(
  b: Box,
  width: number,
  height: number,
  o: SpanOptions,
): { x: number; y: number; w: number; h: number } {
  const pad = b.w * o.pad;
  const chin = b.w * o.chin;
  const x0 = Math.max(0, Math.floor(b.x - pad));
  const y0 = Math.max(0, Math.floor(b.y - pad));
  const x1 = Math.min(width, Math.ceil(b.x + b.w + pad));
  const y1 = Math.min(height, Math.ceil(b.y + b.h + pad + chin));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

function same(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * When to sample the source for detection.
 *
 * Not every frame: decoding and detecting 25 fps of 1080p is minutes of work
 * for a result that changes very little between neighbouring frames. Twice a
 * second is enough for `track()` to link a walking person, and `gap` in
 * TRACK_DEFAULTS is a full second precisely so a couple of missed samples do
 * not split a track.
 *
 * Capped by count as well as by rate, because half-hourly footage at 2 Hz is
 * three and a half thousand ffmpeg frame extractions and nobody is waiting
 * that long. Over the cap the rate drops instead, and the caller says so.
 */
export function sampleTimes(duration: number, rate = 2, max = 240): number[] {
  if (!(duration > 0)) return [];
  const wanted = Math.max(1, Math.round(duration * rate));
  const n = Math.min(wanted, max);
  const step = duration / n;
  // Half-step offsets: sampling at exactly 0 catches a black lead-in frame in
  // a surprising number of files.
  return Array.from({ length: n }, (_, i) => step * (i + 0.5));
}

// ── Layers → spans ───────────────────────────────────────────────────────────
//
// The manual workspace and the trackers speak in `BlurLayer`s: a look, a time
// range, and a box that moves between keyframes. ffmpeg still speaks in
// static, time-gated rectangles. The cut below is the same shape as the one
// for face tracks: windows of `step` seconds, each covered by the union of
// the box at the window's ends and at every keyframe inside it, identical
// consecutive windows merged. A layer that never moves is one span however
// long it runs, so a minute of three still layers is three overlays, not
// three hundred.

export interface LayerSpanOptions {
  /** Window length for a moving layer, seconds. */
  step: number;
  /**
   * Grown by this fraction of the box's *short edge* on every side. Manual
   * boxes are drawn to fit, so the pad is small; it is there for the
   * interpolation between keyframes cutting a corner the object did not.
   */
  pad: number;
  /** Hard cap on emitted spans across all layers; over it, layers coarsen. */
  max: number;
}

export const LAYER_SPAN_DEFAULTS: LayerSpanOptions = {
  step: 0.5,
  pad: 0.06,
  max: 400,
};

/**
 * Static spans for a set of layers over a clip `width`×`height` px and
 * `duration` s long. Layers that are disabled are skipped; `wholeClip` ones
 * cover [0, duration]. Ellipses, brushes and polygons are exported as their
 * bounding box (the preview shows that box dashed so nobody is surprised).
 */
export function layerSpans(
  layers: readonly BlurLayer[],
  width: number,
  height: number,
  duration: number,
  opts: Partial<LayerSpanOptions> = {},
): SpanResult {
  const o = { ...LAYER_SPAN_DEFAULTS, ...opts };
  if (width <= 0 || height <= 0 || layers.length === 0) return { spans: [], coarsened: false };
  const fine = cutLayers(layers, width, height, duration, o, o.step);
  if (fine.length <= o.max) return { spans: fine, coarsened: false };
  return { spans: cutLayers(layers, width, height, duration, o, Infinity), coarsened: true };
}

function cutLayers(
  layers: readonly BlurLayer[],
  width: number,
  height: number,
  duration: number,
  o: LayerSpanOptions,
  step: number,
): BlurSpan[] {
  const out: BlurSpan[] = [];
  const end = duration > 0 ? duration : Infinity;
  for (const l of layers) {
    if (!l.enabled) continue;
    const from = l.wholeClip ? 0 : Math.max(0, l.from);
    const to = l.wholeClip ? end : Math.min(end, l.to);
    if (to < from) continue;
    const kind = l.region.kind;
    const amount = l.region.amount;
    const still = l.keys.length <= 1 || l.keys.every((k) => sameRect(k.rect, l.keys[0]!.rect));
    const length = Number.isFinite(to) ? Math.max(0, to - from) : 0;
    const windows = still || !Number.isFinite(step) || length === 0
      ? 1
      : Math.max(1, Math.ceil(length / step));
    const size = length / windows;
    const start = out.length;
    for (let i = 0; i < windows; i++) {
      const w0 = from + size * i;
      const w1 = i === windows - 1 ? to : from + size * (i + 1);
      const box = pxBox(unionOver(l, w0, w1), width, height, o.pad);
      if (box.w < 2 || box.h < 2) continue;
      // The end is exclusive-ish in ffmpeg's between(); a hair of slack keeps
      // the last frame of a window covered by one span or the next.
      const spanTo = Number.isFinite(w1) ? w1 : Math.max(w0 + 1, 1e6);
      const prev = out[out.length - 1];
      if (prev && out.length > start && same(prev, box) && Math.abs(prev.to - w0) < 1e-6) {
        prev.to = spanTo;
        continue;
      }
      // A zero-length layer (drawn but never extended) still covers its one instant.
      out.push({ ...box, from: w0, to: Math.max(spanTo, w0 + 0.04), kind, amount });
    }
  }
  return out;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Union of the layer's box at `w0`, `w1`, and every keyframe between. */
function unionOver(l: BlurLayer, w0: number, w1: number): Rect {
  const rects: Rect[] = [rectAt(l, w0)];
  if (Number.isFinite(w1)) rects.push(rectAt(l, w1));
  for (const k of l.keys) if (k.t > w0 && k.t < w1) rects.push(k.rect);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Normalised rect → padded, clamped, rounded-out source pixels. */
function pxBox(r: Rect, width: number, height: number, pad: number): { x: number; y: number; w: number; h: number } {
  const px = r.x * width;
  const py = r.y * height;
  const pw = r.w * width;
  const ph = r.h * height;
  const p = Math.min(pw, ph) * pad;
  const x0 = Math.max(0, Math.floor(px - p));
  const y0 = Math.max(0, Math.floor(py - p));
  const x1 = Math.min(width, Math.ceil(px + pw + p));
  const y1 = Math.min(height, Math.ceil(py + ph + p));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Face tracks as layers, so a found face is edited like a drawn box: it can
 * be extended, re-shaped, or deleted, and its keyframes carry the detector's
 * samples (grown by the still-image face padding, in normalised units).
 */
export function layersFromTracks(
  tracks: readonly Track[],
  width: number,
  height: number,
  opts: Partial<SpanOptions> = {},
): BlurLayer[] {
  const o = { ...SPAN_DEFAULTS, ...opts };
  const out: BlurLayer[] = [];
  let n = 0;
  for (const t of tracks) {
    if (t.samples.length === 0) continue;
    n++;
    const keys: BlurKeyframe[] = t.samples.map((s) => {
      const g = grow(s.box, width, height, o);
      return {
        t: s.t,
        rect: { x: g.x / width, y: g.y / height, w: g.w / width, h: g.h / height },
        origin: "detect" as const,
      };
    });
    const first = keys[0]!;
    const layer = newLayer("ellipse", Math.max(0, t.from - o.hold), t.to + o.hold, first.rect, {
      name: `face ${n}`,
      source: "face",
      region: { kind: o.kind, amount: o.amount, feather: FACE_DEFAULTS.feather },
    });
    layer.keys = keys;
    out.push(layer);
  }
  return out;
}
