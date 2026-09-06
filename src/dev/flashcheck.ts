/**
 * Dev harness for the viewer's swipe hand-over: does any frame flash?
 *
 * A tester saw "a clear small glitch flash" at the end of a swipe on the
 * phone. This mounts the real `PhoneViewer` over a mock file system of solid
 * colour pictures, drives a swipe with synthetic touch events, and samples
 * the stage on every animation frame: which element owns the centre of the
 * stage (the picture, or a neighbour pane sliding in), what picture it shows
 * (read back from its pixels, so a blob URL the cache minted is still
 * identified), how sharp it is (thumbnail seed or screen-sized copy), and the
 * exact box the picture is drawn in.
 *
 * A flash is one of:
 * - a frame with nothing decoded under the centre of the stage;
 * - the centre showing the *previous* picture again after the new one was in
 *   place (the stage snapping back to centre before its new src arrived);
 * - the hand-over frame, where the pane stops owning the centre and the stage
 *   takes over, moving the picture's box by more than a pixel;
 * - a sharpness swap (thumbnail -> display copy, on the stage or a pane) while
 *   the strip is still moving.
 *
 * Two swipes: one to a neighbour whose display copy is already decoded (the
 * common, fast case), one to a neighbour whose file is slow to arrive so the
 * pane only has the grid thumbnail -- the case where the stage used to draw a
 * 384 px thumbnail at its own size in the middle of a stage the pane had
 * filled, then jump when the sharp copy landed.
 */

import "../styles/base.css";
import "../styles/phone.css";
import "../styles/phone-viewer.css";
import "../styles/phone-editor.css";

import type { FileEntry } from "@core/explorer/types";
import { PhoneViewer } from "@ui/phone/viewer";
import type { PhoneHost } from "@ui/phone/shell";
import type { MediaStore } from "@ui/phone/store";
import type { Thumbs } from "@ui/phone/thumbs";

let pass = 0;
let fail = 0;

function ok(title: string, condition: boolean, extra?: string): void {
  if (condition) {
    pass += 1;
    console.log(`[OK] ${title}`);
  } else {
    fail += 1;
    console.error(`[FAIL] ${title}${extra ? ` (${extra})` : ""}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
const frame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));

// ── Pictures ────────────────────────────────────────────────────────────────
// Solid colours, one per file, so a pixel says which picture is on screen.

interface Pic { path: string; w: number; h: number; rgb: [number, number, number]; url: string; thumb: string }

async function paint(w: number, h: number, rgb: [number, number, number]): Promise<string> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  g.fillRect(0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  return URL.createObjectURL(blob);
}

async function makePic(i: number, w: number, h: number, rgb: [number, number, number]): Promise<Pic> {
  const k = 384 / Math.max(w, h);
  const [url, thumb] = await Promise.all([paint(w, h, rgb), paint(Math.round(w * k), Math.round(h * k), rgb)]);
  return { path: `/pics/p${i}.png`, w, h, rgb, url, thumb };
}

function entryOf(p: Pic): FileEntry {
  return { path: p.path, name: p.path.slice(6), kind: "image", ext: "png", size: 1000, modified: 1 };
}

// ── Reading the stage ───────────────────────────────────────────────────────

/** Which picture an element shows, by its pixels. Cached per src. */
const seen = new Map<string, number>();
const probe = document.createElement("canvas");
probe.width = 1;
probe.height = 1;
const pg = probe.getContext("2d", { willReadFrequently: true })!;

function picOf(el: HTMLImageElement, pics: Pic[]): number {
  if (!el.complete || el.naturalWidth === 0) return -1;
  const hit = seen.get(el.src);
  if (hit !== undefined) return hit;
  pg.clearRect(0, 0, 1, 1);
  try {
    pg.drawImage(el, 0, 0, 1, 1);
  } catch {
    return -1;
  }
  const d = pg.getImageData(0, 0, 1, 1).data;
  let best = -1;
  let bestErr = 1e9;
  pics.forEach((p, i) => {
    const err = Math.abs(p.rgb[0] - d[0]!) + Math.abs(p.rgb[1] - d[1]!) + Math.abs(p.rgb[2] - d[2]!);
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  });
  const id = bestErr < 30 && d[3]! > 200 ? best : -1;
  seen.set(el.src, id);
  return id;
}

interface Box { x: number; y: number; w: number; h: number }

/** Where the picture's pixels land: `object-fit: contain` inside the element's box. */
function drawnBox(el: HTMLImageElement): Box | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || el.naturalWidth === 0) return null;
  const k = Math.min(r.width / el.naturalWidth, r.height / el.naturalHeight);
  const w = el.naturalWidth * k;
  const h = el.naturalHeight * k;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}

interface Sample {
  t: number;
  /** "img" | "prev" | "next" | "" for nothing under the centre. */
  owner: string;
  pic: number;
  sharp: boolean;
  box: Box | null;
  /** Any element under the stage still moving since the last sample. */
  moving: boolean;
  srcs: string[];
  /** Per element, whether any of it is inside the stage box this frame. */
  onStage: boolean[];
  /** The stage as painted this frame, composed at FRAME_W px wide. */
  frame: Uint8ClampedArray;
}

/** Width of the per-frame capture; the height follows the stage's aspect. */
const FRAME_W = 48;

/** Mean absolute per-channel difference between two captured frames, 0..255. */
function frameDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    n += 3;
  }
  return n ? sum / n : 0;
}

class Recorder {
  samples: Sample[] = [];
  private raf = 0;
  private lastRects: number[] = [];
  private readonly shot = document.createElement("canvas");
  /**
   * What the compositor last rastered for each element. Headless Chromium
   * decodes a blob src synchronously, so a bare drawImage would show the new
   * bitmap the very frame the src changed -- which is not what the Android
   * WebView does: it rasters off-thread, and the frame after a src change
   * shows the element's *previous* tile at its new position. The capture
   * models that one-frame lag: an element whose src changed since the last
   * sample is drawn with the bitmap it had.
   */
  private readonly tiles = new Map<HTMLImageElement, { src: string; tile: HTMLCanvasElement | null }>();
  constructor(
    private readonly stage: HTMLElement,
    private readonly els: { img: HTMLImageElement; prev: HTMLImageElement; next: HTMLImageElement },
    private readonly pics: Pic[],
  ) {}

  start(): void {
    const tick = (t: number): void => {
      this.sample(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private sample(t: number): void {
    const s = this.stage.getBoundingClientRect();
    const cx = s.left + s.width / 2;
    const cy = s.top + s.height / 2;
    // Paint order: the next pane over the stage image over the previous pane
    // (the image is a stacking context; positioned panes paint in tree order
    // around it).
    const order: [string, HTMLImageElement][] = [
      ["next", this.els.next], ["img", this.els.img], ["prev", this.els.prev],
    ];
    let owner = "";
    let pic = -1;
    let sharp = false;
    let box: Box | null = null;
    for (const [name, el] of order) {
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      const b = drawnBox(el);
      if (b && (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h)) {
        // The element is under the centre but its picture is letterboxed
        // away from it: a legitimate gap between pictures, not a blank.
        owner = "gap";
        break;
      }
      owner = name;
      pic = b ? picOf(el, this.pics) : -1;
      sharp = el.naturalWidth > 400 || el.naturalHeight > 400;
      box = b;
      break;
    }
    const rects = order.map(([, el]) => Math.round(el.getBoundingClientRect().left * 10));
    const moving = this.lastRects.length > 0 && rects.some((v, i) => v !== this.lastRects[i]);
    this.lastRects = rects;
    // Frame capture: compose what the compositor would show for the stage --
    // every visible element's decoded bitmap at its contain box, in paint
    // order -- into a small canvas. An element whose src has not decoded
    // draws nothing, exactly as it would on screen, so a src swap ahead of
    // its bitmap shows up as a dark frame in the diff.
    const fw = FRAME_W;
    const fh = Math.max(1, Math.round((fw * s.height) / s.width));
    if (this.shot.width !== fw || this.shot.height !== fh) {
      this.shot.width = fw;
      this.shot.height = fh;
    }
    const g = this.shot.getContext("2d")!;
    g.fillStyle = "#000";
    g.fillRect(0, 0, fw, fh);
    const k = fw / s.width;
    for (const [, el] of [...order].reverse()) {
      const had = this.tiles.get(el);
      const stale = had !== undefined && had.src !== el.src;
      let tile: HTMLCanvasElement | null = null;
      if (stale) {
        // Src changed since the last sample: this frame still shows the old
        // tile; the new one lands next frame.
        tile = had.tile;
      } else if (el.naturalWidth > 0) {
        tile = document.createElement("canvas");
        tile.width = 8;
        tile.height = 8;
        try {
          tile.getContext("2d")!.drawImage(el, 0, 0, 8, 8);
        } catch {
          tile = null;
        }
      }
      this.tiles.set(el, { src: el.src, tile });
      if (el.hidden) continue;
      const b = drawnBox(el);
      if (!b || !tile) continue;
      g.drawImage(tile, (b.x - s.left) * k, (b.y - s.top) * k, b.w * k, b.h * k);
    }
    const frame = g.getImageData(0, 0, fw, fh).data;
    this.samples.push({
      t, owner, pic, sharp, box, moving, frame,
      srcs: order.map(([, el]) => el.src),
      onStage: order.map(([, el]) => {
        const r = el.getBoundingClientRect();
        return !el.hidden && r.right > s.left + 0.5 && r.left < s.right - 0.5;
      }),
    });
  }
}

// ── The gesture ─────────────────────────────────────────────────────────────

function touch(target: Element, x: number, y: number): Touch {
  return new Touch({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y });
}

function fire(target: Element, type: string, t: Touch | null): void {
  const list = t ? [t] : [];
  target.dispatchEvent(new TouchEvent(type, {
    touches: type === "touchend" ? [] : list,
    changedTouches: t ? [t] : [],
    targetTouches: type === "touchend" ? [] : list,
    bubbles: true,
    cancelable: true,
  }));
}

/** A left swipe (to the next picture): finger on, eight moves, finger off. */
async function swipeLeft(stage: HTMLElement): Promise<void> {
  const w = window.innerWidth;
  const y = Math.round(window.innerHeight / 2);
  // Start clear of the system's back-gesture strip on either edge.
  const x0 = w - 140;
  const x1 = 20;
  let t = touch(stage, x0, y);
  fire(stage, "touchstart", t);
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await frame();
    const x = Math.round(x0 + (x1 - x0) * (i / steps));
    t = touch(stage, x, y);
    fire(stage, "touchmove", t);
  }
  await frame();
  fire(stage, "touchend", t);
}

// ── Judging the frames ──────────────────────────────────────────────────────

function judge(label: string, samples: Sample[], from: number, to: number): void {
  const before = fail;
  const all = samples;
  // Frames where a picture is under the centre; letterbox gaps between two
  // pictures mid-swipe are not flashes and are judged separately.
  samples = samples.filter((s) => s.owner !== "gap");
  const inSwipe = samples.filter((s) => s.owner !== "" || s.moving);
  ok(`${label}: frames were sampled`, samples.length > 8, `${samples.length}`);

  const blank = samples.filter((s) => s.owner === "" || s.pic === -1);
  ok(`${label}: no frame with nothing decoded under the centre`, blank.length === 0,
    `${blank.length} of ${samples.length}`);
  // A gap is only ever seen while the strip moves; a gap at rest is a hole.
  // "At rest" is three still frames in a row: the single still frame where
  // the finger lifts, before the glide starts, may sit on a gap and is not one.
  const restGaps = all.filter((s, i) => s.owner === "gap" && !s.moving
    && i > 0 && i + 1 < all.length && !all[i - 1]!.moving && !all[i + 1]!.moving);
  ok(`${label}: no letterbox gap under the centre once the strip is at rest`, restGaps.length === 0,
    `${restGaps.length}`);

  // The picture under the centre goes from -> to, once, and never back.
  const seq: number[] = [];
  for (const s of samples) if (seq[seq.length - 1] !== s.pic) seq.push(s.pic);
  ok(`${label}: the centre shows the old picture, then the new one, and never the old again`,
    seq.length === 2 && seq[0] === from && seq[1] === to, seq.join(">"));

  // The hand-over frame: pane -> stage with the box unmoved and the picture the same.
  let handovers = 0;
  let jump = 0;
  let swappedPic = false;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (a.owner === "next" && b.owner === "img") {
      handovers += 1;
      if (a.box && b.box) {
        jump = Math.max(jump, Math.abs(a.box.x - b.box.x), Math.abs(a.box.y - b.box.y),
          Math.abs(a.box.w - b.box.w), Math.abs(a.box.h - b.box.h));
      } else jump = 1e9;
      if (a.pic !== b.pic) swappedPic = true;
    }
  }
  ok(`${label}: the stage took over from the pane exactly once`, handovers === 1, `${handovers}`);
  ok(`${label}: the hand-over moved the picture by under a pixel`, jump < 1, `${jump.toFixed(2)}px`);
  ok(`${label}: the hand-over kept the same picture`, !swappedPic);

  // Sharpness only changes at rest, and never moves the box.
  let popMoving = 0;
  let popJump = 0;
  let srcChangesMoving = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (a.owner === b.owner && a.pic === b.pic && a.sharp !== b.sharp) {
      if (b.moving || a.moving) popMoving += 1;
      if (a.box && b.box) {
        popJump = Math.max(popJump, Math.abs(a.box.x - b.box.x), Math.abs(a.box.w - b.box.w),
          Math.abs(a.box.y - b.box.y), Math.abs(a.box.h - b.box.h));
      }
    }
    if (b.moving && a.srcs.some((s, k) => s !== b.srcs[k] && b.onStage[k])) srcChangesMoving += 1;
  }
  ok(`${label}: no sharpness change while the strip was moving`, popMoving === 0, `${popMoving}`);
  ok(`${label}: a sharper copy landed on the same box`, popJump < 1, `${popJump.toFixed(2)}px`);
  ok(`${label}: no src changed under a moving strip`, srcChangesMoving === 0, `${srcChangesMoving}`);

  // Motion is continuous: no frame moves the centre picture more than a third of the stage.
  let biggest = 0;
  for (let i = 1; i < inSwipe.length; i += 1) {
    const a = inSwipe[i - 1]!;
    const b = inSwipe[i]!;
    if (a.box && b.box && a.pic === b.pic) biggest = Math.max(biggest, Math.abs(a.box.x - b.box.x));
  }
  ok(`${label}: the picture never leapt within a frame`, biggest < window.innerWidth / 3,
    `${biggest.toFixed(0)}px`);

  // Pixel diff of consecutive captured frames. While the strip moves the
  // pictures slide, so frames differ by design and the amount is bounded by
  // the motion; once nothing moves, consecutive frames must be the same
  // picture -- the hand-over frame included. A flash is a frame that differs
  // from both its neighbours by more than the motion accounts for.
  let restDiff = 0;
  let handDiff = 0;
  let spike = 0;
  let spikeAt = -1;
  for (let i = 1; i < all.length; i += 1) {
    const a = all[i - 1]!;
    const b = all[i]!;
    const d = frameDiff(a.frame, b.frame);
    if (!a.moving && !b.moving) restDiff = Math.max(restDiff, d);
    if (a.owner === "next" && b.owner === "img") handDiff = Math.max(handDiff, d);
    if (i + 1 < all.length) {
      // A one-frame excursion: differs from the frame before and the frame
      // after, while those two agree with each other.
      const c = all[i + 1]!;
      const ac = frameDiff(a.frame, c.frame);
      const bc = frameDiff(b.frame, c.frame);
      const ex = Math.min(d, bc) - ac;
      if (ex > spike) {
        spike = ex;
        spikeAt = i;
      }
    }
  }
  ok(`${label}: consecutive frames are identical once nothing moves`, restDiff < 1.5,
    `max mean diff ${restDiff.toFixed(2)}/255`);
  ok(`${label}: the hand-over frame is pixel-identical to the frame before it`, handDiff < 1.5,
    `mean diff ${handDiff.toFixed(2)}/255`);
  ok(`${label}: no single frame flashes against both its neighbours`, spike < 4,
    `worst excursion ${spike.toFixed(2)}/255 at frame ${spikeAt}`);
  if (fail !== before) {
    console.log(`${label} frames: ` + all.map((s) =>
      `${s.owner || "-"}${s.pic}${s.sharp ? "S" : "t"}@${s.box ? s.box.x.toFixed(0) : "?"}${s.moving ? "~" : ""}`).join(" "));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log("Starting flash harness...");
  const pics: Pic[] = await Promise.all([
    makePic(0, 1600, 1200, [200, 40, 40]),
    makePic(1, 1600, 1200, [40, 180, 60]),
    makePic(2, 900, 1600, [40, 80, 220]),
    makePic(3, 1600, 1200, [220, 200, 40]),
  ]);
  const byPath = new Map(pics.map((p) => [p.path, p]));
  // Picture 2 is slow to arrive, so its pane only ever has the thumbnail
  // when the swipe reaches it.
  const slow = new Set(["/pics/p2.png"]);

  const fs = {
    async fileUrl(path: string): Promise<string> {
      if (slow.has(path)) await sleep(1500);
      const p = byPath.get(path);
      if (!p) throw new Error(`no such pic ${path}`);
      return p.url;
    },
    shareFiles: async () => {},
    moveFile: async () => false,
    writeFile: async () => false,
  };
  const host = {
    fs, home: "/", native: false, openPanel() {}, runTool: () => true,
    fileUrl: (path: string) => fs.fileUrl(path),
  } as unknown as PhoneHost;
  const thumbs = {
    async get(entry: FileEntry): Promise<string | null> {
      return byPath.get(entry.path)?.thumb ?? null;
    },
    retain() {},
    release() {},
  } as unknown as Thumbs;
  const store = { forget() {}, noteTrashed() {}, refresh() {} } as unknown as MediaStore;

  const viewer = new PhoneViewer(host, store, thumbs);
  document.body.append(viewer.el);
  const stage = viewer.el.querySelector<HTMLElement>(".phv-stage")!;
  const panes = viewer.el.querySelectorAll<HTMLImageElement>(".phv-pane");
  const img = stage.querySelector<HTMLImageElement>(":scope > img:not(.phv-pane)")!;
  const els = { img, prev: panes[0]!, next: panes[1]! };
  ok("the stage has a picture and two panes", !!img && panes.length === 2);

  const entries = pics.map(entryOf);
  viewer.open(entries[0]!, entries);

  // Wait for the first picture's sharp copy and the next pane's warm copy.
  const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (cond()) return true;
      await sleep(30);
    }
    return cond();
  };
  const warmed = await until(() => img.naturalWidth > 400 && els.next.dataset["full"] === "1", 6000);
  ok("picture 0 is sharp and picture 1 is warm in the next pane", warmed,
    `img ${img.naturalWidth} next full=${els.next.dataset["full"]}`);
  await sleep(100);

  const stageBox = stage.getBoundingClientRect();
  const imgBox = img.getBoundingClientRect();
  ok("the stage picture fills the stage box like a pane does",
    Math.abs(imgBox.width - stageBox.width) < 1 && Math.abs(imgBox.height - stageBox.height) < 1,
    `${imgBox.width}x${imgBox.height} vs ${stageBox.width}x${stageBox.height}`);

  // Swipe 1: to a warm neighbour.
  {
    const rec = new Recorder(stage, els, pics);
    rec.start();
    await swipeLeft(stage);
    await until(() => rec.samples.length > 0 && rec.samples[rec.samples.length - 1]!.owner === "img"
      && !rec.samples[rec.samples.length - 1]!.moving && rec.samples[rec.samples.length - 1]!.pic === 1, 2000);
    await sleep(150);
    rec.stop();
    judge("warm swipe", rec.samples, 0, 1);
  }

  // Swipe 2: to the slow neighbour, whose pane has only the thumbnail.
  ok("picture 2's pane holds the thumbnail, not a sharp copy", els.next.dataset["full"] === "0" && els.next.naturalWidth > 0,
    `full=${els.next.dataset["full"]} nat=${els.next.naturalWidth}`);
  {
    const rec = new Recorder(stage, els, pics);
    rec.start();
    await swipeLeft(stage);
    // The sharp copy arrives ~1.5 s later; keep recording through it.
    await until(() => {
      const last = rec.samples[rec.samples.length - 1];
      return !!last && last.owner === "img" && last.pic === 2 && last.sharp && !last.moving;
    }, 5000);
    await sleep(150);
    rec.stop();
    judge("thumbnail swipe", rec.samples, 1, 2);
    ok("the slow picture ended sharp on the stage", img.naturalWidth > 400, `${img.naturalWidth}`);
  }

  // At rest, the panes are parked a full width off and hold both neighbours.
  const pr = els.prev.getBoundingClientRect();
  const nr = els.next.getBoundingClientRect();
  ok("panes are parked a stage width off screen at rest",
    Math.abs(pr.left + stageBox.width) < 1 && Math.abs(nr.left - stageBox.width) < 1,
    `${pr.left} ${nr.left}`);
  ok("the panes repainted for the new neighbours once at rest",
    els.prev.dataset["path"] === "/pics/p1.png" && els.next.dataset["path"] === "/pics/p3.png",
    `${els.prev.dataset["path"]} ${els.next.dataset["path"]}`);

  // Leave the viewer up when something failed, so it can be inspected.
  if (fail === 0) {
    viewer.close();
    viewer.el.remove();
  }

  const summary = `${pass} passed, ${fail} failed`;
  console.log(summary);
  document.title = summary;
  const out = document.createElement("pre");
  out.textContent = summary;
  document.body.append(out);
}

void run().catch((err) => {
  ok("flash: harness ran without throwing", false, String(err));
  const summary = `${pass} passed, ${fail} failed`;
  console.log(summary);
  document.title = summary;
});
