/**
 * Detection, applied (item 19).
 *
 * `detect.ts` is numbers-in-boxes-out and `faces.ts` is boxes-in-regions-out;
 * both are pure and both are useless on their own, because the thing that
 * actually has the pixels is a canvas. This is the one file allowed to touch
 * one, and everything that wants "blur the faces in this" — the viewer button,
 * the batch runner, the watch rule — goes through here rather than growing its
 * own copy of decode-detect-render.
 *
 * The rule the whole feature is built on, restated because it is easy to lose:
 * a detection becomes a **normal, editable region**. Nothing here bakes a blur
 * into pixels that the user cannot then move, resize, retune or delete. The
 * batch path is the one exception and it writes a copy, never the original.
 */

import { regionAt, renderBlur, type BlurRegion } from "@core/edit/blur";
import { DEFAULTS, detectFaces, toGray, type Box, type DetectOptions, type Gray } from "./detect";
import { facesToRegions, overlap, type FaceRegionOptions } from "./faces";

/**
 * Pull greyscale out of anything drawable.
 *
 * `willReadFrequently` because `getImageData` on a GPU-backed canvas costs a
 * readback stall, and the batch runner does this once per file in a loop of
 * forty. The canvas is local and thrown away — sharing one with `renderBlur`'s
 * scratch pool would mean a detection quietly corrupting a preview mid-draw.
 */
export function grayOf(src: CanvasImageSource, width: number, height: number): Gray {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2d context");
  g.drawImage(src, 0, 0, width, height);
  return toGray(g.getImageData(0, 0, width, height).data, width, height);
}

/** Faces in a drawable, in its own pixel coordinates. */
export function detectIn(
  src: CanvasImageSource,
  width: number,
  height: number,
  opts: Partial<DetectOptions> = {},
): Box[] {
  if (width <= 0 || height <= 0) return [];
  return detectFaces(grayOf(src, width, height), opts);
}

/**
 * How much of a detection has to already be under an existing region before it
 * counts as covered.
 *
 * Low on purpose. The failure this prevents is a second ellipse stacked on a
 * face the user has already dealt with by hand, which is confusing and doubles
 * the blur; the failure it risks is skipping a face that merely stands near a
 * blurred sign. At 0.2 a detection has to be substantially inside an existing
 * region to be skipped, and the user can always press the button again after
 * deleting whatever swallowed it.
 */
const COVERED = 0.2;

/** An existing region's bounding box in pixels, for overlap tests. */
function boxOf(r: BlurRegion, width: number, height: number): Box {
  return {
    x: r.rect.x * width,
    y: r.rect.y * height,
    w: r.rect.w * width,
    h: r.rect.h * height,
    score: 0,
  };
}

/**
 * Turn detections into regions to *add* to a list that may already have some.
 *
 * Two things are dropped: a face already covered by an enabled region, and a
 * face whose centre sits inside one. The second catches the `full` region and
 * brush strokes, whose bounding boxes overlap everything or nothing and whose
 * overlap number therefore says very little.
 *
 * Ids are made unique against the existing list, because the region list is
 * keyed by id for selection, undo and the layer panel, and a duplicate id
 * makes the second one unselectable.
 */
export function newFaceRegions(
  existing: readonly BlurRegion[],
  boxes: Box[],
  width: number,
  height: number,
  opts: Partial<FaceRegionOptions> = {},
): BlurRegion[] {
  const live = existing.filter((r) => r.enabled);
  const fresh = boxes.filter((b) => {
    const centre = { x: (b.x + b.w / 2) / width, y: (b.y + b.h / 2) / height };
    if (regionAt(live, centre)) return false;
    return !live.some((r) => overlap(boxOf(r, width, height), b) > COVERED);
  });

  const taken = new Set(existing.map((r) => r.id));
  let n = existing.filter((r) => r.id.startsWith("face-")).length;
  return facesToRegions(fresh, width, height, opts, () => {
    let id = `face-${++n}`;
    while (taken.has(id)) id = `face-${++n}`;
    taken.add(id);
    return id;
  });
}

/** What a headless run of the whole thing produced. */
export interface BlurredImage {
  bytes: Uint8Array;
  /** Faces found. Zero means the file was read and looked at and had none. */
  faces: number;
  width: number;
  height: number;
}

export interface BlurImageOptions {
  detect: Partial<DetectOptions>;
  face: Partial<FaceRegionOptions>;
  /** Output MIME. Defaults to the input's own type, PNG if unknown. */
  type: string;
  /** JPEG/WebP quality, 0..1. Ignored for PNG. */
  quality: number;
}

/**
 * Decode → detect → blur → encode, with no UI anywhere near it.
 *
 * Used by the batch runner and therefore by watch folders, which is the
 * unattended path: nobody is looking at the result before it is written. It
 * returns the face count so the caller can say "no faces found" in a row
 * instead of writing an identical copy and calling it a success — that
 * distinction is the difference between a queue you can trust and one whose
 * green rows mean nothing.
 */
export async function blurFacesInImage(
  bytes: Uint8Array,
  type: string,
  opts: Partial<BlurImageOptions> = {},
): Promise<BlurredImage | null> {
  const blob = new Blob([bytes as BlobPart], type ? { type } : {});
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const boxes = detectIn(bitmap, width, height, opts.detect ?? {});
    if (boxes.length === 0) return { bytes, faces: 0, width, height };

    const regions = facesToRegions(boxes, width, height, opts.face ?? {});
    const canvas = document.createElement("canvas");
    renderBlur(canvas, bitmap, width, height, regions);

    // PNG for anything that is not already a lossy photo. Re-encoding a JPEG
    // as a JPEG loses a generation, but writing a 40 MB PNG beside a 4 MB
    // photo is worse, and the alternative — surgical re-encode of only the
    // blurred macroblocks — is a different project.
    const out = opts.type ?? (type === "image/jpeg" || type === "image/webp" ? type : "image/png");
    const encoded = await encode(canvas, out, opts.quality ?? 0.92);
    if (!encoded) return null;
    return { bytes: encoded, faces: boxes.length, width, height };
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

/** Sensible detector settings for a still photo, exported so the UI can say so. */
export const PHOTO_DETECT: Partial<DetectOptions> = {
  ...DEFAULTS,
  // A group shot at 12 MP puts a face at maybe 200 px, but a crowd at the back
  // of a hall is 40. The floor stays low and `minNeighbours` does the filtering,
  // because a missed face is a privacy failure and a false one is a click.
  minSize: 24,
};

/**
 * The width video frames are pulled and detected at.
 *
 * A minute of video is a hundred-odd detections, so the per-frame cost matters
 * in a way it does not for one photo. 640 px is enough to find a face that is
 * a twentieth of the frame wide, and the boxes are scaled back to source pixels
 * by the caller, so nothing downstream knows this happened.
 */
export const VIDEO_WIDTH = 640;

/** Detector settings for one sampled video frame. */
export const VIDEO_DETECT: Partial<DetectOptions> = {
  ...DEFAULTS,
  // Proportionally the same floor as PHOTO_DETECT, at a sixteenth the pixels.
  minSize: 20,
  // Already downscaled by the frame extractor; no point paying for it twice.
  workingSize: VIDEO_WIDTH,
};

/**
 * Detect in one encoded frame and hand back boxes in *source* pixels.
 *
 * `sourceWidth` is the video's real width, which is very rarely the width the
 * frame came back at. Returning detector-resolution boxes would mean every
 * caller remembering to scale them, and the failure mode of forgetting is a
 * blur in the top-left corner over nobody's face.
 */
export async function detectInFrame(
  png: Uint8Array,
  sourceWidth: number,
  opts: Partial<DetectOptions> = VIDEO_DETECT,
): Promise<Box[]> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  try {
    const boxes = detectIn(bitmap, bitmap.width, bitmap.height, opts);
    const k = bitmap.width > 0 ? sourceWidth / bitmap.width : 1;
    if (k === 1) return boxes;
    return boxes.map((b) => ({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k, score: b.score }));
  } finally {
    bitmap.close();
  }
}
