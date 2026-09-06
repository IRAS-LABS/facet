/**
 * From "there is a face here" to "this is blurred".
 *
 * The detector returns boxes; the blur engine wants normalised regions. This
 * is the seam, and it is deliberately its own file because the two questions
 * it answers are product questions, not vision ones: *how much* of the head
 * counts as the face, and *what should the blur look like by default*.
 *
 * Pure. No canvas, no DOM — geometry in, regions out.
 */

import { newRegion, type BlurRegion, type BlurKind } from "@core/edit/blur";
import type { Box } from "./detect";

export interface FaceRegionOptions {
  /**
   * How far the box is grown, as a fraction of its own width.
   *
   * The cascade was trained on a tight crop: eyebrows to chin, ear to ear. A
   * blur drawn on exactly that box leaves the forehead, hair, jaw and ears
   * sharp, which is not anonymity — hairline and jaw are most of what makes a
   * face recognisable at a glance. 0.35 covers the head without eating the
   * shoulders.
   */
  pad: number;
  /**
   * Extra downward growth, again as a fraction of width. Faces are taller than
   * the detector's square window and the part it clips is the chin, so the
   * bottom needs more room than the top.
   */
  chin: number;
  kind: BlurKind;
  /** Blur strength, as a fraction of the image's short edge. */
  amount: number;
  /**
   * Soft edge. A hard-edged blur over a face reads as a sticker and shows
   * exactly where the detector thought the boundary was; a feathered one reads
   * as part of the picture.
   */
  feather: number;
}

export const FACE_DEFAULTS: FaceRegionOptions = {
  pad: 0.35,
  chin: 0.15,
  kind: "gaussian",
  amount: 0.05,
  feather: 0.02,
};

/**
 * Turn detections into blur regions over an image of the given size.
 *
 * Ellipses, not rectangles: a rectangle over a face is unmistakably a machine's
 * idea of a face, and its corners blur background that did not need it. The
 * ellipse is inscribed in the same box, so the same handles still drive it if
 * the user drags one afterwards.
 *
 * Every region is a normal, fully editable region — same list, same undo, same
 * layer panel. Detection is a *shortcut for drawing*, not a separate mode.
 * That matters because the detector will sometimes be wrong, and a wrong result
 * you can drag or delete is a minor annoyance where a wrong result baked into
 * the pixels is a ruined photo.
 */
export function facesToRegions(
  boxes: Box[],
  width: number,
  height: number,
  opts: Partial<FaceRegionOptions> = {},
  idFor: (i: number) => string = (i) => `face-${i + 1}`,
): BlurRegion[] {
  const o = { ...FACE_DEFAULTS, ...opts };
  if (width <= 0 || height <= 0) return [];

  return boxes.map((b, i) => {
    const grow = b.w * o.pad;
    const drop = b.w * o.chin;
    // Clamped to the frame: a region hanging off the edge is legal but makes
    // the handles unreachable, and half of a face at the edge of the picture
    // is exactly the case where the user most wants to grab it.
    const x0 = Math.max(0, b.x - grow);
    const y0 = Math.max(0, b.y - grow);
    const x1 = Math.min(width, b.x + b.w + grow);
    const y1 = Math.min(height, b.y + b.h + grow + drop);

    const region = newRegion("ellipse", idFor(i));
    region.label = boxes.length === 1 ? "face" : `face ${i + 1}`;
    region.kind = o.kind;
    region.amount = o.amount;
    region.feather = o.feather;
    region.rect = {
      x: x0 / width,
      y: y0 / height,
      w: (x1 - x0) / width,
      h: (y1 - y0) / height,
    };
    return region;
  });
}

/**
 * How much two boxes overlap, 0..1. Used to decide whether a detection on this
 * frame is the same face as one on the last, and to keep the editor from
 * stacking a second blur on a face the user has already covered by hand.
 */
export function overlap(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** A face followed across sampled video frames. Times are seconds. */
export interface Track {
  id: string;
  from: number;
  to: number;
  /** One box per sample, in source pixels, in time order. */
  samples: { t: number; box: Box }[];
}

export interface TrackOptions {
  /**
   * Overlap needed before a detection continues an existing track rather than
   * starting a new one. Generous, because between two samples half a second
   * apart a walking person moves most of their own width.
   */
  join: number;
  /**
   * How long a track survives with no detection before it is closed, in
   * seconds. Without this, one blink of a missed detection splits a person
   * into two tracks and the blur flickers off between them — which is worse
   * than useless, because the one unblurred frame is the one that gets
   * screenshotted.
   */
  gap: number;
}

export const TRACK_DEFAULTS: TrackOptions = { join: 0.25, gap: 1.0 };

/**
 * Link per-frame detections into tracks.
 *
 * Greedy nearest-overlap association. Not a Kalman filter and not trying to be:
 * the output is a blur, so being approximately right and never dropping out
 * beats being precisely right and occasionally missing. Every heuristic here
 * errs towards *covering more*.
 *
 * `frames` must be in time order.
 */
export function track(
  frames: { t: number; boxes: Box[] }[],
  opts: Partial<TrackOptions> = {},
): Track[] {
  const o = { ...TRACK_DEFAULTS, ...opts };
  const open: Track[] = [];
  const done: Track[] = [];
  let next = 0;

  for (const frame of frames) {
    for (let i = open.length - 1; i >= 0; i--) {
      if (frame.t - open[i]!.to > o.gap) done.push(...open.splice(i, 1));
    }

    const taken = new Set<Track>();
    for (const box of frame.boxes) {
      let best = null as Track | null;
      let bestScore = o.join;
      for (const t of open) {
        if (taken.has(t)) continue;
        const score = overlap(t.samples[t.samples.length - 1]!.box, box);
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
      if (best) {
        best.samples.push({ t: frame.t, box });
        best.to = frame.t;
        taken.add(best);
      } else {
        const fresh: Track = {
          id: `track-${++next}`,
          from: frame.t,
          to: frame.t,
          samples: [{ t: frame.t, box }],
        };
        open.push(fresh);
        taken.add(fresh);
      }
    }
  }

  done.push(...open);
  return done.sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
}

/**
 * The box to blur for a track over one interval, as the union of the samples
 * it covers.
 *
 * A union rather than an interpolation because the blur is burned in over a
 * span of time by a single filter: within that span the box does not move, so
 * it must be big enough for everywhere the face went. Interpolating would be
 * tighter and would leave the face outside the box for part of every span.
 */
export function unionAt(t: Track, from: number, to: number): Box | null {
  const inside = t.samples.filter((s) => s.t >= from && s.t <= to);
  if (inside.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let score = 0;
  for (const s of inside) {
    x0 = Math.min(x0, s.box.x);
    y0 = Math.min(y0, s.box.y);
    x1 = Math.max(x1, s.box.x + s.box.w);
    y1 = Math.max(y1, s.box.y + s.box.h);
    score = Math.max(score, s.box.score);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, score };
}
