/**
 * The camera (item 28).
 *
 * A live preview, a shutter, a recorder, a grid, a self-timer and a look you can
 * build and keep. Everything it knows that is not a device lives in
 * `@core/capture/camera`; this file is the surface, the stream and the two
 * canvases.
 *
 * Three decisions are worth stating, because each of them is a place where the
 * obvious implementation lies to the person holding the camera.
 *
 * **The still is taken at the sensor's resolution, never the preview's.** The
 * `<video>` element is whatever size the window happens to be; `videoWidth` is
 * what the camera actually produced. Drawing the element's box would quietly
 * turn a 4K camera into a 900-pixel one on a small window, and nothing on
 * screen would say so.
 *
 * **The clip is recorded from the canvas, not from the camera.** A CSS filter
 * lives on the preview element and a `MediaStreamTrack` knows nothing about it,
 * so recording the raw track would give a clip with none of the look and none
 * of the mirroring that was on screen while it was framed. Drawing each frame
 * through the same filter and handing out `canvas.captureStream()` costs a draw
 * loop while recording — and only while recording — and is the only way the
 * file matches the screen. The audio track, which no canvas can carry, is taken
 * from the camera stream and added beside it.
 *
 * **Every track is stopped on close.** A webcam whose light stays on after the
 * window is shut is the single most alarming thing a camera app can do, and it
 * is what happens by default: dropping the last reference to a `MediaStream`
 * does not release the device.
 */

import {
  clamp,
  dualAvailable,
  dualBoxes,
  dualHit,
  dualPhoto,
  dualPlace,
  dualRecordStart,
  dualRecordStop,
  dualRects,
  dualStart,
  dualStop,
  DUAL_START,
  INSET_MAX,
  INSET_MIN,
  SHARE_MAX,
  SHARE_MIN,
  type DualLayout,
  type Lens as DualLens,
  type Stage as DualStage,
} from "@core/capture/dual";
import {
  allPresets,
  bestVideoMime,
  clock,
  cloneLook,
  COUNTDOWNS,
  CONTROLS,
  extOf,
  extOfMime,
  filterOf,
  gridLines,
  GRIDS,
  HEIGHTS,
  mimeOf,
  NEUTRAL,
  PHOTO_FORMATS,
  RANGE,
  sameLook,
  stampName,
  videoConstraints,
  withPreset,
  withoutPreset,
  writePresets,
  type Facing,
  type GridKind,
  type Look,
  type PhotoFormat,
  type Preset,
  type PresetBackend,
} from "@core/capture/camera";
import { writeFree } from "@core/save";

/**
 * The device layer, injected.
 *
 * `navigator.mediaDevices` in the app; a canvas pretending to be a camera in
 * the harness. Not a convenience — it is what lets the whole surface, including
 * a real capture and a real recording, be asserted on a machine with no webcam.
 */
export interface CameraSource {
  devices(): Promise<MediaDeviceInfo[]>;
  open(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Fires when a camera is plugged in or unplugged. Optional. */
  onChange?(cb: () => void): () => void;
}

export interface CameraHost {
  source: CameraSource;
  /** Where a capture lands. Read at the moment of saving, never cached. */
  folder(): string;
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
  /** So a new photo appears in the folder behind without an F5. */
  refresh(): void;
  presets: PresetBackend;
  /** Current values of the camera settings, read fresh each open. */
  prefs(): CameraPrefs;
}

/**
 * The shape of the picture, independent of the shape of the sensor.
 *
 * Named the way a camera names it -- landscape first -- and turned with the
 * device, because "4:3" on a phone held upright means a tall 3:4 frame to
 * everyone who has ever used a phone camera.
 */
export type AspectKind = "full" | "4:3" | "1:1" | "16:9";

const ASPECTS: ReadonlyArray<readonly [AspectKind, string, number]> = [
  ["full", "Full", 0],
  ["4:3", "4:3", 4 / 3],
  ["1:1", "Square", 1],
  ["16:9", "16:9", 16 / 9],
];

export interface CameraPrefs {
  format: PhotoFormat;
  quality: number;
  height: number;
  mirror: boolean;
  grid: GridKind;
  aspect: AspectKind;
  countdown: number;
  sound: boolean;
}

/** Frames a second while recording — what is drawn, and what is recorded. */
const FPS = 30;

/**
 * How many pixels one recorded frame may have.
 *
 * A photo is a single frame and can be the whole sensor. A recording is thirty
 * a second through a software encoder, and the full crop of a 4K sensor frame
 * is 6.6 MP: on an S21+ Android killed the app for memory the instant Record
 * was pressed -- `reason=3 (LOW_MEMORY)`, a black screen and back to the home
 * screen. A budget rather than a fixed size, so it holds whatever shape the
 * picture is -- square, 16:9 or the whole 20:9 display -- and lands at about
 * the pixel count of 1080p either way.
 */
const VIDEO_PIXELS = 1920 * 1080;

const FALLBACK: CameraPrefs = {
  format: "jpeg",
  quality: 0.92,
  height: 1080,
  mirror: false,
  grid: "none",
  aspect: "full",
  countdown: 0,
  sound: true,
};

export class CameraView {
  private readonly root: HTMLElement;
  private readonly video = document.createElement("video");
  /** Where a still is drawn, and where a recording is drawn frame by frame. */
  private readonly canvas = document.createElement("canvas");
  private readonly guides = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly flash = document.createElement("div");
  private readonly count = document.createElement("div");
  private readonly panel = document.createElement("aside");
  private readonly status = document.createElement("div");
  private readonly shot = document.createElement("img");
  private readonly timeOut = document.createElement("span");
  private readonly shutter: HTMLButtonElement;
  private readonly recBtn: HTMLButtonElement;
  private readonly deviceSel = document.createElement("select");
  private readonly sizeSel = document.createElement("select");
  private readonly fmtSel = document.createElement("select");
  private readonly gridSel = document.createElement("select");
  private readonly aspectSel = document.createElement("select");
  private readonly timerSel = document.createElement("select");
  private readonly more = document.createElement("div");
  private flip!: HTMLButtonElement;
  private moreBtn!: HTMLButtonElement;

  private stream: MediaStream | null = null;
  /** The zoom chips, and the ring a tap-to-focus leaves behind. */
  private readonly zoomBar = document.createElement("div");
  private readonly ring = document.createElement("div");
  /**
   * The box the picture lives in, between the stage and the video.
   *
   * It exists so that the digital zoom can be a `transform` on the video
   * without moving the thing that measures the picture: a transformed element
   * reports its *enlarged* rectangle, so `shown` and the tap-to-focus maths
   * would both have been reading the zoomed picture rather than the window
   * onto it -- a crop that grew with the zoom and a focus point that drifted
   * further off the harder you zoomed in. The frame is never transformed.
   */
  private readonly frame = document.createElement("div");
  private readonly evRail = document.createElement("div");
  private readonly evDot = document.createElement("div");
  /** The manual row, its slider, and the button that brings both. */
  private readonly proBar = document.createElement("div");
  private readonly proRow = document.createElement("div");
  private readonly proSlide = document.createElement("input");
  private proBtn!: HTMLButtonElement;
  private torchBtn!: HTMLButtonElement;
  /** What the open lens will do, re-read on every `start` — it is per lens. */
  private able: LensCaps = {};
  private zoom = 1;
  /** The stops on the strip, rebuilt per lens. */
  private steps: Step[] = [];
  /** The crop into the open lens. 1 is the whole of it. */
  private dig = 1;
  /** Where the brightness rail is, in the units the driver uses. */
  private evVal = 0;
  /** True when the manual row is showing. */
  private pro = false;
  /** The dials this lens actually offers, rebuilt per lens. */
  private dials: Dial[] = [];
  /** Which dial the slider is currently driving; -1 for none. */
  private dialAt = -1;
  /**
   * Keeps the row's numbers live while it is open.
   *
   * Most of what the row shows is not what was set but what the camera is
   * doing: on automatic the ISO and the shutter move with every change in the
   * light, and a readout that answered once when the row opened would sit at a
   * number that stopped being true seconds ago. Half a second is slow enough
   * to read and fast enough to believe.
   */
  private proTimer = 0;
  /**
   * True once a person has chosen a lens rather than been given one.
   *
   * After that the view stops correcting the choice, because the correction
   * and the choice would be the same act pulling in opposite directions --
   * press .5x, get moved back to 1x, press it again.
   */
  private lensPicked = false;
  /**
   * How to put the lens back if the one `pinMain` moved to will not open.
   *
   * The correction pins a device id `exact`, so a lens that refuses takes the
   * whole viewfinder down with it. Trading a working camera for the right one
   * is not a trade worth making, so the move is undoable.
   */
  private lensUndo: { to: string | null } | null = null;
  /**
   * A pixel budget for `paint`, or 0 for the sensor's own scale.
   *
   * Non-zero only while recording. A photo taken during a recording is capped
   * too, which is the right trade: resizing the canvas under a live
   * `captureStream` would damage the clip, and the clip is the thing that
   * cannot be taken again.
   */
  private cap = 0;
  private torch = false;
  private ringTimer = 0;
  private devices: MediaDeviceInfo[] = [];
  /** The same cameras, named and ordered for this device. See `lenses`. */
  private lenses: Lens[] = [];
  private deviceId: string | null = null;
  /** Which lens to ask for when no specific device is pinned. */
  private facing: Facing | null = null;
  /** Set the moment the mirror toggle is touched; after that it is theirs. */
  private mirrorTouched = false;
  /** Re-opens the device when the phone is turned. */
  private orient: (() => void) | null = null;
  private prefs: CameraPrefs = { ...FALLBACK };
  private look: Look = cloneLook(NEUTRAL);
  private presets: Preset[] = [];
  private chosen = "Natural";

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recStarted = 0;
  private ticker: number | null = null;
  private drawing: number | null = null;
  /** The capture track, while it is one we push frames into ourselves. */
  private pushes: CanvasCaptureMediaStreamTrack | null = null;
  private counting: number | null = null;
  private unwatch: (() => void) | null = null;

  /**
   * The dual viewfinder: non-null exactly while both cameras are running.
   *
   * It holds where the two pictures are, not what they are -- the pictures
   * themselves are native views behind the page, and this layout is the only
   * thing that decides where they land. See `@core/capture/dual`.
   */
  private dual: DualLayout | null = null;
  private dualBtn!: HTMLButtonElement;
  /** The transparent layer that catches taps and drags over the two previews. */
  private readonly dualPad = document.createElement("div");
  private readonly dualHit0 = document.createElement("div");
  private readonly dualHit1 = document.createElement("div");
  private dualRec = false;
  /**
   * What `dual_available` answered, asked once.
   *
   * It is a question for the camera service, not a capability of the browser,
   * and the answer cannot change while the app is running.
   */
  private dualOk: boolean | null = null;
  private dualDrag: { kind: "tap" | "move" | "resize" | "divider"; x: number; y: number; ok: boolean } | null =
    null;
  /**
   * Keeps the previews on the stage when the stage moves.
   *
   * The native views know nothing about the page: turn the phone, open the
   * settings panel, let the address bar come and go, and they stay exactly
   * where they were told to be, which is now the wrong place. Watching the
   * layer they are supposed to be under covers all of those with one rule.
   */
  private dualWatch: ResizeObserver | null = null;

  constructor(private readonly host: CameraHost) {
    this.root = document.createElement("div");
    this.root.className = "cam";
    this.root.hidden = true;

    this.video.className = "cam-video";
    this.video.autoplay = true;
    this.video.playsInline = true;
    // Muted, or the preview feeds the speakers the microphone and the room
    // howls — and a preview is not a monitor.
    this.video.muted = true;

    this.guides.setAttribute("class", "cam-guides");
    this.guides.setAttribute("viewBox", "0 0 100 100");
    this.guides.setAttribute("preserveAspectRatio", "none");
    this.flash.className = "cam-flash";
    this.count.className = "cam-count";
    this.count.hidden = true;

    this.ring.className = "cam-ring";
    this.ring.hidden = true;
    this.zoomBar.className = "cam-zoom";
    this.zoomBar.hidden = true;

    const stage = document.createElement("div");
    stage.className = "cam-stage";
    this.frame.className = "cam-frame";
    this.frame.append(this.video, this.guides);
    this.wireEv();
    this.wirePro();
    this.dualPad.className = "cam-dualpad";
    this.dualPad.hidden = true;
    for (const [pad, n] of [[this.dualHit0, 0], [this.dualHit1, 1]] as const) {
      pad.className = "cam-dualhit";
      pad.dataset["n"] = String(n);
      pad.append(document.createElement("span"));
    }
    this.dualPad.append(this.dualHit0, this.dualHit1);
    this.wireDual();
    stage.append(
      this.frame,
      this.dualPad,
      this.flash,
      this.count,
      this.ring,
      this.evRail,
      this.proBar,
      this.zoomBar,
    );
    this.wireStage(stage);
    // The strip and the status line both describe a frame whose size is not
    // known until the first metadata arrives, and on a cold open that is after
    // `start` has already run once. Without this the strip came up as a single
    // 1x chip and stayed that way.
    this.video.addEventListener("loadedmetadata", () => {
      this.buildZoom();
      this.drawGuides();
      this.sayLive();
    });

    const bar = document.createElement("header");
    bar.className = "cam-bar";
    this.deviceSel.className = "cam-sel";
    this.deviceSel.title = "Which camera";
    this.deviceSel.addEventListener("change", () => {
      this.deviceId = this.deviceSel.value || null;
      this.lensPicked = true;
      void this.start();
    });
    this.sizeSel.className = "cam-sel";
    this.sizeSel.title = "Asked-for height — the camera gives the nearest it has";
    for (const h of HEIGHTS) this.sizeSel.append(option(String(h), `${h}p`));
    this.sizeSel.addEventListener("change", () => {
      this.prefs.height = Number(this.sizeSel.value);
      void this.start();
    });
    this.fmtSel.className = "cam-sel";
    this.fmtSel.title = "What a photo is saved as";
    for (const [id, label, why] of PHOTO_FORMATS) {
      const o = option(id, label);
      o.title = why;
      this.fmtSel.append(o);
    }
    this.fmtSel.addEventListener("change", () => {
      this.prefs.format = this.fmtSel.value as PhotoFormat;
      this.say(`Photos save as ${this.fmtSel.value.toUpperCase()}`);
    });
    this.gridSel.className = "cam-sel";
    this.gridSel.title = "Framing guides  (G)";
    for (const [id, label] of GRIDS) this.gridSel.append(option(id, label));
    this.gridSel.addEventListener("change", () => {
      this.prefs.grid = this.gridSel.value as GridKind;
      this.drawGuides();
    });
    this.aspectSel.className = "cam-sel";
    this.aspectSel.title = "The shape of the picture";
    for (const [id, label] of ASPECTS) this.aspectSel.append(option(id, label));
    this.aspectSel.addEventListener("change", () => {
      this.prefs.aspect = this.aspectSel.value as AspectKind;
      this.syncAspect();
      this.drawGuides();
      this.sayLive();
    });
    this.timerSel.className = "cam-sel";
    this.timerSel.title = "Self-timer";
    for (const s of COUNTDOWNS) this.timerSel.append(option(String(s), s === 0 ? "No timer" : `${s}s`));
    this.timerSel.addEventListener("change", () => {
      this.prefs.countdown = Number(this.timerSel.value);
    });

    // Six dropdowns in a row is a desktop toolbar. On a 384 px screen they
    // wrapped to three rows and took a fifth of the display away from the
    // thing the screen is for, so everything that is a *setting* rather than a
    // shot moves into one tray behind a single button. The bar keeps what a
    // camera is used with: which lens, the look, the way out.
    this.more.className = "cam-more";
    this.more.hidden = true;
    this.more.append(
      this.deviceSel,
      this.sizeSel,
      this.fmtSel,
      this.aspectSel,
      this.gridSel,
      this.timerSel,
      this.btn("⇄", "Mirror the preview and the file together  (M)", () => this.toggleMirror()),
    );

    // The phone shell writes a word under a bare glyph, and guesses it from
    // the tooltip: this one came out "Switch between", which says nothing and
    // was wide enough to stretch the round button into an ellipse. Both of
    // these say their own word instead of being guessed at.
    this.flip = this.btn("⟳", "Switch between the front and back camera", () => this.flipLens());
    this.flip.dataset["fctShort"] = "Flip";
    this.flip.classList.add("cam-flip");
    this.flip.hidden = true;
    this.moreBtn = this.btn("⋯", "Camera settings", () => this.toggleMore());
    this.moreBtn.dataset["fctShort"] = "Settings";
    this.moreBtn.setAttribute("aria-expanded", "false");

    this.torchBtn = this.btn("⚡", "Turn the light on", () => void this.toggleTorch());
    this.torchBtn.dataset["fctShort"] = "Light";
    this.torchBtn.hidden = true;

    this.dualBtn = this.btn("⧉", "Show both cameras at once", () => void this.toggleDual());
    this.dualBtn.dataset["fctShort"] = "Both";
    this.dualBtn.setAttribute("aria-pressed", "false");
    // Hidden until the camera service says this phone will really run two at
    // once. Most will not, and a button that explains itself by failing is
    // worse than no button.
    this.dualBtn.hidden = true;

    const shut = this.btn("✕", "Close  (Esc)", () => this.close());
    const look = this.btn("✦ Look", "Filters  (F)", () => this.togglePanel());
    look.classList.add("cam-look");
    this.proBtn = this.btn("Pro", "Manual ISO, shutter, focus and white balance", () => this.togglePro());
    this.proBtn.classList.add("cam-look");
    this.proBtn.setAttribute("aria-pressed", "false");
    this.proBtn.hidden = true;
    // A viewfinder is the picture. Four bordered cards with a word under each,
    // across the top of it, is a toolbar that happens to have a camera behind
    // it -- so the bar carries glyphs and nothing else, and the words they
    // would have had are on `title` and `aria-label`, where a screen reader
    // still reads them and the picture does not have to make room.
    for (const b of [shut, this.torchBtn, this.flip, this.dualBtn, this.moreBtn, look, this.proBtn]) {
      b.dataset["fctLabelled"] = "";
      delete b.dataset["fctShort"];
    }
    bar.append(shut, spacer(), this.torchBtn, this.flip, this.dualBtn, this.proBtn, look, this.moreBtn);

    const foot = document.createElement("footer");
    foot.className = "cam-foot";
    this.shot.className = "cam-thumb";
    this.shot.hidden = true;
    this.shot.alt = "";
    this.shutter = this.btn("", "Take a photo  (Space)", () => void this.shoot());
    this.shutter.className = "cam-shutter";
    this.recBtn = this.btn("", "Record a clip  (R)", () => void this.toggleRecord());
    this.recBtn.className = "cam-rec";
    // The phone shell gives every wordless button a word, which is right for a
    // toolbar glyph and wrong for these two: a white circle and a red dot are
    // the two most recognised controls on any camera ever made, and the sweep
    // turned them into pills reading "Take a photo" and "Record clip" -- the
    // second in red on red, unreadable. They keep their accessible names in
    // `title`; it is the drawn label they opt out of.
    this.shutter.dataset["fctLabelled"] = "";
    this.recBtn.dataset["fctLabelled"] = "";
    this.shutter.setAttribute("aria-label", "Take a photo");
    this.recBtn.setAttribute("aria-label", "Record a clip");
    this.timeOut.className = "cam-time";
    this.timeOut.hidden = true;
    this.status.className = "cam-status";
    foot.append(this.shot, spacer(), this.shutter, this.recBtn, this.timeOut, spacer(), this.status);

    this.panel.className = "cam-panel";
    this.panel.hidden = true;

    this.root.append(bar, stage, this.more, this.panel, foot);
    document.body.appendChild(this.root);
    this.wireKeys();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Nothing — the camera is not a file. The session record asks anyway. */
  get openPath(): string | null {
    return null;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    this.prefs = { ...FALLBACK, ...this.host.prefs() };
    // A camera app on a phone opens on the camera that points away from you.
    // Nothing here said so, so the choice fell through to whichever device the
    // platform enumerated first -- on an S21+ that is a front lens, and Facet
    // opened on a selfie every time. Only when no specific camera is pinned:
    // someone who picked a lens gets that lens back.
    if (isPhone() && !this.deviceId) this.facing = "environment";
    this.presets = allPresets(this.host.presets);
    this.sizeSel.value = String(this.prefs.height);
    this.fmtSel.value = this.prefs.format;
    this.gridSel.value = this.prefs.grid;
    this.aspectSel.value = this.prefs.aspect;
    this.syncAspect();
    this.timerSel.value = String(this.prefs.countdown);
    this.root.hidden = false;
    this.buildPanel();
    this.applyLook();
    this.drawGuides();
    // Plugging a camera in while the app is open should populate the list, and
    // unplugging the one in use should not leave a frozen frame on screen
    // claiming to be live.
    this.unwatch = this.host.source.onChange?.(() => void this.listDevices()) ?? null;
    // Asked once per run, before the viewfinder starts so the button is
    // already in place when the bar first draws.
    await this.offerDual();
    await this.start();
  }

  close(): void {
    if (!this.isOpen) return;
    this.cancelCountdown();
    if (this.recorder && this.recorder.state !== "inactive") {
      // Stopped rather than abandoned: the clip that was being recorded is the
      // user's, and closing a window is not a decision to throw it away.
      this.recorder.stop();
    }
    if (this.dual) void this.leaveDual(false);
    this.stop();
    this.unwatch?.();
    this.unwatch = null;
    this.root.hidden = true;
    this.panel.hidden = true;
    this.more.hidden = true;
    this.moreBtn.setAttribute("aria-expanded", "false");
    this.shot.hidden = true;
    if (this.shot.src.startsWith("blob:")) URL.revokeObjectURL(this.shot.src);
    this.shot.removeAttribute("src");
  }

  /**
   * Open the device and show it.
   *
   * Re-entrant on purpose — changing camera or resolution comes straight back
   * here — so the old stream is stopped first. Two streams on one device is
   * how a webcam ends up returning `NotReadableError` to its own app.
   */
  private async start(): Promise<void> {
    this.stop();
    this.say("Opening the camera…");
    // Which lens, decided before the door rather than after it -- see `pinMain`.
    await this.listDevices();
    this.pinMain();
    // Zoom has to be asked for at the door -- see `ptz` -- and a device that
    // does not do it may refuse the whole request rather than ignore the extra
    // word. So it is asked for first and dropped on refusal, because a camera
    // that opens without a zoom strip beats a camera that does not open.
    for (const ptz of [true, false]) {
      try {
        this.stream = await this.openStream(ptz);
        break;
      } catch (err) {
        this.stream = null;
        if (!ptz) {
          if (this.lensUndo) {
            const { to } = this.lensUndo;
            this.lensUndo = null;
            this.deviceId = to;
            this.deviceSel.value = to ?? "";
            // Once, and then leave it alone: a correction that cannot be made
            // is not one to keep attempting on every reopen.
            this.lensPicked = true;
            void this.start();
            return;
          }
          this.say(reason(err));
          return;
        }
      }
    }
    if (!this.stream) return;
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      /* autoplay refusals are not fatal — the stream is live either way */
    }
    await this.listDevices();
    // `enumerateDevices` returns blank labels until the camera permission has
    // been granted once, so the *first* open after an install cannot tell the
    // lenses apart and lands wherever `facingMode` put it. Now it can. One
    // black frame at first launch, against every photo after it coming off the
    // wide-angle lens.
    if (this.pinMain()) {
      void this.start();
      return;
    }
    this.lensUndo = null;
    this.syncAspect();
    this.syncAble();
    this.syncMirror();
    this.applyLook();
    this.watchOrientation();
    this.sayLive();
  }

  private openStream(ptz: boolean): Promise<MediaStream> {
    return this.host.source.open({
      video: videoConstraints(this.deviceId, this.askHeight(), {
        // Asked for landscape on a phone, which is the opposite of how it
        // reads: this web view returns the sensor's own landscape frame
        // whatever it is asked for -- verified on an S21+ with the lens
        // pinned by id and `width: 1080, height: 1920` in the constraints --
        // so asking portrait only made the numbers in the request describe a
        // frame nobody was going to get. The upright picture comes from
        // cropping that frame to the screen; see `shown`.
        portrait: isPhone() ? false : isPortrait(),
        facing: this.facing,
        ptz,
      }),
      // Sound is asked for up front, not at the moment Record is pressed:
      // the permission prompt belongs at the point someone opened a camera,
      // not in the half-second they were trying to catch something.
      audio: this.prefs.sound,
    });
  }

  /**
   * A phone that is turned needs the device re-opened, not just re-laid-out.
   * The frame's aspect is fixed when the track is created, so a stream opened
   * portrait stays portrait after a turn to landscape and letterboxes into
   * two black bars. Debounced, because the event fires mid-rotation.
   */
  private watchOrientation(): void {
    if (this.orient || !isPhone()) return;
    let timer = 0;
    let was = isPortrait();
    const onTurn = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const now = isPortrait();
        if (now === was || !this.stream) return;
        was = now;
        void this.start();
      }, 400);
    };
    this.orient = onTurn;
    window.addEventListener("orientationchange", onTurn);
    window.addEventListener("resize", onTurn);
  }

  private unwatchOrientation(): void {
    if (!this.orient) return;
    window.removeEventListener("orientationchange", this.orient);
    window.removeEventListener("resize", this.orient);
    this.orient = null;
  }

  /**
   * The front camera opens mirrored. Not a preference imposed on the file --
   * the toggle still moves both -- but the state a selfie preview has to start
   * in to read as working. Once the toggle is touched this stops interfering.
   */
  private syncMirror(): void {
    if (this.mirrorTouched) return;
    const facing = this.stream?.getVideoTracks()[0]?.getSettings().facingMode;
    if (facing !== "user" && facing !== "environment") return;
    this.facing = facing;
    const want = facing === "user";
    if (this.prefs.mirror === want) return;
    this.prefs.mirror = want;
    this.applyLook();
  }

  private stop(): void {
    window.clearInterval(this.proTimer);
    this.proTimer = 0;
    this.stopDrawing();
    this.unwatchOrientation();
    // Every track, not just the video one: a stopped camera with a live
    // microphone is still a recording device with a light on somewhere.
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  /**
   * Fill the camera list.
   *
   * Called *after* the stream is open, and that ordering is the whole reason
   * this is not done once at startup: until a page has been granted a camera,
   * `enumerateDevices` returns entries with empty labels — a dropdown of three
   * blank rows. With permission granted the same call returns "HD Webcam", and
   * FACET can honestly say which camera it is on.
   */
  /** Swap to the first lens facing the other way. */
  private flipLens(): void {
    const now = this.lenses.find((l) => l.id === this.deviceId);
    const want = now?.back === true ? false : true;
    const next = this.lenses.find((l) => l.back === want);
    if (!next) return;
    this.deviceId = next.id;
    this.deviceSel.value = next.id;
    // The remembered side moves with it, so a reopen comes back to the lens
    // that was last in use rather than to the default.
    this.facing = want ? "environment" : "user";
    void this.start();
  }

  private toggleMore(): void {
    this.more.hidden = !this.more.hidden;
    this.moreBtn.setAttribute("aria-expanded", String(!this.more.hidden));
    // One tray at a time: Look and settings are both bottom sheets on a phone
    // and two of them stacked is a preview with nothing left of it.
    if (!this.more.hidden) this.panel.hidden = true;
  }

  /**
   * Move to the main lens for this side, and say whether that changed anything.
   *
   * `facingMode: "environment"` means *a* rear camera, and the one the driver
   * names first is the one it gives. On an S21+ that is camera 2, the 2.2 mm
   * ultrawide -- so a camera app opened on the wide-angle lens and every photo
   * came off it. There is nothing in the constraint language that can ask for
   * the main one; the only fix is to look at what opened, notice it is not the
   * primary, and reopen pinned to the one that is.
   *
   * Safe to call twice: the second time the ids already match and it does
   * nothing, which is what stops the reopen it triggers from looping.
   */
  private pinMain(): boolean {
    if (!isPhone() || this.lensPicked) return false;
    const main = this.lenses.find((l) => l.back === this.onBack());
    if (!main || main.id === this.deviceId) return false;
    this.lensUndo = { to: this.deviceId };
    this.deviceId = main.id;
    this.deviceSel.value = main.id;
    return true;
  }

  private async listDevices(): Promise<void> {
    try {
      this.devices = (await this.host.source.devices()).filter((d) => d.kind === "videoinput");
    } catch {
      this.devices = [];
    }
    const live = this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
    if (live) this.deviceId = live;
    this.lenses = lenses(this.devices, isPhone());
    this.deviceSel.replaceChildren(...this.lenses.map((l) => option(l.id, l.label)));
    this.flip.hidden = this.lenses.filter((l) => l.back !== null).length < 2;
    /*
     * Selected explicitly, and never left to the browser.
     *
     * Replacing a `<select>`'s children does not reliably select the first of
     * them — the list ends up on `selectedIndex === -1`, which draws as an
     * empty box. On a camera that is not cosmetic: the one question this
     * control answers is *which camera am I looking through*, and a blank
     * answer to it is worse than no control. So if the track named its device
     * that one is shown, and otherwise the first is both shown and adopted as
     * the current one, so what is on screen and what the code believes agree.
     *
     * Adopting is a guess, and worth naming: with two cameras and a track that
     * declines to say which it is, the first in the list is shown and the next
     * reopen will pin to it — possibly switching cameras. The alternative is a
     * label that says one camera while the picture comes from another, which is
     * the same guess told less honestly and with no way to correct it. Every
     * real browser fills in `deviceId`, so this is the path taken by fakes.
     */
    if (this.deviceId && this.devices.some((d) => d.deviceId === this.deviceId)) {
      this.deviceSel.value = this.deviceId;
    } else if (this.lenses.length) {
      // `lenses[0]`, not `devices[0]`: on a phone the list is reordered so the
      // rear lens comes first, and reading the unordered array here would have
      // shown "Back camera" while pinning the front one -- the label lying
      // about the picture, which is the one thing this whole block is for.
      this.deviceSel.selectedIndex = 0;
      this.deviceId = this.lenses[0]!.id;
    }
    this.deviceSel.disabled = this.devices.length < 2;
  }

  // ── The look ────────────────────────────────────────────────────────────

  private applyLook(): void {
    this.video.style.filter = filterOf(this.look);
    // The mirror and the digital zoom are both transforms on the same element,
    // so they are written together. Setting either on its own dropped the
    // other, which is how a mirrored preview un-mirrored itself on a pinch.
    const flip = this.prefs.mirror ? "scaleX(-1)" : "";
    const zoom = this.dig > 1 ? `scale(${this.dig})` : "";
    this.video.style.transform = [flip, zoom].filter(Boolean).join(" ");
  }

  private toggleMirror(): void {
    this.mirrorTouched = true;
    this.prefs.mirror = !this.prefs.mirror;
    this.applyLook();
    this.say(this.prefs.mirror ? "Mirrored — the file matches the screen" : "Not mirrored");
  }

  private togglePanel(): void {
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) {
      // The other sheet gives way. See `toggleMore`.
      this.more.hidden = true;
      this.moreBtn.setAttribute("aria-expanded", "false");
      this.buildPanel();
    }
  }

  /**
   * Rebuild the whole panel.
   *
   * Same reasoning as the 3D edit panel: choosing a preset moves eight sliders
   * and eight readouts at once, and the version of that which walks stored
   * references is the version that misses the ninth control the day it is
   * added.
   */
  private buildPanel(): void {
    const list = document.createElement("div");
    list.className = "cam-presets";
    for (const p of this.presets) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cam-preset";
      b.textContent = p.name;
      b.title = p.own ? "Your own look — right-click to remove" : "";
      if (p.name === this.chosen) b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", () => {
        this.look = cloneLook(p.look);
        this.chosen = p.name;
        this.applyLook();
        this.buildPanel();
      });
      if (p.own) {
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.presets = withoutPreset(this.presets, p.name);
          this.host.presets.write(writePresets(this.presets));
          if (this.chosen === p.name) this.chosen = "";
          this.buildPanel();
        });
      }
      list.append(b);
    }

    const sliders = document.createElement("div");
    sliders.className = "cam-sliders";
    for (const [key, label, unit] of CONTROLS) {
      const [min, max, step] = RANGE[key];
      const row = document.createElement("label");
      row.className = "cam-row";
      const name = document.createElement("span");
      name.className = "cam-label";
      name.textContent = label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(this.look[key]);
      input.title = label;
      const out = document.createElement("output");
      out.textContent = `${trim(this.look[key])}${unit}`;
      // `input`, not `change`: a slider that only shows its effect on release
      // is a slider nobody can aim, and this is a live preview.
      input.addEventListener("input", () => {
        this.look[key] = Number(input.value);
        out.textContent = `${trim(this.look[key])}${unit}`;
        // The name of a preset stops being true the moment a slider moves.
        if (this.chosen && !sameLook(this.look, this.presets.find((p) => p.name === this.chosen)?.look ?? NEUTRAL)) {
          this.chosen = "";
          for (const b of list.querySelectorAll(".cam-preset")) b.removeAttribute("aria-pressed");
        }
        this.applyLook();
      });
      row.append(name, input, out);
      sliders.append(row);
    }

    const save = document.createElement("div");
    save.className = "cam-save";
    const nameBox = document.createElement("input");
    nameBox.type = "text";
    nameBox.className = "cam-name";
    nameBox.placeholder = "Name this look";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "cam-keep";
    keep.textContent = "Keep";
    keep.addEventListener("click", () => {
      const name = nameBox.value.trim();
      if (!name) {
        nameBox.focus();
        return;
      }
      this.presets = withPreset(this.presets, name, this.look);
      this.host.presets.write(writePresets(this.presets));
      this.chosen = name;
      nameBox.value = "";
      this.buildPanel();
      this.say(`Kept “${name}”`);
    });
    save.append(nameBox, keep);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "cam-plain";
    reset.textContent = "Back to plain";
    reset.addEventListener("click", () => {
      this.look = cloneLook(NEUTRAL);
      this.chosen = "Natural";
      this.applyLook();
      this.buildPanel();
    });

    this.panel.replaceChildren(title("Looks"), list, title("Adjust"), sliders, save, reset);
  }

  // ── The guides ──────────────────────────────────────────────────────────

  private drawGuides(): void {
    const w = this.video.videoWidth || 16;
    const h = this.video.videoHeight || 9;
    // The shape of the *picture*. A square crop of a 16:9 sensor wants a square
    // grid over it, and asking the frame would have drawn a 16:9 one.
    const out = this.shown(w, h);
    const lines = gridLines(this.prefs.grid, (out.sw || w) / (out.sh || h));
    this.guides.replaceChildren(
      ...lines.map((l) => {
        const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
        el.setAttribute("x1", String(l.x1 * 100));
        el.setAttribute("y1", String(l.y1 * 100));
        el.setAttribute("x2", String(l.x2 * 100));
        el.setAttribute("y2", String(l.y2 * 100));
        return el;
      }),
    );
    // `hidden` is an HTML property and this is SVG, so the display is set
    // directly — the same effect, one layer lower.
    this.guides.style.display = lines.length ? "" : "none";
  }

  // ── Both cameras ────────────────────────────────────────────────────────

  /**
   * Ask, once, whether this phone will run two cameras at once.
   *
   * Nothing is shown while the answer is unknown: the button appearing a
   * second after the viewfinder is a smaller oddity than one that is there
   * from the start and then turns out to be a lie on this hardware.
   */
  private async offerDual(): Promise<void> {
    if (this.dualOk !== null) return;
    if (this.stream) return;
    this.dualOk = await dualAvailable();
    this.dualBtn.hidden = !this.dualOk;
  }

  private async toggleDual(): Promise<void> {
    if (this.dual) {
      await this.leaveDual(true);
      return;
    }
    await this.enterDual();
  }

  /**
   * Hand the cameras over to the native side and go see-through.
   *
   * The web stream has to be released first and completely. One process holds
   * one camera on Android: leave `getUserMedia` running and Camera2 is refused
   * the very lens it is being asked to pair, and the failure arrives as a
   * driver error rather than as the ordinary thing it is.
   */
  private async enterDual(): Promise<void> {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.say("Stop the recording first");
      return;
    }
    this.stop();
    this.dual = { ...DUAL_START, inset: { ...DUAL_START.inset } };
    // Stopping the tracks asks the platform to close the device; it does not
    // wait for it to happen. Camera2 arriving while the old handle is still
    // being torn down is refused with "camera in use", which is true for
    // another moment and then is not, so it is worth asking twice.
    let trouble: unknown = null;
    for (const wait of [0, 450]) {
      if (wait) await new Promise((go) => setTimeout(go, wait));
      try {
        await dualStart();
        trouble = null;
        break;
      } catch (err) {
        trouble = err;
      }
    }
    if (trouble) {
      this.dual = null;
      this.say(reason(trouble));
      // Whatever went wrong, the single camera was working a moment ago.
      await this.start();
      return;
    }
    document.body.classList.add("cam-seethru");
    this.root.classList.add("cam-both");
    this.dualPad.hidden = false;
    this.dualWatch ??= new ResizeObserver(() => {
      this.applyDual();
    });
    this.dualWatch.observe(this.dualPad);
    this.dualBtn.setAttribute("aria-pressed", "true");
    this.dualBtn.title = "Back to one camera";
    this.applyDual();
    // The size is the one thing about dual mode that is worse rather than
    // different, so it is said rather than discovered later in the file.
    this.say("Both cameras · 2.8 MP each — tap a picture to make it the big one");
  }

  /** Give the cameras back. `resume` reopens the ordinary single viewfinder. */
  private async leaveDual(resume: boolean): Promise<void> {
    if (!this.dual) return;
    if (this.dualRec) await this.dualToggleRecord();
    this.dual = null;
    this.dualRec = false;
    this.dualWatch?.disconnect();
    this.dualPad.hidden = true;
    document.body.classList.remove("cam-seethru");
    this.root.classList.remove("cam-both");
    this.dualBtn.setAttribute("aria-pressed", "false");
    this.dualBtn.title = "Show both cameras at once";
    await dualStop();
    if (resume) await this.start();
  }

  /** The stage in page coordinates, which is what the native side is told. */
  private stageBox(): DualStage {
    const r = (this.dualPad.parentElement ?? this.root).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /**
   * Put the previews where the layout says, and the touch targets on top.
   *
   * One function for both, from one set of numbers, so what a finger lands on
   * is exactly what the eye sees -- the two drifting apart is the classic way
   * for a native view under a web page to feel broken.
   */
  /**
   * Keep the small picture out from under the top buttons and the shutter.
   *
   * On a phone the stage runs the full height of the screen with the bars laid
   * over it, so a corner that is "near the top" of the stage is under the close
   * button -- and the inset's touch pad would then sit in the way of it.
   */
  private keepInsetClear(layout: DualLayout, stage: DualStage): void {
    const bar = this.root.querySelector(".cam-bar")?.getBoundingClientRect();
    const foot = this.root.querySelector(".cam-foot")?.getBoundingClientRect();
    const gap = 8;
    // Turned sideways the footer is a column down the right edge, not a row
    // along the bottom, so it bounds the inset from the side instead.
    const side = !!foot && foot.height > stage.height * 0.6;
    const top = bar ? Math.max(0, bar.bottom - stage.top + gap) : 0;
    const bottom = foot && !side ? Math.min(stage.height, foot.top - stage.top - gap) : stage.height;
    const right = foot && side ? Math.min(stage.width, foot.left - stage.left - gap) : stage.width;
    // In pip the inset's height is its width fraction times the stage height.
    const room = Math.min((bottom - top) / stage.height, right / stage.width);
    const w = clamp(layout.inset.w, INSET_MIN, Math.max(INSET_MIN, Math.min(INSET_MAX, room)));
    layout.inset.w = w;
    layout.inset.y = clamp(layout.inset.y, top / stage.height, Math.max(top / stage.height, bottom / stage.height - w));
    layout.inset.x = clamp(layout.inset.x, 0, Math.max(0, right / stage.width - w));
  }

  private applyDual(): void {
    const layout = this.dual;
    if (!layout) return;
    const stage = this.stageBox();
    const dpr = window.devicePixelRatio || 1;
    this.keepInsetClear(layout, stage);
    void dualPlace(dualRects(layout, stage, dpr)).catch((err: unknown) => {
      this.say(reason(err));
    });
    const boxes = dualBoxes(layout, stage, dpr);
    for (const [pad, box] of [[this.dualHit0, boxes[0]], [this.dualHit1, boxes[1]]] as const) {
      if (!box) continue;
      pad.style.left = `${box.cssX}px`;
      pad.style.top = `${box.cssY}px`;
      pad.style.width = `${box.cssW}px`;
      pad.style.height = `${box.cssH}px`;
      pad.dataset["cam"] = box.cam;
      pad.classList.toggle("cam-dualsmall", layout.shape === "pip" && box.z > 0);
      pad.classList.toggle("cam-dualhalf", layout.shape === "split");
      // The name goes against the divider: the bottom edge of the first half,
      // the top edge of the second (or right/left side by side).
      const first = box.cssY < 1 && box.cssX < 1;
      const tall = stage.height >= stage.width;
      pad.dataset["edge"] = first ? (tall ? "bottom" : "right") : "";
      const name = box.cam === "back" ? "Back" : "Front";
      const span = pad.firstElementChild;
      if (span) span.textContent = name;
      pad.setAttribute(
        "aria-label",
        box.cam === layout.big
          ? `${name} camera, showing large. Tap for half and half.`
          : `${name} camera. Tap to make it the big one.`,
      );
    }
  }

  /**
   * Taps and drags over the two pictures.
   *
   * A tap on the smaller one makes it the big one -- which is the swap, since
   * there are only two. A tap on the big one goes to half and half and back.
   * Dragging moves the inset, or the divider in a split, and dragging the
   * inset's bottom-right corner resizes it, so "bigger", "smaller" and
   * "however I want it" are all the same gesture with different starting
   * points rather than a menu of named layouts.
   *
   * The listener is on the layer, not on the two pads, because a drag that
   * leaves the rectangle it started in is still that drag.
   */
  private wireDual(): void {
    const at = (e: PointerEvent): { x: number; y: number } => {
      const r = this.dualPad.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    this.dualPad.addEventListener("pointerdown", (e) => {
      const layout = this.dual;
      if (!layout) return;
      e.preventDefault();
      e.stopPropagation();
      this.dualPad.setPointerCapture(e.pointerId);
      const p = at(e);
      const stage = this.stageBox();
      const boxes = dualBoxes(layout, stage, window.devicePixelRatio || 1);
      const small = boxes.find((b) => b.z > 0);
      const edge = layout.shape === "split" ? boxes[1] : undefined;
      const along = stage.height >= stage.width;
      let kind: "tap" | "move" | "resize" | "divider" = "tap";
      if (edge && Math.abs((along ? p.y - edge.cssY : p.x - edge.cssX)) <= 28) {
        kind = "divider";
      } else if (small) {
        const corner =
          p.x >= small.cssX + small.cssW - 40 &&
          p.y >= small.cssY + small.cssH - 40 &&
          p.x <= small.cssX + small.cssW &&
          p.y <= small.cssY + small.cssH;
        const inside =
          p.x >= small.cssX &&
          p.x <= small.cssX + small.cssW &&
          p.y >= small.cssY &&
          p.y <= small.cssY + small.cssH;
        if (corner) kind = "resize";
        else if (inside) kind = "move";
      }
      this.dualDrag = { kind, x: p.x, y: p.y, ok: false };
    });

    this.dualPad.addEventListener("pointermove", (e) => {
      const drag = this.dualDrag;
      const layout = this.dual;
      if (!drag || !layout) return;
      const p = at(e);
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      // Under this, it is a tap with a shaky hand rather than a drag.
      if (!drag.ok && Math.hypot(dx, dy) < 8) return;
      drag.ok = true;
      if (drag.kind === "tap") return;
      const stage = this.stageBox();
      const along = stage.height >= stage.width;
      if (drag.kind === "divider") {
        const t = along ? p.y / stage.height : p.x / stage.width;
        layout.share = clamp(t, SHARE_MIN, SHARE_MAX);
      } else if (drag.kind === "move") {
        layout.inset.x = clamp(layout.inset.x + dx / stage.width, 0, 1);
        layout.inset.y = clamp(layout.inset.y + dy / stage.height, 0, 1);
        drag.x = p.x;
        drag.y = p.y;
      } else {
        // Sized from the corner the finger is holding, so the inset grows
        // under it rather than away from it.
        const w = (p.x - layout.inset.x * stage.width) / stage.width;
        layout.inset.w = clamp(w, INSET_MIN, INSET_MAX);
      }
      this.applyDual();
    });

    const end = (e: PointerEvent): void => {
      const drag = this.dualDrag;
      const layout = this.dual;
      this.dualDrag = null;
      if (!drag || !layout) return;
      if (this.dualPad.hasPointerCapture(e.pointerId)) {
        this.dualPad.releasePointerCapture(e.pointerId);
      }
      if (drag.ok) return;
      const p = at(e);
      const boxes = dualBoxes(layout, this.stageBox(), window.devicePixelRatio || 1);
      const hit: DualLens | null = dualHit(boxes, p.x, p.y);
      if (!hit) return;
      if (layout.shape === "split") {
        // Out of half and half: the one tapped fills the screen.
        layout.shape = "pip";
        layout.big = hit;
      } else if (hit !== layout.big) {
        layout.big = hit;
      } else {
        // Into half and half, and actually half: a divider dragged last time
        // is not what "view both equally" means.
        layout.shape = "split";
        layout.share = 0.5;
      }
      this.applyDual();
      this.say(
        layout.shape === "split"
          ? "Half and half — drag the line to resize, tap one to make it full screen"
          : `${layout.big === "back" ? "Back" : "Front"} camera large — drag the small one to move it, its corner to resize`,
      );
    };
    this.dualPad.addEventListener("pointerup", end);
    this.dualPad.addEventListener("pointercancel", end);
  }

  /** One photograph from each camera, combined the way the screen looks. */
  private async dualShoot(): Promise<void> {
    this.blink();
    try {
      await dualPhoto();
      this.say("Photo saved");
      this.host.refresh();
    } catch (err) {
      this.say(reason(err));
    }
  }

  /**
   * Film on both.
   *
   * Normally the two are drawn into one video as they film and stopping is
   * instant. A device that cannot do that films two clips and combines them
   * afterwards, which takes about twice the clip's length -- so the wait is
   * still said out loud, since silence for that long reads as a hung camera.
   */
  private async dualToggleRecord(): Promise<void> {
    if (this.dualRec) {
      this.dualRec = false;
      this.recBtn.classList.remove("cam-on");
      this.stopTicker();
      this.say("Saving the video…");
      try {
        await dualRecordStop();
        this.say("Video saved");
        this.host.refresh();
      } catch (err) {
        this.say(reason(err));
      }
      return;
    }
    try {
      await dualRecordStart();
    } catch (err) {
      this.say(reason(err));
      return;
    }
    this.dualRec = true;
    this.recBtn.classList.add("cam-on");
    this.startTicker();
  }

  // ── Stills ──────────────────────────────────────────────────────────────

  private async shoot(): Promise<void> {
    if (this.counting !== null) {
      // A second press during a countdown cancels it. Anything else — queuing a
      // second shot, restarting the count — is a surprise while someone is
      // running back into frame.
      this.cancelCountdown();
      return;
    }
    const wait = this.prefs.countdown;
    if (wait > 0) {
      await this.countdown(wait);
      // In dual mode there is no stream here at all -- the cameras are open on
      // the native side -- so the guard asks whether there is still something
      // to photograph, not whether there is a `MediaStream`.
      if (!this.isOpen || (!this.stream && !this.dual)) return;
    }
    if (this.dual) {
      await this.dualShoot();
      return;
    }
    await this.capture();
  }

  private countdown(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      let left = seconds;
      this.count.hidden = false;
      this.count.textContent = String(left);
      this.counting = window.setInterval(() => {
        left -= 1;
        if (left > 0) {
          this.count.textContent = String(left);
          return;
        }
        this.cancelCountdown();
        resolve();
      }, 1000);
    });
  }

  private cancelCountdown(): void {
    if (this.counting !== null) window.clearInterval(this.counting);
    this.counting = null;
    this.count.hidden = true;
  }


  // -- The shape of the picture ---------------------------------------------

  /**
   * Letterbox the preview to the chosen shape, and let the file follow.
   *
   * The crop is applied to the *element*, not to the drawing: `shown` reads the
   * box back and `paint` copies exactly that, so one rule decides the shape of
   * both and there is no second copy of it to drift. `cover` comes with the
   * crop because a cropped frame that is then fitted inside its own box is not
   * a crop at all -- it is the same picture with more black around it.
   */
  private syncAspect(): void {
    const want = ASPECTS.find(([id]) => id === this.prefs.aspect);
    const ratio = want ? want[2] : 0;
    if (!(ratio > 0)) {
      this.frame.classList.remove("cam-crop");
      this.frame.style.removeProperty("--cam-aspect");
      return;
    }
    const tall = window.innerHeight > window.innerWidth;
    this.frame.style.setProperty("--cam-aspect", String(tall ? 1 / ratio : ratio));
    this.frame.classList.add("cam-crop");
  }

  // -- Zoom, light and focus -------------------------------------------------
  //
  // The three things a phone camera has that a webcam page does not, and the
  // three the Samsung app puts first: a zoom strip, a light, and a tap that
  // focuses where you tapped. All three are properties of the open track and
  // all three differ per lens, so they are re-read on every `start`, and a
  // control with nothing behind it hides rather than pretending.

  private track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  /** Ask the open lens for something. False when it will not, or cannot. */
  private async ask(want: LensAsk): Promise<boolean> {
    const track = this.track();
    if (!track) return false;
    try {
      await track.applyConstraints({ advanced: [want] } as MediaTrackConstraints);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-read what this lens can do and rebuild the controls for it.
   *
   * Every phone answers differently -- a front camera has no light, and a
   * driver that reports `zoom: 1..1` has no zoom worth a strip -- and being
   * wrong in either direction is bad: a dead button reads as a broken app, a
   * missing one as a missing feature. So it is asked, per lens, every time.
   */
  private syncAble(): void {
    const track = this.track();
    this.able = track && typeof track.getCapabilities === "function"
      ? (track.getCapabilities() as MediaTrackCapabilities & LensCaps)
      : {};

    this.torch = false;
    this.torchBtn.hidden = this.able.torch !== true;
    this.paintTorch();
    this.syncEv();
    this.syncPro();
    this.buildZoom();
  }

  // -- Manual controls --------------------------------------------------------
  //
  // Everything Samsung keeps behind a mode called Pro, and the half of a phone
  // camera the web actually gets: the Image Capture *extensions* -- zoom,
  // torch, points of interest -- are absent from the system web view, but ISO,
  // shutter, manual focus and white balance are all here and all settable. The
  // row is built from what the open lens reports rather than from a list
  // written here, so a front camera that meters but does not focus gets the
  // controls it has and no dead buttons beside them.

  private wirePro(): void {
    this.proBar.className = "cam-pro";
    this.proBar.hidden = true;
    this.proRow.className = "cam-pro-row";
    this.proSlide.type = "range";
    this.proSlide.className = "cam-pro-slide";
    this.proSlide.hidden = true;
    // `input`, not `change`: a value that only lands when the finger lifts is a
    // guess, and the point of a manual control is watching it happen.
    this.proSlide.addEventListener("input", () => void this.setDial(Number(this.proSlide.value)));
    // The whole bar sits on the stage, where a press is a tap-to-focus and a
    // drag is a pinch. None of it is either -- and a chip that focused the
    // camera behind itself as it was pressed would undo the manual focus the
    // chip beside it had just set.
    for (const kind of ["pointerdown", "pointermove", "pointerup"]) {
      this.proBar.addEventListener(kind, (e) => e.stopPropagation());
    }
    this.proBar.append(this.proSlide, this.proRow);
  }

  /** Rebuild the row for the open lens, and hide the button if it offers none. */
  private syncPro(): void {
    this.dials = DIALS.filter((d) => {
      const span = this.able[d.key];
      return !!span && span.max > span.min;
    });
    this.proBtn.hidden = this.dials.length === 0;
    if (!this.dials.length) this.pro = false;
    this.dialAt = -1;
    this.proSlide.hidden = true;
    this.buildPro();
  }

  private buildPro(): void {
    this.proBar.hidden = !this.pro;
    window.clearInterval(this.proTimer);
    if (this.pro) this.proTimer = window.setInterval(() => this.paintDials(), 500);
    this.proBtn.setAttribute("aria-pressed", String(this.pro));
    this.proBtn.classList.toggle("on", this.pro);
    const auto = document.createElement("button");
    auto.type = "button";
    auto.className = "cam-pro-chip cam-pro-auto";
    auto.dataset["fctLabelled"] = "";
    auto.textContent = "Auto";
    auto.title = "Give every control back to the camera";
    auto.setAttribute("aria-label", auto.title);
    auto.addEventListener("click", () => void this.autoAll());
    this.proRow.replaceChildren(auto, ...this.dials.map((d, i) => this.dialChip(d, i)));
    this.paintDials();
  }

  private dialChip(d: Dial, i: number): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cam-pro-chip";
    b.dataset["fctLabelled"] = "";
    b.textContent = d.name;
    b.title = d.name;
    b.setAttribute("aria-label", d.name);
    b.addEventListener("click", () => void this.openDial(i));
    return b;
  }

  /** What the lens says a value is right now, or nothing if it will not say. */
  private live(key: string): number | undefined {
    const seen = this.track()?.getSettings() as Record<string, unknown> | undefined;
    const v = seen?.[key];
    return typeof v === "number" ? v : undefined;
  }

  /** Put the slider on a dial, or take it off the one it is already on. */
  private async openDial(i: number): Promise<void> {
    if (this.dialAt === i) {
      this.dialAt = -1;
      this.proSlide.hidden = true;
      this.paintDials();
      return;
    }
    const d = this.dials[i];
    const span = d ? this.able[d.key] : undefined;
    if (!d || !span) return;
    this.dialAt = i;
    if (d.mode) await this.ask({ [d.mode.of]: d.mode.to } as LensAsk);
    const w = d.warp;
    const ends = w ? [w.in(span.min), w.in(span.max)] : [span.min, span.max];
    const lo = Math.min(ends[0] as number, ends[1] as number);
    const hi = Math.max(ends[0] as number, ends[1] as number);
    // A driver that names no step still has to be given one, or the slider
    // moves in whole units across a range measured in thousands. A warped dial
    // has no step worth carrying over, because the step is not in its units.
    const step = !w && span.step && span.step > 0 ? span.step : (hi - lo) / 100;
    const now = this.live(d.key) ?? (span.min + span.max) / 2;
    this.proSlide.min = String(lo);
    this.proSlide.max = String(hi);
    this.proSlide.step = String(step);
    this.proSlide.value = String(w ? w.in(now) : now);
    this.proSlide.setAttribute("aria-label", d.name);
    this.proSlide.hidden = false;
    this.paintDials();
  }

  private async setDial(t: number): Promise<void> {
    const d = this.dials[this.dialAt];
    const span = d ? this.able[d.key] : undefined;
    if (!d || !span) return;
    // Back through the warp and then held to the ends the driver gave, because
    // one over a number is not exact and a value a hair past the limit is not
    // a near miss -- `applyConstraints` refuses it outright.
    const raw = d.warp ? d.warp.out(t) : t;
    const v = Math.min(span.max, Math.max(span.min, raw));
    await this.ask({ [d.key]: v } as LensAsk);
    // The tap-to-focus rail and the EV dial are the same number reached two
    // ways, so moving either has to move the other.
    if (d.key === "exposureCompensation") {
      this.evVal = v;
      this.paintEv();
    }
    this.paintDials();
  }

  /** Hand every control back to the camera. */
  private async autoAll(): Promise<void> {
    this.dialAt = -1;
    this.proSlide.hidden = true;
    // One at a time. An `advanced` entry is applied only if *every* constraint
    // in it can be met, so folding these into one request would let a lens with
    // no white balance control throw away the exposure reset beside it.
    for (const of of ["exposureMode", "focusMode", "whiteBalanceMode"] as const) {
      if (this.able[of]?.includes("continuous")) await this.ask({ [of]: "continuous" } as LensAsk);
    }
    this.paintDials();
  }

  /** Write the live value onto each chip, and mark the one being driven. */
  private paintDials(): void {
    const chips = Array.from(this.proRow.children);
    this.dials.forEach((d, i) => {
      const el = chips[i + 1];
      if (!(el instanceof HTMLElement)) return;
      // White balance reads back 0 K while the camera is choosing it, and 0 K
      // is not a colour -- it is the driver saying it has no answer. A chip
      // that prints it is worse than one that admits to knowing nothing.
      const span = this.able[d.key];
      const v = this.live(d.key);
      const known = v !== undefined && (!span || (v >= span.min && v <= span.max));
      el.textContent = known && v !== undefined ? `${d.name} ${d.show(v)}` : d.name;
      el.classList.toggle("on", i === this.dialAt);
    });
  }

  private togglePro(): void {
    this.pro = !this.pro;
    // Leaving the row is leaving manual: a camera that stayed on a hand-set
    // shutter after its controls were put away would look simply broken.
    if (!this.pro) void this.autoAll();
    this.buildPro();
    this.say(this.pro ? "Manual controls on" : "Back to automatic");
  }

  /**
   * The zoom strip, built from the lenses this phone actually has.
   *
   * The system web view on an S21+ reports no `zoom` capability at all -- the
   * Image Capture extensions are a Chrome-for-Android thing and the system web
   * view does not ship them -- so a strip driven by the driver's zoom range
   * would never appear on the device it matters most on. It is built from what
   * *is* knowable instead. The second rear lens is the ultrawide on every phone
   * that has one, so .5x is a camera change; everything above 1x is a centre
   * crop of a 12 MP frame, which is what a phone's 2x is anyway once the
   * telephoto is out of reach -- and on this phone it is, because Android does
   * not offer the tele to apps as a camera of its own.
   */
  private buildZoom(): void {
    const side = this.lenses.filter((l) => l.back === this.onBack());
    const main = side[0];
    const steps: Step[] = [];
    // An extra *rear* lens is a wider one, and it is labelled .5x the way every
    // phone labels it rather than by its true focal ratio -- 2.2 mm against
    // 5.4 mm is .41x, and nobody has ever wanted that on a button. The number
    // on a lens button is a name, not a measurement.
    //
    // Only at the back. The two front entries on an S21+ are both 3.3 mm, one
    // a smaller read-out of the same lens, so a .5x there would have been a
    // button that changed the resolution and nothing a person could see.
    if (this.onBack()) {
      side.slice(1).forEach((l, i) => steps.push({ at: i === 0 ? 0.5 : 0.3, lens: l.id, dig: 1 }));
    }
    if (main) {
      steps.push({ at: 1, lens: main.id, dig: 1 });
      const most = this.maxDig();
      for (const v of [2, 3, 5, 10]) {
        if (v <= most) steps.push({ at: v, lens: main.id, dig: v });
      }
    }
    steps.sort((a, b) => a.at - b.at);
    this.steps = steps;
    // One stop is not a strip -- it is a button that does nothing, on a screen
    // that has no room for one.
    this.zoomBar.hidden = steps.length < 2;
    this.zoomBar.replaceChildren(...steps.map((st) => this.chip(st)));
    this.zoom = this.reading();
    this.paintZoom();
  }

  /** True when the open lens faces away from the person holding the phone. */
  private onBack(): boolean {
    const now = this.lenses.find((l) => l.id === this.deviceId);
    if (now && now.back !== null) return now.back;
    return this.facing !== "user";
  }

  /**
   * How far the crop may go before the picture stops being worth having.
   *
   * Measured on the window the picture is actually taken from, not on the
   * sensor: a portrait phone already throws away most of a 4:3 frame's width
   * to fill the screen, so a limit read off the sensor would have offered a 3x
   * that was really a 7x. 400 px on the short side is the floor -- past that a
   * stop is not zoom, it is an upscale with a number on it.
   */
  private maxDig(): number {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    // Before the first frame nothing is known, and a strip with only 1x on it
    // would be built and then never rebuilt. `loadedmetadata` redoes it.
    if (!vw || !vh) return 3;
    const out = this.shown(vw, vh, 1);
    const short = Math.min(out.sw, out.sh);
    return short > 0 ? Math.max(1, Math.min(8, short / 400)) : 1;
  }

  /** What the strip should read: where the lens starts, times the crop on it. */
  private reading(): number {
    const base = this.steps.find((st) => st.lens === this.deviceId && st.dig === 1)?.at ?? 1;
    return base * this.dig;
  }

  private chip(step: Step): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cam-chip";
    // A chip is already its own label; the phone shell's word-under-the-glyph
    // sweep would write "Zoom to" under every one of them.
    b.dataset["fctLabelled"] = "";
    b.dataset["zoom"] = String(step.at);
    b.textContent = zoomLabel(step.at);
    b.title = `Zoom to ${zoomLabel(step.at)}`;
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", () => void this.setStep(step));
    return b;
  }

  /** Go to a stop: change lens if it is on another one, then set the crop. */
  private async setStep(step: Step): Promise<void> {
    if (step.lens !== this.deviceId) {
      this.deviceId = step.lens;
      this.deviceSel.value = step.lens;
      // .5x is a choice, and the main-lens correction must not undo it.
      this.lensPicked = true;
      // Set before the reopen, so `syncAble` rebuilds the strip already at the
      // stop that was pressed rather than snapping back to 1x for a frame.
      this.dig = step.dig;
      const now = this.lenses.find((l) => l.id === step.lens);
      if (now && now.back !== null) this.facing = now.back ? "environment" : "user";
      await this.start();
      return;
    }
    this.setDig(step.dig);
  }

  /**
   * Crop into the open lens, on the preview and on the file at once.
   *
   * The preview scales the video inside a frame that clips it; `shown` narrows
   * its window by the same factor. One number read in two places, and nothing
   * to keep in step by hand -- which is the promise the whole view is built on:
   * what is on the screen is what lands in the file.
   */
  private setDig(value: number): void {
    const next = Math.max(1, Math.min(this.maxDig(), value));
    if (Math.abs(next - this.dig) < 1e-4) return;
    this.dig = next;
    this.applyLook();
    this.zoom = this.reading();
    this.paintZoom();
    this.drawGuides();
    this.sayLive();
  }

  // -- Brightness -------------------------------------------------------------
  //
  // `exposureCompensation` is one of the few controls this web view does hand
  // over, and it is the one people reach for straight after focus: tap a face
  // against a bright window and the face goes black, and the fix is to pull the
  // exposure down without leaving the viewfinder. So it lives where a phone
  // camera puts it -- a rail beside the focus ring, up for brighter.

  private syncEv(): void {
    const c = this.able.exposureCompensation;
    this.evRail.hidden = true;
    this.evRail.dataset["able"] = c && c.max > c.min ? "1" : "";
    const live = (this.track()?.getSettings() as (MediaTrackSettings & { exposureCompensation?: number }) | undefined)
      ?.exposureCompensation;
    if (typeof live === "number") this.evVal = live;
    else this.evVal = c ? Math.min(c.max, Math.max(c.min, 0)) : 0;
    this.paintEv();
  }

  private wireEv(): void {
    this.evRail.className = "cam-ev";
    this.evRail.hidden = true;
    this.evRail.setAttribute("role", "slider");
    this.evRail.setAttribute("aria-label", "Brightness");
    this.evDot.className = "cam-ev-dot";
    this.evDot.textContent = "\u2600";
    this.evRail.append(this.evDot);

    const drag = (e: PointerEvent): void => {
      const r = this.evRail.getBoundingClientRect();
      if (!r.height) return;
      void this.setEv(1 - (e.clientY - r.top) / r.height);
      this.holdEv();
    };
    this.evRail.addEventListener("pointerdown", (e) => {
      // The rail sits on the stage, where a press is a tap-to-focus and a drag
      // is a pinch. Neither is what this is.
      e.stopPropagation();
      this.evRail.setPointerCapture(e.pointerId);
      drag(e);
    });
    this.evRail.addEventListener("pointermove", (e) => {
      if (!this.evRail.hasPointerCapture(e.pointerId)) return;
      e.stopPropagation();
      drag(e);
    });
    const done = (e: PointerEvent): void => {
      if (this.evRail.hasPointerCapture(e.pointerId)) this.evRail.releasePointerCapture(e.pointerId);
      e.stopPropagation();
    };
    this.evRail.addEventListener("pointerup", done);
    this.evRail.addEventListener("pointercancel", done);
  }

  /** Put the rail beside the tap, kept clear of the edges it would hang off. */
  private showEv(x: number, y: number, on: DOMRect): void {
    if (!this.evRail.dataset["able"]) return;
    const left = x - on.left + 54;
    this.evRail.style.left = `${Math.min(on.width - 24, Math.max(24, left))}px`;
    this.evRail.style.top = `${Math.min(on.height - 90, Math.max(90, y - on.top))}px`;
    this.evRail.hidden = false;
    this.paintEv();
  }

  private paintEv(): void {
    const c = this.able.exposureCompensation;
    if (!c || !(c.max > c.min)) return;
    const f = (this.evVal - c.min) / (c.max - c.min);
    this.evDot.style.bottom = `${Math.min(1, Math.max(0, f)) * 100}%`;
    this.evRail.setAttribute("aria-valuenow", this.evVal.toFixed(2));
  }

  /** `f` is 0 at the bottom of the rail and 1 at the top. */
  private async setEv(f: number): Promise<void> {
    const c = this.able.exposureCompensation;
    if (!c || !(c.max > c.min)) return;
    const want = c.min + Math.min(1, Math.max(0, f)) * (c.max - c.min);
    // Off-step values are refused outright by some drivers rather than rounded,
    // and a slider that silently does nothing is worse than one that steps.
    const step = c.step && c.step > 0 ? c.step : 0;
    const next = step ? c.min + Math.round((want - c.min) / step) * step : want;
    this.evVal = Math.min(c.max, Math.max(c.min, next));
    this.paintEv();
    await this.ask({ exposureCompensation: this.evVal });
  }

  /** Keep the ring and the rail up while either is being used. */
  private holdEv(): void {
    window.clearTimeout(this.ringTimer);
    this.ringTimer = window.setTimeout(() => {
      this.ring.hidden = true;
      this.evRail.hidden = true;
    }, 2600);
  }

  /** Mark the chip the zoom is at, or the nearest one below it. */
  private paintZoom(): void {
    const chips = [...this.zoomBar.querySelectorAll<HTMLButtonElement>(".cam-chip")];
    let best: HTMLButtonElement | null = null;
    for (const c of chips) {
      c.classList.remove("on");
      if (Number(c.dataset["zoom"]) <= this.zoom + 1e-6) best = c;
    }
    (best ?? chips[0])?.classList.add("on");
  }

  private async toggleTorch(): Promise<void> {
    const want = !this.torch;
    if (!(await this.ask({ torch: want }))) {
      this.say("This camera has no light");
      this.torchBtn.hidden = true;
      return;
    }
    this.torch = want;
    this.paintTorch();
    this.say(want ? "Light on" : "Light off");
  }

  private paintTorch(): void {
    this.torchBtn.classList.toggle("on", this.torch);
    this.torchBtn.title = this.torch ? "Turn the light off" : "Turn the light on";
    this.torchBtn.setAttribute("aria-pressed", String(this.torch));
  }

  /**
   * A tap focuses there; two fingers zoom.
   *
   * Both are wired to the stage rather than the video element, because the
   * stage is what the finger is pointing at. The point handed to the driver is
   * a fraction of the *frame*, not of the screen, so the crop has to be undone
   * first: the left edge of a cropped preview is not the left edge of the
   * sensor, and without this the focus landed well off to the side.
   */
  private wireStage(stage: HTMLElement): void {
    const live = new Map<number, { x: number; y: number }>();
    let base = 0;
    let from = 1;
    let pinched = false;

    stage.addEventListener("pointerdown", (e) => {
      live.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (live.size === 2) {
        base = spread(live);
        from = this.dig;
        pinched = true;
      }
    });

    stage.addEventListener("pointermove", (e) => {
      if (!live.has(e.pointerId)) return;
      live.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (live.size !== 2 || base <= 0) return;
      const now = spread(live);
      // The crop only, never a lens change: a reopen mid-pinch is a black frame
      // and a new track under the fingers that are still moving.
      if (now > 0) this.setDig(from * (now / base));
    });

    const up = (e: PointerEvent): void => {
      const was = live.size;
      live.delete(e.pointerId);
      if (live.size > 0) return;
      // One finger down and up with no second joining it is a tap. Anything
      // that involved two is a pinch to its very last finger, and a pinch must
      // not also focus on wherever that finger happened to end up. A tap that
      // landed on a control is that control being pressed -- the zoom chips sit
      // on the stage, and focusing behind the button you just pressed is both
      // wrong and startling.
      const on = e.target instanceof Element ? e.target.closest("button, a, input, select, .cam-ev") : null;
      if (was === 1 && !pinched && !on) void this.focusAt(e, stage);
      base = 0;
      pinched = false;
    };
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
  }

  private async focusAt(e: PointerEvent, stage: HTMLElement): Promise<void> {
    // Measured against the picture, not the stage: with a shape chosen the
    // picture is letterboxed inside the stage, and a tap on the black bar is
    // not a tap on anything. The ring is still placed in stage coordinates,
    // because the stage is what it hangs off.
    const box = this.frame.getBoundingClientRect();
    const on = stage.getBoundingClientRect();
    if (!box.width || !box.height || !on.width) return;
    const px = (e.clientX - box.left) / box.width;
    const py = (e.clientY - box.top) / box.height;
    if (px < 0 || px > 1 || py < 0 || py > 1) return;

    // The ring is drawn whatever the driver answers, because the tap happened,
    // and a control that responds only sometimes reads as one that is broken.
    this.ring.style.left = `${e.clientX - on.left}px`;
    this.ring.style.top = `${e.clientY - on.top}px`;
    this.ring.hidden = false;
    this.ring.classList.remove("go");
    void this.ring.offsetWidth;
    this.ring.classList.add("go");
    this.showEv(e.clientX, e.clientY, on);
    this.holdEv();

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    const { sx, sy, sw, sh } = this.shown(vw, vh);
    const at = { x: (sx + px * sw) / vw, y: (sy + py * sh) / vh };
    const modes = this.able.focusMode ?? [];
    const mode = modes.includes("single-shot") ? "single-shot" : null;
    await this.ask(mode ? { focusMode: mode, pointsOfInterest: [at] } : { pointsOfInterest: [at] });
  }

  /**
   * The frame height to ask the device for.
   *
   * The quality names the short edge of the *picture*. On a desktop the frame
   * is the picture and the two are the same number. On a phone the frame is
   * cropped to the screen, and a 1920 x 1080 frame cropped to a 1080 x 2400
   * display is 486 px wide -- "1080p" delivering a photo narrower than a
   * thumbnail. So the ask is scaled up by the crop: 1080 / (1080/2400) is
   * 2400, which the device rounds to its 4K mode, and the picture comes out
   * 972 x 2160. Rounded to a mode the camera actually has, because a height
   * between two of them lands on whichever the driver prefers.
   */
  private askHeight(): number {
    const want = this.prefs.height;
    if (!isPhone() || !isPortrait()) return want;
    const wide = window.innerWidth / window.innerHeight;
    if (!(wide > 0)) return want;
    const need = want / wide;
    // HEIGHTS is largest first, so the last one at or above `need` is the
    // smallest that meets it; nothing meeting it means take the largest.
    const fits = HEIGHTS.filter((h) => h >= need);
    return fits.length ? fits[fits.length - 1]! : HEIGHTS[0]!;
  }

  /**
   * The part of the frame the preview is actually showing.
   *
   * An Android web view hands back the sensor's own landscape frame whatever
   * it is asked for: 1920 x 1080 on a phone held upright, pinned by device id,
   * with `width: 1080, height: 1920` in the constraints and the re-open done.
   * Letterboxed into a portrait screen that is a thin strip with two thirds of
   * the display black, which is not a camera app. So the preview fills the
   * screen instead, and the frame is cropped to what fills it.
   *
   * The fit is *read back from the element* rather than decided again here.
   * Two copies of this rule -- one in CSS for the preview, one here for the
   * file -- is exactly how a preview and a file drift apart, and matching them
   * is the promise this camera is built on. `cover` centres its crop, so this
   * centres its own.
   */
  private shown(w: number, h: number, dig = this.dig): { sx: number; sy: number; sw: number; sh: number } {
    let box = { sx: 0, sy: 0, sw: w, sh: h };
    // `offsetWidth`, not a bounding rect: the video inside this frame carries
    // the zoom as a transform, and a rect would report the enlarged picture.
    const fw = this.frame.offsetWidth;
    const fh = this.frame.offsetHeight;
    if (getComputedStyle(this.video).objectFit === "cover" && fw > 0 && fh > 0) {
      const want = fw / fh;
      if (w / h > want) {
        const sw = Math.round(h * want);
        box = { sx: Math.round((w - sw) / 2), sy: 0, sw, sh: h };
      } else {
        const sh = Math.round(w / want);
        box = { sx: 0, sy: Math.round((h - sh) / 2), sw: w, sh };
      }
    }
    if (!(dig > 1)) return box;
    // Digital zoom is a narrower window on the same frame, centred where the
    // preview's `scale` centres it -- one crop, so the file is what was shown.
    const sw = Math.max(2, Math.round(box.sw / dig));
    const sh = Math.max(2, Math.round(box.sh / dig));
    return {
      sx: box.sx + Math.round((box.sw - sw) / 2),
      sy: box.sy + Math.round((box.sh - sh) / 2),
      sw,
      sh,
    };
  }

  /**
   * Draw what the preview is showing into `canvas`.
   *
   * At the sensor's own scale for a photo, and inside `cap` while recording.
   * The canvas is deliberately *not* resized once a recording is under way --
   * `captureStream` is bound to it, and changing its size mid-clip is how a
   * recording ends up with a torn or empty tail.
   */
  private paint(): boolean {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return false;
    const { sx, sy, sw, sh } = this.shown(vw, vh);
    const [dw, dh] = fit(sw, sh, this.cap);
    if (this.canvas.width !== dw || this.canvas.height !== dh) {
      this.canvas.width = dw;
      this.canvas.height = dh;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return false;
    ctx.save();
    if (this.prefs.mirror) {
      ctx.translate(dw, 0);
      ctx.scale(-1, 1);
    }
    // The same string the preview element carries, which is the whole contract.
    ctx.filter = filterOf(this.look);
    ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.restore();
    return true;
  }

  private async capture(): Promise<void> {
    if (!this.stream) {
      this.say("No camera is open");
      return;
    }
    const format = this.prefs.format;
    const full = await this.stillCanvas();
    if (!full && !this.paint()) {
      this.say("The camera has not produced a frame yet");
      return;
    }
    const target = full ?? this.canvas;
    const blob = await new Promise<Blob | null>((resolve) => {
      // Quality is ignored for PNG by every browser, which is correct — it is
      // lossless — so it is passed unconditionally rather than branched on.
      target.toBlob(resolve, mimeOf(format), this.prefs.quality);
    });
    if (full) full.width = full.height = 0;
    if (!blob) {
      this.say("The frame could not be encoded");
      return;
    }
    this.blink();
    await this.deliver(blob, extOf(format));
  }

  /**
   * The photo at the sensor's full resolution, cropped and styled the way the
   * preview shows it, or null where the engine cannot take one.
   *
   * A frame of the preview stream tops out at the stream's size -- about 2 MP
   * once it is cropped to a phone screen -- while `takePhoto` runs a real still
   * capture: the whole sensor, through the camera's own still processing. The
   * crop is the preview's crop carried across as fractions, because the still
   * and the stream share a centre but not an aspect ratio.
   */
  private async stillCanvas(): Promise<HTMLCanvasElement | null> {
    const track = this.stream?.getVideoTracks()[0];
    const Capture = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!track || !Capture || !vw || !vh) return null;
    let bmp: ImageBitmap;
    try {
      const cap = new Capture(track);
      const caps = await cap.getPhotoCapabilities().catch(() => null);
      const settings: Record<string, number> = {};
      if (caps?.imageWidth?.max && caps.imageHeight?.max) {
        settings["imageWidth"] = caps.imageWidth.max;
        settings["imageHeight"] = caps.imageHeight.max;
      }
      const shot = await cap.takePhoto(settings);
      bmp = await createImageBitmap(shot, { imageOrientation: "from-image" });
    } catch {
      return null;
    }
    // A still whose long side runs the other way from the stream's has come
    // back in sensor orientation; turn it to match what the preview shows.
    const turn = vw > vh !== bmp.width > bmp.height;
    const pw = turn ? bmp.height : bmp.width;
    const ph = turn ? bmp.width : bmp.height;
    if (pw * ph <= vw * vh) {
      bmp.close();
      return null;
    }
    // The stream's view inside the still: its aspect, centred.
    let bw = pw;
    let bh = Math.round(pw * (vh / vw));
    if (bh > ph) {
      bh = ph;
      bw = Math.round(ph * (vw / vh));
    }
    const bx = (pw - bw) / 2;
    const by = (ph - bh) / 2;
    const { sx, sy, sw, sh } = this.shown(vw, vh);
    const k = bw / vw;
    const cx = bx + sx * k;
    const cy = by + sy * (bh / vh);
    const dw = Math.max(1, Math.round(sw * k));
    const dh = Math.max(1, Math.round(sh * (bh / vh)));
    const out = document.createElement("canvas");
    out.width = dw;
    out.height = dh;
    const ctx = out.getContext("2d");
    if (!ctx) {
      bmp.close();
      return null;
    }
    if (this.prefs.mirror) {
      ctx.translate(dw, 0);
      ctx.scale(-1, 1);
    }
    ctx.filter = filterOf(this.look);
    // Crop coordinates are in the turned picture; draw the turned picture with
    // its origin shifted so the crop lands at the canvas origin.
    ctx.translate(-cx, -cy);
    if (turn) {
      ctx.translate(pw, 0);
      ctx.rotate(Math.PI / 2);
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return out;
  }

  private blink(): void {
    this.flash.classList.remove("cam-blink");
    // Reading a layout property is what makes the class removal take effect
    // before it is added again; without it the animation only ever runs once.
    void this.flash.offsetWidth;
    this.flash.classList.add("cam-blink");
  }

  // ── Clips ───────────────────────────────────────────────────────────────

  private async toggleRecord(): Promise<void> {
    if (this.dual) {
      await this.dualToggleRecord();
      return;
    }
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
      return;
    }
    await this.record();
  }

  private async record(): Promise<void> {
    if (!this.stream) {
      this.say("No camera is open");
      return;
    }
    // Before the first paint, so the canvas is already the size the whole clip
    // will be -- see `cap`.
    this.cap = VIDEO_PIXELS;
    if (!this.paint()) {
      this.cap = 0;
      this.say("The camera has not produced a frame yet");
      return;
    }
    const mime = bestVideoMime((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      this.cap = 0;
      this.say("This build cannot record video");
      return;
    }

    /*
     * The canvas, not the camera — see the header.
     *
     * `captureStream(0)` means the browser emits **no** frames on its own and
     * one frame per `requestFrame()`, which is the opposite of the obvious
     * `captureStream(30)` and is the whole reason recording is reliable.
     * Automatic capture is driven by the compositor, so it stops when the
     * window is occluded, minimised or on a background tab: the clip carries on
     * for the full minute and every frame after the user looked away is the
     * same frozen one. Pushing frames explicitly from the draw loop takes the
     * compositor out of it entirely — what was drawn is what was recorded.
     *
     * `captureStream(0)` with no `requestFrame` on the track would record
     * nothing at all, so an engine without it falls back to the automatic
     * behaviour: a clip that freezes when minimised beats no clip.
     */
    let canvasStream = this.canvas.captureStream(0);
    // A cast, because `getVideoTracks` is typed for any stream while a canvas
    // capture's tracks really do carry `requestFrame` — which is why the very
    // next line checks for it rather than trusting the cast.
    this.pushes = (canvasStream.getVideoTracks()[0] ?? null) as CanvasCaptureMediaStreamTrack | null;
    if (typeof this.pushes?.requestFrame !== "function") {
      for (const t of canvasStream.getTracks()) t.stop();
      canvasStream = this.canvas.captureStream(FPS);
      this.pushes = null;
    }
    const tracks = [...canvasStream.getVideoTracks(), ...this.stream.getAudioTracks()];
    const mixed = new MediaStream(tracks);

    this.chunks = [];
    const rec = new MediaRecorder(mixed, { mimeType: mime });
    this.recorder = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.onstop = () => {
      this.stopDrawing();
      this.stopTicker();
      for (const t of canvasStream.getVideoTracks()) t.stop();
      this.recorder = null;
      this.recBtn.classList.remove("cam-on");
      const blob = new Blob(this.chunks, { type: mime });
      this.chunks = [];
      // A recording that produced no bytes is a failure and has to say so.
      // Silently doing nothing here is indistinguishable from a save that
      // worked, and the user finds out when the folder is empty.
      if (blob.size > 0) void this.deliver(blob, extOfMime(mime));
      else this.say("The recording produced no data and was not saved");
    };
    // A timeslice, so a crash mid-recording leaves the chunks that already
    // fired rather than one buffer that was never handed over.
    rec.start(1000);
    this.startDrawing();
    this.startTicker();
    this.recBtn.classList.add("cam-on");
    this.say("Recording");
  }

  /**
   * Redraw on a clock, not on the compositor.
   *
   * `requestAnimationFrame` is the reflex here and it is the wrong call. It is
   * tied to painting the window, so it is throttled to roughly once a second
   * the moment that window is minimised, occluded or backgrounded — and a
   * camera is precisely the app someone starts recording with and then looks
   * away from. A timer keeps running, so the clip keeps having frames in it.
   */
  private startDrawing(): void {
    if (this.drawing !== null) return;
    this.drawing = window.setInterval(() => {
      if (!this.paint()) return;
      // Only meaningful on a `captureStream(0)` track; null when the engine
      // could not give us one and the browser is pulling frames itself.
      this.pushes?.requestFrame?.();
    }, Math.round(1000 / FPS));
  }

  private stopDrawing(): void {
    if (this.drawing !== null) window.clearInterval(this.drawing);
    this.drawing = null;
    this.pushes = null;
    // Back to the sensor's own scale, so the next photo is a full-size one.
    this.cap = 0;
  }

  private startTicker(): void {
    this.recStarted = performance.now();
    this.timeOut.hidden = false;
    this.timeOut.textContent = clock(0);
    this.ticker = window.setInterval(() => {
      this.timeOut.textContent = clock((performance.now() - this.recStarted) / 1000);
    }, 250);
  }

  private stopTicker(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
    this.timeOut.hidden = true;
  }

  // ── Saving ──────────────────────────────────────────────────────────────

  /**
   * Write it, show it, and say it saved -- by kind, not file name.
   *
   * Never over an existing file: `writeFree` steps to `facet-… (2).jpg` when a
   * second capture lands in the same second.
   *
   * It used to call `writeFile(…, false)` under a comment claiming the shell
   * picked the next free name. Nothing did — `write_file` refuses a taken name
   * and refuses it as an error — so the second of two shots inside one second
   * was lost with "could not save" under it.
   */
  private async deliver(blob: Blob, ext: string): Promise<void> {
    const name = stampName(new Date(), ext);
    const folder = this.host.folder();
    const path = join(folder, name);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      await writeFree(this.host, path, bytes);
      this.say(blob.type.startsWith("image/") ? "Photo saved" : "Video saved");
      this.host.refresh();
    } catch (err) {
      this.say(`Could not save: ${reason(err)}`);
      return;
    }
    if (this.shot.src.startsWith("blob:")) URL.revokeObjectURL(this.shot.src);
    // Only a still gets a thumbnail; an <img> cannot show a webm, and a broken
    // image icon in the corner reads as a failed capture.
    if (ext === "webm" || ext === "mp4") {
      this.shot.hidden = true;
      return;
    }
    this.shot.src = URL.createObjectURL(blob);
    this.shot.hidden = false;
  }

  // ── Words and keys ──────────────────────────────────────────────────────

  private say(message: string): void {
    this.status.textContent = message;
  }

  private sayLive(): void {
    const track = this.stream?.getVideoTracks()[0];
    const s = track?.getSettings();
    if (!s?.width || !s.height) {
      this.say("Camera open");
      return;
    }
    // What the camera *gave*, not what was asked for — `ideal` constraints mean
    // those are routinely different, and the one that matters is on the wire.
    const fps = s.frameRate ? ` · ${Math.round(s.frameRate)} fps` : "";
    const sound = this.stream?.getAudioTracks().length ? " · sound" : " · no sound";
    // The size of the *file*, not of the track: on a phone the preview fills
    // the screen and the frame is cropped to it, so the track's own numbers
    // name a picture nobody is being shown. See `shown`.
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const out = vw && vh ? this.shown(vw, vh) : null;
    const size = out ? `${out.sw} × ${out.sh}` : `${s.width} × ${s.height}`;
    this.say(`${size}${fps}${sound}`);
  }

  private wireKeys(): void {
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.isOpen) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        // The preset name box is a text field on the same surface as a Space
        // shortcut, and a look called "my dark one" would otherwise take four
        // photos while it was being typed.
        if (e.target instanceof HTMLElement && isTyping(e.target)) return;
        switch (e.key) {
          case "Escape":
            // One layer at a time: the panel first, then the camera.
            if (!this.panel.hidden) this.panel.hidden = true;
            else this.close();
            break;
          case " ":
            void this.shoot();
            break;
          case "r":
          case "R":
            void this.toggleRecord();
            break;
          case "m":
          case "M":
            this.toggleMirror();
            break;
          case "f":
          case "F":
            this.togglePanel();
            break;
          case "g":
          case "G": {
            const i = GRIDS.findIndex(([id]) => id === this.prefs.grid);
            this.prefs.grid = GRIDS[(i + 1) % GRIDS.length]![0];
            this.gridSel.value = this.prefs.grid;
            this.drawGuides();
            break;
          }
          default:
            return;
        }
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  private btn(label: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cam-btn";
    b.textContent = label;
    b.title = title;
    // A glyph button's name lives only in its tooltip, and a tooltip is not a
    // name to anything that is not a mouse.
    b.setAttribute("aria-label", title);
    b.addEventListener("click", run);
    return b;
  }
}

// ── Module helpers ──────────────────────────────────────────────────────────

/**
 * The camera controls the DOM types do not carry.
 *
 * `zoom`, `torch` and `pointsOfInterest` are in the Image Capture spec and
 * implemented by Chromium on Android -- they are how a web page gets the
 * things a phone camera app has and a webcam page does not -- but
 * `lib.dom.d.ts` still types `MediaTrackCapabilities` without them. Declared
 * here rather than cast at each call site, so there is one place that says
 * what is being assumed and one place to delete when the types catch up.
 */
/** The Image Capture constructor, which the DOM typings do not carry. */
type ImageCaptureCtor = new (track: MediaStreamTrack) => {
  getPhotoCapabilities(): Promise<{ imageWidth?: Span; imageHeight?: Span }>;
  takePhoto(settings?: Record<string, number>): Promise<Blob>;
};

interface Span {
  min: number;
  max: number;
  step?: number;
}

interface LensCaps {
  zoom?: Span;
  torch?: boolean;
  focusMode?: string[];
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  exposureCompensation?: Span;
  exposureTime?: Span;
  iso?: Span;
  focusDistance?: Span;
  colorTemperature?: Span;
}

interface LensAsk {
  zoom?: number;
  torch?: boolean;
  focusMode?: string;
  exposureMode?: string;
  whiteBalanceMode?: string;
  exposureCompensation?: number;
  exposureTime?: number;
  iso?: number;
  focusDistance?: number;
  colorTemperature?: number;
  pointsOfInterest?: Array<{ x: number; y: number }>;
}

/** The capability keys a dial reads its range from. */
type DialKey = "iso" | "exposureTime" | "exposureCompensation" | "focusDistance" | "colorTemperature";

/** The mode keys that have to be taken off automatic before a dial will bite. */
type ModeKey = "exposureMode" | "focusMode" | "whiteBalanceMode";

/** One manual control: what it is called, what it moves, and how it reads. */
interface Dial {
  key: DialKey;
  name: string;
  /**
   * The automatic behaviour that has to be switched off first, if any.
   *
   * An ISO set while the camera is still metering for itself is a number the
   * driver is free to overwrite on the next frame, and does -- the control
   * appears to work for an instant and then undoes itself, which is worse than
   * one that plainly does nothing.
   */
  mode?: { of: ModeKey; to: string };
  show: (v: number) => string;
  /**
   * How the slider's travel maps onto the value, where even travel is wrong.
   *
   * Distance is the case that needs it. A lens that focuses from 9 cm to 4.5 m
   * spends nine tenths of a linear slider between two and four metres, where
   * nothing changes, and squeezes everything from macro to half a metre -- the
   * whole reason to focus by hand -- into the first centimetre of travel. A
   * focus ring on a real lens is not marked evenly either; it is marked in
   * diopters, which is one over the distance, and that is what this is.
   */
  warp?: { in: (v: number) => number; out: (t: number) => number };
}

/**
 * A shutter speed, written the way a camera writes it.
 *
 * The unit on the web is hundreds of microseconds -- `exposureTime: 166` is
 * a sixtieth of a second -- which is a number nobody has ever seen on a dial.
 */
function shutterLabel(units: number): string {
  const s = units / 10000;
  if (!(s > 0)) return "\u2014";
  if (s >= 1) return `${s.toFixed(1)}\u2033`;
  return `1/${Math.round(1 / s)}`;
}

/**
 * The manual controls, in the order a photographer reaches for them.
 *
 * Only the ones the open lens actually reports are built, because the set
 * differs per camera and per phone: the system web view ships no `zoom` or
 * `torch` extension at all but does offer this whole row, which is the half of
 * a phone camera Samsung keeps behind a mode called Pro.
 */
const DIALS: readonly Dial[] = [
  { key: "iso", name: "ISO", mode: { of: "exposureMode", to: "manual" }, show: (v) => String(Math.round(v)) },
  { key: "exposureTime", name: "Shutter", mode: { of: "exposureMode", to: "manual" }, show: shutterLabel },
  { key: "exposureCompensation", name: "EV", show: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}` },
  {
    key: "focusDistance",
    name: "Focus",
    mode: { of: "focusMode", to: "manual" },
    // Metres, and checked rather than assumed: on an S21+ a keyboard a foot
    // away comes up sharp at 0.25 and is bokeh at 4.0, so Chromium is doing the
    // conversion from the diopters Android's HAL speaks. Worth re-checking on
    // any new device -- if close things read as large numbers, it did not.
    show: (v) => (v >= 10 ? "\u221e" : `${v.toFixed(2)} m`),
    // Negated so that the distance still grows left to right; a focus control
    // that ran backwards would be right and still feel broken.
    warp: { in: (m) => (m > 0 ? -1 / m : -1e4), out: (t) => (t < 0 ? -1 / t : 1e4) },
  },
  {
    key: "colorTemperature",
    name: "WB",
    mode: { of: "whiteBalanceMode", to: "manual" },
    show: (v) => `${Math.round(v)}K`,
  },
];

/**
 * A stop on the zoom strip: a lens to be on, and how far to crop into it.
 *
 * The two halves of what a phone calls "zoom". Which one a stop uses is not
 * something the person pressing it should have to know -- .5x and 2x are the
 * same kind of button, and only one of them changes camera.
 */
interface Step {
  /** What it reads as, against the main lens: 0.5, 1, 2, 3. */
  at: number;
  /** The lens it lives on. */
  lens: string;
  /** The crop applied to that lens. 1 is the lens's own field of view. */
  dig: number;
}

/** One camera, named in a way the person holding the phone can act on. */
interface Lens {
  id: string;
  label: string;
  /** True for a rear lens, false for a front one, null when it will not say. */
  back: boolean | null;
}

/**
 * The cameras, named and ordered for the device they are on.
 *
 * Three things were wrong on an S21+, and they were all the same thing. The
 * list came back in the order Android enumerates it -- camera 1 front, camera
 * 3 front, camera 2 back, camera 0 back -- so a *camera app* opened on the
 * selfie lens; the labels were those strings verbatim, which name the driver's
 * index and nothing a person can use; and once the rear lenses were brought to
 * the front, the first of them was camera 2, the 2.2 mm ultrawide. Every photo
 * came off the wide-angle lens. Four rows saying "camera N, facing X" do not
 * answer the only question being asked of them, which is which of these is the
 * one I point at things.
 *
 * So: rear lenses first on a phone, each side ordered by the driver's index,
 * and named by side and position -- Back camera, Back camera 2, Front camera,
 * Front camera 2. The index decides the order because Android requires camera 0
 * to be the primary rear one and camera 1 the primary front one; it does not
 * decide the name, because a row reading "camera2 2" helps nobody.
 *
 * A webcam that names itself ("HD Pro Webcam C920") keeps its own name and its
 * own place. There is nothing wrong with either and nothing to improve.
 */
function lenses(devices: readonly MediaDeviceInfo[], phone: boolean): Lens[] {
  const sideOf = (d: MediaDeviceInfo): boolean | null => {
    const m = /facing\s+(back|front|environment|user)/i.exec(d.label || "");
    return m ? /back|environment/i.test(m[1]!) : null;
  };
  // Chromium names an Android camera "camera2 N, facing back", where N is the
  // driver's index -- and that index is the only thing in the whole list that
  // distinguishes the main lens from the ultrawide beside it. A device that
  // does not say sorts last within its side, keeping the order it came in.
  const indexOf = (d: MediaDeviceInfo): number => {
    const m = /camera2?\s+(\d+)/i.exec(d.label || "");
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const rows = devices.map((d) => ({ d, back: sideOf(d), at: indexOf(d) }));
  if (phone) {
    rows.sort((a, b) => Number(b.back === true) - Number(a.back === true) || a.at - b.at);
  }
  let nb = 0;
  let nf = 0;
  return rows.map(({ d, back }, i) => {
    let label: string;
    if (back === null) label = (d.label || "").trim() || `Camera ${i + 1}`;
    else if (back) {
      nb += 1;
      label = nb === 1 ? "Back camera" : `Back camera ${nb}`;
    } else {
      nf += 1;
      label = nf === 1 ? "Front camera" : `Front camera ${nf}`;
    }
    return { id: d.deviceId, label, back };
  });
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function spacer(): HTMLElement {
  const s = document.createElement("span");
  s.className = "cam-gap";
  return s;
}

function title(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "cam-title";
  h.textContent = text;
  return h;
}

function trim(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function isTyping(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && el.type !== "range" && el.type !== "checkbox";
}

/** Join without caring which slash the platform uses; the backend normalises. */
function join(folder: string, name: string): string {
  if (!folder) return name;
  return /[\\/]$/.test(folder) ? `${folder}${name}` : `${folder}/${name}`;
}


/**
 * Upright, by the window rather than by `screen.orientation`.
 *
 * `screen.orientation` reports the *device*, which on a tablet in a landscape
 * stand running a portrait app is the wrong answer, and it is missing from
 * enough WebViews to need this fallback anyway. What the preview has to match
 * is the shape of the box it is drawn into.
 */
/** ".5x", "1x", "2.3x" -- a zoom reads as a multiple, not as a raw number. */
function zoomLabel(value: number): string {
  const round = Math.abs(value - Math.round(value)) < 0.05;
  const n = round ? String(Math.round(value)) : value.toFixed(1);
  // ".5" rather than "0.5": it is the label every phone camera uses for the
  // wide lens, and the strip is read at a glance.
  return `${n.startsWith("0.") ? n.slice(1) : n}\u00d7`;
}

/**
 * `w` x `h` brought inside a pixel budget, keeping its shape.
 *
 * Even numbers on the way out: H.264 encodes in 2x2 blocks, and an odd edge is
 * rejected outright by some encoders and quietly rounded by others -- which is
 * a one-pixel shear down the whole clip.
 */
function fit(w: number, h: number, budget: number): [number, number] {
  if (budget <= 0 || w * h <= budget) return [w, h];
  const k = Math.sqrt(budget / (w * h));
  const even = (n: number): number => Math.max(2, Math.round((n * k) / 2) * 2);
  return [even(w), even(h)];
}

/** The distance between the only two pointers on the stage. */
function spread(live: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...live.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isPortrait(): boolean {
  return window.innerHeight >= window.innerWidth;
}

/** True only inside the phone shell, which is the only thing that gets turned. */
function isPhone(): boolean {
  return document.body.classList.contains("fct-phone");
}

/**
 * What went wrong, in words a person can act on.
 *
 * The `getUserMedia` error names are the whole reason this exists: a bare
 * "NotAllowedError" on screen tells someone nothing, while "the camera is
 * blocked" tells them where to look. `NotReadableError` in particular almost
 * always means another program has the device, which is a thing the user can
 * fix in five seconds if anybody tells them.
 */
function reason(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access is blocked — allow it in Windows privacy settings, then reopen";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera answered. Check it is plugged in and not disabled";
    case "NotReadableError":
      return "The camera is busy — another program has it open";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
