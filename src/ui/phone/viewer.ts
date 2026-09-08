/**
 * The full-bleed viewer.
 *
 * The picture is the screen. The bars are a translucent overlay that a tap
 * dismisses, the actions along the bottom carry words as well as glyphs, and
 * opening the editor keeps the photograph at 55% of the height instead of
 * shrinking it to a strip beside a panel.
 *
 * The gesture set is chosen around one hard constraint: Android's navigation
 * owns a ~130 px strip down both screen edges, and a WebView cannot opt out of
 * it. A horizontal drag that *starts* in that strip is a back gesture, full
 * stop. So swiping between pictures works from the middle of the screen and is
 * never the only way to move — the header carries ‹ and › buttons with a
 * position counter, which is also what makes "where am I in 4,000 photos"
 * answerable at all.
 */

import type { FileEntry } from "@core/explorer/types";
import { mediaReady } from "@core/explorer/tauri-fs";
import { formatDuration } from "@core/phone/gallery";
import { EDGE_GESTURE_PX } from "@core/phone/env";
import { FULL_SETTLE_MS, wantsOriginal } from "@core/phone/display";
import { pageTarget, stripOffset } from "@core/phone/merge";
import { perf } from "@core/phone/mark";
import { readMetadata, strip } from "@core/meta/exif";
import { describeMediaError } from "../media";
import { bytes, el, fill, shortDate } from "./dom";
import { dropFav, isFav, toggleFav } from "./favorites";
import { icon } from "./icons";
import { DisplayCache } from "./display";
import { PhoneEditor, type SaveOptions } from "./editor";
import { dragToDismiss } from "./sheet-drag";
import type { PhoneHost } from "./shell";
import type { MediaStore } from "./store";
import type { Thumbs } from "./thumbs";

/**
 * How long a clip gets to produce a first frame before it is treated as
 * unplayable. Long enough for a large file off shared storage, short enough
 * that nobody sits looking at a blank player wondering.
 */
const BLANK_VIDEO_MS = 2500;

/** Below this the drag is a tap. */
/** Every tag block a camera writes sits in the first stretch of a file, so the
 *  sheet counts them from the head rather than pulling a 5 MB photograph over
 *  IPC to render one line. The strip itself reads the file whole. */
const META_BYTES = 256 * 1024;

const TAP_SLOP = 10;
/** Horizontal travel that commits to the next picture. */
const SWIPE_PX = 60;

/**
 * How far down the picture has to be dragged before letting go dismisses it
 * (item 4), and the distance the shrink is measured against.
 *
 * Larger than `SWIPE_PX * 1.6`, which is what the old release-only test used.
 * That threshold was tuned for a gesture with no feedback, where it had to be
 * small enough to feel responsive; now that the picture visibly follows the
 * finger and shrinks as it goes, the threshold can be where it belongs -- far
 * enough that you cannot dismiss a photograph by accident while trying to
 * scroll something, and near enough that a deliberate flick clears it.
 */
const DISMISS_PX = 140;
/** Zoom bounds. */
const MIN_SCALE = 1;
/**
 * How far in a pinch can go.
 *
 * Eight was enough to look at a photograph and is not enough to work on one.
 * "Blur just his eye" on a 12 MP frame means placing a mask a few dozen pixels
 * across, and at 8x on a 384 px-wide viewport an eye is still about four points
 * of finger travel. Twenty-four puts it at a comfortable thumb's width.
 */
const MAX_SCALE = 24;

interface OpenOptions {
  /** Jump straight into the editor with this tool armed. */
  tool?: string;
  /**
   * A picture already on screen for this entry -- the neighbour pane the user
   * just dragged into place. Goes onto the stage before anything else so the
   * hand-over from pane to stage is invisible.
   */
  seed?: string;
  /** The original, already decoded by the preloader: skip placeholder and decode. */
  full?: string;
  /**
   * The strip just glided a pane into place and this load is the hand-over:
   * the pane stays where it is, over the stage, until the stage has decoded
   * and painted the same picture, and only then is it parked. Internal.
   */
  handover?: boolean;
}

/**
 * A neighbour's display copy, being decoded off-DOM or already decoded.
 *
 * `url` is the screen-sized copy (see display.ts) and is what the stage and
 * the panes show; `orig` is the file itself, wanted only past `FULL_ZOOM`.
 */
interface WarmImage {
  url: string;
  orig: string;
  img: HTMLImageElement;
  ready: boolean;
  /**
   * The original is a format the WebView cannot decode — HEIC, DNG, TIFF, JXL
   * — and `url` is a native decode of it. There is no sharper picture to swap
   * in past `FULL_ZOOM`; asking for one puts a black stage under the zoom.
   */
  foreign: boolean;
}

/** How long the strip takes to settle on a page or spring back. */
const PAGE_MS = 200;

export class PhoneViewer {
  readonly el: HTMLElement;

  private stage: HTMLElement;
  private img: HTMLImageElement;
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private nameEl: HTMLElement;
  private starEl: HTMLElement;
  private countEl: HTMLElement;
  private actions: HTMLElement;
  private toast: HTMLElement;
  /** What is on stage when there is no picture and never will be. */
  private blank: HTMLElement;

  /**
   * The video transport, built here rather than left to the browser.
   *
   * `controls` on a `<video>` is a shadow root the page cannot style or move.
   * On this shell it drew its clock, fullscreen button and overflow menu
   * through the action bar, and put its scrub thumb on the bottom edge of the
   * screen -- which is the back gesture, so seeking walked out of the app.
   * Reported from the device, not guessed.
   */
  private vbar: HTMLElement;
  private playBtn: HTMLButtonElement;
  private atEl: HTMLElement;
  private ofEl: HTMLElement;
  private track: HTMLElement;
  private trackFill: HTMLElement;
  private knob: HTMLElement;
  /** True between pointerdown and pointerup on the track. */
  private seeking = false;
  private editor: PhoneEditor;

  private items: FileEntry[] = [];
  private index = 0;
  /**
   * Which `load()` is the current one. A fast swipe fires several loads whose
   * awaits resolve out of order; only the newest may touch the stage, or the
   * picture you landed on gets replaced by the one you swiped past.
   */
  private loadSeq = 0;
  /** Entry whose grid thumbnail we pinned as the placeholder. */
  private thumbHeld: FileEntry | null = null;
  private editing = false;
  private aux: HTMLElement;
  private chrome = true;
  private source: ImageBitmap | null = null;
  private objectUrl: string | null = null;
  private toastTimer = 0;

  /** Pan/zoom of the browse-mode picture. */
  private scale = 1;

  /**
   * How far through the drag-to-dismiss gesture we are, 0 to 1 (item 4).
   *
   * Kept apart from `scale` rather than folded into it, because they mean
   * different things and undoing them differs: `scale` is where the person has
   * zoomed to and survives a release, this is a transient the release either
   * completes or springs back.
   */
  private dismiss = 0;
  private tx = 0;
  private ty = 0;

  /**
   * A live one-finger gesture. `axis` is locked once the drag clears the tap
   * slop and decides what the rest of it means -- "x" turns the page, "y"
   * drags the picture back towards the grid (item 4), "" is a gesture that has
   * not moved far enough to have an opinion yet.
   */
  private drag:
    | {
        x: number; y: number; sx: number; sy: number;
        moved: boolean; edit: boolean; axis: "" | "x" | "y";
        /** Recent finger positions, for the release velocity. */
        samples: { x: number; t: number }[];
      }
    | null = null;

  // ── The strip ─────────────────────────────────────────────────────────
  //
  // Three panes: the stage's own picture in the middle and one neighbour on
  // each side, kept just off screen. A horizontal drag moves all three with the
  // finger, so the next photograph is visibly arriving rather than the current
  // one visibly leaving to be replaced by nothing.
  private prevPane: HTMLImageElement;
  private nextPane: HTMLImageElement;
  /** Stage width read once per gesture; the pane offset and the paging threshold. */
  private stripW = 0;
  /** Where the finger has put the strip; applied once per frame. */
  private stripDx = 0;
  private stripFrame = 0;
  private stripOn = false;
  /** Which kind of file the action buttons were last built for. */
  private actionsKind = "";
  /** Which way the screen was last seen; a flip refits the display copies. */
  private landscape = window.innerWidth > window.innerHeight;
  private readonly onResize = (): void => this.refit();
  /** Frame probe: long frames during a swipe, by phase, reported to `perf`. */
  private probeFrame = 0;
  private probeLast = 0;
  private probePhase = "";
  private probeLong: string[] = [];
  private probeCount = 0;
  /** Set while the settle animation runs, so a new touch does not fight it. */
  private paging = false;
  /** Callers waiting for the strip to come to rest (`whenAtRest`). */
  private restWaiters: (() => void)[] = [];
  /** A pane wanted a new picture while it was on screen; repaint at rest. */
  private panesDirty = false;
  /** Neighbours' display copies by path, decoded off-DOM. */
  private warm = new Map<string, WarmImage>();
  /** Screen-sized copies of originals, made off the main thread and kept by path. */
  private display: DisplayCache;
  /** Watchdog for a clip that loads but never paints a frame. */
  private blankTimer = 0;
  /** True while the stage shows the original rather than its display copy. */
  private stageFull = false;
  /** Pending swap to the original after a zoom settles past `FULL_ZOOM`. */
  private fullTimer = 0;
  /** The last `--phv-dismiss` written, so a pan or pinch never touches the root. */
  private dismissVar = -1;
  /** One transform write per frame, whatever the touch event rate. */
  private xfFrame = 0;
  private pixelated = false;
  /**
   * A live two-finger gesture.
   *
   * Carries the centroid and the pan offset at the moment it began, because a
   * pinch has to pan as well as scale: once you are zoomed into a face there is
   * no other way to reach the other eye, and in edit mode one finger is a brush
   * stroke rather than a pan.
   */
  private pinch:
    | { base: number; scale: number; cx: number; cy: number; tx: number; ty: number }
    | null = null;

  constructor(
    private readonly host: PhoneHost,
    private readonly store: MediaStore,
    private readonly thumbs: Thumbs,
  ) {
    this.img = el<"img">("img", { alt: "", decoding: "async", hidden: true });
    this.display = new DisplayCache(host.fs);
    window.addEventListener("resize", this.onResize);
    this.video = el<"video">("video", {
      // No `controls`. See `vbar` above -- the app draws its own.
      playsinline: true,
      // Fetch frames, not just the header. With the default the element has
      // nothing to paint when `play()` is called and shows its own blank
      // background for as long as the first buffer takes to arrive.
      preload: "auto",
      hidden: true,
    });
    /*
     * Put the picture back when the clip runs out.
     *
     * A `poster` is shown before playback and never again, so the end of a
     * six-second clip leaves the element black with the browser's own grey
     * play button floating in it -- the exact screen item 5 was about, arrived
     * at from the other end. Seeking to zero paints the first frame, so what
     * is behind the button is the picture the clip started on.
     *
     * Rewind rather than loop: a gallery that will not stop is worse than one
     * that ends, and the frame is what makes it read as finished rather than
     * broken.
     */
    this.video.addEventListener("ended", () => {
      try { this.video.currentTime = 0; } catch { /* nothing seekable yet */ }
    });

    /*
     * A clip the platform will not play must not be left in the element.
     *
     * Android's WebView draws its own placeholder for a `<video>` with no
     * frames -- a grey play triangle blown up to the size of the element and
     * blurred by the upscale -- and it is the last thing on screen for every
     * container Chromium has no demuxer for: FLV, MPEG-PS, VOB, DivX, WMV,
     * Theora. The app already has a real frame of every one of them, decoded
     * natively for the grid, so the failure hands the stage back to the still
     * path: the poster becomes the picture, the transport goes away, and the
     * reason is said once rather than drawn forever.
     */
    this.video.addEventListener("error", () => {
      const entry = this.current;
      if (!entry || entry.kind !== "video") return;
      void this.posterOnly(entry, describeMediaError(this.video.error), this.loadSeq);
    });

    /*
     * The same courtesy for a still.
     *
     * `display.get` hands back the original's URL whenever it cannot make a
     * copy, on the reasoning that some formats never report a decode failure
     * and the <img> should get its say. The <img> was never asked. Nothing
     * listened for its error, so a .jxl -- recognised by the app, decodable by
     * nothing on the device -- opened as a black rectangle with a file name
     * over it and no way to tell a broken file from a broken app.
     *
     * So: ask the platform for its thumbnail, which is a real picture of the
     * file for HEIC, DNG and TIFF even when the WebView cannot read the
     * original. If that is nothing either, say so on the stage, in words, and
     * leave it there -- a toast that fades after two seconds is no use to
     * someone who walked away while the file was loading.
     */
    this.img.addEventListener("error", () => {
      const entry = this.current;
      if (!entry || entry.kind !== "image" || this.img.hidden) return;
      // Clearing the source between files can itself raise `error`. Only a
      // source that is actually set can have failed to load.
      if (!this.img.getAttribute("src")) return;
      void this.stillFailed(entry, this.loadSeq);
    });

    this.blank = el("div.phv-blank", { hidden: true }, el("p.phv-blank-what"), el("p.phv-blank-why"));

    this.canvas = el<"canvas">("canvas", { hidden: true });

    // Never `hidden`. A pane that is `display: none` between swipes is not
    // decoded or rasterised until the finger moves, and the first frame of
    // every swipe then paid for a screen-sized texture (30-45 ms on the reference phone,
    // the visible hitch). Parked a full width off to either side instead, the
    // layers stay resident and a swipe begins as a pure layer move.
    this.prevPane = el<"img">("img.phv-pane", { alt: "", decoding: "async" });
    this.nextPane = el<"img">("img.phv-pane", { alt: "", decoding: "async" });
    this.parkPanes();

    this.stage = el("div.phv-stage", {},
      this.prevPane, this.img, this.video, this.canvas, this.nextPane, this.blank,
    );

    // ── The transport ─────────────────────────────────────────────────────
    //
    // Play, elapsed, track, duration. No fullscreen button: the picture is
    // already the whole screen, and no overflow menu, because everything that
    // was behind it is a row of labelled actions underneath.
    // Born as Play. `paintPlay()` corrects it on the first play/pause event,
    // but until then nothing is playing, and a paused video that shows a pause
    // glyph and announces "Pause" to a screen reader is just wrong.
    this.playBtn = el<"button">("button.phv-icon.phv-play", {
      type: "button", "aria-label": "Play", title: "Play",
    });
    this.playBtn.append(icon("▶"));
    this.playBtn.addEventListener("click", () => { this.togglePlay(); });

    this.atEl = el("span.phv-time", { text: "0:00" });
    this.ofEl = el("span.phv-time", { text: "0:00" });
    this.trackFill = el("span.phv-track-fill");
    this.knob = el("span.phv-knob");
    this.track = el<"div">("div.phv-track", {
      role: "slider",
      "aria-label": "Seek",
      "aria-valuemin": "0",
      "aria-valuenow": "0",
      tabindex: "0",
    }, el("span.phv-track-rail"), this.trackFill, this.knob);
    this.wireSeek();

    this.vbar = el("div.phv-vbar", { hidden: true },
      this.playBtn, this.atEl, this.track, this.ofEl,
    );

    this.video.addEventListener("play", () => { this.paintPlay(); });
    this.video.addEventListener("pause", () => { this.paintPlay(); });
    this.video.addEventListener("timeupdate", () => { this.paintTime(); });
    this.video.addEventListener("durationchange", () => { this.paintTime(); });
    this.video.addEventListener("loadedmetadata", () => { this.paintTime(); });

    this.nameEl = el("span.phv-name", { text: "" });
    this.countEl = el("span.phv-count", { text: "" });

    const back = iconBtn("←", "Close", () => this.close());
    const prev = iconBtn("‹", "Previous", () => this.step(-1));
    const next = iconBtn("›", "Next", () => this.step(1));
    // In the top bar, not the action bar: five actions is the most that fits
    // at 384 px, and a star is a glance-and-tap, not a workflow.
    this.starEl = iconBtn("☆", "Favorite", () => this.toggleStar());

    const bar = el("div.phv-bar", {}, back, this.nameEl, this.countEl, this.starEl, prev, next);

    this.actions = el("div.phv-actions");
    this.toast = el("div.phv-toast", { hidden: true, role: "status" });

    // Rename and Details use a small glass sheet of their own. It used to be
    // the editor's element, borrowed; the editor is now a top bar and a dock,
    // neither of which is a sheet.
    this.aux = el("div.phv-sheet", { hidden: true });
    // Push it back down to close it. Both sheets that borrow `aux` close the
    // same two ways, so the gesture is wired once here rather than in each.
    dragToDismiss(this.aux, {
      dismiss: () => this.shutAux(),
      scroller: () => this.aux.querySelector(".phv-sheet-body"),
    });

    this.editor = new PhoneEditor({
      native: host.native,
      // A getter, not a literal: the probe answers a moment after startup, and
      // the strips are rebuilt on every entry into edit mode. Hard-coded true,
      // fifteen tools were offered on devices the binaries were never
      // packaged for and failed at spawn time instead of being greyed out.
      get ffmpeg(): boolean { return mediaReady(); },
      leave: () => this.leaveEdit(),
      say: (text) => this.say(text),
      save: (opts) => this.saveEdit(opts),
      share: (path) => this.host.fs.shareFiles([path]),
      runTool: (id) => {
        const entry = this.current;
        if (!entry) return false;

        // Four of the tiles are this screen's own bar buttons under another
        // name, and they were dead taps because the sheet handed them to the
        // shell, which has no viewer to act on. Handled here, where the file
        // being looked at and the edit in progress both already exist.
        //
        // Save deliberately does not leave edit mode first: it is the one that
        // needs the canvas still holding the edit, and it leaves on its own
        // once the bytes are down.
        switch (id) {
          case "info.delete": this.leaveEdit(); void this.remove(); return true;
          case "info.rename": this.leaveEdit(); this.showRename(); return true;
          default: break;
        }

        // A panel is about to take the whole screen. Leaving edit mode first
        // means coming back from it lands on the picture rather than on a
        // half-open sheet over a canvas that no longer matches.
        this.leaveEdit();
        const took = this.host.runTool(entry, id);
        // ...and then the viewer itself has to go. `.phv` is
        // `position: fixed; inset: 0; z-index: 500`; the panels it delegates
        // to top out at 74 (associations). Left up, every one of these ~25
        // chips opened a full-screen panel *underneath* an opaque black
        // screen, so the tap read as dead and it took two backs to escape.
        // Only on a hand-off that was actually taken -- a tool that declined
        // must not cost the picture.
        if (took) this.close();
        return took;
      },
    });

    this.el = el("div.phv", { hidden: true },
      this.stage, bar, this.vbar, this.actions, this.toast,
      this.editor.top, this.editor.el, this.aux,
    );

    this.renderActions();
    this.wireGestures();
  }

  // ── Open / close ────────────────────────────────────────────────────────

  open(entry: FileEntry, siblings: readonly FileEntry[] = [], opts: OpenOptions = {}): void {
    this.items = siblings.length > 0 ? [...siblings] : [entry];
    this.index = Math.max(0, this.items.findIndex((s) => s.path === entry.path));
    this.el.hidden = false;
    this.chrome = true;
    this.el.classList.remove("chrome-off");
    void this.load(opts);
  }

  close(): void {
    if (this.editing) {
      // The editor asks about unsaved work itself, in its own strip, and
      // calls back to leave. Hardware back lands here too.
      this.editor.requestClose();
      return;
    }
    if (!this.aux.hidden) {
      this.shutAux();
      return;
    }
    this.release();
    this.dropWarm(null);
    this.stripRest();
    this.el.hidden = true;
    this.items = [];
  }

  /** A back press. True if the viewer consumed it. */
  back(): boolean {
    if (this.el.hidden) return false;
    this.close();
    return true;
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    if (this.probeFrame) cancelAnimationFrame(this.probeFrame);
    this.probeFrame = 0;
    this.release();
    this.dropWarm(null);
    this.display.clear();
  }

  private release(): void {
    window.clearTimeout(this.blankTimer);
    this.editor.end();
    this.source?.close();
    this.source = null;
    if (this.thumbHeld) {
      this.thumbs.release(this.thumbHeld);
      this.thumbHeld = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.video.pause();
    this.vbar.hidden = true;
    this.video.removeAttribute("src");
    // Cleared with the source. A poster left behind is the previous clip's
    // frame sitting under the next one while it loads.
    this.video.removeAttribute("poster");
    this.video.load();
    this.img.removeAttribute("src");
    this.editing = false;
    this.el.classList.remove("editing", "phe");
    this.editor.el.hidden = true;
    this.editor.top.hidden = true;
    this.aux.hidden = true;
  }

  private get current(): FileEntry | undefined {
    return this.items[this.index];
  }

  private step(delta: number, opts: OpenOptions = {}): boolean {
    if (this.editing) return false;
    const next = this.index + delta;
    if (next < 0 || next >= this.items.length) return false;
    this.index = next;
    void this.load(opts);
    return true;
  }

  /**
   * The hand-over frame. The stage has the new picture's src and sits a page
   * width off to the side; the pane that glided in covers the centre with the
   * same bitmap. Wait for the stage to have decoded it, then, in one frame,
   * put the stage at rest and park the pane: same pixels before and after, so
   * nothing flashes. False if another load overtook this one.
   */
  private async handOver(seq: number): Promise<boolean> {
    await this.img.decode().catch(() => {});
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (seq !== this.loadSeq) return false;
    this.resetTransform();
    this.stripRest();
    return true;
  }

  /** Resolves once the strip is neither under a finger nor gliding. */
  private whenAtRest(): Promise<void> {
    if (!this.stripOn && !this.paging) return Promise.resolve();
    return new Promise((r) => this.restWaiters.push(r));
  }

  private async load(opts: OpenOptions = {}): Promise<void> {
    const entry = this.current;
    if (!entry) return;

    const t0 = performance.now();
    const seq = ++this.loadSeq;
    this.release();
    this.stageFull = false;
    // Whatever could not be shown last time is not this file's problem.
    this.blank.hidden = true;
    // A hand-over from the strip: the pane that was dragged in is still on
    // screen, over the stage, showing this very picture. The stage stays a
    // page width off to the side with the transform it has -- resetting it
    // now would snap the *previous* picture to the centre for the frame it
    // takes the new src to arrive. `handOver` below does the reset once the
    // new picture has decoded, in the same frame the pane is parked.
    const hand = !!opts.handover && (this.stripOn || this.paging);
    if (!hand) {
      this.resetTransform();
      if (this.stripOn || this.paging) this.stripRest();
    }
    // The seed goes up in the same task that emptied the stage, so there is
    // no frame in between with nothing on it. When the warm copy is ready the
    // stage takes it directly: one src, one decode, no intermediate bitmap.
    const warm = entry.kind === "image" ? opts.full ?? this.warmUrl(entry) : null;
    const first = warm ?? opts.seed;
    if (first) {
      this.img.src = first;
      if (entry.kind === "video" && opts.seed) this.video.poster = opts.seed;
    }

    this.nameEl.textContent = entry.name;
    this.countEl.textContent = this.items.length > 1
      ? `${this.index + 1} / ${this.items.length}`
      : "";
    this.paintStar(isFav(entry.path));
    // The four action buttons only change with the kind of file. Rebuilding
    // them on every swipe was a DOM teardown, four emoji glyph rasters and a
    // layout of the bar in the same frame the new picture landed.
    if (this.actionsKind !== entry.kind) {
      this.actionsKind = entry.kind;
      this.renderActions();
    }

    if (entry.kind === "video") {
      this.img.hidden = true;
      this.canvas.hidden = true;
      this.video.hidden = false;
      this.vbar.hidden = false;
      this.paintTime();
      this.paintPlay();

      /*
       * Open on the picture, playing (item 5).
       *
       * What this replaces: a bare `src` on a `preload="metadata"` element,
       * which paints the element's own empty background until enough of the
       * file has arrived to show a frame, and then waits to be told to play.
       * Tapping a clip in the roll gave you a grey rectangle and a play button
       * -- two taps and a blank screen between them, for a file whose first
       * frame the app had already decoded and cached to draw the tile you just
       * tapped.
       *
       * So that frame goes up as the poster. It is the same image the grid is
       * showing, so the tile appears to grow into the player with nothing
       * blank in between, and it is already in the cache -- a paint, not a
       * decode. The 200 ms race is the same bargain the still path makes
       * below: a poster is worth a short wait and never worth a stall, and
       * without one the element simply loads as it did before.
       */
      this.thumbs.retain(entry);
      this.thumbHeld = entry;
      if (hand && !(await this.handOver(seq))) return;
      if (!opts.seed) {
        const poster = await Promise.race([
          this.thumbs.get(entry, true),
          new Promise<null>((r) => window.setTimeout(() => r(null), 200)),
        ]);
        if (seq !== this.loadSeq) return;
        if (typeof poster === "string") this.video.poster = poster;
      }

      try {
        const url = await this.host.fs.fileUrl(entry.path);
        if (seq !== this.loadSeq) return;
        this.video.src = url;
        /*
         * Autoplay, with the sound on, and a rejection that is not an error.
         *
         * Opening a video means watching it; the second tap was never a
         * decision anyone wanted to make. But a browser is entitled to refuse
         * playback that it does not consider user-initiated, and the refusal
         * arrives as a rejected promise rather than an exception. Swallowing
         * it leaves exactly what the element would have shown anyway -- the
         * poster frame and a play button -- so the worst case here is the old
         * behaviour with a real picture behind it instead of grey.
         *
         * Not muted to buy a guaranteed autoplay: a clip that silently plays
         * its video with the sound off is a worse failure than one that waits
         * to be started, because nothing on screen says the sound was taken
         * away.
         */
        void this.video.play().catch(() => {});

        /*
         * The failure that does not fire `error`.
         *
         * A container Chromium can demux but whose video codec it cannot
         * decode -- Theora in Ogg is the one on this phone -- loads, reports
         * a duration, plays its audio, and paints either nothing or a field
         * of solid green. `videoWidth` stays zero, and that is the only
         * signal there is. Checked once, late enough that a slow file over a
         * content:// URI is not accused of it.
         */
        window.clearTimeout(this.blankTimer);
        this.blankTimer = window.setTimeout(() => {
          if (seq !== this.loadSeq || this.video.hidden) return;
          if (this.video.videoWidth > 0) return;
          void this.posterOnly(entry, "this format is not playable here yet", seq);
        }, BLANK_VIDEO_MS);
      } catch {
        this.say("Can't play this file");
      }
      return;
    }

    this.video.hidden = true;
    this.vbar.hidden = true;
    this.canvas.hidden = true;
    this.img.hidden = false;

    // Two-step paint. Assigning a 12 MP original straight to the visible <img>
    // left the stage blank for the whole decode — several hundred milliseconds
    // per swipe, which is the "slow as hell" of 2026-08-31. The grid already
    // holds a decoded 384 px thumbnail of this very picture, so that goes up
    // first (a paint, not a decode), and the original is decoded *off-DOM* and
    // swapped in only when it is ready. Same URL, so the swap hits the image
    // cache and costs one frame.
    this.thumbs.retain(entry);
    this.thumbHeld = entry;
    let placed: string | null = opts.seed ?? null;
    if (hand && !(await this.handOver(seq))) return;
    if (warm) {
      perf(`viewer ${entry.name} shown from warm in ${Math.round(performance.now() - t0)}ms`);
    } else {
      if (!placed) {
        const got = await Promise.race([
          this.thumbs.get(entry, true),
          new Promise<null>((r) => window.setTimeout(() => r(null), 200)),
        ]);
        if (seq !== this.loadSeq) return;
        if (typeof got === "string") {
          placed = got;
          this.img.src = got;
        }
      }
      try {
        // Screen-sized, not the file: see display.ts. The worker decodes the
        // original once with the codec scaling it down, and what reaches the
        // stage is a fraction of the texture to move.
        const copy = await this.display.get(entry);
        if (seq !== this.loadSeq) return;
        if (!copy) throw new Error("no url");
        const full = new Image();
        full.decoding = "async";
        full.src = copy.display;
        // A decode() rejection is not always a broken file (some formats never
        // report), so the URL still goes on stage and the <img> gets its say.
        await full.decode().catch(() => {});
        // Never mid-gesture: a sharpness pop while the strip is moving is a
        // flash. The swap waits for the strip to come to rest.
        await this.whenAtRest();
        if (seq !== this.loadSeq) return;
        this.img.src = copy.display;
        this.warm.set(entry.path, {
          url: copy.display,
          orig: copy.original,
          img: full,
          ready: true,
          foreign: copy.foreign,
        });
        perf(`viewer ${entry.name} display decode in ${Math.round(performance.now() - t0)}ms`);
      } catch {
        if (seq === this.loadSeq && placed === null) this.say("Can't open this file");
        return;
      }
    }

    // Warm the neighbours so the next swipe in either direction swaps in an
    // already-decoded bitmap instead of starting from the file. Two deep each
    // way, nearest first; anything further off is let go.
    this.dropWarm(entry);
    this.preload(1);
    this.preload(-1);
    this.preload(2);
    this.preload(-2);
    this.preparePanes();

    if (opts.tool) void this.enterEdit(opts.tool);
  }

  /** The decoded display copy for `entry`, if the preloader has it. */
  private warmUrl(entry: FileEntry): string | null {
    const w = this.warm.get(entry.path);
    return w && w.ready ? w.url : null;
  }

  /**
   * Forget every warm original more than two steps from `around` (all of them
   * for null). A decode still in flight is cancelled by clearing its `src`:
   * a fling across ten pictures must not leave ten full-size decodes queued
   * behind the one now needed.
   */
  private dropWarm(around: FileEntry | null): void {
    const keep = new Set<string>();
    if (around) {
      for (let d = -2; d <= 2; d += 1) {
        const n = this.items[this.index + d];
        if (n) keep.add(n.path);
      }
    }
    for (const [path, w] of this.warm) {
      if (keep.has(path)) continue;
      if (!w.ready) w.img.src = "";
      this.warm.delete(path);
    }
  }

  /** Decode the picture `delta` steps away, off-DOM, and keep it warm. */
  private preload(delta: number): void {
    const n = this.items[this.index + delta];
    if (!n || n.kind !== "image" || this.warm.has(n.path)) return;
    const im = new Image();
    im.decoding = "async";
    const rec: WarmImage = { url: "", orig: "", img: im, ready: false, foreign: false };
    this.warm.set(n.path, rec);
    void (async () => {
      try {
        const copy = await this.display.get(n);
        // Dropped while the copy was being made: do not start the decode.
        if (this.warm.get(n.path) !== rec) return;
        if (!copy) throw new Error("no url");
        rec.url = copy.display;
        rec.orig = copy.original;
        rec.foreign = copy.foreign;
        im.src = copy.display;
        await im.decode().catch(() => {});
        if (this.warm.get(n.path) !== rec) return;
        rec.ready = true;
        // The pane for this neighbour can trade its thumbnail for the original.
        this.paintPane(this.prevPane, this.index - 1);
        this.paintPane(this.nextPane, this.index + 1);
      } catch {
        this.warm.delete(n.path);
      }
    })();
  }

  /**
   * The screen turned: display copies are fitted to the screen exactly (see
   * `displayBox`), so the ones made for the other way round are the wrong
   * size. Drop them and put the current picture through again, with what is
   * on stage as the seed so nothing blinks. Only a flip counts -- the soft
   * keyboard also resizes the window, and that is not a reason to redo a
   * decode.
   */
  private refit(): void {
    const land = window.innerWidth > window.innerHeight;
    if (land === this.landscape) return;
    this.landscape = land;
    if (!this.display.fitTo(window.innerWidth, window.innerHeight, window.devicePixelRatio)) return;
    this.dropWarm(null);
    const entry = this.current;
    if (this.el.hidden || !entry || entry.kind !== "image" || this.editing) return;
    const seed = this.img.currentSrc || undefined;
    void this.load(seed ? { seed } : {});
  }

  /** Point the side panes at the current neighbours, thumbnail or original. */
  private preparePanes(): void {
    this.panesDirty = false;
    this.paintPane(this.prevPane, this.index - 1);
    this.paintPane(this.nextPane, this.index + 1);
  }

  private paintPane(pane: HTMLImageElement, at: number): void {
    // A pane on screen keeps the picture it has: a src change under the finger
    // is a blank frame or a sharpness pop. `stripRest` repaints at rest.
    if (this.stripOn || this.paging) {
      this.panesDirty = true;
      return;
    }
    const n = this.items[at];
    if (!n) {
      pane.dataset["path"] = "";
      pane.removeAttribute("src");
      return;
    }
    const full = this.warmUrl(n);
    if (full) {
      if (pane.dataset["path"] !== n.path || pane.dataset["full"] !== "1") {
        pane.dataset["path"] = n.path;
        pane.dataset["full"] = "1";
        pane.src = full;
      }
      return;
    }
    if (pane.dataset["path"] === n.path) return;
    pane.dataset["path"] = n.path;
    pane.dataset["full"] = "0";
    pane.removeAttribute("src");
    // The grid's thumbnail, the same one the tile shows: a paint, not a decode.
    void this.thumbs.get(n, false).then((url) => {
      if (pane.dataset["path"] !== n.path || pane.dataset["full"] === "1") return;
      if (typeof url === "string") pane.src = url;
    });
  }

  /** What the pane at `delta` is showing, for the hand-over into `load`. */
  private paneSeed(delta: number): OpenOptions {
    const pane = delta < 0 ? this.prevPane : this.nextPane;
    const n = this.items[this.index + delta];
    if (!n || pane.dataset["path"] !== n.path || !pane.src) return {};
    const full = this.warmUrl(n);
    return full ? { seed: full, full } : { seed: pane.src };
  }

  /**
   * Finger speed at release in px/ms, from the last ~80 ms of samples. The
   * final sample alone is too noisy -- touch events arrive unevenly -- and
   * the whole drag is too slow to notice a flick at the end of a hesitation.
   */
  private releaseVelocity(samples: readonly { x: number; t: number }[], endX: number): number {
    const now = performance.now();
    let from = samples[0];
    for (const s of samples) {
      if (now - s.t <= 80) {
        from = s;
        break;
      }
    }
    if (!from) return 0;
    const dt = now - from.t;
    if (dt <= 0) return 0;
    return (endX - from.x) / dt;
  }

  // ── Strip motion ────────────────────────────────────────────────────────

  /** Bring the side panes on and take the stage width. */
  private stripBegin(): void {
    if (this.stripOn) return;
    this.stripOn = true;
    this.stripW = this.stage.clientWidth || window.innerWidth;
    this.probeStart("drag");
    this.stripMove(0);
  }

  // ── Frame probe ────────────────────────────────────────────────────────
  // A rAF loop that runs only while the strip is in motion and writes one
  // `perf` line per swipe naming every frame over 20 ms and the phase it fell
  // in (drag / glide / settle). `dumpsys gfxinfo` says *that* frames were
  // dropped; this says *where*, and reaches logcat from a release build.

  private probeStart(phase: string): void {
    this.probePhase = phase;
    if (this.probeFrame) return;
    this.probeLong = [];
    this.probeCount = 0;
    this.probeLast = performance.now();
    const tick = (now: number) => {
      const dt = now - this.probeLast;
      this.probeLast = now;
      this.probeCount += 1;
      if (dt > 20 && this.probeCount > 1) this.probeLong.push(`${this.probePhase}+${Math.round(dt)}`);
      this.probeFrame = requestAnimationFrame(tick);
    };
    this.probeFrame = requestAnimationFrame(tick);
  }

  private probeStop(): void {
    if (!this.probeFrame) return;
    cancelAnimationFrame(this.probeFrame);
    this.probeFrame = 0;
    perf(`swipe ${this.probeCount} frames, long: ${this.probeLong.join(" ") || "none"}`);
  }

  /** Schedule one frame's worth of strip movement. */
  private stripMove(dx: number): void {
    this.stripDx = dx;
    if (this.stripFrame) return;
    this.stripFrame = requestAnimationFrame(() => {
      this.stripFrame = 0;
      this.applyStrip();
    });
  }

  private applyStrip(): void {
    const dx = this.stripDx;
    const w = this.stripW;
    this.tx = dx;
    this.ty = 0;
    this.applyTransform();
    this.prevPane.style.transform = `translate3d(${dx - w}px, 0, 0)`;
    this.nextPane.style.transform = `translate3d(${dx + w}px, 0, 0)`;
  }

  /**
   * Finger up: settle on the page the drag and its speed chose. The strip
   * animates to a full page width, and only then does the stage take the new
   * picture over from the pane -- with the pane's own bitmap as its seed, so
   * the swap is not visible.
   */
  private stripEnd(dx: number, vx: number): void {
    if (this.stripFrame) {
      cancelAnimationFrame(this.stripFrame);
      this.stripFrame = 0;
    }
    const hasPrev = this.index - 1 >= 0;
    const hasNext = this.index + 1 < this.items.length;
    const target = pageTarget(dx, vx, this.stripW, hasPrev, hasNext);
    this.glide(true);
    this.probePhase = "glide";
    if (target === 0) {
      this.stripDx = 0;
      this.applyStrip();
      window.setTimeout(() => {
        this.stripRest();
        this.probeStop();
      }, PAGE_MS + 40);
      return;
    }
    this.paging = true;
    this.stripDx = -target * this.stripW;
    this.applyStrip();
    const seed = this.paneSeed(target);
    // Hand over when the glide has actually finished, not when a timer thinks
    // it has: `transitionend` on the pane coming in, with a timer as the
    // fallback for a pane that had nothing to animate. `paging` stays set and
    // the pane stays where it landed until `handOver` has the stage ready.
    const pane = target > 0 ? this.nextPane : this.prevPane;
    let done = false;
    const go = (): void => {
      if (done) return;
      done = true;
      pane.removeEventListener("transitionend", go);
      this.probePhase = "settle";
      if (!this.step(target, { ...seed, handover: true })) this.stripRest();
      window.setTimeout(() => this.probeStop(), 160);
    };
    pane.addEventListener("transitionend", go);
    window.setTimeout(go, PAGE_MS + 80);
  }

  /** Strip motion over: transitions off, panes parked a width off screen. */
  private stripRest(): void {
    this.glide(false);
    this.stripOn = false;
    this.paging = false;
    this.parkPanes();
    if (this.panesDirty) this.preparePanes();
    const waiters = this.restWaiters;
    this.restWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Both panes a full width off screen, in their own terms: a pane is as wide
   * as the stage, so `100%` is the stage width whatever the rotation, and the
   * stage's `overflow: hidden` clips them. The layer is kept, the pixels are not
   * seen.
   */
  private parkPanes(): void {
    this.prevPane.style.transform = "translate3d(-100%, 0, 0)";
    this.nextPane.style.transform = "translate3d(100%, 0, 0)";
  }

  // ── Chrome ──────────────────────────────────────────────────────────────

  private toggleChrome(): void {
    if (this.editing) return;
    this.chrome = !this.chrome;
    this.el.classList.toggle("chrome-off", !this.chrome);
  }

  /**
   * Show the clip's own frame instead of a player that cannot play it.
   *
   * The frame comes from the same cache the grid drew its tile from, so in
   * the ordinary case this is a paint. Waited for properly rather than raced:
   * there is nothing else going on stage, so a slow decode is worth more than
   * an empty screen.
   */
  private async posterOnly(entry: FileEntry, why: string, seq: number): Promise<void> {
    window.clearTimeout(this.blankTimer);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.hidden = true;
    this.vbar.hidden = true;
    this.canvas.hidden = true;
    this.img.hidden = false;
    this.say(`${entry.name.slice(0, 28)} — ${why}`);
    let poster: unknown = null;
    try {
      poster = await this.thumbs.get(entry, true);
    } catch {
      poster = null;
    }
    if (seq !== this.loadSeq) return;
    if (typeof poster === "string") this.img.src = poster;
  }

  /**
   * The still equivalent of `posterOnly`: the <img> refused the file.
   *
   * The platform thumbnailer is tried first and is genuinely a different
   * decoder -- it reads HEIC, DNG, TIFF and CR2, none of which a WebView
   * touches -- so a failure here is often still recoverable into a real
   * picture of the file. Only when that comes back empty is the stage given
   * over to a sentence.
   */
  private async stillFailed(entry: FileEntry, seq: number): Promise<void> {
    let poster: unknown = null;
    try {
      poster = await this.thumbs.get(entry, true);
    } catch {
      poster = null;
    }
    if (seq !== this.loadSeq || this.current?.path !== entry.path) return;
    if (typeof poster === "string" && poster !== this.img.src) {
      this.img.src = poster;
      return;
    }
    this.showBlank(entry);
  }

  /**
   * No picture, and no prospect of one. Say which file and why, and stop.
   *
   * The reason is the extension, because that is the true one and it is also
   * the actionable one: "this phone has no JPEG XL decoder" tells you the file
   * is fine and the device is the limit, which is a different problem from a
   * file that is damaged, and the two used to look identical -- both black.
   */
  private showBlank(entry: FileEntry): void {
    const ext = entry.ext ? entry.ext.toUpperCase() : "";
    const what = this.blank.querySelector(".phv-blank-what");
    const why = this.blank.querySelector(".phv-blank-why");
    if (what) what.textContent = ext ? `No ${ext} decoder` : "Can't show this file";
    if (why) {
      why.textContent = ext
        ? `Nothing on this phone can read ${ext}. The file itself is untouched -- share it to an app that can, or convert it.`
        : "The file could not be decoded. It may be damaged.";
    }
    this.img.hidden = true;
    this.blank.hidden = false;
  }

  private say(text: string): void {
    this.toast.textContent = text;
    this.toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast.hidden = true; }, 2600);
  }

  /**
   * The four actions: Share, Edit, Info, Delete.
   *
   * Icon *and* word, every one of them. This is the direct answer to "buttons
   * that are clear what it is" — the desktop explained its glyphs with hover
   * tooltips, and a finger cannot hover, so the explanation has to be on the
   * button.
   *
   * There used to be a fifth, Blur, beside Edit. User testing's verdict was
   * "why do we need those two buttons, just merge the two — all the editing
   * should be within an Edit button", and that is right: Blur was one group
   * of the editor's rail promoted to the front, so the bar was offering the
   * same place twice under two names. Blur is now where every other tool is:
   * in the editor's rail, one tap past Edit. Four actions also get room to
   * breathe at 360 px; the bar centres them rather than stretching them to
   * the corners (see phone-viewer.css).
   */
  private renderActions(): void {
    const kind = this.current?.kind ?? "image";

    // A video gets a live Edit button too — it opens the video editor at the
    // trim tool, which is where trimming and burned-in blur for a clip live.
    // Greying it out, which is what this once did, left every video in the
    // roll with a dead control and no hint that the tools existed elsewhere.
    const toEditor = (id: string) => () => {
      const entry = this.current;
      if (!entry) return;
      this.close();
      if (!this.host.runTool(entry, id)) this.say("No editor for this kind of file");
    };

    fill(this.actions,
      action("↗", "Share", () => void this.share()),
      action("✎", "Edit",
        kind === "image" ? () => void this.enterEdit() : toEditor("tf.trim")),
      action("ⓘ", "Info", () => this.showInfo()),
      action("🗑", "Delete", () => void this.remove()),
    );
  }

  // ── Editing ─────────────────────────────────────────────────────────────

  /**
   * Enter the editor.
   *
   * The full-resolution bitmap is decoded here rather than reusing the `<img>`,
   * because the engine renders at source size so preview and export are the same
   * code path — an editor that previews at screen resolution and exports at full
   * resolution is one where the blur you approved is not the blur you saved.
   */
  private async enterEdit(tool?: string): Promise<void> {
    const entry = this.current;
    if (!entry || entry.kind !== "image") return;

    this.say("Loading full resolution…");
    try {
      const url = await this.host.fs.fileUrl(entry.path);
      const blob = await (await fetch(url)).blob();
      this.source = await createImageBitmap(blob);
    } catch {
      this.say("Can't edit this file");
      return;
    }

    this.editing = true;
    this.resetTransform();
    // `phe` is real edit mode: the grid gains a top bar and a dock and the
    // stage shrinks to fit between them, so the whole picture stays on screen.
    // Distinct from `editing`, which the rename and details sheets still use.
    this.aux.hidden = true;
    this.el.classList.remove("editing");
    this.el.classList.add("phe");
    this.img.hidden = true;
    this.video.hidden = true;
    this.canvas.hidden = false;
    this.editor.top.hidden = false;
    this.editor.el.hidden = false;

    this.editor.begin(this.source, this.canvas, entry.kind, entry.name);

    // Fire whatever tile the caller named. This used to test for one specific
    // id, so passing any other tool opened a bare editor and silently dropped
    // the instruction -- which is what happened the moment Blur stopped meaning
    // "fog everything".
    if (tool) this.editorRun(tool);
    this.toast.hidden = true;
  }

  /** Fire a tool by id from outside the sheet. */
  private editorRun(id: string): void {
    if (!this.editor.runById(id)) this.say("That tool is not available here");
  }

  /**
   * Leave edit mode. Unsaved work has already been asked about by the editor,
   * whose confirm lives in its strip rather than in a `confirm()` the WebView
   * would block on.
   */
  private leaveEdit(): void {
    if (!this.editing) return;
    this.editing = false;
    this.el.classList.remove("phe");
    this.editor.el.hidden = true;
    this.editor.top.hidden = true;
    this.editor.end();
    this.resetTransform();
    this.canvas.hidden = true;
    this.img.hidden = false;
    this.source?.close();
    this.source = null;
    this.renderActions();
  }

  /**
   * Write the edit out. A copy beside the original unless told otherwise.
   *
   * A copy is the default and the only path that does not ask first. This
   * app's whole purpose is removing things from pictures, and an in-place
   * default means the one operation you cannot undo is also the default one.
   * The name carries the suffix so the copy is obvious in any gallery,
   * including the phone's own. Resolves to the path written, or null.
   */
  private async saveEdit(opts: SaveOptions): Promise<string | null> {
    const entry = this.current;
    if (!entry) return null;
    if (!this.host.native) {
      this.say("Saving needs the installed app");
      return null;
    }
    if (!this.editor.dirty) {
      this.say("Nothing to save yet");
      return null;
    }

    this.say("Saving…");
    this.editor.clearHandles();

    const jpeg = entry.ext === "jpg" || entry.ext === "jpeg";
    const data = await this.editor.encode(jpeg ? "image/jpeg" : "image/png", opts.quality);
    if (!data) {
      this.say("Couldn't encode the picture");
      return null;
    }

    if (opts.overwrite) {
      // Only ever reached through the editor's own "Replace" confirm.
      try {
        const written = await this.host.fs.writeFile(entry.path, data, true);
        this.say(`Saved over ${entry.name}`);
        void this.store.refresh();
        return written;
      } catch (err) {
        this.say(`Couldn't save: ${String(err)}`);
        return null;
      }
    }

    // Never over the original. `writeFile(.., false)` *fails* when the name is
    // taken rather than picking another, so the numbering is ours to do — and it
    // has to be done, because the second edit of the same photo is the ordinary
    // case, not the rare one, and without this it fails with "already exists".
    const dot = entry.path.lastIndexOf(".");
    const slash = entry.path.lastIndexOf("/");
    const stem = dot > slash ? entry.path.slice(0, dot) : entry.path;
    const tail = jpeg ? "jpg" : "png";

    for (let n = 1; n <= 50; n++) {
      const out = n === 1 ? `${stem}-facet.${tail}` : `${stem}-facet-${n}.${tail}`;
      try {
        const written = await this.host.fs.writeFile(out, data, false);
        this.say(`Saved as ${written.split("/").pop() ?? out}`);
        void this.store.refresh();
        return written;
      } catch (err) {
        // "already exists" is the one failure worth another go. Anything else —
        // no permission, no space, a read-only volume — repeats fifty times and
        // ends in the same place, so it stops here with the real reason.
        if (!/already exists/i.test(String(err))) {
          this.say(`Couldn't save: ${String(err)}`);
          return null;
        }
      }
    }
    this.say("Fifty edits of this picture already saved beside it");
    return null;
  }

  // ── Browse actions ──────────────────────────────────────────────────────

  private async share(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    if (!this.host.native) {
      this.say("Sharing needs the installed app");
      return;
    }
    try {
      await this.host.fs.shareFiles([entry.path]);
    } catch {
      this.say("Nothing available to share to");
    }
  }

  private toggleStar(): void {
    const entry = this.current;
    if (!entry) return;
    const on = toggleFav(entry.path);
    this.paintStar(on);
    this.say(on ? "Added to Favorites" : "Removed from Favorites");
  }

  private paintStar(on: boolean): void {
    // One drawing, two states: `.phv-starred` fills the outline via CSS.
    this.starEl.classList.toggle("phv-starred", on);
  }

  /**
   * Delete, into a trash folder rather than off the card.
   *
   * A move, not an unlink: a gallery whose delete button is irreversible is one
   * you use carefully rather than freely, and the whole point of a roll is that
   * you can clear it out quickly. `.facet-trash` sits beside the file so the
   * move stays on the same volume, which is what makes it instant.
   */
  private async remove(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    if (!this.host.native) {
      this.say("Deleting needs the installed app");
      return;
    }

    const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
    const dest = `${dir}/.facet-trash/${entry.name}`;

    let landed: string;
    try {
      landed = (await this.host.fs.moveFile(entry.path, dest, false)).path;
    } catch {
      this.say("Couldn't move it to the trash");
      return;
    }

    this.say("Moved to trash");
    dropFav(entry.path);
    // Into the store's trash list, not just out of the roll — the Trash screen
    // must show this file without waiting for the next full walk.
    this.store.noteTrashed(entry.path, landed);

    // Advance to whatever is next, or leave if that was the last one.
    this.items.splice(this.index, 1);
    if (this.items.length === 0) {
      this.close();
      return;
    }
    if (this.index >= this.items.length) this.index = this.items.length - 1;
    void this.load();
  }

  /**
   * Rename, in the sheet rather than in a dialog.
   *
   * `prompt()` would be four lines instead of forty, and it is not an option:
   * a modal dialog in the Android WebView blocks the event loop the whole app
   * runs on, and the platform is free to suppress it outright, which fails by
   * doing nothing at all.
   *
   * The extension is kept out of the field and re-attached on the way out.
   * Renaming a photo to something with no extension is a way to lose it from
   * the gallery entirely, and nobody who types a new name means to do that.
   */
  private showRename(): void {
    const entry = this.current;
    if (!entry) return;
    if (!this.host.native) {
      this.say("Renaming needs the installed app");
      return;
    }

    const dot = entry.name.lastIndexOf(".");
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
    const ext = dot > 0 ? entry.name.slice(dot) : "";

    const field = el<"input">("input.phv-field", {
      type: "text",
      value: stem,
      "aria-label": "New name",
      spellcheck: false,
      autocapitalize: "off",
      autocomplete: "off",
    });

    const note = el("p.phv-ctl-note", { text: ext ? `Keeps the ${ext} ending` : "" });

    const shut = (): void => { this.shutAux(); };

    const go = async (): Promise<void> => {
      const typed = field.value.trim();
      if (typed === "" || typed === stem) { shut(); return; }
      // The characters that are not a name on any volume this runs on. Silently
      // stripping them beats a rename that fails with an errno.
      const clean = typed.replace(/[\\/:*?"<>|]/g, "").trim();
      if (clean === "") {
        note.textContent = "That name has nothing usable in it";
        return;
      }

      const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
      const dest = `${dir}/${clean}${ext}`;
      try {
        const res = await this.host.fs.moveFile(entry.path, dest, false);
        // `copied` means it crossed volumes and the original is still there.
        // Not possible for a rename in place, but the adapter can say it, and
        // reporting "renamed" when there are now two files would be a lie.
        if (res.copied) {
          this.say("Copied rather than renamed \u2014 the original is still there");
        } else {
          this.say(`Renamed to ${clean}${ext}`);
        }
        this.store.forget(entry.path);
        void this.store.refresh();
        // The open item now points at a path that no longer exists. Correcting
        // it in place keeps the swipe order and the position in the roll.
        const at = this.items[this.index];
        if (at) this.items[this.index] = { ...at, path: res.path, name: `${clean}${ext}` };
        shut();
        void this.load();
      } catch (err) {
        note.textContent = /already exists/i.test(String(err))
          ? "There is already a file with that name here"
          : `Couldn't rename: ${String(err)}`;
      }
    };

    field.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); void go(); }
    });

    const ok = el<"button">("button.phv-note-btn", { type: "button", text: "Rename" });
    ok.addEventListener("click", () => void go());

    const close = el<"button">("button.phv-sheet-close", { type: "button", text: "Cancel" });
    close.addEventListener("click", shut);

    fill(this.aux,
      el("div.phv-grab", { "aria-hidden": true }),
      el("div.phv-sheet-head", {}, el("h2.phv-sheet-title", { text: "Rename" }), close),
      el("div.phv-sheet-body", {},
        el("div.phv-ctl", {}, field, note),
        ok,
      ),
    );
    this.aux.hidden = false;
    this.el.classList.add("editing");
    // Focus after the sheet is on screen, or the keyboard opens against an
    // element that is still hidden and closes again immediately.
    requestAnimationFrame(() => { field.focus(); field.select(); });
  }

  /**
   * Put the Details/Rename sheet away.
   *
   * The class has to come off with it. It came from opening the sheet, not
   * from real edit mode, and left on it keeps the bottom action bar at
   * `display: none` until the viewer itself is closed.
   */
  private shutAux(): void {
    this.aux.hidden = true;
    this.el.classList.remove("editing");
  }

  /** File facts, in the same sheet the tools use. */
  private showInfo(): void {
    const entry = this.current;
    if (!entry) return;

    const facts: Array<[string, string]> = [
      ["Name", entry.name],
      ["Folder", entry.path.slice(0, entry.path.lastIndexOf("/")) || "/"],
      ["Kind", entry.kind],
      ["Size", bytes(entry.size) || "unknown"],
      ["Modified", entry.modified ? new Date(entry.modified).toLocaleString() : "unknown"],
    ];
    if (entry.width && entry.height) facts.push(["Dimensions", `${entry.width} × ${entry.height}`]);
    if (entry.duration) facts.push(["Duration", formatDuration(entry.duration)]);
    facts.push(["Last opened", shortDate(Date.now())]);

    const list = el("dl.phv-facts");
    for (const [k, v] of facts) {
      list.append(el("div.phv-fact", {}, el("dt", { text: k }), el("dd", { text: v })));
    }

    // Read afterwards, and appended when it lands: the sheet must open at a
    // tap's speed, and a file on a phone's own storage still costs a round trip
    // through IPC. Nothing below is on the path to the facts above.
    const metaSlot = el("div.phv-meta");
    void this.showMeta(entry, metaSlot);

    const close = el<"button">("button.phv-sheet-close", { type: "button", text: "Close" });
    close.addEventListener("click", () => { this.shutAux(); });

    fill(this.aux,
      el("div.phv-grab", { "aria-hidden": true }),
      el("div.phv-sheet-head", {}, el("h2.phv-sheet-title", { text: "Details" }), close),
      el("div.phv-sheet-body", {}, list, metaSlot),
    );
    this.aux.hidden = false;
    this.el.classList.add("editing");
  }

  /**
   * What the file says about the person who made it, and the way to delete it.
   *
   * This sheet used to stop at name, size and date -- the five facts the
   * gallery already had in memory. Meanwhile the picture carried the camera
   * body, its serial number, the second the shutter fired and, from a phone,
   * the coordinates of wherever that was; there was no way to see any of it and
   * no way to remove it without a desktop. For an app whose whole argument is
   * that your files stay yours, that was the wrong half to ship first.
   *
   * The default is a copy, not an overwrite. Stripping is not reversible and
   * the original is somebody's photograph.
   */
  private async showMeta(entry: FileEntry, slot: HTMLElement): Promise<void> {
    if (!this.host.native) return;
    // The heading goes up whatever happens below it. Returning early on a
    // read failure took the whole Metadata block -- including "Save a clean
    // copy" -- off the sheet with no explanation, so Info looked like it had
    // fewer features on some files than on others for no visible reason.
    const head3 = (): void => {
      if (!slot.querySelector(".phv-meta-head")) {
        slot.append(el("h3.phv-meta-head", { text: "Metadata" }));
      }
    };
    if (entry.kind !== "image") {
      head3();
      slot.append(el("p.phv-meta-note", { text: "Metadata is read for photos only." }));
      return;
    }
    let meta;
    try {
      const head = new Uint8Array(await this.host.fs.readHead(entry.path, META_BYTES));
      meta = readMetadata(head);
    } catch {
      head3();
      slot.append(el("p.phv-meta-note", { text: "Couldn't read this file's metadata." }));
      return;
    }
    if (!meta) {
      head3();
      slot.append(el("p.phv-meta-note", { text: "No metadata in this file." }));
      return;
    }

    const tags = meta.groups.reduce((n, g) => n + g.tags.length, 0);
    if (tags === 0 && !meta.strippable) {
      head3();
      slot.append(el("p.phv-meta-note", { text: "No metadata in this file." }));
      return;
    }

    const gps = meta.gps
      ? el("p.phv-meta-warn", { text: "This file records where it was taken." })
      : null;
    const count = el("p.phv-meta-note", {
      text: tags === 1 ? "1 metadata tag" : `${tags} metadata tags`,
    });
    head3();
    slot.append(count);
    if (gps) slot.append(gps);

    if (!meta.strippable) {
      slot.append(el("p.phv-meta-note", { text: "Nothing removable in this format." }));
      return;
    }

    const status = el("p.phv-meta-note");
    const btn = el<"button">("button.phv-meta-btn", {
      type: "button",
      text: "Save a clean copy",
    });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      status.textContent = "Cleaning…";
      void (async () => {
        try {
          // Read whole, not head: the tags are at the front but the picture is
          // the rest of the file, and a strip that wrote back only the head
          // would be a delete with extra steps.
          const all = new Uint8Array(
            await this.host.fs.readHead(entry.path, entry.size ?? META_BYTES),
          );
          const r = strip(all);
          if (!r) { status.textContent = "Nothing to remove."; return; }
          const dot = entry.path.lastIndexOf(".");
          const out = dot > entry.path.lastIndexOf("/")
            ? `${entry.path.slice(0, dot)}-clean${entry.path.slice(dot)}`
            : `${entry.path}-clean`;
          const written = await this.host.fs.writeFile(out, r.bytes, false);
          status.textContent =
            `Saved ${written.slice(written.lastIndexOf("/") + 1)} — ` +
            `${bytes(r.saved) || "0 B"} of metadata removed.`;
        } catch (e) {
          status.textContent = `Could not write the copy: ${String(e).slice(0, 80)}`;
          btn.disabled = false;
        }
      })();
    });
    slot.append(btn, status);
  }

  // ── Gestures ────────────────────────────────────────────────────────────

  private resetTransform(): void {
    window.clearTimeout(this.fullTimer);
    if (this.xfFrame) {
      cancelAnimationFrame(this.xfFrame);
      this.xfFrame = 0;
    }
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.dismiss = 0;
    this.glide(false);
    this.applyTransform();
  }

  /**
   * Put the right picture under a zoom.
   *
   * Past `FULL_ZOOM` the display copy is being stretched further than its
   * spare resolution covers, so once the pinch has settled the original is
   * decoded off-DOM and swapped in; back at or below it the copy returns,
   * which is what makes the next swipe cheap again. Called when a gesture
   * ends, never per frame: the swap is one decode, not a per-move cost.
   */
  private syncSource(): void {
    window.clearTimeout(this.fullTimer);
    const entry = this.current;
    if (!entry || entry.kind !== "image" || this.editing) return;
    const w = this.warm.get(entry.path);
    if (!w || !w.ready || !w.orig || w.url === w.orig || w.foreign) return;
    if (wantsOriginal(this.scale)) {
      if (this.stageFull) return;
      const seq = this.loadSeq;
      this.fullTimer = window.setTimeout(() => { void this.swapOriginal(entry.name, w, seq); }, FULL_SETTLE_MS);
      return;
    }
    if (this.stageFull) {
      this.stageFull = false;
      this.img.src = w.url;
    }
  }

  private async swapOriginal(name: string, w: WarmImage, seq: number): Promise<void> {
    const t0 = performance.now();
    const full = new Image();
    full.decoding = "async";
    full.src = w.orig;
    await full.decode().catch(() => {});
    if (seq !== this.loadSeq || this.stageFull || !wantsOriginal(this.scale) || this.editing) return;
    this.stageFull = true;
    this.img.src = w.orig;
    perf(`viewer ${name} original in at ${this.scale.toFixed(2)}x after ${Math.round(performance.now() - t0)}ms`);
  }

  /** Coalesce a burst of touch moves into one transform write per frame. */
  private scheduleTransform(): void {
    if (this.xfFrame) return;
    this.xfFrame = requestAnimationFrame(() => {
      this.xfFrame = 0;
      this.applyTransform();
    });
  }

  /**
   * Turn the transform transition on for a spring-back and off for a drag.
   *
   * A transition is exactly wrong while a finger is down -- the picture lags
   * behind the thumb by the duration of the ease, which is the specific feeling
   * of an interface that is not listening -- and exactly right the moment the
   * finger lifts, because a picture that teleports back to centre reads as a
   * glitch rather than as a cancelled gesture.
   */
  /**
   * Return the picture to rest, visibly.
   *
   * The glide is cleared afterwards so the next drag is not fighting a
   * transition; the timeout matches the duration in `glide`, and running early
   * only ends an animation that has already arrived.
   */
  private snapBack(): void {
    this.glide(true);
    this.tx = 0;
    this.ty = 0;
    this.dismiss = 0;
    this.applyTransform();
    window.setTimeout(() => this.glide(false), 240);
  }

  private glide(on: boolean): void {
    const t = on ? `transform ${PAGE_MS}ms cubic-bezier(.2,.7,.3,1)` : "";
    this.img.style.transition = t;
    this.video.style.transition = t;
    this.canvas.style.transition = t;
    this.prevPane.style.transition = t;
    this.nextPane.style.transition = t;
  }

  private applyTransform(): void {
    // The dismissal shrink multiplies the zoom rather than replacing it, so a
    // gesture that starts at 1x behaves the same as one that starts zoomed out
    // of a pinch, and neither has to know about the other.
    // `translate3d`, so the picture lives on its own compositor layer and a
    // drag is a layer move, not a repaint of a 12 MP bitmap per frame.
    const t =
      `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale * (1 - this.dismiss * 0.3)})`;
    // Drives the background fade and the chrome. Set on the root rather than
    // read back out of the transform, because CSS cannot see a matrix -- and
    // only when it moved: a custom property on the root restyles the whole
    // viewer subtree, which a pinch or a page turn has no reason to pay for.
    if (this.dismiss !== this.dismissVar) {
      this.dismissVar = this.dismiss;
      this.el.style.setProperty("--phv-dismiss", this.dismiss.toFixed(3));
    }
    this.img.style.transform = t;
    // The video as well. Every gesture on this screen is wired to the stage,
    // so a pinch over a playing video always *ran* -- `this.scale` went up,
    // `syncSource` was consulted, the whole machine turned -- and then the one
    // line that puts the number on screen only ever wrote to the still image.
    // The result was a video you could not zoom, next to a photograph you
    // could, with no reason on screen for the difference. Anything on the
    // stage is a picture as far as a finger is concerned.
    this.video.style.transform = t;
    // The canvas as well, or zoom silently does nothing the moment you start
    // editing -- which is exactly when it matters, because the editor shows the
    // canvas and hides the img. `toImage` reads `getBoundingClientRect`, which
    // already accounts for the transform, so the mapping from finger to pixel
    // stays correct at every scale with no extra arithmetic.
    this.canvas.style.transform = t;
    // Nearest-neighbour past the point where interpolation is a lie: at 24x a
    // smoothed canvas shows a soft grey haze where the pixel you are trying to
    // mask actually has an edge.
    const pix = this.scale >= 4;
    if (pix !== this.pixelated) {
      this.pixelated = pix;
      this.canvas.style.imageRendering = pix ? "pixelated" : "auto";
    }
  }

  /** Screen point → normalised image coordinates, through the canvas box. */
  private toImage(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (clientY - box.top) / box.height)),
    };
  }

  private wireGestures(): void {
    this.stage.addEventListener("touchstart", (ev) => {
      if (ev.touches.length === 2) {
        // A second finger landing mid-stroke ends the stroke rather than
        // abandoning it: `dragStart` has already pushed a region and an undo
        // entry, and dropping `this.drag` without telling the editor left a
        // half-painted stroke that the next drag would continue from.
        if (this.drag?.edit) this.editor.dragEnd();

        const base = spread(ev.touches);
        const c = centroid(ev.touches);
        // A zero base would make every later ratio infinite; two fingers landing
        // on the exact same pixel is rare but it is not impossible.
        this.pinch = base > 0
          ? { base, scale: this.scale, cx: c.x, cy: c.y, tx: this.tx, ty: this.ty }
          : null;
        this.drag = null;
        return;
      }

      const t = ev.touches[0];
      if (!t) return;

      // A drag that begins in the system's back-gesture strip is not ours, and
      // trying to claim it produces a viewer that fights the OS and loses.
      const nearEdge =
        t.clientX < EDGE_GESTURE_PX || t.clientX > window.innerWidth - EDGE_GESTURE_PX;

      const editHere =
        this.editing && this.editor.armed && !this.canvas.hidden;

      // Mid-settle from the last swipe: let it finish rather than tear the
      // strip out from under the animation.
      if (this.paging) return;

      this.glide(false);
      this.drag = {
        x: t.clientX, y: t.clientY,
        sx: this.tx, sy: this.ty,
        moved: false,
        edit: editHere,
        axis: "",
        samples: [{ x: t.clientX, t: performance.now() }],
      };

      if (editHere) {
        const p = this.toImage(t.clientX, t.clientY);
        this.editor.dragStart(p.x, p.y);
      } else if (nearEdge && this.scale === 1) {
        // Let the system have it.
        this.drag = null;
      }
    }, { passive: true });

    this.stage.addEventListener("touchmove", (ev) => {
      if (this.pinch && ev.touches.length === 2) {
        const ratio = spread(ev.touches) / this.pinch.base;
        this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.pinch.scale * ratio));
        if (this.scale === MIN_SCALE) {
          this.tx = 0;
          this.ty = 0;
        } else {
          // Follow the midpoint. Without this the picture zooms about its own
          // centre and the detail you pinched towards slides off the screen,
          // which at 24x means it is gone.
          const c = centroid(ev.touches);
          this.tx = this.pinch.tx + (c.x - this.pinch.cx);
          this.ty = this.pinch.ty + (c.y - this.pinch.cy);
        }
        this.scheduleTransform();
        return;
      }

      const d = this.drag;
      if (!d || ev.touches.length !== 1) return;
      const t = ev.touches[0];
      if (!t) return;
      const dx = t.clientX - d.x;
      const dy = t.clientY - d.y;
      if (Math.hypot(dx, dy) > TAP_SLOP) d.moved = true;

      if (d.edit) {
        const p = this.toImage(t.clientX, t.clientY);
        this.editor.dragMove(p.x, p.y);
        return;
      }

      // Zoomed in, a drag pans. At 1× it is a swipe or a dismissal.
      if (this.scale > 1) {
        this.tx = d.sx + dx;
        this.ty = d.sy + dy;
        this.scheduleTransform();
        return;
      }

      /*
       * Item 4: the picture comes with your finger.
       *
       * It used to sit perfectly still through the entire drag and then vanish
       * on release if you happened to have passed a threshold you could not
       * see. Nothing on screen said a gesture was in progress, said which way
       * it was going, or said how far was far enough -- so the only way to find
       * out whether you were dismissing the photograph was to let go.
       *
       * The axis is locked once, at the moment the drag passes the tap slop,
       * and never revisited. Deciding it per frame means a drag held near the
       * diagonal flickers between turning the page and dismissing, and a finger
       * is never as straight as the person moving it believes.
       */
      if (d.axis === "" && Math.hypot(dx, dy) > TAP_SLOP) {
        d.axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
        if (d.axis === "x") this.stripBegin();
      }
      if (d.axis === "x") {
        // The page comes with the finger. Resistance at either end of the
        // roll says "nothing further this way" without a modal, and the
        // velocity samples decide on release whether a short fast flick turns
        // the page.
        d.samples.push({ x: t.clientX, t: performance.now() });
        if (d.samples.length > 6) d.samples.shift();
        this.stripMove(stripOffset(dx, this.index - 1 >= 0, this.index + 1 < this.items.length));
        return;
      }
      if (d.axis !== "y") return;

      // Sideways motion is damped rather than ignored: following it exactly
      // would let a dismissal wander off the side of the screen, and dropping
      // it entirely makes the picture feel stuck to a rail.
      this.tx = dx * 0.35;
      this.ty = dy;
      // Downward only. The picture follows the finger either way -- that is the
      // whole point of the item -- but only a downward drag can dismiss, so
      // only a downward drag shrinks and fades. Measuring the distance with
      // `Math.abs` meant an upward swipe shrank the photograph to 70% exactly
      // as a real dismissal does and then sprang back on release, which is the
      // gesture promising an outcome it does not deliver.
      this.dismiss = Math.min(1, Math.max(0, dy) / DISMISS_PX);
      this.scheduleTransform();
    }, { passive: true });

    this.stage.addEventListener("touchend", (ev) => {
      if (this.pinch && ev.touches.length < 2) {
        this.pinch = null;
        this.syncSource();
        return;
      }

      const d = this.drag;
      this.drag = null;
      if (!d) return;

      if (d.edit) {
        this.editor.dragEnd();
        return;
      }

      if (!d.moved) {
        this.toggleChrome();
        return;
      }

      if (this.scale > 1) return;

      const t = ev.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - d.x;
      const dy = t.clientY - d.y;

      if (d.axis === "y") {
        // Down and far enough: let it go. `close()` resets the transform, so
        // there is nothing to tidy up on this branch.
        if (dy > DISMISS_PX) {
          this.close();
          return;
        }
        // Otherwise put it back, visibly.
        this.snapBack();
        return;
      }

      if (d.axis === "x") {
        this.stripEnd(dx, this.releaseVelocity(d.samples, t.clientX));
        return;
      }
      // Axis never locked (a tiny movement over the slop): the old threshold.
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_PX) {
        this.step(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    /*
     * The system can take a gesture away mid-drag, and when it does there is no
     * `touchend` -- only this.
     *
     * The case that actually happens on this phone: a finger starting near the
     * top of the screen and moving down is both the dismissal gesture and the
     * pull for the notification shade. When the shade wins, the drag simply
     * stops arriving, and without this handler the photograph is left wherever
     * the last `touchmove` put it -- shrunk, offset, mid-dismissal -- until the
     * next tap happens to rebuild the transform. An incoming call and the
     * back-gesture do the same thing.
     */
    this.stage.addEventListener("touchcancel", () => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.edit) {
        this.editor.dragEnd();
        return;
      }
      if (this.scale > 1) return;
      if (d.axis === "x") {
        this.stripEnd(0, 0);
        return;
      }
      this.snapBack();
    }, { passive: true });

    // Double-tap to zoom, since pinch to 2× on a phone is fiddly one-handed.
    let lastTap = 0;
    this.stage.addEventListener("click", () => {
      const now = performance.now();
      // In the editor the second stop is 2x: fit, then a closer look, then
      // fit again, which is the rhythm of checking a blur edge.
      if (now - lastTap < 300 && !this.editor.busy) {
        this.scale = this.scale > 1 ? 1 : this.editing ? 2 : 2.5;
        this.tx = 0;
        this.ty = 0;
        this.applyTransform();
        this.syncSource();
      }
      lastTap = now;
    });
  }

  // ── The video transport ─────────────────────────────────────────────────

  private togglePlay(): void {
    if (this.video.paused) void this.video.play().catch(() => {});
    else this.video.pause();
  }

  /** Glyph and label follow the element, not the tap -- autoplay counts too. */
  private paintPlay(): void {
    const playing = !this.video.paused && !this.video.ended;
    const label = playing ? "Pause" : "Play";
    this.playBtn.replaceChildren(icon(playing ? "\u23f8" : "\u25b6"));
    this.playBtn.setAttribute("aria-label", label);
    this.playBtn.title = label;
  }

  /**
   * Clock and track position.
   *
   * Skipped while a finger is down: `timeupdate` keeps arriving during a seek
   * and would drag the knob back to wherever the decoder has got to, which
   * reads as the control fighting you.
   */
  private paintTime(): void {
    const dur = this.video.duration;
    const known = Number.isFinite(dur) && dur > 0;
    this.ofEl.textContent = known ? formatDuration(dur) : "0:00";
    if (this.seeking) return;
    this.atEl.textContent = formatDuration(this.video.currentTime);
    this.paintAt(known ? this.video.currentTime / dur : 0);
  }

  private paintAt(frac: number): void {
    const pct = `${(Math.min(1, Math.max(0, frac)) * 100).toFixed(2)}%`;
    this.trackFill.style.width = pct;
    this.knob.style.left = pct;
    this.track.setAttribute("aria-valuenow", Math.round(this.video.currentTime).toString());
    const dur = this.video.duration;
    if (Number.isFinite(dur) && dur > 0) {
      this.track.setAttribute("aria-valuemax", Math.round(dur).toString());
    }
  }

  /**
   * Drag anywhere on the track to seek.
   *
   * Pointer events with capture rather than a range input: a native slider on
   * this WebView is a 4px line with a thumb that is hard to land on, and the
   * whole complaint was about a control being fiddly and in the wrong place.
   * The track is the target; the knob is only paint.
   *
   * `stopPropagation` on the way in, because the viewer's own gesture handler
   * is on an ancestor and reads a horizontal drag as "next picture" -- seeking
   * would otherwise turn the page.
   */
  private wireSeek(): void {
    const at = (e: PointerEvent): number => {
      const box = this.track.getBoundingClientRect();
      if (box.width <= 0) return 0;
      return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    };
    const to = (frac: number): void => {
      const dur = this.video.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      this.video.currentTime = frac * dur;
      this.atEl.textContent = formatDuration(frac * dur);
      this.paintAt(frac);
    };

    this.track.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.seeking = true;
      this.track.setPointerCapture(e.pointerId);
      this.track.classList.add("seeking");
      to(at(e));
    });
    this.track.addEventListener("pointermove", (e) => {
      if (!this.seeking) return;
      e.stopPropagation();
      to(at(e));
    });
    const done = (e: PointerEvent): void => {
      if (!this.seeking) return;
      e.stopPropagation();
      this.seeking = false;
      this.track.classList.remove("seeking");
      this.paintTime();
    };
    this.track.addEventListener("pointerup", done);
    this.track.addEventListener("pointercancel", done);

    // Arrow keys, for the desktop build and anything plugged into the phone.
    this.track.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowLeft" ? -5 : e.key === "ArrowRight" ? 5 : 0;
      if (step === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const dur = this.video.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      this.video.currentTime = Math.min(dur, Math.max(0, this.video.currentTime + step));
      this.paintTime();
    });
  }
}

/** The midpoint between the first two touches, in client coordinates. */
function centroid(touches: TouchList): { x: number; y: number } {
  const a = touches[0];
  const b = touches[1];
  if (!a || !b) return { x: 0, y: 0 };
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

function spread(touches: TouchList): number {
  const a = touches[0];
  const b = touches[1];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

}

function iconBtn(glyph: string, label: string, onClick: () => void): HTMLElement {
  const b = el<"button">("button.phv-icon", {
    type: "button", "aria-label": label, title: label,
  });
  b.append(icon(glyph));
  b.addEventListener("click", onClick);
  return b;
}

/** An action: icon on top, word underneath. Never one without the other. */
function action(glyph: string, label: string, onClick: () => void, disabled = false): HTMLElement {
  const iconWrap = el("span.phv-action-icon", { "aria-hidden": true });
  iconWrap.append(icon(glyph));
  const b = el<"button">("button.phv-action", {
    type: "button", "aria-label": label, disabled,
  },
    iconWrap,
    el("span.phv-action-label", { text: label }),
  );
  if (!disabled) b.addEventListener("click", onClick);
  return b;
}

/** Tool id → its label, for finding the tile to click programmatically. */

