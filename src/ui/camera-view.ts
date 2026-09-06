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
  type GridKind,
  type Look,
  type PhotoFormat,
  type Preset,
  type PresetBackend,
} from "@core/capture/camera";

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

export interface CameraPrefs {
  format: PhotoFormat;
  quality: number;
  height: number;
  mirror: boolean;
  grid: GridKind;
  countdown: number;
  sound: boolean;
}

/** Frames a second while recording — what is drawn, and what is recorded. */
const FPS = 30;

const FALLBACK: CameraPrefs = {
  format: "jpeg",
  quality: 0.92,
  height: 1080,
  mirror: false,
  grid: "none",
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
  private readonly timerSel = document.createElement("select");

  private stream: MediaStream | null = null;
  private devices: MediaDeviceInfo[] = [];
  private deviceId: string | null = null;
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

    const stage = document.createElement("div");
    stage.className = "cam-stage";
    stage.append(this.video, this.guides, this.flash, this.count);

    const bar = document.createElement("header");
    bar.className = "cam-bar";
    this.deviceSel.className = "cam-sel";
    this.deviceSel.title = "Which camera";
    this.deviceSel.addEventListener("change", () => {
      this.deviceId = this.deviceSel.value || null;
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
    this.timerSel.className = "cam-sel";
    this.timerSel.title = "Self-timer";
    for (const s of COUNTDOWNS) this.timerSel.append(option(String(s), s === 0 ? "No timer" : `${s}s`));
    this.timerSel.addEventListener("change", () => {
      this.prefs.countdown = Number(this.timerSel.value);
    });

    bar.append(
      this.deviceSel,
      this.sizeSel,
      this.fmtSel,
      this.gridSel,
      this.timerSel,
      this.btn("⇄", "Mirror the preview and the file together  (M)", () => this.toggleMirror()),
      spacer(),
      this.btn("✦ Look", "Filters  (F)", () => this.togglePanel()),
      this.btn("✕", "Close  (Esc)", () => this.close()),
    );

    const foot = document.createElement("footer");
    foot.className = "cam-foot";
    this.shot.className = "cam-thumb";
    this.shot.hidden = true;
    this.shot.alt = "";
    this.shutter = this.btn("", "Take a photo  (Space)", () => void this.shoot());
    this.shutter.className = "cam-shutter";
    this.recBtn = this.btn("", "Record a clip  (R)", () => void this.toggleRecord());
    this.recBtn.className = "cam-rec";
    this.timeOut.className = "cam-time";
    this.timeOut.hidden = true;
    this.status.className = "cam-status";
    foot.append(this.shot, spacer(), this.shutter, this.recBtn, this.timeOut, spacer(), this.status);

    this.panel.className = "cam-panel";
    this.panel.hidden = true;

    this.root.append(bar, stage, this.panel, foot);
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
    this.presets = allPresets(this.host.presets);
    this.sizeSel.value = String(this.prefs.height);
    this.fmtSel.value = this.prefs.format;
    this.gridSel.value = this.prefs.grid;
    this.timerSel.value = String(this.prefs.countdown);
    this.root.hidden = false;
    this.buildPanel();
    this.applyLook();
    this.drawGuides();
    // Plugging a camera in while the app is open should populate the list, and
    // unplugging the one in use should not leave a frozen frame on screen
    // claiming to be live.
    this.unwatch = this.host.source.onChange?.(() => void this.listDevices()) ?? null;
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
    this.stop();
    this.unwatch?.();
    this.unwatch = null;
    this.root.hidden = true;
    this.panel.hidden = true;
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
    try {
      this.stream = await this.host.source.open({
        video: videoConstraints(this.deviceId, this.prefs.height),
        // Sound is asked for up front, not at the moment Record is pressed:
        // the permission prompt belongs at the point someone opened a camera,
        // not in the half-second they were trying to catch something.
        audio: this.prefs.sound,
      });
    } catch (err) {
      this.stream = null;
      this.say(reason(err));
      return;
    }
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      /* autoplay refusals are not fatal — the stream is live either way */
    }
    await this.listDevices();
    this.sayLive();
  }

  private stop(): void {
    this.stopDrawing();
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
  private async listDevices(): Promise<void> {
    try {
      this.devices = (await this.host.source.devices()).filter((d) => d.kind === "videoinput");
    } catch {
      this.devices = [];
    }
    const live = this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
    if (live) this.deviceId = live;
    this.deviceSel.replaceChildren(
      ...this.devices.map((d, i) => option(d.deviceId, d.label || `Camera ${i + 1}`)),
    );
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
    } else if (this.devices.length) {
      this.deviceSel.selectedIndex = 0;
      this.deviceId = this.devices[0]!.deviceId;
    }
    this.deviceSel.disabled = this.devices.length < 2;
  }

  // ── The look ────────────────────────────────────────────────────────────

  private applyLook(): void {
    const filter = filterOf(this.look);
    this.video.style.filter = filter;
    this.video.style.transform = this.prefs.mirror ? "scaleX(-1)" : "";
  }

  private toggleMirror(): void {
    this.prefs.mirror = !this.prefs.mirror;
    this.applyLook();
    this.say(this.prefs.mirror ? "Mirrored — the file matches the screen" : "Not mirrored");
  }

  private togglePanel(): void {
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) this.buildPanel();
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
    const lines = gridLines(this.prefs.grid, w / h);
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
      if (!this.isOpen || !this.stream) return;
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

  /** Draw the live frame into `canvas` at the sensor's own resolution. */
  private paint(): boolean {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) return false;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return false;
    ctx.save();
    if (this.prefs.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    // The same string the preview element carries, which is the whole contract.
    ctx.filter = filterOf(this.look);
    ctx.drawImage(this.video, 0, 0, w, h);
    ctx.restore();
    return true;
  }

  private async capture(): Promise<void> {
    if (!this.stream) {
      this.say("No camera is open");
      return;
    }
    if (!this.paint()) {
      this.say("The camera has not produced a frame yet");
      return;
    }
    const format = this.prefs.format;
    const blob = await new Promise<Blob | null>((resolve) => {
      // Quality is ignored for PNG by every browser, which is correct — it is
      // lossless — so it is passed unconditionally rather than branched on.
      this.canvas.toBlob(resolve, mimeOf(format), this.prefs.quality);
    });
    if (!blob) {
      this.say("The frame could not be encoded");
      return;
    }
    this.blink();
    await this.deliver(blob, extOf(format));
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
    if (!this.paint()) {
      this.say("The camera has not produced a frame yet");
      return;
    }
    const mime = bestVideoMime((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
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
   * Write it, show it, and say where it went.
   *
   * `overwrite: false` always, and the name that comes *back* is the one
   * reported — the shell picks `facet-… (2).jpg` when a second capture lands in
   * the same second, and a camera that told you the wrong name would be a
   * camera that appears to have lost a photo.
   */
  private async deliver(blob: Blob, ext: string): Promise<void> {
    const name = stampName(new Date(), ext);
    const folder = this.host.folder();
    const path = join(folder, name);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      const written = await this.host.writeFile(path, bytes, false);
      this.say(`Saved ${base(written)} — ${(bytes.length / 1e6).toFixed(1)} MB`);
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
    this.say(`${s.width} × ${s.height}${fps}${sound}`);
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
    b.addEventListener("click", run);
    return b;
  }
}

// ── Module helpers ──────────────────────────────────────────────────────────

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

function base(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
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
