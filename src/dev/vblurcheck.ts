/**
 * Video blur harness: the layer model, the tracker, the layers-to-spans cut,
 * and the workspace itself driven through the DOM.
 *
 * The tracker is checked against synthetic frames whose object path is known
 * to the pixel, so "how far off was it" is a number and not an opinion. The
 * workspace is checked with a real 6-second clip of a red square crossing a
 * grey field (`devfixtures/vblurcheck.mp4`), and a `frameAt` stub that draws
 * the same square at the same place for any time asked — so Follow in the UI
 * pulls frames the way the app does and its keyframes can be compared with
 * where the square really was.
 */

import "../styles/base.css";
import "../styles/vedit.css";
import { themes } from "@core/theme/theme-engine";
import {
  layerLive,
  newLayer,
  rectAt,
  regionsAt,
  removeKeyframe,
  setKeyframe,
  type BlurLayer,
  type Rect,
} from "@core/edit/blur";
import { follow, Tracker, type Gray, type TimedFrame } from "@core/vision/tracker";
import { layerSpans, layersFromTracks } from "@core/vision/video";
import type { Track } from "@core/vision/faces";
import { VideoEditor, type Job, type Media } from "@ui/vedit";

themes.init();

let passed = 0;
let failed = 0;

function ok(what: string, cond: boolean, saw = ""): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL  ${what}${saw ? `  — saw ${saw}` : ""}`);
  }
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) < eps;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Synthetic frames ─────────────────────────────────────────────────────────

/** Where the square is at `t` in the fixture clip, source pixels. */
const SQ = { w: 40, h: 40, x: (t: number) => 40 + t * 30, y: (t: number) => 50 + t * 10 };

function frame(w: number, h: number, draw: (g: Gray) => void, noise = 0): Gray {
  const g: Gray = { w, h, data: new Float32Array(w * h).fill(128) };
  draw(g);
  if (noise > 0) {
    for (let i = 0; i < g.data.length; i++) g.data[i]! += (Math.random() - 0.5) * 2 * noise;
  }
  return g;
}

function box(g: Gray, x: number, y: number, w: number, h: number, v: number): void {
  for (let j = Math.max(0, Math.floor(y)); j < Math.min(g.h, y + h); j++) {
    for (let i = Math.max(0, Math.floor(x)); i < Math.min(g.w, x + w); i++) g.data[j * g.w + i] = v;
  }
}

/** A textured object, because a flat square is the easy case. */
function thing(g: Gray, x: number, y: number, s: number): void {
  box(g, x, y, s, s, 40);
  box(g, x + s * 0.2, y + s * 0.2, s * 0.25, s * 0.25, 220);
  box(g, x + s * 0.55, y + s * 0.5, s * 0.3, s * 0.35, 160);
  box(g, x + s * 0.1, y + s * 0.7, s * 0.35, s * 0.15, 90);
}

// ── Model ────────────────────────────────────────────────────────────────────

function modelChecks(): void {
  const l = newLayer("rect", 2, 8, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { name: "plate" });
  ok("a new layer runs from the frame it was drawn on", l.from === 2 && l.to === 8 && l.keys.length === 1);
  ok("and is a user keyframe there", l.keys[0]!.origin === "user" && l.keys[0]!.t === 2);
  setKeyframe(l, { t: 6, rect: { x: 0.5, y: 0.3, w: 0.2, h: 0.2 }, origin: "user" });
  setKeyframe(l, { t: 4, rect: { x: 0.3, y: 0.2, w: 0.2, h: 0.2 }, origin: "track" });
  ok("keyframes stay sorted however they are added", l.keys.map((k) => k.t).join() === "2,4,6", l.keys.map((k) => k.t).join());
  const mid = rectAt(l, 5);
  ok("the box is interpolated between keyframes", near(mid.x, 0.4, 1e-9) && near(mid.y, 0.25, 1e-9), JSON.stringify(mid));
  ok("and held flat before the first and after the last",
    rectAt(l, 0).x === 0.1 && rectAt(l, 9).x === 0.5);
  setKeyframe(l, { t: 4.0004, rect: { x: 0.31, y: 0.2, w: 0.2, h: 0.2 }, origin: "user" });
  ok("a keyframe within a millisecond replaces rather than duplicates", l.keys.length === 3 && l.keys[1]!.rect.x === 0.31);
  ok("removing a keyframe works", removeKeyframe(l, 4) && l.keys.length === 2);
  ok("but the last one cannot be removed",
    !removeKeyframe(newLayer("rect", 0, 1, { x: 0, y: 0, w: 1, h: 1 }), 0));
  ok("a layer is live inside its range and not outside",
    layerLive(l, 5) && !layerLive(l, 1) && !layerLive(l, 9));
  l.wholeClip = true;
  ok("whole-clip ignores the range", layerLive(l, 1) && layerLive(l, 100));
  l.wholeClip = false;
  l.enabled = false;
  ok("a disabled layer is never live", !layerLive(l, 5));
  l.enabled = true;

  const b = newLayer("brush", 0, 5, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 });
  b.region.strokes = [{ width: 0.02, points: [{ x: 0.22, y: 0.22 }, { x: 0.28, y: 0.28 }], erase: false }];
  setKeyframe(b, { t: 5, rect: { x: 0.6, y: 0.5, w: 0.1, h: 0.1 }, origin: "track" });
  const r = regionsAt([b], 5)[0]!;
  ok("a brush stroke rides along with its tracked box",
    near(r.strokes[0]!.points[0]!.x, 0.62, 1e-9) && near(r.strokes[0]!.points[0]!.y, 0.52, 1e-9),
    JSON.stringify(r.strokes[0]!.points[0]));
  ok("regionsAt skips layers that are not live", regionsAt([l], 1).length === 0 && regionsAt([l], 5).length === 1);
}

// ── Tracker ──────────────────────────────────────────────────────────────────

function trackerChecks(): void {
  const W = 192;
  const H = 108;
  const S = 24;

  // Straight line, 3 px per frame, textured object, noisy field.
  const path = (i: number): [number, number] => [20 + i * 3, 30 + i * 1.5];
  const frames: TimedFrame[] = [];
  for (let i = 0; i < 40; i++) {
    const [x, y] = path(i);
    frames.push({ t: i / 6, gray: frame(W, H, (g) => thing(g, x, y, S), 6) });
  }
  const start: Rect = { x: 20 / W, y: 30 / H, w: S / W, h: S / H };
  const t0 = performance.now();
  const res = follow(frames, start);
  const ms = (performance.now() - t0) / Math.max(1, res.found.length - 1);
  let worst = 0;
  let sum = 0;
  for (let i = 0; i < res.found.length; i++) {
    const [x, y] = path(i);
    const f = res.found[i]!;
    const ex = Math.abs(f.rect.x * W - x);
    const ey = Math.abs(f.rect.y * H - y);
    worst = Math.max(worst, ex, ey);
    sum += Math.hypot(ex, ey);
  }
  const mean = sum / res.found.length;
  ok("a moving object is followed through every frame", res.found.length === 40 && res.lostAt === null,
    `${res.found.length} frames, lost at ${res.lostAt}`);
  ok("to within a pixel and a half on average", mean < 1.5, `mean ${mean.toFixed(2)} px`);
  ok("and never more than three pixels off", worst < 3, `worst ${worst.toFixed(2)} px`);
  console.log(`vblur: tracker ${ms.toFixed(2)} ms/step at ${W}x${H}, template ${S}px; mean error ${mean.toFixed(2)} px, worst ${worst.toFixed(2)} px over 40 frames`);

  // Backwards is the same frames reversed.
  const back = follow([...frames].reverse(), res.found[39]!.rect);
  ok("tracking backwards lands where it started",
    back.lostAt === null && near(back.found[39]!.rect.x * W, 20, 3) && near(back.found[39]!.rect.y * H, 30, 3),
    `${JSON.stringify(back.found[39]?.rect)} lost ${back.lostAt}`);

  // Occlusion: the object vanishes at frame 20. The track must end, not wander.
  const occl: TimedFrame[] = frames.slice(0, 20).concat(
    Array.from({ length: 10 }, (_, k) => ({ t: (20 + k) / 6, gray: frame(W, H, () => {}, 6) })),
  );
  const lost = follow(occl, start);
  ok("when the object disappears the track stops and says where",
    lost.lostAt !== null && lost.found.length >= 20 && lost.found.length <= 22,
    `found ${lost.found.length}, lost at ${lost.lostAt}`);
  ok("a step with nothing to match is not filed as a find",
    lost.found.every((f, i) => i < 20 || Math.abs(f.rect.x * W - path(19)[0]) < 4));

  // Growth: the object doubles in size over 30 frames; the box should grow with it.
  const grow: TimedFrame[] = [];
  for (let i = 0; i < 30; i++) {
    const s = 20 + i * 0.7;
    grow.push({ t: i / 6, gray: frame(W, H, (g) => thing(g, 60, 40, s), 3) });
  }
  const grown = follow(grow, { x: 60 / W, y: 40 / H, w: 20 / W, h: 20 / H });
  const finalW = grown.found[grown.found.length - 1]!.rect.w * W;
  ok("a growing object keeps its box growing with it",
    grown.lostAt === null && finalW > 32 && finalW < 48, `final width ${finalW.toFixed(1)} px, expected ~40`);

  // The class API: anchor, step, and re-anchor keeps the same template size.
  const tr = new Tracker();
  tr.anchor(frames[0]!.gray, start);
  const s1 = tr.step(frames[1]!.gray);
  ok("a single step answers with a score in the correlation range",
    s1 !== null && s1.score > 0.6 && s1.score <= 1.0001, String(s1?.score));
}

// ── Spans ────────────────────────────────────────────────────────────────────

function spanChecks(): void {
  const W = 1920;
  const H = 1080;
  const still = newLayer("rect", 5, 65, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { name: "a" });
  const r1 = layerSpans([still], W, H, 70);
  ok("a still layer over a minute is one span", r1.spans.length === 1, String(r1.spans.length));
  const s = r1.spans[0]!;
  ok("in integer source pixels, padded outwards",
    Number.isInteger(s.x) && Number.isInteger(s.w) && s.x < 192 && s.x + s.w > 384 && s.y < 108 && s.y + s.h > 216,
    JSON.stringify(s));
  ok("over exactly its range", s.from === 5 && s.to === 65, `${s.from}-${s.to}`);
  ok("with the layer's own look", s.kind === "gaussian" && s.amount === still.region.amount);

  const three = [still, newLayer("ellipse", 0, 70, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }), newLayer("brush", 10, 20, { x: 0.3, y: 0.3, w: 0.1, h: 0.1 })];
  ok("three still layers over a minute are three spans, not three hundred",
    layerSpans(three, W, H, 70).spans.length === 3);

  // A moving layer: 10 s crossing the frame.
  const mv = newLayer("rect", 0, 10, { x: 0.05, y: 0.4, w: 0.1, h: 0.15 });
  setKeyframe(mv, { t: 10, rect: { x: 0.8, y: 0.45, w: 0.1, h: 0.15 }, origin: "track" });
  const r2 = layerSpans([mv], W, H, 70);
  ok("a moving layer is cut into windows", r2.spans.length >= 15 && r2.spans.length <= 21, String(r2.spans.length));
  let covered = true;
  for (let t = 0; t <= 10; t += 0.1) {
    const r = rectAt(mv, t);
    const px = { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H };
    const hit = r2.spans.some((sp) => sp.from <= t + 1e-9 && sp.to >= t - 1e-9 &&
      sp.x <= px.x && sp.y <= px.y && sp.x + sp.w >= px.x + px.w && sp.y + sp.h >= px.y + px.h);
    if (!hit) { covered = false; break; }
  }
  ok("and every moment of its path is inside some span", covered);
  ok("the windows are contiguous in time",
    r2.spans.every((sp, i) => i === 0 || near(sp.from, r2.spans[i - 1]!.to, 1e-6)));

  const off = newLayer("rect", 0, 10, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
  off.enabled = false;
  ok("a switched-off layer sends nothing", layerSpans([off], W, H, 70).spans.length === 0);

  const whole = newLayer("rect", 30, 31, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
  whole.wholeClip = true;
  const r3 = layerSpans([whole], W, H, 70).spans[0]!;
  ok("whole-clip covers the clip whatever the range says", r3.from === 0 && r3.to === 70, `${r3.from}-${r3.to}`);

  const edge = newLayer("rect", 0, 1, { x: 0.95, y: 0.95, w: 0.2, h: 0.2 });
  const r4 = layerSpans([edge], W, H, 70).spans[0]!;
  ok("a box hanging off the frame is clamped, not shifted",
    r4.x + r4.w <= W && r4.y + r4.h <= H && r4.x >= 1800, JSON.stringify(r4));

  const many: BlurLayer[] = [];
  for (let i = 0; i < 30; i++) {
    const l = newLayer("rect", 0, 60, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
    setKeyframe(l, { t: 60, rect: { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, origin: "track" });
    many.push(l);
  }
  const r5 = layerSpans(many, W, H, 60);
  ok("over the cap the cut coarsens to one box per layer and says so",
    r5.coarsened && r5.spans.length === 30, `${r5.spans.length} coarsened=${r5.coarsened}`);

  const tracks: Track[] = [{
    id: "1", from: 2, to: 4,
    samples: [{ t: 2, box: { x: 100, y: 100, w: 50, h: 50, score: 0.9 } }, { t: 3, box: { x: 120, y: 100, w: 50, h: 50, score: 0.9 } }, { t: 4, box: { x: 140, y: 100, w: 50, h: 50, score: 0.9 } }],
  }];
  const faces = layersFromTracks(tracks, 640, 360);
  ok("a face track becomes one layer with a keyframe per sample",
    faces.length === 1 && faces[0]!.keys.length === 3 && faces[0]!.source === "face" && faces[0]!.keys.every((k) => k.origin === "detect"),
    JSON.stringify(faces[0]?.keys.length));
  ok("held a little before and after the detections", faces[0]!.from < 2 && faces[0]!.to > 4);
  ok("and padded the way a still face is", faces[0]!.keys[0]!.rect.x * 640 < 100 && faces[0]!.keys[0]!.rect.w * 640 > 50);
}

// ── The workspace ────────────────────────────────────────────────────────────

const MEDIA: Media = {
  duration: 6,
  bitrate: 100000,
  format: "mov,mp4",
  width: 320,
  height: 180,
  tracks: [
    { index: 0, kind: "video", codec: "h264", width: 320, height: 180, fps: 25, channels: 0, sampleRate: 0, rotation: 0, language: "" },
  ],
};

let lastJob: Job | null = null;
let doneCb: ((d: unknown) => void) | null = null;
let framesServed = 0;

/** What ffmpeg would hand back for `frame_at(t, width)`: the square, where it is at `t`. */
async function fakeFrame(t: number, width: number): Promise<Uint8Array> {
  framesServed++;
  const s = width / 320;
  const c = document.createElement("canvas");
  c.width = Math.round(320 * s);
  c.height = Math.round(180 * s);
  const g = c.getContext("2d")!;
  g.fillStyle = "#808080";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#d02020";
  g.fillRect(SQ.x(t) * s, SQ.y(t) * s, SQ.w * s, SQ.h * s);
  g.fillStyle = "#2020d0";
  g.fillRect((SQ.x(t) + 8) * s, (SQ.y(t) + 8) * s, 24 * s, 24 * s);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  return new Uint8Array(await blob!.arrayBuffer());
}

const editor = new VideoEditor({
  fileUrl: (p) => Promise.resolve(p),
  probe: () => Promise.resolve(MEDIA),
  frameAt: (_p, t, width) => fakeFrame(t, width),
  runJob: (job) => { lastJob = job; return Promise.resolve(7); },
  cancelJob: () => Promise.resolve(),
  onProgress: () => () => {},
  onDone: (cb) => { doneCb = cb as (d: unknown) => void; return () => {}; },
  refresh: () => {},
});

const root = (): HTMLElement => document.querySelector<HTMLElement>(".vedit")!;
const vb = (): HTMLElement => root().querySelector<HTMLElement>(".vb")!;
const video = (): HTMLVideoElement => root().querySelector("video")!;
const stage = (): HTMLElement => vb().querySelector<HTMLElement>(".vb-stage")!;
const layers = (): BlurLayer[] => (editor as unknown as { vb: { layers: BlurLayer[] } }).vb.layers;

function button(scope: HTMLElement, fragment: string): HTMLButtonElement | null {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((x) =>
    x.title.toLowerCase().includes(fragment.toLowerCase())) ?? null;
}
function press(fragment: string): void {
  const b = button(vb(), fragment) ?? button(root(), fragment);
  if (!b) throw new Error(`no button whose tooltip mentions "${fragment}"`);
  b.click();
}

function picture(): DOMRect {
  const el = video().getBoundingClientRect();
  const scale = Math.min(el.width / 320, el.height / 180);
  const w = 320 * scale;
  const h = 180 * scale;
  return new DOMRect(el.left + (el.width - w) / 2, el.top + (el.height - h) / 2, w, h);
}

/** Source pixel → page point. */
function at(x: number, y: number): [number, number] {
  const p = picture();
  return [p.left + (x / 320) * p.width, p.top + (y / 180) * p.height];
}

function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, isPrimary: true }));
}

/**
 * Pointer capture in a real browser keeps delivering moves to the capturing
 * element even when the thing under the finger was rebuilt; here the moves
 * go straight to the capturing surface to match.
 */
function drag(target: Element, pts: [number, number][]): void {
  const surface = target.closest(".vb-timeline") ?? target;
  pointer(target, "pointerdown", pts[0]![0], pts[0]![1]);
  for (const [x, y] of pts.slice(1)) pointer(surface, "pointermove", x, y);
  const last = pts[pts.length - 1]!;
  pointer(surface, "pointerup", last[0], last[1]);
}

function seek(t: number): Promise<void> {
  const v = video();
  return new Promise((res) => {
    v.addEventListener("seeked", () => res(), { once: true });
    v.currentTime = t;
    setTimeout(res, 300);
  });
}

async function exportNow(): Promise<Job> {
  lastJob = null;
  press("never touched");
  for (let i = 0; i < 60 && !lastJob; i++) await sleep(16);
  const job = lastJob as Job | null;
  if (!job) throw new Error("export never produced a job");
  await sleep(0);
  doneCb?.({ id: 7, ok: true, output: job.output, leftover: "", error: "", copied: false });
  return job;
}

async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/** The phone budget, checked on the box the workspace was given. */
function layoutChecks(tag: string, w: number, h: number, inset: number): void {
  const r = vb().getBoundingClientRect();
  const top = vb().querySelector<HTMLElement>(".vb-top")!.getBoundingClientRect();
  const dock = vb().querySelector<HTMLElement>(".vb-dock")!.getBoundingClientRect();
  const st = stage().getBoundingClientRect();
  const pic = picture();
  ok(`${tag}: the workspace fills its box`, near(r.width, w, 1) && near(r.height, h, 1), `${r.width}x${r.height}`);
  const firstBtn = vb().querySelector<HTMLElement>(".vb-top .vb-btn")!.getBoundingClientRect();
  ok(`${tag}: the top bar clears the status bar`, firstBtn.top >= r.top + inset - 0.5, `button at ${firstBtn.top - r.top}, inset ${inset}`);
  ok(`${tag}: the picture is whole — inside the stage, not under the dock`,
    pic.top >= st.top - 0.5 && pic.bottom <= st.bottom + 0.5 && pic.left >= st.left - 0.5 && pic.right <= st.right + 0.5 && pic.width > 0,
    `pic ${Math.round(pic.top)}-${Math.round(pic.bottom)} stage ${Math.round(st.top)}-${Math.round(st.bottom)}`);
  ok(`${tag}: the dock sits below the stage and inside the screen`,
    dock.top >= st.bottom - 0.5 && dock.bottom <= r.bottom + 0.5 && top.bottom <= st.top + 0.5,
    `dock ${Math.round(dock.top)}-${Math.round(dock.bottom)}, stage ends ${Math.round(st.bottom)}`);
  const strip = vb().querySelector<HTMLElement>(".vb-strip")!.getBoundingClientRect();
  ok(`${tag}: the chip strip keeps a floor above the gesture pill`, r.bottom - strip.bottom >= 16 - 0.5, `${r.bottom - strip.bottom}`);
  const chips = Array.from(vb().querySelectorAll<HTMLElement>(".vb-chip"));
  ok(`${tag}: chips are finger-sized`, chips.length > 0 && chips.every((c) => c.getBoundingClientRect().height >= 36), String(chips.map((c) => c.getBoundingClientRect().height)[0]));
  ok(`${tag}: nothing but the blur is over the picture`,
    !Array.from(vb().querySelectorAll<HTMLElement>(".vb-dock *, .vb-top *")).some((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.bottom > pic.top && b.top < pic.bottom && b.right > pic.left && b.left < pic.right;
    }));
  ok(`${tag}: the picture is a useful size`, pic.width >= Math.min(w, 300) * 0.85, `${Math.round(pic.width)}px wide`);
}

async function uiChecks(): Promise<void> {
  document.body.classList.add("fct-phone");
  const box = root();
  box.style.cssText = "position:fixed; inset:auto; left:0; top:0; width:360px; height:780px; --fct-inset-top:24px; --fct-inset-bottom:0px;";

  await editor.open("C:/clips/vblurcheck.mp4", "blur");
  video().src = "/devfixtures/vblurcheck.mp4";
  await new Promise<void>((res) => {
    if (video().readyState >= 2) return res();
    video().addEventListener("loadeddata", () => res(), { once: true });
    setTimeout(res, 4000);
  });
  ok("a real video loaded", video().videoWidth === 320 && video().videoHeight === 180, `${video().videoWidth}x${video().videoHeight}`);
  ok("opening in blur mode shows the workspace", !vb().hidden && getComputedStyle(vb()).display !== "none");
  ok("with the video borrowed into its stage", video().parentElement === stage());
  await seek(0);
  await sleep(50);
  layoutChecks("portrait 360x780", 360, 780, 24);

  // ── Draw a box over the square at t=0 ──
  const s = stage();
  drag(s, [at(38, 48), at(60, 70), at(84, 94)]);
  await sleep(30);
  ok("dragging on the picture makes a layer", layers().length === 1, String(layers().length));
  const l1 = layers()[0]!;
  ok("that starts at this moment and runs to the end of the clip", l1.from === 0 && near(l1.to, 6, 0.01), `${l1.from}-${l1.to}`);
  const r0 = rectAt(l1, 0);
  ok("with its box where it was drawn, in frame coordinates",
    near(r0.x * 320, 38, 2) && near(r0.y * 180, 48, 2) && near(r0.w * 320, 46, 3) && near(r0.h * 180, 46, 3),
    JSON.stringify({ x: r0.x * 320, y: r0.y * 180, w: r0.w * 320, h: r0.h * 180 }));
  ok("and it is selected, with its own strip", !!button(vb(), "Follow what this covers forward"));
  ok("the timeline shows one bar", vb().querySelectorAll(".vb-bar").length === 1);
  ok("the editor no longer promises a free export",
    !(button(root(), "never touched")?.textContent ?? "").includes("no re-encode"));

  // ── Live preview ──
  press("How it is hidden");
  const black = Array.from(vb().querySelectorAll<HTMLButtonElement>(".vb-chip")).find((c) => c.textContent?.includes("Black bar"));
  black?.click();
  await sleep(60);
  const canvas = vb().querySelector<HTMLCanvasElement>(".vb-canvas")!;
  const px = canvas.getContext("2d")!.getImageData(Math.round(60 * canvas.width / 320), Math.round(70 * canvas.height / 180), 1, 1).data;
  ok("the preview draws the blur over the frame while paused", canvas.width === 320 && px[3]! > 200 && px[0]! < 40 && px[1]! < 40,
    `canvas ${canvas.width}x${canvas.height} pixel ${Array.from(px).join(",")}`);
  const outside = canvas.getContext("2d")!.getImageData(Math.round(250 * canvas.width / 320), Math.round(150 * canvas.height / 180), 1, 1).data;
  ok("and the untouched part of the frame is the frame", outside[3]! > 200 && outside[0]! > 100 && outside[0]! < 160, Array.from(outside).join(","));
  ok("the style chip took", l1.region.kind === "solid");
  press("Undo");
  ok("undo puts the style back", l1.region.kind === "gaussian" || layers()[0]!.region.kind === "gaussian");
  press("Redo");
  ok("redo puts it forward again", layers()[0]!.region.kind === "solid");

  // ── Follow ──
  Array.from(vb().querySelectorAll<HTMLButtonElement>(".vb-chip")).find((c) => c.title.startsWith("Back to the layer"))?.click();
  framesServed = 0;
  press("Follow what this covers forward");
  const done = await until(() => !!button(vb(), "Follow what this covers forward") && !button(vb(), "Follow what this covers forward")!.disabled && layers()[0]!.keys.length > 5, 20000);
  const l = layers()[0]!;
  ok("Follow pulls frames and lays keyframes along the path", done && l.keys.length > 20, `${l.keys.length} keys, ${framesServed} frames`);
  const r5 = rectAt(l, 5);
  ok("and the box at 5 s is where the square really is",
    near(r5.x * 320, SQ.x(5) - 2, 6) && near(r5.y * 180, SQ.y(5) - 2, 6),
    `x ${(r5.x * 320).toFixed(1)} y ${(r5.y * 180).toFixed(1)} expected ${SQ.x(5) - 2},${SQ.y(5) - 2}`);
  ok("it was not lost", l.lostAt === undefined && near(l.to, 6, 0.05), `lostAt ${l.lostAt} to ${l.to}`);
  const note = vb().querySelector(".vb-note")?.textContent ?? "";
  ok("and the bar says so", note.includes("followed"), note);
  console.log(`vblur: UI follow: ${framesServed} frames served, ${l.keys.length} keyframes`);

  // ── Scrub, keyframes, handles ──
  const tl = vb().querySelector<HTMLElement>(".vb-timeline")!;
  const tr = tl.getBoundingClientRect();
  drag(tl.querySelector(".vb-ruler")!, [[tr.left + tr.width * 0.5, tr.top + 5]]);
  await sleep(350);
  ok("tapping the ruler scrubs there", near(video().currentTime, 3, 0.2), String(video().currentTime));
  await seek(3);
  press("Pin the box where it is");
  ok("Key pins a user keyframe at the playhead", l.keys.some((k) => Math.abs(k.t - 3) < 0.02 && k.origin === "user"));
  ok("the keyframe shows on the timeline", vb().querySelectorAll(".vb-key.user").length >= 2);
  press("Remove the keyframe at this moment");
  ok("and can be removed again", !l.keys.some((k) => Math.abs(k.t - 3) < 0.02 && k.origin === "user"));

  // Drag the box at t=3: becomes a user keyframe there, moves only that moment.
  const r3 = rectAt(l, 3);
  const [cx, cy] = at((r3.x + r3.w / 2) * 320, (r3.y + r3.h / 2) * 180);
  drag(s, [[cx, cy], [cx + 10, cy + 10], [cx + 20, cy + 20]]);
  await sleep(30);
  const moved = rectAt(l, 3);
  const dx = (moved.x - r3.x) * picture().width;
  ok("dragging the box at a moment moves it there and pins a keyframe",
    near(dx, 20, 3) && l.keys.some((k) => Math.abs(k.t - 3) < 0.02 && k.origin === "user"), `moved ${dx.toFixed(1)} px`);
  ok("without moving it at the start", near(rectAt(l, 0).x, r0.x, 1e-6));

  press("End this blur at this moment");
  ok("End trims the layer to the playhead", near(l.to, 3, 0.02), String(l.to));
  const bar = vb().querySelector<HTMLElement>(".vb-bar")!;
  const barR = bar.getBoundingClientRect();
  const ruler = tl.querySelector(".vb-ruler")!.getBoundingClientRect();
  ok("the bar shrinks with it", near(barR.right, ruler.left + ruler.width * 0.5, 8), `${barR.right - ruler.left} of ${ruler.width}`);
  const handle = bar.querySelector<HTMLElement>(".vb-handle.r")!;
  const hr = handle.getBoundingClientRect();
  drag(handle, [[hr.left + hr.width / 2, hr.top + hr.height / 2], [tr.left + tr.width * 0.7, hr.top + 5], [tr.left + tr.width * 0.83, hr.top + 5]]);
  await sleep(350);
  ok("dragging the end handle extends the layer", l.to > 4.7 && l.to < 5.3, String(l.to));
  press("Undo");
  ok("undo restores the end", near(layers()[0]!.to, 3, 0.05), String(layers()[0]!.to));
  press("Redo");

  press("Cover the whole clip");
  ok("whole clip toggles", layers()[0]!.wholeClip);
  let job = await exportNow();
  ok("a whole-clip layer exports spans over the whole clip",
    (job.blur ?? []).length > 0 && job.blur![0]!.from === 0 && near(job.blur![job.blur!.length - 1]!.to, 6, 0.01),
    JSON.stringify(job.blur?.map((b) => [b.from, b.to])));
  press("Cover the whole clip");

  // ── Export ──
  job = await exportNow();
  const spans = job.blur ?? [];
  ok("the export carries a span per window of the moving box", spans.length >= 6 && spans.length <= 14, String(spans.length));
  ok("in source pixels inside the frame",
    spans.every((b) => Number.isInteger(b.x) && b.x >= 0 && b.y >= 0 && b.x + b.w <= 320 && b.y + b.h <= 180));
  ok("with the chosen style", spans.every((b) => b.kind === "solid"));
  const sq2 = { x: SQ.x(2), y: SQ.y(2) };
  ok("and the square at 2 s is inside the span covering 2 s",
    spans.some((b) => b.from <= 2 && b.to >= 2 && b.x <= sq2.x && b.y <= sq2.y && b.x + b.w >= sq2.x + 40 && b.y + b.h >= sq2.y + 40),
    JSON.stringify(spans.find((b) => b.from <= 2 && b.to >= 2)));
  ok("only for as long as the layer runs", spans.every((b) => b.to <= layers()[0]!.to + 0.05), String(Math.max(...spans.map((b) => b.to))));

  // ── Duplicate, rename, layers list, delete ──
  press("Duplicate this layer");
  ok("duplicate makes a second layer, selected", layers().length === 2 && layers()[1]!.keys.length === l.keys.length);
  press("Name this layer");
  const input = vb().querySelector<HTMLInputElement>(".vb-name");
  ok("Name shows an input in the strip, not a floating prompt", !!input);
  if (input) {
    input.value = "plate";
    input.dispatchEvent(new Event("change"));
  }
  ok("and the name sticks", layers()[1]!.name === "plate", layers()[1]!.name);
  Array.from(vb().querySelectorAll<HTMLButtonElement>(".vb-chip")).find((c) => c.title.startsWith("Back to the layer"))?.click();
  Array.from(vb().querySelectorAll<HTMLButtonElement>(".vb-chip")).find((c) => c.title === "Done with this layer")?.click();
  press("Every blur on this clip");
  ok("the layers list names each one", Array.from(vb().querySelectorAll(".vb-layer")).some((c) => c.textContent?.includes("plate")));
  (vb().querySelector<HTMLElement>(".vb-layer .vb-chip-x"))?.click();
  ok("the x on a layer chip deletes it", layers().length === 1, String(layers().length));
  press("Undo");
  ok("and that is undoable", layers().length === 2);
  press("Redo");

  // ── Oval and brush ──
  Array.from(vb().querySelectorAll<HTMLButtonElement>(".vb-chip")).find((c) => c.title.startsWith("Back"))?.click();
  press("Draw a oval");
  await seek(1);
  drag(s, [at(200, 20), at(230, 40), at(260, 60)]);
  await sleep(20);
  ok("an oval is a layer too", layers().length === 2 && layers()[1]!.region.shape === "ellipse");
  job = await exportNow();
  const oval = (job.blur ?? []).find((b) => b.kind !== "solid");
  ok("exported as its bounding box, from the moment it was drawn", !!oval && oval.from >= 0.9 && oval.from <= 1.1 && oval.w >= 60, JSON.stringify(oval));

  Array.from(vb().querySelectorAll<HTMLButtonElement>(".vb-chip")).find((c) => c.title === "Done with this layer")?.click();
  press("Draw a brush");
  drag(s, [at(100, 150), at(120, 152), at(140, 150), at(160, 148)]);
  await sleep(20);
  const br = layers()[2];
  ok("a brush stroke is a layer with the stroke inside it", !!br && br.region.shape === "brush" && br.region.strokes[0]!.points.length >= 3,
    String(br?.region.strokes[0]?.points.length));
  ok("whose box is the stroke's extent", !!br && br.region.rect.w * 320 > 55 && br.region.rect.x * 320 < 100);

  // ── Tap on empty picture deselects; delete key ──
  drag(s, [at(300, 10)]);
  ok("a tap on empty picture deselects", !button(vb(), "Follow what this covers forward"));
  ok("the layer list shows the count", (Array.from(vb().querySelectorAll<HTMLElement>(".vb-chip")).find((c) => c.textContent?.includes("Layers"))?.textContent ?? "").includes("3"));

  // ── Lost track ends the layer with a marker ──
  // Draw over nothing but grey: the tracker has nothing to hold on to and must say so.
  await seek(0);
  press("Draw a box");
  drag(s, [at(200, 120), at(220, 140), at(240, 160)]);
  await sleep(20);
  const flat = layers()[3]!;
  press("Follow what this covers forward");
  await until(() => !(button(vb(), "Follow what this covers forward")?.disabled ?? true), 20000);
  ok("a box over nothing distinctive is reported lost rather than wandered",
    flat.lostAt !== undefined && flat.to < 1.5, `lostAt ${flat.lostAt} to ${flat.to}`);
  ok("with a marker on its bar", !!vb().querySelector(".vb-lost"));
  ok("and a note saying where", (vb().querySelector(".vb-note")?.textContent ?? "").includes("Lost"));

  // ── Faces via the workspace chip (the stub frames have no face in them) ──
  drag(s, [at(300, 10)]);
  press("Find every face");
  await until(() => !(Array.from(vb().querySelectorAll<HTMLButtonElement>(".vb-chip")).find((c) => c.title.startsWith("Find every face"))?.disabled ?? true), 30000);
  ok("a face scan over a clip with nobody in it says so", (vb().querySelector(".vb-note")?.textContent ?? "").toLowerCase().includes("no faces"),
    vb().querySelector(".vb-note")?.textContent ?? "");

  // ── Landscape box ──
  box.style.width = "780px";
  box.style.height = "360px";
  await sleep(80);
  window.dispatchEvent(new Event("resize"));
  await sleep(50);
  layoutChecks("landscape 780x360", 780, 360, 24);

  // ── Done returns the video ──
  press("Done");
  ok("Done hides the workspace and gives the video back", vb().hidden && video().parentElement?.classList.contains("vedit-stage") === true);
  ok("and the layers survive for the export", layers().length === 4);
  press("Blur anything");
  ok("Blur… on the sheet reopens it", !vb().hidden);

  // ── The Auto strip: nothing pre-ticked, in-place ticks, remembered ──
  localStorage.removeItem("fct.autoblur.pick.v1");
  const tool = (id: string): HTMLButtonElement | null => vb().querySelector<HTMLButtonElement>(`.vb-strip [data-tool="${id}"]`) ?? vb().querySelector<HTMLButtonElement>(`[data-tool="${id}"]`);
  press("Pick what to find");
  ok("Auto opens a picker strip with Go, Everything and a chip per category", tool("ai.auto.go") !== null && tool("ai.auto.all") !== null && tool("ai.pick.plates") !== null);
  ok("nothing is pre-ticked on first use", tool("ai.auto.go")?.disabled === true && tool("ai.pick.faces")?.getAttribute("aria-pressed") === "false");
  const goChip = tool("ai.auto.go");
  const platesChip = tool("ai.pick.plates");
  platesChip?.click();
  ok("ticking a category enables Go and counts it", goChip?.disabled === false && (goChip?.textContent ?? "").includes("1"), goChip?.textContent ?? "");
  ok("the tick updates the chips in place (no rebuild)", tool("ai.auto.go") === goChip && tool("ai.pick.plates") === platesChip && platesChip?.getAttribute("aria-pressed") === "true");
  ok("the pick is remembered", localStorage.getItem("fct.autoblur.pick.v1") === JSON.stringify(["plates"]), localStorage.getItem("fct.autoblur.pick.v1") ?? "null");
  tool("ai.auto.all")?.click();
  ok("Everything ticks them all", (goChip?.textContent ?? "").includes("7"), goChip?.textContent ?? "");
  tool("ai.auto.all")?.click();
  ok("Everything again clears them all", goChip?.disabled === true);
  localStorage.removeItem("fct.autoblur.pick.v1");
  press("Back to the tools");

  press("Done");
  box.style.cssText = "";
  document.body.classList.remove("fct-phone");
}

/**
 * `?shot=1`: no checks, just the workspace left open with a followed layer,
 * sized to the window, for screenshots at phone sizes.
 */
async function shoot(): Promise<void> {
  document.body.classList.add("fct-phone");
  const box = root();
  box.style.cssText = "position:fixed; inset:0; --fct-inset-top:24px; --fct-inset-bottom:0px;";
  await editor.open("C:/clips/vblurcheck.mp4", "blur");
  video().src = "/devfixtures/vblurcheck.mp4";
  await new Promise<void>((res) => {
    if (video().readyState >= 2) return res();
    video().addEventListener("loadeddata", () => res(), { once: true });
    setTimeout(res, 4000);
  });
  await seek(0);
  await sleep(100);
  drag(stage(), [at(38, 48), at(60, 70), at(84, 94)]);
  await sleep(30);
  press("Follow what this covers forward");
  await until(() => !(button(vb(), "Follow what this covers forward")?.disabled ?? true) && layers()[0]!.keys.length > 5, 20000);
  await seek(2.5);
  press("Pin the box where it is");
  await seek(2.4);
  document.title = "vblur shot ready";
}

async function run(): Promise<void> {
  if (new URLSearchParams(location.search).has("shot")) {
    await shoot();
    return;
  }
  modelChecks();
  trackerChecks();
  spanChecks();
  await uiChecks();
}

run()
  .catch((e) => {
    failed++;
    console.error("FAIL  the harness itself threw:", e);
  })
  .finally(() => {
    if (new URLSearchParams(location.search).has("shot")) return;
    console.log(`vblur: ${passed} passed, ${failed} failed`);
    document.title = `vblur: ${passed} passed, ${failed} failed`;
  });
