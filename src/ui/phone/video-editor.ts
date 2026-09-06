/**
 * The video blur workspace: draw a blur on any frame, and it stays on from
 * that moment, follows what it covers, and can be trimmed, moved and re-shaped
 * on a timeline.
 *
 * Why this exists apart from the video editor's cut/rotate/crop sheet: "blur
 * the plate that appears at 0:41" is a different job from trimming. It needs
 * the whole picture visible (the thing being covered is small), a scrubber
 * that lands on a frame, a drawing surface, and a per-layer timeline — none
 * of which fit in a sheet floating over a third of the video. So on both
 * shells this is its own screen: top bar, the frame, a dock underneath, and
 * nothing over the picture but the blur itself.
 *
 * The model is `BlurLayer` from `@core/edit/blur`: one look, a time range,
 * and keyframes. The preview draws the same engine as the still editor over
 * the `<video>` element, so what you see is what the still editor would make
 * of that frame. The export is a box per moment (see `layerSpans`), so an
 * oval or a brush is exported as its bounding box — the handles show that
 * box dashed so nothing about the export is a surprise.
 *
 * Shared between desktop and phone: same DOM, same gestures, one stylesheet
 * with a coarse-pointer budget. The host is the video editor, which lends
 * this its `<video>` element while the workspace is open and takes it back.
 */

import {
  cloneLayer,
  keyframeAt,
  layerLive,
  newLayer,
  nextLayerId,
  rectAt,
  regionAt,
  regionsAt,
  removeKeyframe,
  renderBlur,
  setKeyframe,
  type BlurKind,
  type BlurLayer,
  type Point,
  type Rect,
  type ShapeKind,
} from "@core/edit/blur";
import { followAsync, grayOf, type Gray } from "@core/vision/tracker";
import { formatTime } from "@ui/media";
import { AUTO_CATEGORIES, CATEGORY_NAMES, type AutoCategory } from "@core/vision/autoblur-config";
import { loadAutoPick, saveAutoPick } from "@core/phone/autoblur-prefs";
import { el } from "./dom";
import { icon } from "./icons";

export interface VideoBlurHost {
  /** The editor's preview element; borrowed while the workspace is open. */
  video: HTMLVideoElement;
  /** Source geometry in display orientation, and the clip's length. */
  media(): { width: number; height: number; duration: number; fps: number } | null;
  /** A frame at `t` seconds, `width` px wide, as JPEG or PNG bytes. */
  frameAt(t: number, width: number): Promise<Uint8Array>;
  /** Run the face detector over the clip and answer with layers. */
  scanFaces(): Promise<BlurLayer[]>;
  /**
   * Run the given auto-blur categories (plates, screens, terminals, codes…)
   * over the clip and answer with layers. Optional: a host without it simply
   * has no Auto chip. See `scanClipAuto` in `@core/vision/autoblur-image`.
   */
  scanAuto?(categories: readonly AutoCategory[]): Promise<BlurLayer[]>;
  /** The layer list changed (export label, lossless promise). */
  onChange(): void;
  /** The user pressed Done. */
  onClose(): void;
}

const HISTORY_CAP = 40;
/** Frames per second the tracker looks at. */
const TRACK_RATE = 6;
/** Most frames one Follow will pull from ffmpeg. */
const TRACK_MAX = 400;
/** Width of the frames the tracker sees. Plenty for a box; cheap to decode. */
const TRACK_WIDTH = 192;
const BRUSH_MIN = 0.004;
const BRUSH_MAX = 0.06;
const BRUSH_DEFAULT = 0.4;
const CORNER_PX = 16;

const KINDS: { kind: BlurKind; label: string; icon: string }[] = [
  { kind: "gaussian", label: "Soft", icon: "blur" },
  { kind: "pixelate", label: "Pixels", icon: "pixelate" },
  { kind: "mosaic", label: "Mosaic", icon: "mosaic" },
  { kind: "solid", label: "Black bar", icon: "bar" },
  { kind: "box", label: "Box", icon: "box-blur" },
  { kind: "motion", label: "Motion", icon: "motion" },
  { kind: "radial", label: "Spin", icon: "spin" },
  { kind: "frosted", label: "Frost", icon: "frost" },
];

const SHAPES: { shape: ShapeKind; label: string; icon: string }[] = [
  { shape: "rect", label: "Box", icon: "rect-shape" },
  { shape: "ellipse", label: "Oval", icon: "oval" },
  { shape: "brush", label: "Brush", icon: "brush" },
];

type Drag =
  | { kind: "new"; shape: ShapeKind; origin: Point; layer: BlurLayer | null }
  | { kind: "move"; id: string; last: Point; moved: boolean }
  | { kind: "corner"; id: string; corner: number; last: Point }
  | { kind: "brush"; layer: BlurLayer; fresh: boolean }
  | { kind: "scrub" }
  | { kind: "bar"; id: string; from: number; to: number; x0: number; moved: boolean }
  | { kind: "handle"; id: string; side: "from" | "to" };

export class VideoBlur {
  readonly root = el<"div">("div.vb");
  layers: BlurLayer[] = [];

  private readonly top = el<"div">("div.vb-top");
  private readonly title = el<"div">("div.vb-title", { text: "Blur" });
  private readonly note = el<"div">("div.vb-note");
  private readonly stage = el<"div">("div.vb-stage");
  private readonly canvas = el<"canvas">("canvas.vb-canvas");
  private readonly dock = el<"div">("div.vb-dock");
  private readonly ruler = el<"div">("div.vb-ruler");
  private readonly playhead = el<"i">("i.vb-playhead");
  private readonly rows = el<"div">("div.vb-rows");
  private readonly timeline = el<"div">("div.vb-timeline");
  private readonly clock = el<"div">("div.vb-clock", { text: "0:00" });
  private readonly strip = el<"div">("div.vb-strip");
  private readonly playBtn: HTMLButtonElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;

  private selected: string | null = null;
  private shape: ShapeKind = "rect";
  private brush = BRUSH_DEFAULT;
  private drag: Drag | null = null;
  private history: BlurLayer[][] = [];
  private future: BlurLayer[][] = [];
  private snapshot: BlurLayer[] | null = null;
  private raf = 0;
  private trackToken = 0;
  private tracking = false;
  private scanning = false;
  private videoHome: { parent: Node; next: Node | null; transform: string; w: string; h: string } | null = null;
  private strips: "main" | "layer" | "style" | "strength" | "shape" | "layers" | "name" | "auto" = "main";
  /** Categories ticked in the Auto strip; loaded on first open, remembered after. */
  private autoPick: Set<AutoCategory> | null = null;
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);
  private readonly onResize = (): void => this.paint();
  private counter = 0;

  constructor(private readonly host: VideoBlurHost) {
    this.root.hidden = true;
    this.playBtn = this.btn("play", "Play / pause  (space)", () => this.toggle());
    this.undoBtn = this.btn("undo", "Undo  (ctrl+Z)", () => this.undo());
    this.redoBtn = this.btn("redo", "Redo  (ctrl+shift+Z)", () => this.redo());
    this.top.append(
      this.btn("check", "Done — back to the editor", () => this.close()),
      this.title,
      this.note,
      this.undoBtn,
      this.redoBtn,
    );
    this.stage.append(this.canvas);
    this.ruler.append(this.playhead);
    this.timeline.append(this.ruler, this.rows);
    const transport = el<"div">("div.vb-transport");
    transport.append(
      this.btn("chevron-left", "Back one second  (shift+←)", () => this.nudge(-1)),
      this.btn("minus", "Back one frame  (←)", () => this.nudge(-this.frame())),
      this.playBtn,
      this.btn("plus", "Forward one frame  (→)", () => this.nudge(this.frame())),
      this.btn("chevron-right", "Forward one second  (shift+→)", () => this.nudge(1)),
      this.clock,
    );
    this.dock.append(this.timeline, transport, this.strip);
    this.root.append(this.top, this.stage, this.dock);
    this.wireStage();
    this.wireTimeline();
    this.host.video.addEventListener("timeupdate", () => { if (!this.root.hidden) this.tick(); });
    this.host.video.addEventListener("seeked", () => { if (!this.root.hidden) { this.tick(); this.paint(); } });
    this.host.video.addEventListener("play", () => { if (!this.root.hidden) this.loop(); });
    this.host.video.addEventListener("pause", () => { if (!this.root.hidden) this.paint(); });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Borrow the video, show the screen. */
  open(): void {
    const v = this.host.video;
    if (!this.videoHome) {
      this.videoHome = {
        parent: v.parentNode!,
        next: v.nextSibling,
        transform: v.style.transform,
        w: v.style.width,
        h: v.style.height,
      };
      v.style.transform = "";
      v.style.width = "";
      v.style.height = "";
      this.stage.insertBefore(v, this.canvas);
    }
    this.root.hidden = false;
    this.selected = null;
    this.showStrip("main");
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
    this.paint();
    this.paintTimeline();
  }

  close(): void {
    if (this.root.hidden) return;
    this.trackToken++;
    this.tracking = false;
    this.host.video.pause();
    const home = this.videoHome;
    if (home) {
      const v = this.host.video;
      v.style.transform = home.transform;
      v.style.width = home.w;
      v.style.height = home.h;
      home.parent.insertBefore(v, home.next);
      this.videoHome = null;
    }
    this.root.hidden = true;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.host.onClose();
  }

  /** Forget everything: a new clip was opened. */
  reset(): void {
    this.trackToken++;
    this.tracking = false;
    this.layers = [];
    this.history = [];
    this.future = [];
    this.selected = null;
    this.counter = 0;
    if (!this.root.hidden) {
      this.paint();
      this.paintTimeline();
      this.showStrip("main");
    }
  }

  /** Layers from outside (the face scan on the editor's own button). */
  add(layers: BlurLayer[]): void {
    if (layers.length === 0) return;
    this.commit();
    for (const l of layers) {
      if (!l.name) l.name = this.nextName(l.region.shape);
      this.layers.push(l);
    }
    this.changed();
  }

  /** Drop every layer of one source (the scanner's faces, say). Undoable. */
  removeSource(source: BlurLayer["source"]): number {
    const gone = this.layers.filter((l) => l.source === source);
    if (gone.length === 0) return 0;
    this.commit();
    this.layers = this.layers.filter((l) => l.source !== source);
    if (this.selected && gone.some((l) => l.id === this.selected)) this.selected = null;
    this.changed();
    return gone.length;
  }

  private nextName(shape: ShapeKind): string {
    this.counter++;
    const base = shape === "brush" ? "brush" : shape === "ellipse" ? "oval" : "blur";
    return `${base} ${this.counter}`;
  }

  // ── Time ──────────────────────────────────────────────────────────────────

  private get t(): number {
    return this.host.video.currentTime;
  }

  private get duration(): number {
    return this.host.media()?.duration || this.host.video.duration || 0;
  }

  private frame(): number {
    return 1 / (this.host.media()?.fps || 30);
  }

  private seek(t: number): void {
    const d = this.duration;
    this.host.video.currentTime = Math.max(0, Math.min(d > 0 ? d : t, t));
    this.tick();
    this.paint();
  }

  private nudge(by: number): void {
    this.host.video.pause();
    this.seek(this.t + by);
  }

  private toggle(): void {
    const v = this.host.video;
    if (v.paused) void v.play();
    else v.pause();
  }

  private loop(): void {
    cancelAnimationFrame(this.raf);
    const step = (): void => {
      if (this.root.hidden || this.host.video.paused) {
        this.raf = 0;
        this.paint();
        return;
      }
      this.paint();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private tick(): void {
    const d = this.duration;
    this.clock.textContent = `${formatTime(this.t)} / ${formatTime(d)}`;
    this.playhead.style.left = `${d > 0 ? (this.t / d) * 100 : 0}%`;
    this.playBtn.replaceChildren(icon(this.host.video.paused ? "play" : "pause"));
    if (this.strips === "layer") this.refreshLayerStrip();
  }

  // ── Undo ──────────────────────────────────────────────────────────────────

  private clone(): BlurLayer[] {
    return this.layers.map((l) => cloneLayer(l));
  }

  /** Take a snapshot now; `commit()` files it as one undo step. */
  private snap(): void {
    if (!this.snapshot) this.snapshot = this.clone();
  }

  private commit(): void {
    const before = this.snapshot ?? this.clone();
    this.snapshot = null;
    this.history.push(before);
    if (this.history.length > HISTORY_CAP) this.history.shift();
    this.future = [];
    this.paintUndo();
  }

  private discard(): void {
    this.snapshot = null;
  }

  undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.clone());
    this.layers = prev;
    if (this.selected && !this.layers.some((l) => l.id === this.selected)) this.selected = null;
    this.changed();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.clone());
    this.layers = next;
    if (this.selected && !this.layers.some((l) => l.id === this.selected)) this.selected = null;
    this.changed();
  }

  private paintUndo(): void {
    this.undoBtn.disabled = this.history.length === 0;
    this.redoBtn.disabled = this.future.length === 0;
  }

  private changed(): void {
    this.paint();
    this.paintTimeline();
    this.paintUndo();
    this.showStrip(this.selected ? (this.strips === "main" ? "layer" : this.strips) : "main");
    this.host.onChange();
  }

  // ── Layers ────────────────────────────────────────────────────────────────

  private get sel(): BlurLayer | null {
    return this.layers.find((l) => l.id === this.selected) ?? null;
  }

  select(id: string | null): void {
    this.selected = id;
    this.showStrip(id ? "layer" : "main");
    this.paint();
    this.paintTimeline();
  }

  private create(shape: ShapeKind, rect: Rect): BlurLayer {
    const layer = newLayer(shape, this.t, this.duration || this.t, rect, {
      id: nextLayerId(),
      name: this.nextName(shape),
    });
    return layer;
  }

  private remove(id: string): void {
    this.commit();
    this.layers = this.layers.filter((l) => l.id !== id);
    if (this.selected === id) this.selected = null;
    this.changed();
  }

  private duplicate(l: BlurLayer): void {
    this.commit();
    const copy = cloneLayer(l, nextLayerId());
    copy.name = this.nextName(l.region.shape);
    this.layers.push(copy);
    this.selected = copy.id;
    this.changed();
  }

  /** Move the layer's current box, recording it as a keyframe at `t`. */
  private place(l: BlurLayer, rect: Rect): void {
    const r = { ...rect };
    r.w = Math.max(0.01, r.w);
    r.h = Math.max(0.01, r.h);
    setKeyframe(l, { t: this.t, rect: r, origin: "user" });
    if (l.keys.length === 1) l.region.rect = { ...r };
    if (!l.wholeClip) {
      if (this.t < l.from) l.from = this.t;
      if (this.t > l.to) l.to = this.t;
    }
  }

  private setStart(l: BlurLayer): void {
    this.commit();
    l.from = this.t;
    if (l.to < l.from) l.to = l.from;
    l.wholeClip = false;
    this.changed();
  }

  private setEnd(l: BlurLayer): void {
    this.commit();
    l.to = this.t;
    if (l.from > l.to) l.from = l.to;
    l.wholeClip = false;
    this.changed();
  }

  private toggleWhole(l: BlurLayer): void {
    this.commit();
    l.wholeClip = !l.wholeClip;
    this.changed();
  }

  private addKey(l: BlurLayer): void {
    this.commit();
    setKeyframe(l, { t: this.t, rect: rectAt(l, this.t), origin: "user" });
    this.changed();
  }

  private dropKey(l: BlurLayer): void {
    const k = keyframeAt(l, this.t);
    if (!k) return;
    this.commit();
    removeKeyframe(l, k.t);
    this.changed();
  }

  private setKind(l: BlurLayer, kind: BlurKind): void {
    this.commit();
    l.region.kind = kind;
    this.changed();
  }

  private setShape(l: BlurLayer, shape: ShapeKind): void {
    if (l.region.shape === shape) return;
    this.commit();
    l.region.shape = shape;
    if (shape !== "brush") l.region.strokes = [];
    this.changed();
  }

  // ── Tracking ──────────────────────────────────────────────────────────────

  /**
   * Follow the selected layer's box from now to the next user keyframe (or
   * the end of the clip, extending the layer), or backwards to the previous
   * one (or the start). The frame it is followed from becomes a user
   * keyframe, so a second Follow re-anchors rather than compounding drift.
   */
  private async follow(l: BlurLayer, dir: 1 | -1): Promise<void> {
    if (this.tracking) return;
    const media = this.host.media();
    if (!media) return;
    const token = ++this.trackToken;
    this.tracking = true;
    this.host.video.pause();
    const t0 = this.t;
    this.commit();
    const anchor = rectAt(l, t0);
    setKeyframe(l, { t: t0, rect: anchor, origin: "user" });
    const users = l.keys.filter((k) => k.origin === "user").map((k) => k.t);
    const end = dir > 0
      ? Math.min(media.duration, ...users.filter((u) => u > t0 + 1e-3), Infinity)
      : Math.max(0, ...users.filter((u) => u < t0 - 1e-3), -Infinity);
    const span = Math.abs(end - t0);
    const n = Math.min(TRACK_MAX, Math.max(1, Math.round(span * TRACK_RATE)));
    const step = n > 0 ? span / n : 0;
    const times = [t0];
    for (let i = 1; i <= n && step > 0; i++) times.push(t0 + dir * step * i);
    if (span > 0 && times.length > 1) times[times.length - 1] = end;

    const wanted = new Set(times.slice(1));
    // Track-origin keys in the stretch are regenerated; user ones stay.
    l.keys = l.keys.filter((k) => k.origin === "user" ||
      (dir > 0 ? !(k.t > t0 && k.t <= end) : !(k.t < t0 && k.t >= end)));
    delete l.lostAt;
    this.showStrip("layer");
    this.say(`Following ${l.name}…`);

    let done = 0;
    const result = await followAsync(
      times,
      (t) => this.sample(t, media.width, token),
      anchor,
      {},
      (t, rect) => {
        if (token !== this.trackToken) return false;
        done++;
        if (wanted.has(t)) setKeyframe(l, { t, rect, origin: "track" });
        if (done % 3 === 0) {
          this.say(`Following ${l.name}… ${Math.round((done / n) * 100)}%`);
          this.paintTimeline();
        }
        return true;
      },
    );
    if (token !== this.trackToken) return;
    this.tracking = false;

    const found = result.found;
    const last = found[found.length - 1];
    if (last) {
      if (dir > 0) l.to = Math.max(l.to, Math.min(media.duration, last.t));
      else l.from = Math.min(l.from, Math.max(0, last.t));
    }
    if (result.lostAt !== null) {
      l.lostAt = result.lostAt;
      const later = dir > 0
        ? users.some((u) => u > result.lostAt!)
        : users.some((u) => u < result.lostAt!);
      // Lost and nothing anchors it further on: the layer ends here, and the
      // bar carries a marker saying why. Covering an extra fraction of a
      // second past the last sighting is the cheap side to err on.
      if (!later) {
        if (dir > 0) l.to = Math.min(media.duration, result.lostAt + 0.25);
        else l.from = Math.max(0, result.lostAt - 0.25);
      }
      this.say(`Lost ${l.name} at ${formatTime(result.lostAt)} — the blur ends there. Scrub to it and drag the box to pick it up again.`, true);
    } else if (found.length > 1) {
      this.say(`${l.name} followed to ${formatTime(last!.t)}.`);
    } else {
      this.say(`Nothing to follow: ${l.name} already ends here.`);
    }
    this.changed();
  }

  private readonly frames = new Map<number, Gray>();

  private async sample(t: number, srcWidth: number, token: number): Promise<Gray | null> {
    if (token !== this.trackToken) return null;
    const key = Math.round(t * 1000);
    const hit = this.frames.get(key);
    if (hit) return hit;
    try {
      const bytes = await this.host.frameAt(t, Math.min(TRACK_WIDTH, srcWidth));
      const g = await decode(bytes);
      if (this.frames.size > 600) this.frames.clear();
      this.frames.set(key, g);
      return g;
    } catch {
      return null;
    }
  }

  private async faces(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.say("Looking for faces…");
    this.showStrip("main");
    try {
      const found = await this.host.scanFaces();
      if (found.length === 0) this.say("No faces found.", true);
      else {
        this.add(found);
        this.say(`${found.length} face${found.length === 1 ? "" : "s"} found — each is a layer now.`);
      }
    } catch (e) {
      this.say(`Face scan failed — ${String(e)}`, true);
    } finally {
      this.scanning = false;
      this.showStrip(this.selected ? "layer" : "main");
    }
  }

  private async auto(categories: readonly AutoCategory[]): Promise<void> {
    if (this.scanning || !this.host.scanAuto || categories.length === 0) return;
    this.scanning = true;
    this.say("Auto-blur: looking…");
    this.showStrip("main");
    try {
      const found = await this.host.scanAuto(categories);
      if (found.length === 0) this.say("Nothing found.", true);
      else {
        this.add(found);
        this.say(`${found.length} blur${found.length === 1 ? "" : "s"} added — each is a layer now.`);
      }
    } catch (e) {
      this.say(`Auto-blur failed — ${String(e)}`, true);
    } finally {
      this.scanning = false;
      this.showStrip(this.selected ? "layer" : "main");
    }
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  /** The letterboxed picture inside the video element, in page pixels. */
  picture(): DOMRect | null {
    const v = this.host.video;
    const el = v.getBoundingClientRect();
    const vw = v.videoWidth || this.host.media()?.width || 0;
    const vh = v.videoHeight || this.host.media()?.height || 0;
    if (!vw || !vh || el.width === 0) return null;
    const scale = Math.min(el.width / vw, el.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    return new DOMRect(el.left + (el.width - w) / 2, el.top + (el.height - h) / 2, w, h);
  }

  private fromScreen(x: number, y: number): Point {
    const p = this.picture();
    if (!p) return { x: 0, y: 0 };
    return { x: (x - p.left) / p.width, y: (y - p.top) / p.height };
  }

  paint(): void {
    if (this.root.hidden) return;
    const pic = this.picture();
    const c = this.canvas;
    if (!pic) {
      c.width = c.height = 0;
      return;
    }
    const stage = this.stage.getBoundingClientRect();
    c.style.left = `${pic.left - stage.left}px`;
    c.style.top = `${pic.top - stage.top}px`;
    c.style.width = `${pic.width}px`;
    c.style.height = `${pic.height}px`;
    const v = this.host.video;
    const vw = v.videoWidth || this.host.media()?.width || 0;
    const vh = v.videoHeight || this.host.media()?.height || 0;
    if (!vw || !vh) {
      c.width = c.height = 0;
      return;
    }
    const t = this.t;
    const regions = regionsAt(this.layers, t);
    let drew = false;
    // The engine renders at source size, as the still editor does, so the
    // preview is pixel-for-pixel what that editor would make of the frame.
    if (regions.length > 0 && v.readyState >= 2) {
      try {
        renderBlur(c, v, vw, vh, regions);
        drew = true;
      } catch {
        // A frame that is not decodable yet is not an error; it repaints on seek.
      }
    }
    if (!drew) {
      if (c.width !== vw || c.height !== vh) {
        c.width = vw;
        c.height = vh;
      }
      c.getContext("2d")!.clearRect(0, 0, vw, vh);
    }
    const sel = this.sel;
    if (sel) this.drawHandles(c.getContext("2d")!, sel, t, vw, vh);
  }

  private drawHandles(ctx: CanvasRenderingContext2D, l: BlurLayer, t: number, bw: number, bh: number): void {
    const r = rectAt(l, t);
    const live = layerLive(l, t);
    const x = r.x * bw;
    const y = r.y * bh;
    const w = r.w * bw;
    const h = r.h * bh;
    const line = Math.max(2, Math.round(Math.min(bw, bh) / 300));
    ctx.save();
    ctx.lineWidth = line;
    ctx.setLineDash([line * 3, line * 3]);
    ctx.strokeStyle = live ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.4)";
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    if (live) {
      const s = Math.max(6, Math.round(Math.min(bw, bh) / 60));
      ctx.fillStyle = "#fff";
      const corners: [number, number][] = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
      for (const [cx, cy] of corners) {
        ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
      }
      // A diamond at the top says "this frame is a keyframe".
      if (keyframeAt(l, t)) {
        const d = s * 0.9;
        const mx = x + w / 2;
        ctx.beginPath();
        ctx.moveTo(mx, y - d * 2);
        ctx.lineTo(mx + d, y - d);
        ctx.lineTo(mx, y);
        ctx.lineTo(mx - d, y - d);
        ctx.closePath();
        ctx.fillStyle = "#ffd54f";
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private say(msg: string, bad = false): void {
    this.note.textContent = msg;
    this.note.classList.toggle("bad", bad);
  }

  // ── Stage gestures ────────────────────────────────────────────────────────

  private cornerAt(l: BlurLayer, p: Point): number {
    const pic = this.picture();
    if (!pic) return -1;
    const r = rectAt(l, this.t);
    const tol = { x: CORNER_PX / pic.width, y: CORNER_PX / pic.height };
    const corners: Point[] = [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x, y: r.y + r.h },
      { x: r.x + r.w, y: r.y + r.h },
    ];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(corners[i]!.x - p.x) <= tol.x && Math.abs(corners[i]!.y - p.y) <= tol.y) return i;
    }
    return -1;
  }

  private wireStage(): void {
    const s = this.stage;
    s.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.tracking) return;
      const pic = this.picture();
      if (!pic) return;
      if (e.clientX < pic.left || e.clientX > pic.right || e.clientY < pic.top || e.clientY > pic.bottom) return;
      this.host.video.pause();
      s.setPointerCapture(e.pointerId);
      e.preventDefault();
      const p = this.fromScreen(e.clientX, e.clientY);
      const t = this.t;
      const sel = this.sel;
      if (sel && layerLive(sel, t)) {
        const c = this.cornerAt(sel, p);
        if (c >= 0) {
          this.snap();
          this.drag = { kind: "corner", id: sel.id, corner: c, last: p };
          return;
        }
      }
      if (sel && sel.region.shape === "brush" && layerLive(sel, t) && this.shape === "brush") {
        // Painting more onto the selected brush layer.
        this.snap();
        sel.region.strokes.push({ width: this.brushWidth(), points: [p], erase: false });
        this.drag = { kind: "brush", layer: sel, fresh: false };
        this.paint();
        return;
      }
      const hit = regionAt(regionsAt(this.layers, t), p);
      if (hit) {
        this.selected = hit.id;
        this.showStrip("layer");
        this.paintTimeline();
        this.snap();
        this.drag = { kind: "move", id: hit.id, last: p, moved: false };
        this.paint();
        return;
      }
      if (this.shape === "brush") {
        this.snap();
        const layer = this.create("brush", { x: p.x, y: p.y, w: 0.01, h: 0.01 });
        layer.region.strokes = [{ width: this.brushWidth(), points: [p], erase: false }];
        this.layers.push(layer);
        this.selected = layer.id;
        this.drag = { kind: "brush", layer, fresh: true };
        this.paint();
        return;
      }
      this.snap();
      this.drag = { kind: "new", shape: this.shape, origin: p, layer: null };
    });
    s.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) return;
      const p = this.fromScreen(e.clientX, e.clientY);
      const q = { x: clamp01(p.x), y: clamp01(p.y) };
      if (d.kind === "new") {
        const rect = norm(d.origin, q);
        if (!d.layer) {
          if (rect.w < 0.01 && rect.h < 0.01) return;
          d.layer = this.create(d.shape, rect);
          this.layers.push(d.layer);
          this.selected = d.layer.id;
        } else {
          d.layer.keys[0]!.rect = rect;
          d.layer.region.rect = { ...rect };
        }
        this.paint();
      } else if (d.kind === "move") {
        const l = this.layers.find((x) => x.id === d.id);
        if (!l) return;
        const r = rectAt(l, this.t);
        const dx = p.x - d.last.x;
        const dy = p.y - d.last.y;
        if (!d.moved && Math.hypot(dx, dy) < 0.004) return;
        d.moved = true;
        d.last = p;
        this.place(l, { ...r, x: r.x + dx, y: r.y + dy });
        this.paint();
      } else if (d.kind === "corner") {
        const l = this.layers.find((x) => x.id === d.id);
        if (!l) return;
        const r = rectAt(l, this.t);
        const x1 = r.x + r.w;
        const y1 = r.y + r.h;
        const left = d.corner === 0 || d.corner === 2;
        const top = d.corner === 0 || d.corner === 1;
        const nx0 = left ? Math.min(q.x, x1 - 0.01) : r.x;
        const nx1 = left ? x1 : Math.max(q.x, r.x + 0.01);
        const ny0 = top ? Math.min(q.y, y1 - 0.01) : r.y;
        const ny1 = top ? y1 : Math.max(q.y, r.y + 0.01);
        this.place(l, { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 });
        this.paint();
      } else if (d.kind === "brush") {
        const stroke = d.layer.region.strokes[d.layer.region.strokes.length - 1]!;
        const lastP = stroke.points[stroke.points.length - 1]!;
        if (Math.hypot(p.x - lastP.x, p.y - lastP.y) < 0.003) return;
        stroke.points.push(p);
        this.fitBrush(d.layer);
        this.paint();
      }
    });
    const up = (e: PointerEvent): void => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      try { s.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (d.kind === "new") {
        if (!d.layer) {
          // A tap on empty picture: deselect.
          this.discard();
          if (this.selected) this.select(null);
          return;
        }
        this.commit();
        this.changed();
      } else if (d.kind === "move") {
        if (!d.moved) {
          this.discard();
          this.showStrip("layer");
          return;
        }
        this.commit();
        this.changed();
      } else if (d.kind === "corner") {
        this.commit();
        this.changed();
      } else if (d.kind === "brush") {
        const stroke = d.layer.region.strokes[d.layer.region.strokes.length - 1]!;
        if (stroke.points.length < 2) {
          // A tap, not a stroke: it deselects, the same as with the other tools.
          if (d.fresh) this.layers = this.layers.filter((l) => l !== d.layer);
          else d.layer.region.strokes.pop();
          this.discard();
          this.select(null);
          return;
        }
        this.fitBrush(d.layer);
        this.commit();
        this.changed();
      }
    };
    s.addEventListener("pointerup", up);
    s.addEventListener("pointercancel", up);
  }

  private brushWidth(): number {
    return BRUSH_MIN + (BRUSH_MAX - BRUSH_MIN) * this.brush;
  }

  /** The brush layer's box is the strokes' extent; keyframes ride on it. */
  private fitBrush(l: BlurLayer): void {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const s of l.region.strokes) {
      for (const p of s.points) {
        x0 = Math.min(x0, p.x - s.width / 2);
        y0 = Math.min(y0, p.y - s.width / 2);
        x1 = Math.max(x1, p.x + s.width / 2);
        y1 = Math.max(y1, p.y + s.width / 2);
      }
    }
    if (x1 <= x0 || y1 <= y0) return;
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    // Strokes are stored relative to `region.rect`; moving the anchor moves
    // every keyframe by the same offset so the drawn frame still lines up.
    const old = l.region.rect;
    const dx = rect.x - old.x;
    const dy = rect.y - old.y;
    l.region.rect = rect;
    for (const k of l.keys) k.rect = { x: k.rect.x + dx, y: k.rect.y + dy, w: rect.w, h: rect.h };
  }

  // ── Timeline ──────────────────────────────────────────────────────────────

  private paintTimeline(): void {
    const d = this.duration;
    this.rows.replaceChildren();
    for (const l of this.layers) {
      const row = el<"div">("div.vb-row", { "data-id": l.id });
      row.classList.toggle("on", l.id === this.selected);
      row.classList.toggle("off", !l.enabled);
      const from = l.wholeClip ? 0 : l.from;
      const to = l.wholeClip ? d : l.to;
      const bar = el<"div">("div.vb-bar", { "data-id": l.id, title: l.name });
      bar.style.left = `${d > 0 ? (from / d) * 100 : 0}%`;
      bar.style.width = `${d > 0 ? Math.max(0.6, ((to - from) / d) * 100) : 100}%`;
      bar.append(
        el("i.vb-handle.l", { "data-side": "from", "data-id": l.id }),
        el("span.vb-bar-name", { text: l.name }),
        el("i.vb-handle.r", { "data-side": "to", "data-id": l.id }),
      );
      if (l.wholeClip) bar.classList.add("whole");
      for (const k of l.keys) {
        const dot = el("i.vb-key", { "data-t": String(k.t), "data-id": l.id, title: `Keyframe at ${formatTime(k.t)}` });
        dot.classList.toggle("user", k.origin === "user");
        dot.style.left = `${d > 0 ? (k.t / d) * 100 : 0}%`;
        row.append(dot);
      }
      if (l.lostAt !== undefined) {
        const mark = el("i.vb-lost", { title: `Lost track at ${formatTime(l.lostAt)}` });
        mark.style.left = `${d > 0 ? (l.lostAt / d) * 100 : 0}%`;
        row.append(mark);
      }
      row.append(bar);
      this.rows.append(row);
    }
    this.ruler.replaceChildren(this.playhead);
    if (d > 0) {
      const n = Math.min(12, Math.max(2, Math.floor(d)));
      for (let i = 0; i <= n; i++) {
        const t = (d * i) / n;
        const tick = el("i.vb-tick", { text: i % 2 === 0 || n <= 6 ? formatTime(t) : "" });
        tick.style.left = `${(i / n) * 100}%`;
        this.ruler.append(tick);
      }
    }
    this.tick();
  }

  private timeAt(clientX: number): number {
    const r = this.timeline.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return f * this.duration;
  }

  private wireTimeline(): void {
    const tl = this.timeline;
    tl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.tracking) return;
      const target = e.target as HTMLElement;
      tl.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.host.video.pause();
      const handle = target.closest<HTMLElement>(".vb-handle");
      const key = target.closest<HTMLElement>(".vb-key");
      const bar = target.closest<HTMLElement>(".vb-bar");
      if (handle) {
        const id = handle.dataset["id"]!;
        this.selected = id;
        this.snap();
        this.drag = { kind: "handle", id, side: handle.dataset["side"] as "from" | "to" };
        this.showStrip("layer");
        this.paintTimeline();
        return;
      }
      if (key) {
        this.selected = key.dataset["id"]!;
        this.drag = { kind: "scrub" };
        this.seek(Number(key.dataset["t"]));
        this.showStrip("layer");
        this.paintTimeline();
        return;
      }
      if (bar) {
        const id = bar.dataset["id"]!;
        const l = this.layers.find((x) => x.id === id);
        if (!l) return;
        this.selected = id;
        this.snap();
        this.drag = { kind: "bar", id, from: l.from, to: l.to, x0: e.clientX, moved: false };
        this.showStrip("layer");
        this.paintTimeline();
        this.paint();
        return;
      }
      this.drag = { kind: "scrub" };
      this.seek(this.timeAt(e.clientX));
    });
    tl.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) return;
      if (d.kind === "scrub") {
        this.seek(this.timeAt(e.clientX));
      } else if (d.kind === "handle") {
        const l = this.layers.find((x) => x.id === d.id);
        if (!l) return;
        const t = this.timeAt(e.clientX);
        l.wholeClip = false;
        if (d.side === "from") l.from = Math.min(t, l.to);
        else l.to = Math.max(t, l.from);
        this.seek(t);
        this.paintTimeline();
      } else if (d.kind === "bar") {
        const l = this.layers.find((x) => x.id === d.id);
        if (!l) return;
        const r = tl.getBoundingClientRect();
        const dt = ((e.clientX - d.x0) / r.width) * this.duration;
        if (!d.moved && Math.abs(e.clientX - d.x0) < 6) return;
        d.moved = true;
        const len = d.to - d.from;
        let from = d.from + dt;
        from = Math.max(0, Math.min(this.duration - len, from));
        // Shifting the whole layer in time shifts its keyframes with it.
        const shift = from - l.from;
        l.from = from;
        l.to = from + len;
        l.wholeClip = false;
        for (const k of l.keys) k.t += shift;
        if (l.lostAt !== undefined) l.lostAt += shift;
        this.paintTimeline();
        this.paint();
      }
    });
    const up = (e: PointerEvent): void => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      try { tl.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (d.kind === "handle") {
        this.commit();
        this.changed();
      } else if (d.kind === "bar") {
        if (d.moved) {
          this.commit();
          this.changed();
        } else {
          this.discard();
          this.showStrip("layer");
        }
      }
    };
    tl.addEventListener("pointerup", up);
    tl.addEventListener("pointercancel", up);
  }

  // ── Strips ────────────────────────────────────────────────────────────────

  private showStrip(which: typeof this.strips): void {
    const sel = this.sel;
    if (which !== "main" && which !== "layers" && which !== "auto" && !sel) which = "main";
    this.strips = which;
    const kids: HTMLElement[] = [];
    const back = (): HTMLElement => this.chip("chevron-left", "Back", () => this.showStrip(sel ? "layer" : "main"), "Back to the layer");
    if (which === "main") {
      for (const s of SHAPES) {
        const c = this.chip(s.icon, s.label, () => { this.shape = s.shape; this.showStrip("main"); },
          `Draw a ${s.label.toLowerCase()} on the picture — it is blurred from this moment on`);
        c.setAttribute("aria-pressed", String(this.shape === s.shape));
        kids.push(c);
      }
      if (this.shape === "brush") kids.push(this.slider("Size", this.brush, 0, 1, 0.01, (v) => { this.brush = v; }));
      kids.push(this.divider());
      const faces = this.chip("face", this.scanning ? "Looking…" : "Faces", () => void this.faces(), "Find every face in the clip and blur each one");
      faces.disabled = this.scanning;
      kids.push(faces);
      if (this.host.scanAuto) {
        const auto = this.chip("sparkles", this.scanning ? "Looking…" : "Auto", () => this.showStrip("auto"), "Pick what to find — plates, screens, terminals, codes, text — and blur each one through the clip");
        auto.disabled = this.scanning;
        kids.push(auto);
      }
      const n = this.layers.length;
      const layers = this.chip("layers", n ? `Layers ${n}` : "Layers", () => this.showStrip("layers"), "Every blur on this clip");
      layers.disabled = n === 0;
      kids.push(layers);
    } else if (which === "layers") {
      kids.push(this.chip("chevron-left", "Back", () => this.showStrip(sel ? "layer" : "main"), "Back"));
      for (const l of this.layers) {
        const c = this.chip(l.region.shape === "brush" ? "brush" : l.region.shape === "ellipse" ? "oval" : "rect-shape",
          l.name, () => { this.selected = l.id; this.seek(Math.max(l.from, Math.min(l.to, this.t))); this.showStrip("layer"); this.paintTimeline(); this.paint(); },
          `Select ${l.name}`);
        c.classList.add("vb-layer");
        c.setAttribute("aria-pressed", String(l.id === this.selected));
        if (!l.enabled) c.classList.add("off");
        const x = el("span.vb-chip-x", { title: `Delete ${l.name}` });
        x.append(icon("x"));
        x.addEventListener("click", (e) => { e.stopPropagation(); this.remove(l.id); this.showStrip("layers"); });
        c.append(x);
        kids.push(c);
      }
    } else if (which === "layer" && sel) {
      const live = layerLive(sel, this.t);
      // Only a keyframe the user pinned offers "remove"; over a tracked one
      // the chip pins, which turns it into an anchor the tracker respects.
      const found = keyframeAt(sel, this.t);
      const key = found && found.origin === "user" ? found : null;
      kids.push(this.chip("chevron-left", "", () => this.select(null), "Done with this layer"));
      const fwd = this.chip("zap", this.tracking ? "Following…" : "Follow", () => void this.follow(sel, 1),
        "Follow what this covers forward from here, to the end or the next keyframe you set");
      fwd.disabled = this.tracking;
      kids.push(fwd);
      const bwd = this.chip("rotate-ccw", "Back", () => void this.follow(sel, -1),
        "Follow what this covers backwards from here, to the start or the previous keyframe");
      bwd.disabled = this.tracking;
      kids.push(bwd);
      kids.push(this.divider());
      kids.push(key
        ? this.chip("minus", "Key", () => this.dropKey(sel), "Remove the keyframe at this moment")
        : this.chip("plus", "Key", () => this.addKey(sel), "Pin the box where it is at this moment"));
      kids.push(this.chip("chevron-left", "Start", () => this.setStart(sel), "Start this blur at this moment"));
      kids.push(this.chip("chevron-right", "End", () => this.setEnd(sel), "End this blur at this moment"));
      const whole = this.chip("film", "Whole clip", () => this.toggleWhole(sel), "Cover the whole clip, start to end");
      whole.setAttribute("aria-pressed", String(sel.wholeClip));
      kids.push(whole);
      kids.push(this.divider());
      kids.push(this.chip(KINDS.find((k) => k.kind === sel.region.kind)?.icon ?? "blur", "Style", () => this.showStrip("style"), "How it is hidden: soft, pixels, black bar…"));
      kids.push(this.chip("gauge", "Strength", () => this.showStrip("strength"), "How heavy the blur is"));
      kids.push(this.chip(SHAPES.find((s) => s.shape === sel.region.shape)?.icon ?? "rect-shape", "Shape", () => this.showStrip("shape"), "Box, oval or brush"));
      kids.push(this.chip("rename", "Name", () => this.showStrip("name"), "Name this layer"));
      kids.push(this.divider());
      const eye = this.chip(sel.enabled ? "eye" : "eye-off", sel.enabled ? "On" : "Off", () => { this.commit(); sel.enabled = !sel.enabled; this.changed(); }, "Switch this blur off without deleting it");
      kids.push(eye);
      kids.push(this.chip("copy", "Copy", () => this.duplicate(sel), "Duplicate this layer"));
      kids.push(this.chip("trash", "Delete", () => this.remove(sel.id), "Delete this layer"));
      if (!live) kids[1]!.title += " (scrub inside the bar first)";
    } else if (which === "style" && sel) {
      kids.push(back());
      for (const k of KINDS) {
        const c = this.chip(k.icon, k.label, () => { this.setKind(sel, k.kind); this.showStrip("style"); }, k.label);
        c.setAttribute("aria-pressed", String(sel.region.kind === k.kind));
        kids.push(c);
      }
    } else if (which === "strength" && sel) {
      kids.push(back());
      kids.push(this.slider("Strength", sel.region.amount, 0.005, 0.25, 0.005, (v, done) => {
        if (done) this.commit(); else this.snap();
        sel.region.amount = v;
        this.paint();
        if (done) this.changed();
      }, (v) => `${Math.round(v * 400)}%`));
    } else if (which === "shape" && sel) {
      kids.push(back());
      for (const s of SHAPES) {
        const c = this.chip(s.icon, s.label, () => { this.setShape(sel, s.shape); this.shape = s.shape; this.showStrip("shape"); }, s.label);
        c.setAttribute("aria-pressed", String(sel.region.shape === s.shape));
        kids.push(c);
      }
      if (sel.region.shape === "brush") {
        kids.push(this.slider("Size", this.brush, 0, 1, 0.01, (v) => { this.brush = v; }));
      }
    } else if (which === "auto") {
      // Same shape as the photo editor's sheet: nothing pre-ticked the first
      // time, the pick remembered after, and every tap updates the chips in
      // place -- a rebuild would reset the strip's scroll and throw the row
      // back to its left edge on every tick.
      if (!this.autoPick) this.autoPick = loadAutoPick();
      const pick = this.autoPick;
      kids.push(this.chip("chevron-left", "Back", () => this.showStrip("main"), "Back to the tools"));
      const go = this.chip("sparkles", `Go ${pick.size}`, () => void this.auto([...AUTO_CATEGORIES].filter((c) => pick.has(c))), "Look through the clip for the ticked categories");
      go.dataset["tool"] = "ai.auto.go";
      go.disabled = this.scanning || pick.size === 0;
      kids.push(go);
      const all = this.chip("fill-all", "Everything", () => {
        if (pick.size === AUTO_CATEGORIES.length) pick.clear();
        else for (const c of AUTO_CATEGORIES) pick.add(c);
        this.syncAutoStrip();
      }, "Tick every category — tap again to clear them all");
      all.dataset["tool"] = "ai.auto.all";
      all.setAttribute("aria-pressed", String(pick.size === AUTO_CATEGORIES.length));
      kids.push(all);
      kids.push(this.divider());
      for (const c of AUTO_CATEGORIES) {
        const chip = this.chip("sparkles", CATEGORY_NAMES[c].title, () => {
          if (pick.has(c)) pick.delete(c); else pick.add(c);
          this.syncAutoStrip();
        }, `Find ${CATEGORY_NAMES[c].many} in the clip`);
        chip.dataset["tool"] = `ai.pick.${c}`;
        chip.setAttribute("aria-pressed", String(pick.has(c)));
        kids.push(chip);
      }
    } else if (which === "name" && sel) {
      kids.push(back());
      const input = el("input.vb-name", { type: "text", value: sel.name, spellcheck: "false", "aria-label": "Layer name" }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const v = input.value.trim();
        if (v && v !== sel.name) {
          this.commit();
          sel.name = v;
          this.changed();
        }
      });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { input.blur(); this.showStrip("layer"); } });
      kids.push(input);
      setTimeout(() => input.focus(), 0);
    }
    this.strip.replaceChildren(...kids);
  }

  /** Reflect `autoPick` on the chips already in the strip; no rebuild, no scroll reset. */
  private syncAutoStrip(): void {
    const pick = this.autoPick;
    if (!pick) return;
    saveAutoPick(pick);
    const q = (tool: string): HTMLButtonElement | null => this.strip.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`);
    for (const c of AUTO_CATEGORIES) q(`ai.pick.${c}`)?.setAttribute("aria-pressed", String(pick.has(c)));
    q("ai.auto.all")?.setAttribute("aria-pressed", String(pick.size === AUTO_CATEGORIES.length));
    const go = q("ai.auto.go");
    if (go) {
      const label = go.querySelector(".vb-chip-label") ?? go.lastChild;
      if (label) label.textContent = `Go ${pick.size}`;
      go.disabled = this.scanning || pick.size === 0;
    }
  }

  private refreshLayerStrip(): void {
    // Cheap: the key chip flips between + and − as the playhead crosses keyframes.
    const sel = this.sel;
    if (!sel) return;
    const has = keyframeAt(sel, this.t)?.origin === "user";
    const chip = this.strip.querySelector<HTMLElement>('[data-key="1"]');
    if (chip && chip.dataset["has"] !== String(has)) this.showStrip("layer");
  }

  private chip(ic: string, label: string, on: () => void, title: string): HTMLButtonElement {
    const b = el("button.vb-chip", { type: "button", title }) as HTMLButtonElement;
    b.append(icon(ic));
    if (label) b.append(el("span", { text: label }));
    if (label === "Key") {
      b.dataset["key"] = "1";
      b.dataset["has"] = String(ic === "minus");
    }
    b.addEventListener("click", on);
    return b;
  }

  private divider(): HTMLElement {
    return el("i.vb-divider");
  }

  private btn(ic: string, title: string, on: () => void): HTMLButtonElement {
    const b = el("button.vb-btn", { type: "button", title }) as HTMLButtonElement;
    b.append(icon(ic));
    b.addEventListener("click", on);
    return b;
  }

  private slider(
    label: string, value: number, min: number, max: number, step: number,
    on: (v: number, done: boolean) => void, fmt: (v: number) => string = (v) => `${Math.round(v * 100)}%`,
  ): HTMLElement {
    const wrap = el("label.vb-slider");
    const out = el("span.vb-slider-value", { text: fmt(value) });
    const input = el("input.vb-range", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    input.addEventListener("input", () => { on(Number(input.value), false); out.textContent = fmt(Number(input.value)); });
    input.addEventListener("change", () => on(Number(input.value), true));
    wrap.append(el("span.vb-slider-label", { text: label }), input, out);
    return wrap;
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  private key(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = this.sel;
    const acts: Record<string, () => void> = {
      escape: () => (sel ? this.select(null) : this.close()),
      " ": () => this.toggle(),
      arrowleft: () => this.nudge(-(e.shiftKey ? 1 : this.frame())),
      arrowright: () => this.nudge(e.shiftKey ? 1 : this.frame()),
      delete: () => { if (sel) this.remove(sel.id); },
      backspace: () => { if (sel) this.remove(sel.id); },
      k: () => { if (sel) (keyframeAt(sel, this.t) ? this.dropKey(sel) : this.addKey(sel)); },
      f: () => { if (sel) void this.follow(sel, 1); },
      i: () => { if (sel) this.setStart(sel); },
      o: () => { if (sel) this.setEnd(sel); },
    };
    const act = acts[k];
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function norm(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x: clamp01(x), y: clamp01(y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Image bytes (JPEG/PNG) → grey frame, via the browser's decoder. */
export async function decode(bytes: Uint8Array): Promise<Gray> {
  const blob = new Blob([bytes as BlobPart]);
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return grayOf(img.data, c.width, c.height);
}
