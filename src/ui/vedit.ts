/**
 * Video editor — item 4, and the surface that finishes item 12.
 *
 * Trim, cut, join, crop, rotate, speed, fades, export. It opens over the player
 * with **E**, the same key the photo editor uses, because "the thing I am
 * looking at, but editable" should not be two different gestures.
 *
 * **The model is a list of spans to keep, never a list of edits to apply.**
 * Trimming is one span. Cutting a middle out is two. Removing three ad breaks
 * is four. Undo is then just the previous list, and the exporter has one case to
 * build a filter graph for instead of a taxonomy of operations that interact.
 * It also means the timeline is a direct drawing of the model rather than a
 * simulation of it — what you see is literally the array.
 *
 * **Nothing here touches the source file.** Export writes a new file beside it,
 * defaulting to `<name>-edit.mp4`, and the button says so. Every other editor I
 * have watched people lose work in did so by being ambiguous about that.
 *
 * The heavy lifting is all in `src-tauri/src/ffmpeg.rs`; this module builds a
 * typed job and hands it over. It deliberately does not know what a filter graph
 * looks like — see that file's header for why the split falls there.
 */

import { SpanList, type Span } from "@core/edit/spans";
import { detectInFrame, VIDEO_WIDTH } from "@core/vision/apply";
import type { Box } from "@core/vision/detect";
import { track as linkFaces } from "@core/vision/faces";
import { layerSpans, layersFromTracks, sampleTimes, type BlurSpan } from "@core/vision/video";
import { scanClipAuto } from "@core/vision/autoblur-image";
import { enabledCategories, type AutoCategory } from "@core/vision/autoblur-config";
import { getRunner } from "@core/vision/onnx-runner";
import { autoBlurStore } from "@core/phone/autoblur-prefs";
import type { BlurLayer } from "@core/edit/blur";
import { VideoBlur } from "./phone/video-editor";
import { formatTime } from "./media";

export type { Span };

export interface Track {
  index: number;
  kind: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  channels: number;
  sampleRate: number;
  rotation: number;
  language: string;
}

export interface Media {
  duration: number;
  bitrate: number;
  format: string;
  tracks: Track[];
  width: number;
  height: number;
}

export interface Job {
  inputs: string[];
  output: string;
  spans?: Span[];
  crop?: { x: number; y: number; w: number; h: number } | null;
  rotate?: number;
  flipH?: boolean;
  flipV?: boolean;
  speed?: number;
  scale?: [number, number] | null;
  mute?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  quality?: number;
  fps?: number | null;
  precise?: boolean;
  /** Invent the in-between frames when slowing down. See `Job::smooth`. */
  smooth?: boolean;
  /**
   * Faces to burn in (item 19). Times are on the **source** timeline, before
   * any trim or speed change — see the note above `blur_graph` in `ffmpeg.rs`
   * for why that is the only sane place to measure them.
   */
  blur?: BlurSpan[];
  /**
   * Subtitles to burn in (item 31). Carried here because this interface is the
   * front-end mirror of `ffmpeg::Job` and a mirror with a missing field is how
   * the next person concludes the back end cannot do it. The video editor does
   * not set it — the subtitle panel does, and it builds a job of this shape.
   */
  subtitles?: {
    text: string;
    size: number;
    color: string;
    outline: number;
    boxBehind: boolean;
    margin: number;
  };
}

export interface JobProgress {
  id: number;
  fraction: number;
  seconds: number;
  speed: number;
  fps: number;
}

export interface JobDone {
  id: number;
  ok: boolean;
  output: string;
  leftover: string;
  error: string;
  copied: boolean;
}

export interface VideoEditHost {
  fileUrl(path: string): Promise<string>;
  probe(path: string): Promise<Media>;
  frameAt(path: string, at: number, width: number): Promise<Uint8Array>;
  runJob(job: Job): Promise<number>;
  cancelJob(id: number): Promise<void>;
  onProgress(cb: (p: JobProgress) => void): () => void;
  onDone(cb: (d: JobDone) => void): () => void;
  /** So a finished export appears in the folder without a manual refresh. */
  refresh(): void;
}

/**
 * Speed rungs, from a twentieth to a hundredfold.
 *
 * The old ladder stopped at 0.25, which is not slow motion, it is "a bit slow".
 * The floor is now 0.05 — a second of footage becomes twenty — and the rungs
 * below 1 are spaced by ratio rather than evenly, because the difference
 * between 1/2 and 1/3 is a real one and the difference between 1/19 and 1/20 is
 * not. The top end goes to 100, which turns an hour of a static camera into
 * thirty-six seconds.
 *
 * Slowing this far only looks like slow motion with `smooth` on; without it
 * ffmpeg holds each source frame for the extra time. Hence the Smooth toggle
 * next to these buttons.
 */
const SPEEDS = [
  0.05, 0.0625, 0.08, 0.1, 0.125, 0.1667, 0.2, 0.25, 0.3333, 0.5, 0.75,
  1,
  1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 30, 45, 60, 100,
];

/**
 * The source's frame rate, or 30 when the probe could not say.
 *
 * Wrong-but-plausible beats failing: a file with no readable rate still gets
 * smoothed to something watchable, and 30 is what phone video is.
 */
function sourceFps(m: Media | null): number {
  const v = m?.tracks.find((t) => t.kind === "video" && t.fps > 0);
  return v ? Math.min(120, Math.max(12, v.fps)) : 30;
}

/** Filmstrip thumbnails. More is prettier and costs a decode each. */
const STRIP = 12;

export class VideoEditor {
  private readonly root = document.createElement("div");
  private readonly video = document.createElement("video");
  private readonly stage = document.createElement("div");
  private readonly cropBox = document.createElement("div");
  private readonly strip = document.createElement("div");
  private readonly track = document.createElement("div");
  private readonly playhead = document.createElement("i");
  private readonly clock = document.createElement("div");
  private readonly note = document.createElement("div");
  private readonly bar = document.createElement("div");
  private readonly barFill = document.createElement("i");
  private readonly exportBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly facesBtn: HTMLButtonElement;
  private readonly facesClear: HTMLButtonElement;
  private readonly autoBtn: HTMLButtonElement;
  private readonly speedOut = document.createElement("output");
  private readonly smoothBtn: HTMLButtonElement;
  private readonly nameIn = document.createElement("input");

  private path = "";
  private media: Media | null = null;
  private readonly model = new SpanList();

  private rotate = 0;
  private flipH = false;
  private flipV = false;
  private speed = 1;
  /** Synthesise in-between frames when slowing down. Off: it is slow to run. */
  private smooth = false;
  private mute = false;
  private fadeIn = 0;
  private fadeOut = 0;
  private quality = 20;
  private precise = false;
  private crop: { x: number; y: number; w: number; h: number } | null = null;
  private cropping = false;

  private job: number | null = null;
  private raf = 0;
  private stripToken = 0;

  /** Faces found by the last scan, in source pixels and source seconds. */
  /**
   * Blur layers, owned by the workspace in `./phone/video-editor` and turned
   * into static `BlurSpan`s only at export time. Faces found by the scanner
   * land here too, as layers, so they can be edited like anything drawn.
   */
  private readonly vb: VideoBlur;
  /** Bumped on every open and every rescan, so a stale scan cannot land. */
  private scanToken = 0;
  private scanning = false;

  constructor(private readonly host: VideoEditHost) {
    this.root.className = "vedit";
    this.root.hidden = true;
    this.vb = new VideoBlur({
      video: this.video,
      media: () => this.media
        ? { width: this.media.width, height: this.media.height, duration: this.media.duration, fps: sourceFps(this.media) || 30 }
        : null,
      frameAt: (t, width) => this.host.frameAt(this.path, t, width),
      scanFaces: () => this.findFaces(),
      scanAuto: (cats) => this.findAuto(cats),
      onChange: () => this.paintFaces(),
      onClose: () => { this.paint(); },
    });

    const head = document.createElement("header");
    head.className = "vedit-bar";
    const title = document.createElement("div");
    title.className = "vedit-title";
    this.note.className = "vedit-note";
    head.append(title, this.note, this.btn("✕", "Close  (Esc)", () => this.close()));

    this.stage.className = "vedit-stage";
    this.video.className = "vedit-video";
    this.video.playsInline = true;
    this.cropBox.className = "vedit-crop";
    this.cropBox.hidden = true;
    this.stage.append(this.video, this.cropBox);
    this.wireCrop();

    // ── Timeline ────────────────────────────────────────────────────────────
    this.strip.className = "vedit-strip";
    this.track.className = "vedit-track";
    this.playhead.className = "vedit-head";
    this.track.append(this.playhead);
    this.wireTrack();

    const time = document.createElement("div");
    time.className = "vedit-time";
    this.clock.className = "vedit-clock";

    // ── Controls ────────────────────────────────────────────────────────────
    const cuts = this.group("Cut", [
      this.btn("▶", "Play / pause  (space)", () => this.toggle()),
      this.btn("[", "Trim the start to here  (I)", () => this.mark("in")),
      this.btn("]", "Trim the end to here  (O)", () => this.mark("out")),
      this.btn("✂", "Split here  (S)", () => this.split()),
      this.btn("⌫", "Drop the piece under the playhead  (Del)", () => this.drop()),
      this.btn("⟲", "Undo  (ctrl+Z)", () => this.undo()),
      this.btn("⟳", "Redo  (ctrl+shift+Z)", () => this.redo()),
      this.btn("⤢", "Keep all of it again", () => this.resetSpans()),
    ]);

    this.speedOut.className = "vedit-speed";
    this.smoothBtn = this.btn(
      "\u224b",
      "Smooth slow motion",
      () => this.toggleSmooth(),
    );
    const geom = this.group("Frame", [
      this.btn("⟳90", "Turn a quarter clockwise  (R)", () => this.turn(90)),
      this.btn("⟲90", "Turn a quarter the other way", () => this.turn(-90)),
      this.btn("↔", "Mirror left to right", () => { this.flipH = !this.flipH; this.paint(); }),
      this.btn("↕", "Flip top to bottom", () => { this.flipV = !this.flipV; this.paint(); }),
      this.btn("⬚", "Crop — drag a rectangle on the video  (C)", () => this.toggleCrop()),
      this.btn("−", "Slower", () => this.stepSpeed(-1)),
      this.speedOut,
      this.btn("+", "Faster", () => this.stepSpeed(1)),
      this.smoothBtn,
    ]);

    // Faces live in Output, not Frame: nothing about them changes what is on
    // screen here, only what comes out of ffmpeg.
    this.facesBtn = this.btn(
      "Blur faces",
      // Deliberately not phrased "the original is never touched": that sentence
      // belongs to the export button, and the harness finds buttons by title.
      "Look through the video for faces and blur each one into the exported copy",
      () => void this.scanFaces(),
    );
    this.facesClear = this.btn("✕", "Forget the faces that were found", () => this.clearFaces());
    this.facesClear.hidden = true;
    this.autoBtn = this.btn(
      "Auto-blur",
      "Look through the video for plates, screens, terminals, codes — every category switched on in Auto-blur settings — and blur each one into the exported copy",
      () => void this.scanAuto(),
    );
    this.blurBtn = this.btn(
      "Blur…",
      "Blur anything — draw a box on any frame and it follows what it covers",
      () => this.openBlur(),
    );

    const outp = this.group("Output", [
      this.blurBtn,
      this.facesBtn,
      this.facesClear,
      this.autoBtn,
      this.check("Mute", "Drop the audio entirely", (v) => { this.mute = v; this.paint(); }),
      this.check("Fade", "One second in and out", (v) => {
        this.fadeIn = this.fadeOut = v ? 1 : 0;
        this.paint();
      }),
      this.check("Frame-exact", "Cut on the exact frame — needs a re-encode", (v) => {
        this.precise = v;
        this.paint();
      }),
      this.quali(),
    ]);

    this.nameIn.className = "vedit-name";
    this.nameIn.spellcheck = false;
    this.bar.className = "vedit-progress";
    this.barFill.className = "vedit-progress-fill";
    this.bar.append(this.barFill);
    this.bar.hidden = true;
    this.exportBtn = this.btn("Export a copy", "Writes a new file — the original is never touched", () =>
      void this.run(),
    );
    this.exportBtn.classList.add("vedit-go");
    this.cancelBtn = this.btn("Stop", "Cancel the export", () => void this.stop());
    this.cancelBtn.hidden = true;

    const foot = document.createElement("footer");
    foot.className = "vedit-foot";
    foot.append(this.nameIn, this.bar, this.cancelBtn, this.exportBtn);

    time.append(this.clock);
    const tl = document.createElement("div");
    tl.className = "vedit-timeline";
    tl.append(this.strip, this.track, time);

    const rows = document.createElement("div");
    rows.className = "vedit-controls";
    rows.append(cuts, geom, outp);

    // On the desktop the sheet is an inert wrapper — the three blocks stack
    // exactly as they did as siblings. On a phone it floats over a full-bleed
    // stage, and the grabber cycles how much of it is on screen so the video
    // itself never shrinks. The stage is `1fr` either way, so `fit()` never
    // has to know which mode it is in.
    const sheet = document.createElement("div");
    sheet.className = "vedit-sheet";
    sheet.dataset["state"] = "open";
    const grab = document.createElement("button");
    grab.type = "button";
    grab.className = "vedit-grab";
    grab.title = "Show more or less of the controls";
    // Opt out of panel-fit's glyph labelling: a word inside the grab pill
    // would break the shape everyone reads as "drag me".
    grab.dataset["fctLabelled"] = "";
    grab.addEventListener("click", () => {
      const next = { open: "slim", slim: "stub", stub: "open" } as const;
      const cur = sheet.dataset["state"] as keyof typeof next | undefined;
      sheet.dataset["state"] = next[cur ?? "open"];
    });
    sheet.append(grab, tl, rows, foot);

    this.root.append(head, this.stage, sheet, this.vb.root);
    document.body.appendChild(this.root);

    this.video.addEventListener("timeupdate", () => this.tick());
    this.video.addEventListener("loadedmetadata", () => this.tick());
    // The preview is sized in pixels, so it has to be re-sized when the window
    // changes shape. Cheap enough to do on every resize event: two style writes
    // against an element that is not even in the layout when the editor is shut.
    window.addEventListener("resize", () => { if (this.isOpen) this.fit(); });
    this.wireKeys();

    this.host.onProgress((p) => {
      if (p.id !== this.job) return;
      this.bar.hidden = false;
      this.barFill.style.width = `${Math.max(0, p.fraction) * 100}%`;
      this.say(
        p.fraction < 0
          ? `Encoding — ${formatTime(p.seconds)} done`
          : `Encoding ${Math.round(p.fraction * 100)}%  ·  ${p.speed.toFixed(1)}× realtime`,
      );
    });
    this.host.onDone((d) => {
      if (d.id !== this.job) return;
      this.job = null;
      this.bar.hidden = true;
      this.cancelBtn.hidden = true;
      this.exportBtn.disabled = false;
      if (d.ok) {
        this.say(
          d.copied
            ? `Saved without re-encoding — ${d.output.split("/").pop() ?? ""} is bit-for-bit the original`
            : `Saved ${d.output.split("/").pop() ?? ""}`,
        );
        this.host.refresh();
      } else {
        // The partial is named rather than removed. A job that failed at 90% is
        // sometimes still worth having, and deleting a file the user can see is
        // not a decision an export button gets to make on its own.
        this.say(
          `Export failed — ${d.error}${d.leftover ? `  (partial left at ${d.leftover})` : ""}`,
          true,
        );
      }
    });
    this.titleEl = title;
  }

  private readonly titleEl: HTMLElement;
  private readonly blurBtn: HTMLButtonElement;
  private pendingBlur = false;

  /** The blur workspace, for whoever wants to reach it by tool id. */
  openBlur(): void {
    if (!this.media) {
      this.pendingBlur = true;
      return;
    }
    this.vb.open();
  }

  get blurOpen(): boolean {
    return this.vb.isOpen;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get openPath(): string | null {
    return this.root.hidden ? null : this.path;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async open(path: string, mode: "cut" | "blur" = "cut"): Promise<void> {
    this.path = path;
    this.root.hidden = false;
    this.resetAll();
    this.pendingBlur = mode === "blur";
    const name = path.split("/").pop() ?? path;
    this.titleEl.textContent = name;
    this.nameIn.value = suggestName(name);
    this.say("Reading the file…");

    try {
      this.media = await this.host.probe(path);
    } catch (e) {
      this.say(`Cannot read this file — ${String(e)}`, true);
      return;
    }
    this.model.load(this.media.duration);
    this.video.src = await this.host.fileUrl(path);
    const v = this.media.tracks.find((t) => t.kind === "video");
    this.say(
      `${this.media.width}×${this.media.height}  ·  ${formatTime(this.media.duration)}  ·  ` +
        `${v?.codec ?? "?"}${v?.fps ? ` at ${v.fps.toFixed(2)} fps` : ""}`,
    );
    this.paint();
    void this.filmstrip();
    if (this.pendingBlur) {
      this.pendingBlur = false;
      this.vb.open();
    }
  }

  close(): void {
    this.pendingBlur = false;
    if (this.vb.isOpen) this.vb.close();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    // A running export is deliberately *not* cancelled. Closing the editor is
    // not "throw away the encode I have been waiting four minutes for"; the
    // finished file lands in the folder either way.
  }

  private resetAll(): void {
    this.model.load(0);
    this.rotate = 0;
    this.flipH = this.flipV = false;
    this.speed = 1;
    this.mute = this.precise = false;
    this.fadeIn = this.fadeOut = 0;
    this.crop = null;
    this.cropping = false;
    this.cropBox.hidden = true;
    this.vb.reset();
    this.clearFaces();
  }

  // ── The span model ────────────────────────────────────────────────────────
  //
  // Thin wrappers over `SpanList`, which the audio editor cuts with too. Each
  // one repaints only on a real change, so a split at the very start of a clip
  // is a no-op rather than an undo step that removes nothing.

  private undo(): void {
    if (this.model.undo()) this.paint();
  }

  private redo(): void {
    if (this.model.redo()) this.paint();
  }

  private resetSpans(): void {
    if (this.media && this.model.reset(this.media.duration)) this.paint();
  }

  private mark(which: "in" | "out"): void {
    if (this.model.mark(this.video.currentTime, which)) this.paint();
  }

  private split(): void {
    if (this.model.split(this.video.currentTime)) this.paint();
  }

  private drop(): void {
    if (this.model.drop(this.video.currentTime)) this.paint();
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private toggle(): void {
    if (this.video.paused) void this.video.play();
    else this.video.pause();
  }

  /**
   * Preview skips the parts you cut.
   *
   * Playing straight through the removed sections would make the timeline a
   * diagram of an edit rather than a preview of one, and the whole reason to cut
   * on a timeline is to watch the join.
   */
  private tick(): void {
    const t = this.video.currentTime;
    if (this.model.count > 0 && this.model.indexAt(t) < 0) {
      const nxt = this.model.nextAfter(t);
      if (nxt) this.video.currentTime = nxt.start;
      else this.video.pause();
    }
    const total = this.media?.duration ?? this.video.duration ?? 0;
    this.playhead.style.left = `${total > 0 ? (t / total) * 100 : 0}%`;
    this.clock.textContent =
      `${formatTime(t)} / ${formatTime(total)}` +
      `   →   ${formatTime(this.outSeconds())} out`;
  }

  private outSeconds(): number {
    const kept = this.model.kept;
    return this.speed > 0 ? kept / this.speed : kept;
  }

  private turn(by: number): void {
    this.rotate = (((this.rotate + by) % 360) + 360) % 360;
    this.paint();
  }

  private stepSpeed(dir: number): void {
    // Nearest rung rather than `indexOf`, so a speed that came from anywhere
    // but this ladder still steps to a neighbour instead of jumping to 1x.
    let i = SPEEDS.indexOf(this.speed);
    if (i < 0) {
      i = 0;
      for (let k = 1; k < SPEEDS.length; k++) {
        const a = SPEEDS[k] ?? 1;
        const b = SPEEDS[i] ?? 1;
        if (Math.abs(Math.log(a / this.speed)) < Math.abs(Math.log(b / this.speed))) i = k;
      }
    }
    const n = Math.min(SPEEDS.length - 1, Math.max(0, i + dir));
    this.speed = SPEEDS[n] ?? 1;
    this.paint();
  }

  private toggleSmooth(): void {
    this.smooth = !this.smooth;
    this.paint();
  }

  /**
   * "1/20x", not "0.05x".
   *
   * Nobody reading a speed control does the division in their head, and 0.0625
   * in particular reads as a typo. Above 1 the plain number is already the way
   * people say it.
   */
  private speedLabel(): string {
    if (this.speed === 1) return "1×";
    if (this.speed > 1) return `${this.speed}×`;
    return `1/${Math.round(1 / this.speed)}×`;
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  /**
   * Redraw the derived UI: span bars, the preview transform, the labels.
   *
   * The video element itself carries the rotation and flip as a CSS transform,
   * so what you are looking at is what the export will produce without paying
   * for a re-encode to find out.
   */
  private paint(): void {
    const total = this.media?.duration ?? 0;
    for (const old of Array.from(this.track.querySelectorAll(".vedit-span"))) old.remove();
    for (const s of this.model.list) {
      const bar = document.createElement("i");
      bar.className = "vedit-span";
      bar.style.left = `${total > 0 ? (s.start / total) * 100 : 0}%`;
      bar.style.width = `${total > 0 ? ((s.end - s.start) / total) * 100 : 100}%`;
      this.track.insertBefore(bar, this.playhead);
    }

    const t: string[] = [];
    if (this.rotate) t.push(`rotate(${this.rotate}deg)`);
    if (this.flipH) t.push("scaleX(-1)");
    if (this.flipV) t.push("scaleY(-1)");
    this.video.style.transform = t.join(" ");
    // A quarter turn makes the frame's long axis vertical, and without this the
    // preview overflows the stage sideways while claiming to fit.
    this.video.classList.toggle("vedit-turned", this.rotate === 90 || this.rotate === 270);
    this.fit();

    this.speedOut.textContent = this.speedLabel();
    // Only meaningful below 1x: there is nothing to invent when you are
    // throwing frames away. Disabled rather than hidden so the control does not
    // appear and vanish as the speed crosses 1.
    this.smoothBtn.disabled = this.speed >= 1;
    this.smoothBtn.classList.toggle("on", this.smooth && this.speed < 1);
    this.smoothBtn.title = this.speed >= 1
      ? "Smooth slow motion — only applies below 1×"
      : this.smooth
        ? "Smooth: inventing the in-between frames. Slow to export."
        : "Smooth: off — each frame is simply held longer";
    this.exportBtn.textContent = this.losslessLikely() ? "Export (no re-encode)" : "Export a copy";
    this.tick();
  }

  /**
   * Give the preview the whole stage.
   *
   * CSS alone cannot do this. `max-width/max-height: 100%` shrinks a large clip
   * to fit but will not grow a small one, so a 320×180 test clip sat
   * postage-stamp sized in the middle of a black field — which is exactly what
   * a screenshot showed and what none of the assertions could see. Handing the
   * element the stage's box and letting `object-fit: contain` letterbox inside
   * it scales both ways.
   *
   * The axes swap on a quarter turn, because the box is measured before the
   * rotation is applied: a stage-shaped element rotated 90° is taller than the
   * stage it is sitting in.
   */
  private fit(): void {
    const r = this.stage.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const turned = this.rotate === 90 || this.rotate === 270;
    this.video.style.width = `${turned ? r.height : r.width}px`;
    this.video.style.height = `${turned ? r.width : r.height}px`;
  }

  /** Mirrors `Job::copyable` in Rust so the button can promise what it delivers. */
  private losslessLikely(): boolean {
    return (
      !this.precise &&
      !this.vb.layers.some((l) => l.enabled) &&
      this.model.count <= 1 &&
      !this.crop &&
      this.rotate === 0 &&
      !this.flipH &&
      !this.flipV &&
      this.speed === 1 &&
      this.fadeIn === 0 &&
      this.fadeOut === 0
    );
  }

  private say(msg: string, bad = false): void {
    this.note.textContent = msg;
    this.note.classList.toggle("bad", bad);
  }

  /**
   * Thumbnails under the timeline, decoded one at a time.
   *
   * Sequential rather than `Promise.all`: twelve ffmpeg processes at once on a
   * 4K source will starve the machine the app is running on, and the strip is
   * decoration — it must never be the reason the editor feels slow. A token
   * guards against a second file's strip landing on top of the first's.
   */
  private async filmstrip(): Promise<void> {
    const token = ++this.stripToken;
    const total = this.media?.duration ?? 0;
    this.strip.replaceChildren();
    if (total <= 0) return;
    for (let i = 0; i < STRIP; i++) {
      const at = (total * (i + 0.5)) / STRIP;
      try {
        const png = await this.host.frameAt(this.path, at, 160);
        if (token !== this.stripToken) return;
        const img = document.createElement("img");
        img.src = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: "image/png" }));
        // Revoked on load: the bitmap is decoded by then, and a strip that
        // leaks twelve object URLs per file open is a session-long leak.
        img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
        this.strip.append(img);
      } catch {
        if (token !== this.stripToken) return;
        this.strip.append(document.createElement("span"));
      }
    }
  }

  // ── Crop ──────────────────────────────────────────────────────────────────

  private toggleCrop(): void {
    this.cropping = !this.cropping;
    this.stage.classList.toggle("cropping", this.cropping);
    if (!this.cropping && !this.crop) this.cropBox.hidden = true;
    this.say(this.cropping ? "Drag a rectangle on the video. Press C again to finish." : "");
  }

  /**
   * Crop is drawn in screen pixels and stored in source pixels.
   *
   * The video is letterboxed inside the stage by `object-fit: contain`, so the
   * element's box is not the picture's box — mapping through the element rect
   * would put the rectangle in the wrong place on anything whose aspect ratio
   * differs from the stage's, which is most things.
   */
  private wireCrop(): void {
    let from: { x: number; y: number } | null = null;
    this.stage.addEventListener("pointerdown", (e) => {
      if (!this.cropping) return;
      from = { x: e.clientX, y: e.clientY };
      this.cropBox.hidden = false;
      this.stage.setPointerCapture(e.pointerId);
    });
    this.stage.addEventListener("pointermove", (e) => {
      if (!from) return;
      const r = this.stage.getBoundingClientRect();
      const x = Math.min(from.x, e.clientX) - r.left;
      const y = Math.min(from.y, e.clientY) - r.top;
      this.cropBox.style.left = `${x}px`;
      this.cropBox.style.top = `${y}px`;
      this.cropBox.style.width = `${Math.abs(e.clientX - from.x)}px`;
      this.cropBox.style.height = `${Math.abs(e.clientY - from.y)}px`;
    });
    this.stage.addEventListener("pointerup", (e) => {
      if (!from) return;
      const r = this.picture();
      const x0 = Math.min(from.x, e.clientX);
      const y0 = Math.min(from.y, e.clientY);
      const w = Math.abs(e.clientX - from.x);
      const h = Math.abs(e.clientY - from.y);
      from = null;
      if (!r || w < 8 || h < 8 || !this.media) {
        this.crop = null;
        this.cropBox.hidden = true;
        return;
      }
      const sx = this.media.width / r.width;
      const sy = this.media.height / r.height;
      this.crop = {
        x: Math.max(0, Math.round((x0 - r.left) * sx)),
        y: Math.max(0, Math.round((y0 - r.top) * sy)),
        w: Math.min(this.media.width, Math.round(w * sx)),
        h: Math.min(this.media.height, Math.round(h * sy)),
      };
      this.say(`Crop ${this.crop.w}×${this.crop.h} at ${this.crop.x},${this.crop.y}`);
      this.paint();
    });
  }

  /** Where the picture actually is inside the letterboxed element. */
  private picture(): DOMRect | null {
    const el = this.video.getBoundingClientRect();
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(el.width / vw, el.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    return new DOMRect(el.left + (el.width - w) / 2, el.top + (el.height - h) / 2, w, h);
  }

  // ── Faces (item 19) ───────────────────────────────────────────────────────

  /**
   * Find every face in the file and remember where and when it was.
   *
   * Nothing is drawn on the preview. A video's blur is not editable the way a
   * photo's is — there is no sane way to drag a rectangle that moves — so the
   * honest thing is to say plainly how many people were found and let the user
   * decide whether to trust that before exporting. Finding nobody says so
   * loudly, because a silent "done" over an unblurred face is the failure that
   * matters here.
   *
   * Frames come out of ffmpeg one at a time, deliberately: the filmstrip's
   * comment applies with more force at two hundred frames than at twelve.
   */
  private async scanFaces(): Promise<void> {
    if (!this.media || this.scanning || this.job !== null) return;
    let found: BlurLayer[] = [];
    try {
      found = await this.findFaces();
    } catch {
      return;
    }
    if (found.length > 0) this.vb.add(found);
  }

  /**
   * Pull frames, detect, link into tracks, and answer with one layer per
   * face. The note under the title says what happened either way, because a
   * silent "done" over an unblurred face is the failure that matters here.
   */
  private async findFaces(): Promise<BlurLayer[]> {
    const media = this.media;
    if (!media || this.scanning) return [];
    const token = ++this.scanToken;
    this.scanning = true;
    this.facesBtn.disabled = true;

    const times = sampleTimes(media.duration);
    const frames: { t: number; boxes: Box[] }[] = [];
    let failed = 0;

    try {
      for (let i = 0; i < times.length; i++) {
        const at = times[i]!;
        this.facesBtn.textContent = `Looking… ${Math.round(((i + 1) / times.length) * 100)}%`;
        try {
          const png = await this.host.frameAt(this.path, at, Math.min(media.width, VIDEO_WIDTH));
          if (token !== this.scanToken) return [];
          frames.push({ t: at, boxes: await detectInFrame(png, media.width) });
        } catch {
          // One frame that will not decode is a scratch in the file, not a
          // reason to abandon the scan. Too many of them is worth saying.
          failed++;
        }
        if (token !== this.scanToken) return [];
      }

      const tracks = linkFaces(frames);
      if (token !== this.scanToken) return [];
      const layers = layersFromTracks(tracks, media.width, media.height);

      if (tracks.length === 0) {
        this.say(
          failed > 0
            ? `No faces found — and ${failed} of ${times.length} frames would not decode.`
            : "No faces found. Nothing will be blurred.",
          true,
        );
      } else {
        const who = tracks.length === 1 ? "1 face" : `${tracks.length} faces`;
        const n = layerSpans(layers, media.width, media.height, media.duration).spans.length;
        this.say(
          `${who} · ${n} blur${n === 1 ? "" : "s"} in the export` +
            (failed > 0 ? ` · ${failed} frames would not decode` : ""),
        );
      }
      return layers;
    } finally {
      if (token === this.scanToken) {
        this.scanning = false;
        this.facesBtn.disabled = false;
        this.paintFaces();
      }
    }
  }

  /** The Auto-blur button: every configured category, one layer per tracked object. */
  private async scanAuto(): Promise<void> {
    if (!this.media || this.scanning || this.job !== null) return;
    let found: BlurLayer[] = [];
    try {
      found = await this.findAuto();
    } catch {
      return;
    }
    if (found.length > 0) this.vb.add(found);
  }

  /**
   * Sample the clip, run the configured detectors on every sample, and answer
   * with one layer per tracked object — five monitors, five layers, each held
   * through the whole clip when the settings say so.
   */
  private async findAuto(picked?: readonly AutoCategory[]): Promise<BlurLayer[]> {
    const media = this.media;
    if (!media || this.scanning) return [];
    const token = ++this.scanToken;
    this.scanning = true;
    this.autoBtn.disabled = true;
    const config = autoBlurStore().get();
    // The phone's strip hands over what was ticked; the desktop button runs
    // everything switched on in Settings.
    const categories = picked ?? enabledCategories(config);
    if (categories.length === 0) {
      this.say("Nothing switched on in Auto-blur settings.", true);
      this.scanning = false;
      this.autoBtn.disabled = false;
      return [];
    }
    const abort = new AbortController();
    try {
      const r = await scanClipAuto({
        frameAt: (t, width) => this.host.frameAt(this.path, t, width),
        media,
        categories,
        config,
        runner: getRunner(),
        signal: abort.signal,
        onProgress: (f) => {
          if (token !== this.scanToken) abort.abort();
          this.autoBtn.textContent = `Looking… ${Math.round(f * 100)}%`;
        },
      });
      if (token !== this.scanToken) return [];
      if (r.layers.length === 0) {
        this.say(
          r.failed > 0
            ? `Nothing found — and ${r.failed} frames would not decode.`
            : `Nothing found${r.notes.length ? ` — ${r.notes[0]}` : ""}. Nothing will be blurred.`,
          true,
        );
      } else {
        this.say(
          `${r.layers.length} blur${r.layers.length === 1 ? "" : "s"} · ${Math.round(r.msPerFrame)} ms per frame` +
            (r.failed > 0 ? ` · ${r.failed} frames would not decode` : ""),
        );
      }
      return r.layers;
    } finally {
      if (token === this.scanToken) {
        this.scanning = false;
        this.autoBtn.disabled = false;
        this.autoBtn.textContent = "Auto-blur";
        this.paintFaces();
      }
    }
  }

  private clearFaces(): void {
    this.scanToken++;
    this.scanning = false;
    this.vb.removeSource("face");
    this.paintFaces();
  }

  private paintFaces(): void {
    const n = this.vb.layers.filter((l) => l.enabled).length;
    this.facesBtn.textContent = n > 0 ? `Blurring ${n} region${n === 1 ? "" : "s"}` : "Blur faces";
    this.facesBtn.classList.toggle("on", n > 0);
    this.facesClear.hidden = !this.vb.layers.some((l) => l.source === "face");
    this.blurBtn.classList.toggle("on", n > 0);
    this.exportBtn.textContent = this.losslessLikely() ? "Export (no re-encode)" : "Export a copy";
  }

  /** What the export will burn in, as static boxes. */
  private spans(): BlurSpan[] {
    if (!this.media) return [];
    return layerSpans(this.vb.layers, this.media.width, this.media.height, this.media.duration).spans;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    if (!this.media || this.job !== null) return;
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    const name = this.nameIn.value.trim() || suggestName(this.path.split("/").pop() ?? "out.mp4");
    const job: Job = {
      inputs: [this.path],
      output: `${dir}/${name}`,
      spans: this.model.list.map((s) => ({ ...s })),
      crop: this.crop,
      rotate: this.rotate,
      flipH: this.flipH,
      flipV: this.flipV,
      speed: this.speed,
      mute: this.mute,
      fadeIn: this.fadeIn,
      fadeOut: this.fadeOut,
      quality: this.quality,
      precise: this.precise,
      smooth: this.smooth && this.speed < 1,
      // The rate to interpolate *up* to: the source's own, so a 30 fps clip
      // slowed twentyfold comes back as 30 fps rather than as 1.5. Only sent
      // when smoothing, so an ordinary export still inherits the source rate
      // untouched.
      fps: this.smooth && this.speed < 1 ? sourceFps(this.media) : null,
      blur: this.spans(),
    };
    this.exportBtn.disabled = true;
    this.cancelBtn.hidden = false;
    this.bar.hidden = false;
    this.barFill.style.width = "0%";
    this.say("Starting…");
    try {
      this.job = await this.host.runJob(job);
    } catch (e) {
      this.job = null;
      this.exportBtn.disabled = false;
      this.cancelBtn.hidden = true;
      this.bar.hidden = true;
      this.say(`Could not start ffmpeg — ${String(e)}`, true);
    }
  }

  private async stop(): Promise<void> {
    if (this.job === null) return;
    await this.host.cancelJob(this.job);
    this.say("Stopped.");
  }

  // ── Chrome ────────────────────────────────────────────────────────────────

  private btn(label: string, title: string, on: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "vedit-btn";
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", on);
    return b;
  }

  private check(label: string, title: string, on: (v: boolean) => void): HTMLElement {
    const l = document.createElement("label");
    l.className = "vedit-check";
    l.title = title;
    const i = document.createElement("input");
    i.type = "checkbox";
    i.addEventListener("change", () => on(i.checked));
    l.append(i, document.createTextNode(label));
    return l;
  }

  private quali(): HTMLElement {
    const l = document.createElement("label");
    l.className = "vedit-check";
    l.title = "Lower is better and bigger. 18 is visually lossless; 28 is small.";
    const s = document.createElement("select");
    for (const [v, t] of [
      [18, "Best"],
      [20, "High"],
      [23, "Normal"],
      [28, "Small"],
    ] as [number, string][]) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = t;
      if (v === this.quality) o.selected = true;
      s.append(o);
    }
    s.addEventListener("change", () => {
      this.quality = Number(s.value);
    });
    l.append(document.createTextNode("Quality"), s);
    return l;
  }

  private group(label: string, kids: HTMLElement[]): HTMLElement {
    const g = document.createElement("div");
    g.className = "vedit-group";
    const h = document.createElement("span");
    h.className = "vedit-group-label";
    h.textContent = label;
    g.append(h, ...kids);
    return g;
  }

  private wireTrack(): void {
    const seek = (e: PointerEvent): void => {
      const r = this.track.getBoundingClientRect();
      const total = this.media?.duration ?? 0;
      this.video.currentTime = Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total));
    };
    this.track.addEventListener("pointerdown", (e) => {
      this.track.setPointerCapture(e.pointerId);
      seek(e);
    });
    this.track.addEventListener("pointermove", (e) => {
      if (e.buttons & 1) seek(e);
    });
  }

  private wireKeys(): void {
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.isOpen || this.vb.isOpen) return;
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === "z") {
          e.preventDefault();
          if (e.shiftKey) this.redo();
          else this.undo();
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const step = 1 / (this.media?.tracks.find((t) => t.kind === "video")?.fps || 30);
        const acts: Record<string, () => void> = {
          escape: () => this.close(),
          " ": () => this.toggle(),
          i: () => this.mark("in"),
          o: () => this.mark("out"),
          s: () => this.split(),
          delete: () => this.drop(),
          backspace: () => this.drop(),
          r: () => this.turn(90),
          c: () => this.toggleCrop(),
          arrowleft: () => {
            this.video.currentTime = Math.max(0, this.video.currentTime - (e.shiftKey ? 1 : step));
          },
          arrowright: () => {
            this.video.currentTime += e.shiftKey ? 1 : step;
          },
        };
        const act = acts[k];
        if (!act) return;
        e.preventDefault();
        e.stopPropagation();
        act();
      },
      // Capture, so the editor takes these keys before the player underneath
      // sees them — both are listening and both want space and the arrows.
      true,
    );
  }
}

/** `holiday.mp4` → `holiday-edit.mp4`. Never the same name as the source. */
export function suggestName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : ".mp4";
  // Re-editing an export should not produce `clip-edit-edit-edit.mp4`.
  const base = stem.replace(/-edit(-\d+)?$/, "");
  return `${base}-edit${ext}`;
}
