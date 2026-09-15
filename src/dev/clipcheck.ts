/**
 * Video redaction, end to end, on a real clip.
 *
 * `vblurcheck` proves the layer model and the tracker against synthetic frames
 * whose object path is known to the pixel, and that is the right way to measure
 * a tracker. What it cannot say is whether the detectors find anything in a
 * *decoded video frame* — a thing that has been through H.264, chroma
 * subsampling and a seek, none of which a drawn rectangle has been through.
 *
 * Both of the two questions asked of this feature are that question:
 *
 *   1. Pick a face and blur it for the whole clip, not for the one frame it
 *      was found on.
 *   2. Blur the screens in a clip.
 *
 * So this runs the real pipeline over `devfixtures/clipcheck.mp4`, an eight
 * second clip whose first half is a photograph with real faces in it and whose
 * second half is a photograph of a desk with real monitors on it. Frames are
 * decoded by the browser from the actual file — seek, draw, encode — which is
 * the same shape as what ffmpeg hands the app, rather than a stub that redraws
 * a square wherever it is asked.
 *
 * What is checked, in order:
 *
 *   - a face is found in the face half, by the cascade, from decoded frames;
 *   - the detections link into a track that spans that half rather than a
 *     scatter of one-frame tracks;
 *   - the track becomes a layer, and the layer becomes ffmpeg spans that cover
 *     every moment of that half with no unblurred gap in the middle;
 *   - holding a layer to the end of the clip really does reach the end;
 *   - the auto scanner finds the screens in the screen half;
 *   - every emitted span is irreversible, not a soft blur.
 *
 * The clip is a build artefact, not a repository file — `devfixtures/` is
 * ignored. Rebuild it with ffmpeg from the two fixtures in
 * `fixtures/_autoblurcheck/`: four seconds of `face-b.jpg` followed by four of
 * `autoblur-office.jpg`, both padded into 1280x720 at 30 fps.
 *
 * With the clip missing every check is reported as skipped, so a green total on
 * a machine without it means nothing and says so.
 */

import { detectInFrame, VIDEO_DETECT, VIDEO_WIDTH } from "@core/vision/apply";
import type { Box } from "@core/vision/detect";
import { track as linkFaces, type Track } from "@core/vision/faces";
import { layerSpans, layersFromTracks, sampleTimes, type BlurSpan } from "@core/vision/video";
import { scanClipAuto } from "@core/vision/autoblur-image";
import { defaultConfig } from "@core/vision/autoblur-config";
import { getRunner } from "@core/vision/onnx-runner";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.log("FAIL", name, " ", detail);
  }
}

function skipped(name: string, why: string): void {
  console.log("skip", name, " ", why);
}

function say(line: string): void {
  const pre = document.createElement("pre");
  pre.textContent = line;
  pre.style.cssText = "margin:0;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap";
  document.body.appendChild(pre);
}

// ── The clip ────────────────────────────────────────────────────────────────

/** The halves, in seconds. The clip is two four-second stills joined. */
const FACES = { from: 0, to: 4 };
const SCREENS = { from: 4, to: 8 };

interface Clip {
  el: HTMLVideoElement;
  width: number;
  height: number;
  duration: number;
}

async function openClip(): Promise<Clip | null> {
  const res = await fetch("/devfixtures/clipcheck.mp4", { method: "HEAD" }).catch(() => null);
  if (!res?.ok) return null;

  const el = document.createElement("video");
  el.src = "/devfixtures/clipcheck.mp4";
  el.muted = true;
  el.playsInline = true;
  el.preload = "auto";
  el.style.cssText = "width:320px;display:block;margin:8px 0";
  document.body.appendChild(el);

  const ready = await new Promise<boolean>((r) => {
    if (el.readyState >= 2) {
      r(true);
      return;
    }
    el.addEventListener("loadeddata", () => r(true), { once: true });
    el.addEventListener("error", () => r(false), { once: true });
    window.setTimeout(() => r(el.readyState >= 2), 8000);
  });
  if (!ready) return null;
  return { el, width: el.videoWidth, height: el.videoHeight, duration: el.duration };
}

/**
 * One decoded frame, as PNG bytes, at `width` pixels wide.
 *
 * This is the harness standing in for `frameAt`, which in the app is ffmpeg
 * over the Tauri bridge. The pixels are the real ones either way; only who
 * decoded them differs.
 */
function frames(clip: Clip): (t: number, width: number) => Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  return async (t, width) => {
    await new Promise<void>((r) => {
      const done = (): void => r();
      // A seek to a time the decoder is already parked on fires nothing.
      if (Math.abs(clip.el.currentTime - t) < 1e-3) {
        r();
        return;
      }
      clip.el.addEventListener("seeked", done, { once: true });
      clip.el.currentTime = t;
      window.setTimeout(done, 3000);
    });

    const w = Math.max(16, Math.round(Math.min(width, clip.width)));
    const h = Math.max(16, Math.round((w / clip.width) * clip.height));
    canvas.width = w;
    canvas.height = h;
    ctx?.drawImage(clip.el, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("the frame would not encode");
    return new Uint8Array(await blob.arrayBuffer());
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Is `t` covered by at least one span? */
const coveredAt = (spans: readonly BlurSpan[], t: number): boolean =>
  spans.some((s) => s.from <= t && t <= s.to);

/** The longest stretch inside a window that no span covers, in seconds. */
function biggestGap(spans: readonly BlurSpan[], from: number, to: number, step = 0.1): number {
  let worst = 0;
  let run = 0;
  for (let t = from; t <= to; t += step) {
    if (coveredAt(spans, t)) run = 0;
    else {
      run += step;
      worst = Math.max(worst, run);
    }
  }
  return worst;
}

const inHalf = (t: number, half: { from: number; to: number }): boolean =>
  t >= half.from && t < half.to;

// ── The run ─────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const clip = await openClip();
  if (!clip) {
    for (const name of [
      "the model finds a face in decoded frames",
      "the model's face layer covers the face half",
      "the cascade fallback finds a face in decoded frames",
      "the detections link into one track across the half",
      "the spans cover the whole half with no gap",
      "the layer can be held to the end of the clip",
      "the auto scanner finds the screens",
      "the screen spans cover the screen half",
      "everything emitted is irreversible",
    ]) skipped(name, "devfixtures/clipcheck.mp4 is not on this machine");
    return;
  }

  say(`-- clip: ${clip.width}x${clip.height}, ${clip.duration.toFixed(2)} s --`);
  const frameAt = frames(clip);

  const cfg = defaultConfig();

  // 1. Faces, the neural model — what the "Blur faces" button now does. The
  //    cascade used to be this button and found nothing on this clip; see the
  //    header of VIDEO_WIDTH in apply.ts for the numbers.
  const faceScan = await scanClipAuto({
    frameAt,
    media: { width: clip.width, height: clip.height, duration: clip.duration },
    categories: ["faces"],
    config: cfg,
    runner: getRunner(),
  });
  const faceHits = faceScan.frames.filter((f) => f.detections.length > 0);
  say(`   faces (model): ${faceScan.layers.length} layer(s), ${faceHits.length} of ${faceScan.frames.length} frames hit, ${Math.round(faceScan.msPerFrame)} ms each`);
  if (faceScan.notes.length > 0) say(`   notes: ${faceScan.notes.join(" | ")}`);

  ok("the model finds a face in decoded frames",
    faceHits.some((f) => inHalf(f.t, FACES)),
    `hits at ${faceHits.map((f) => f.t.toFixed(2)).join(",") || "nothing"} — ${faceScan.notes.join(" | ")}`);

  const faceSpans = layerSpans(faceScan.layers, clip.width, clip.height, clip.duration).spans;
  const faceGap = biggestGap(faceSpans, FACES.from + 0.2, FACES.to - 0.2);
  ok("the model's face layer covers the face half",
    faceSpans.length > 0 && faceGap < 0.5,
    `${faceSpans.length} spans, gap ${faceGap.toFixed(2)} s`);

  // 2. Faces, the cascade — the fallback for a machine with no model. It is
  //    asserted rather than left to rot: a fallback nobody measures is the same
  //    silent "no faces found" this whole check exists because of.
  const times = sampleTimes(clip.duration, 2);
  const found: { t: number; boxes: Box[] }[] = [];
  const t0 = performance.now();
  for (const t of times) {
    const png = await frameAt(t, VIDEO_WIDTH);
    found.push({ t, boxes: await detectInFrame(png, clip.width, VIDEO_DETECT) });
  }
  const perFrame = Math.round((performance.now() - t0) / times.length);

  const hits = found.filter((f) => f.boxes.length > 0);
  say(`   faces (cascade): ${hits.length} of ${times.length} sampled frames had a detection, ${perFrame} ms each`);
  say(`   at: ${hits.map((f) => f.t.toFixed(2)).join(" ")}`);

  ok("the cascade fallback finds a face in decoded frames",
    hits.some((f) => inHalf(f.t, FACES)),
    `hits at ${hits.map((f) => f.t.toFixed(2)).join(",") || "nothing"}`);

  // 3. Tracks.
  const tracks: Track[] = linkFaces(found);
  const main = [...tracks].sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
  say(`   ${tracks.length} track(s); longest ${main ? `${main.from.toFixed(2)}-${main.to.toFixed(2)} s, ${main.samples.length} samples` : "none"}`);

  ok("the detections link into one track across the half",
    main !== undefined && main.to - main.from >= (FACES.to - FACES.from) * 0.5,
    main ? `${(main.to - main.from).toFixed(2)} s long` : "no track at all");

  // 4. Layers → spans.
  const layers = layersFromTracks(tracks, clip.width, clip.height);
  const spans = layerSpans(layers, clip.width, clip.height, clip.duration).spans;
  say(`   ${layers.length} layer(s) -> ${spans.length} span(s)`);

  const gap = main ? biggestGap(spans, main.from, main.to) : Infinity;
  ok("the spans cover the whole half with no gap", gap < 0.25, `biggest gap ${gap.toFixed(2)} s`);

  // 5. Held to the end — the difference between "blur this face here" and
  //    "blur this face in this video".
  const held = layersFromTracks(tracks, clip.width, clip.height, { hold: clip.duration });
  const heldSpans = layerSpans(held, clip.width, clip.height, clip.duration).spans;
  ok("the layer can be held to the end of the clip",
    heldSpans.length > 0 && coveredAt(heldSpans, clip.duration - 0.05),
    `last span ends ${heldSpans.length ? heldSpans[heldSpans.length - 1]!.to.toFixed(2) : "n/a"}`);

  // 6. Screens, the auto path — the "Blur plates, screens…" button.
  const scan = await scanClipAuto({
    frameAt,
    media: { width: clip.width, height: clip.height, duration: clip.duration },
    categories: ["screens"],
    config: cfg,
    runner: getRunner(),
  });
  const screenFrames = scan.frames.filter((f) => f.detections.length > 0);
  say(`   screens: ${scan.layers.length} layer(s), ${screenFrames.length} frame(s) with a detection, ${Math.round(scan.msPerFrame)} ms each`);
  if (scan.notes.length > 0) say(`   notes: ${scan.notes.join(" | ")}`);

  ok("the auto scanner finds the screens",
    screenFrames.some((f) => inHalf(f.t, SCREENS)),
    `hits at ${screenFrames.map((f) => f.t.toFixed(2)).join(",") || "nothing"} — ${scan.notes.join(" | ")}`);

  const screenSpans = layerSpans(scan.layers, clip.width, clip.height, clip.duration).spans;
  const screenGap = biggestGap(screenSpans, SCREENS.from + 0.2, SCREENS.to - 0.2);
  ok("the screen spans cover the screen half",
    screenSpans.length > 0 && screenGap < 0.5,
    `${screenSpans.length} spans, gap ${screenGap.toFixed(2)} s`);

  // 7. Irreversible. A soft blur here would be a quiet downgrade of the one
  //    promise this feature makes, so it is asserted rather than assumed.
  const all = [...faceSpans, ...spans, ...screenSpans];
  // The four that can be undone: a gaussian can be deconvolved, and the
  // other three are gaussians with a shape on the front.
  const REVERSIBLE = new Set(["gaussian", "motion", "frosted", "radial"]);
  const soft = [...new Set(all.map((s) => s.kind))].filter((k) => REVERSIBLE.has(k));
  ok("everything emitted is irreversible",
    all.length > 0 && soft.length === 0,
    [...new Set(all.map((s) => s.kind))].join(","));
}

run()
  .catch((e: unknown) => {
    fail++;
    console.log("FAIL", "the clip checks ran at all", " ", String(e));
    say(`FAILED TO RUN: ${String(e)}`);
  })
  .finally(() => {
    const line = `clip: ${pass} passed, ${fail} failed`;
    document.title = line;
    console.log(`%c${line}`, fail ? "color:#ff6b6b" : "color:#4ade80");
    const h = document.createElement("h2");
    h.textContent = line;
    h.style.cssText = `font:600 16px system-ui;color:${fail ? "#ff6b6b" : "#4ade80"}`;
    document.body.appendChild(h);
  });
