/**
 * The recorder (item 29).
 *
 * Screen, system sound and microphone, in any combination, written to disk
 * while the take is being made. The arithmetic and the decisions live in
 * `@core/capture/recorder`; this file is the surface, the streams and the
 * writing.
 *
 * Four things here are not the obvious implementation, and each of them is a
 * place where the obvious one loses somebody's recording.
 *
 * **It shrinks when it starts.** The camera takes the whole window because
 * framing needs the whole window. A screen recorder is in its own shot: a large
 * panel sitting in the middle of the screen is a large panel in the middle of
 * the file. So the setup card collapses to a small strip in the corner the
 * moment recording begins, and the strip says how to get FACET out of the
 * picture entirely — pick a single window in the share dialog rather than the
 * whole screen.
 *
 * **Two sounds become one track before recording, never after.**
 * `MediaRecorder` takes the first audio track it is given and silently drops
 * the rest. A call recorded with the microphone and the speakers both switched
 * on would come back as one half of the conversation, discovered on playback.
 * When both are on they are summed through a `WebAudio` graph first.
 *
 * **`getDisplayMedia` will not give sound on its own.** Asking for
 * `{video: false, audio: true}` fails; the system's sound is only ever offered
 * alongside a screen. So "record what the machine is playing, without the
 * picture" has to ask for video anyway and stop the video track immediately —
 * which is exactly what happens below, rather than the feature not existing.
 *
 * **The take goes to disk every few seconds.** Not at stop. See `append_file`
 * in `fsx.rs`: an hour of screen capture is over a gigabyte, and the version
 * that keeps it in the webview until the end loses all of it to the crash, the
 * OOM or the power cut that any long recording eventually meets.
 */

import {
  bestMime,
  bitrates,
  CHUNK_MS,
  CLIP_AT,
  clock,
  dbfs,
  dbText,
  emptyLedger,
  extOfMime,
  ledgerText,
  meterPosition,
  peak,
  PeakHold,
  plan,
  QUALITIES,
  rms,
  size,
  streamable,
  systemAudioLikely,
  takeName,
  worthKeeping,
  type Ledger,
  type Quality,
  type Sources,
} from "@core/capture/recorder";

/**
 * The device layer, injected — same arrangement as the camera and for the same
 * reason. In the app these are `navigator.mediaDevices`; in the harness they
 * are a canvas and an oscillator, which is how a screen recording gets asserted
 * on a machine that is not sharing its screen.
 */
export interface RecorderSource {
  display(options: DisplayMediaStreamOptions): Promise<MediaStream>;
  user(constraints: MediaStreamConstraints): Promise<MediaStream>;
  devices(): Promise<MediaDeviceInfo[]>;
  /** For summing two sounds into one track. Injected so the harness can watch it. */
  audioContext(): AudioContext;
}

export interface RecorderHost {
  source: RecorderSource;
  /** Where a take lands. Read once when it starts — a take cannot move mid-flight. */
  folder(): string;
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
  /**
   * Extend a file already being written. Absent in the browser build, and its
   * absence is not an error: the recorder falls back to holding the take in
   * memory and *says so on screen*, because "in memory" and "on disk" are
   * different promises about what a crash costs.
   */
  appendFile?(path: string, bytes: Uint8Array): Promise<number>;
  refresh(): void;
  prefs(): RecorderPrefs;
  /** `navigator.platform`, for whether system sound can be honoured here. */
  platform(): string;
}

export interface RecorderPrefs extends Sources {
  quality: Quality;
  countdown: number;
}

const FALLBACK: RecorderPrefs = {
  screen: true,
  system: true,
  mic: true,
  quality: "balanced",
  countdown: 3,
};

/** How often the meter is redrawn. Fast enough to see a peak, cheap enough to ignore. */
const METER_MS = 50;

/**
 * How long to wait for a suspended `AudioContext` to start before recording
 * without it. Short on purpose: someone has pressed Start, and half a second of
 * nothing is already noticeable. A context that has not come up by then is one
 * that is not going to.
 */
const RESUME_MS = 400;

export class RecorderView {
  private readonly root: HTMLElement;
  private readonly card = document.createElement("section");
  private readonly status = document.createElement("div");
  private readonly ledgerOut = document.createElement("div");
  private readonly timeOut = document.createElement("div");
  private readonly meterTrack = document.createElement("div");
  /** The mask over the *unlit* part — see recorder.css; `left` is the reading. */
  private readonly meterFill = document.createElement("div");
  private readonly meterHold = document.createElement("div");
  private readonly meterText = document.createElement("span");
  private readonly count = document.createElement("div");
  private readonly setup = document.createElement("div");
  private readonly live = document.createElement("div");

  private readonly screenBox = document.createElement("input");
  private readonly systemBox = document.createElement("input");
  private readonly micBox = document.createElement("input");
  private readonly micSel = document.createElement("select");
  private readonly qualitySel = document.createElement("select");
  private readonly waitSel = document.createElement("select");
  private readonly startBtn: HTMLButtonElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;

  private prefs: RecorderPrefs = { ...FALLBACK };
  private micId: string | null = null;

  /** Everything opened for the current take, so close() can stop all of it. */
  private streams: MediaStream[] = [];
  private audio: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  /**
   * The analyser's scratch buffer.
   *
   * Written as `Float32Array<ArrayBuffer>` rather than the bare `Float32Array`
   * because the bare form widens to `ArrayBufferLike`, which admits a
   * `SharedArrayBuffer` — and `getFloatTimeDomainData` will not take one.
   */
  private samples: Float32Array<ArrayBuffer> | null = null;
  private readonly hold = new PeakHold();

  private recorder: MediaRecorder | null = null;
  private ledger: Ledger = emptyLedger(true);
  private buffer: Blob[] = [];
  /** Appends have to land in order, so every write goes through one chain. */
  private writes: Promise<void> = Promise.resolve();
  private mime = "";
  private outPath: string | null = null;

  private started = 0;
  private pausedFor = 0;
  private pausedAt = 0;
  private ticker: number | null = null;
  private metering: number | null = null;
  private counting: number | null = null;
  /** Cuts the take into chunks. See the note at `rec.start()` for why we do it. */
  private chunker: number | null = null;
  /**
   * A warning about the sound, decided while opening the devices and carried
   * into the ledger once the take starts. Held on a field because it is settled
   * before the ledger it belongs to has been created.
   */
  private soundNote: string | null = null;

  constructor(private readonly host: RecorderHost) {
    this.root = document.createElement("div");
    this.root.className = "rec";
    this.root.hidden = true;

    this.card.className = "rec-card";

    const head = document.createElement("header");
    head.className = "rec-head";
    const name = document.createElement("h2");
    name.className = "rec-name";
    name.textContent = "Recorder";
    const close = this.btn("✕", "Close  (Esc)", () => this.close());
    close.classList.add("rec-x");
    head.append(name, close);

    // ── The three switches ────────────────────────────────────────────────
    this.setup.className = "rec-setup";
    this.setup.append(
      this.check(this.screenBox, "The screen", "A screen, a window or a tab — you choose which when it starts"),
      this.check(this.systemBox, "What the machine is playing", "The other side of a call, or the video you are narrating"),
      this.check(this.micBox, "The microphone", "Your voice"),
    );
    for (const box of [this.screenBox, this.systemBox, this.micBox]) {
      box.addEventListener("change", () => this.readSwitches());
    }

    this.micSel.className = "rec-sel";
    this.micSel.title = "Which microphone";
    this.micSel.addEventListener("change", () => {
      this.micId = this.micSel.value || null;
    });
    this.qualitySel.className = "rec-sel";
    this.qualitySel.title = "How much detail is kept";
    for (const [id, label, why] of QUALITIES) {
      const o = option(id, label);
      o.title = why;
      this.qualitySel.append(o);
    }
    this.qualitySel.addEventListener("change", () => {
      this.prefs.quality = this.qualitySel.value as Quality;
    });
    this.waitSel.className = "rec-sel";
    this.waitSel.title = "A pause after the share dialog, to get to the right window";
    for (const s of [0, 3, 5, 10]) {
      this.waitSel.append(option(String(s), s === 0 ? "Start at once" : `Wait ${s}s`));
    }
    this.waitSel.addEventListener("change", () => {
      this.prefs.countdown = Number(this.waitSel.value);
    });

    const row = document.createElement("div");
    row.className = "rec-row";
    row.append(this.micSel, this.qualitySel, this.waitSel);
    this.setup.append(row);

    this.startBtn = this.btn("Start recording", "Begin a take  (R)", () => void this.start());
    this.startBtn.classList.add("rec-go");
    this.setup.append(this.startBtn);

    // ── While it is running ───────────────────────────────────────────────
    this.live.className = "rec-live";
    this.live.hidden = true;
    this.timeOut.className = "rec-clock";
    this.timeOut.textContent = clock(0);

    const meter = this.meterTrack;
    meter.className = "rec-meter";
    this.meterFill.className = "rec-meter-fill";
    this.meterHold.className = "rec-meter-hold";
    meter.append(this.meterFill, this.meterHold);
    this.meterText.className = "rec-db";
    this.meterText.textContent = dbText(-Infinity);

    this.pauseBtn = this.btn("Pause", "Pause and resume without splitting the file  (P)", () => this.togglePause());
    this.stopBtn = this.btn("Stop", "Finish and save  (R)", () => this.stop());
    this.stopBtn.classList.add("rec-stop");

    const controls = document.createElement("div");
    controls.className = "rec-controls";
    controls.append(this.pauseBtn, this.stopBtn);

    const meterRow = document.createElement("div");
    meterRow.className = "rec-meter-row";
    meterRow.append(meter, this.meterText);

    this.ledgerOut.className = "rec-ledger";
    this.live.append(this.timeOut, meterRow, this.ledgerOut, controls);

    this.count.className = "rec-count";
    this.count.hidden = true;

    this.status.className = "rec-status";
    this.card.append(head, this.setup, this.live, this.status);
    this.root.append(this.card, this.count);
    document.body.append(this.root);
    this.wireKeys();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get isRecording(): boolean {
    return this.recorder !== null;
  }

  /** For the harness and for anything that needs to know where a take went. */
  get lastPath(): string | null {
    return this.outPath;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    this.prefs = { ...FALLBACK, ...this.host.prefs() };
    this.screenBox.checked = this.prefs.screen;
    this.systemBox.checked = this.prefs.system;
    this.micBox.checked = this.prefs.mic;
    this.qualitySel.value = this.prefs.quality;
    this.waitSel.value = String(this.prefs.countdown);
    this.root.hidden = false;
    this.card.classList.remove("rec-small");
    this.setup.hidden = false;
    this.live.hidden = true;
    this.say("Pick what to record");
    this.readSwitches();
    await this.listMics();
  }

  /**
   * Closing while recording saves the take rather than dropping it.
   *
   * The opposite — discarding on close — treats a stray Escape as a decision to
   * throw away an hour, and there is no undo for a recording that was never
   * written. Stop, save, then close.
   */
  close(): void {
    if (this.recorder) {
      this.say("Finishing the recording before closing");
      this.stop();
      return;
    }
    this.teardown();
    this.root.hidden = true;
  }

  // ── The switches ────────────────────────────────────────────────────────

  private readSwitches(): void {
    this.prefs.screen = this.screenBox.checked;
    this.prefs.system = this.systemBox.checked;
    this.prefs.mic = this.micBox.checked;
    const p = plan(this.prefs);
    this.startBtn.disabled = p.empty;
    this.micSel.disabled = !this.prefs.mic;
    // A switch that is on and does nothing is worse than one that is off with a
    // reason beside it, so the platform check is shown rather than discovered.
    if (this.prefs.system && !systemAudioLikely(this.host.platform())) {
      this.say(`${p.says} — this platform may only share a tab's sound, not the whole machine's`);
      return;
    }
    this.say(p.says);
  }

  /**
   * Fill the microphone list.
   *
   * Labels are empty until the browser has granted microphone access at least
   * once — that is a privacy rule, not a bug — so unlabelled devices get
   * numbered rather than shown as blank rows. Numbering is honest about what is
   * known; a blank row in a picker is not.
   */
  private async listMics(): Promise<void> {
    let devices: MediaDeviceInfo[] = [];
    try {
      devices = (await this.host.source.devices()).filter((d) => d.kind === "audioinput");
    } catch {
      devices = [];
    }
    this.micSel.replaceChildren();
    devices.forEach((d, i) => {
      this.micSel.append(option(d.deviceId, d.label || `Microphone ${i + 1}`));
    });
    if (!devices.length) {
      this.micSel.append(option("", "Default microphone"));
    }
    // Filling a `<select>` does not select anything in it — the same trap the
    // camera's device picker fell into, which draws as an empty box.
    if (this.micId && devices.some((d) => d.deviceId === this.micId)) this.micSel.value = this.micId;
    else {
      this.micSel.selectedIndex = 0;
      this.micId = this.micSel.value || null;
    }
  }

  // ── Starting ────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    if (this.recorder || this.counting !== null) return;
    const p = plan(this.prefs);
    if (p.empty) {
      this.say("Pick at least one thing to record");
      return;
    }

    let display: MediaStream | null = null;
    let user: MediaStream | null = null;
    try {
      if (p.display) {
        /*
         * `video` is always asked for, even when only the sound is wanted.
         * `getDisplayMedia({video: false})` is rejected by every engine — the
         * system's output is only ever offered next to a picture — so the
         * audio-only case takes the picture and drops it two lines below,
         * rather than the feature quietly not existing.
         */
        display = await this.host.source.display({
          video: { frameRate: 30 },
          audio: p.displayAudio,
        });
        if (!p.kind || p.kind === "audio") {
          for (const t of display.getVideoTracks()) {
            display.removeTrack(t);
            t.stop();
          }
        }
        if (p.displayAudio && display.getAudioTracks().length === 0) {
          this.say("The chosen source did not offer its sound — recording without it");
        }
        this.streams.push(display);
      }
      if (p.user) {
        user = await this.host.source.user({
          audio: this.micId ? { deviceId: { exact: this.micId } } : true,
        });
        this.streams.push(user);
      }
    } catch (err) {
      this.teardown();
      this.say(reason(err));
      return;
    }

    if (this.prefs.countdown > 0) {
      const ok = await this.countdown(this.prefs.countdown);
      if (!ok) {
        this.teardown();
        this.say("Cancelled");
        return;
      }
    }

    await this.begin(p.kind === "video", display, user, p.mix);
  }

  /** The on-screen count, resolving false if the take was cancelled during it. */
  private countdown(seconds: number): Promise<boolean> {
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
        this.clearCount();
        resolve(true);
      }, 1000);
      // Cancelling is the same key that starts it, which is what an escape
      // hatch has to be: reachable without finding a button.
      this.cancelCount = () => {
        this.clearCount();
        resolve(false);
      };
    });
  }

  private cancelCount: (() => void) | null = null;

  private clearCount(): void {
    if (this.counting !== null) window.clearInterval(this.counting);
    this.counting = null;
    this.cancelCount = null;
    this.count.hidden = true;
  }

  private async begin(
    wantsVideo: boolean,
    display: MediaStream | null,
    user: MediaStream | null,
    mix: boolean,
  ): Promise<void> {
    const video = wantsVideo ? (display?.getVideoTracks()[0] ?? null) : null;
    if (wantsVideo && !video) {
      this.teardown();
      this.say("The screen share produced no picture");
      return;
    }

    const audio = await this.audioTrack(display, user, mix);
    if (!video && !audio) {
      this.teardown();
      this.say("Nothing came through — no picture and no sound");
      return;
    }

    const kind = video ? "video" : "audio";
    const mime = bestMime(kind, (m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      this.teardown();
      this.say(`This build cannot record ${kind}`);
      return;
    }
    this.mime = mime;

    const settings = video?.getSettings();
    const rates = bitrates(this.prefs.quality, settings?.width ?? 1920, settings?.height ?? 1080);
    const options: MediaRecorderOptions = { mimeType: mime, audioBitsPerSecond: rates.audio };
    if (video) options.videoBitsPerSecond = rates.video;

    const tracks: MediaStreamTrack[] = [];
    if (video) tracks.push(video);
    if (audio) tracks.push(audio);
    const stream = new MediaStream(tracks);

    /*
     * Whether this take streams to disk or is held in memory, decided once and
     * shown on screen for the whole recording. Both conditions are real: the
     * browser build has no `appendFile` at all, and an MP4 written in pieces is
     * a file no player opens, because its index is only written at the end.
     */
    const streaming = typeof this.host.appendFile === "function" && streamable(mime);
    this.ledger = emptyLedger(!streaming);
    // Carried across the reset: the sound warning was decided before this
    // ledger existed, and it describes the take that is about to start.
    this.ledger.note = this.soundNote;
    this.buffer = [];
    this.outPath = null;
    this.writes = Promise.resolve();

    const rec = new MediaRecorder(stream, options);
    this.recorder = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      this.ledger.produced += e.data.size;
      if (this.ledger.buffering) this.buffer.push(e.data);
      else this.enqueue(e.data);
      this.showLedger();
    };
    rec.onstop = () => void this.finish();

    /*
     * `MediaRecorder` can fail after it has started — a device is unplugged, the
     * encoder runs out of memory — and it reports that by firing `error` and
     * going inert. Without this handler the clock keeps counting and the card
     * keeps saying "Recording" over an encoder that stopped producing, which is
     * the same silent-empty-file failure the ledger exists to prevent, arriving
     * by a different road. Stopping keeps whatever was written before it broke.
     */
    rec.onerror = (e) => {
      // Read off the event rather than typed: the lib.dom in this TS release
      // has no `MediaRecorderErrorEvent`, and the engines that fire it do not
      // agree on whether the payload is `error` or a plain `DOMException`.
      const err = (e as Event & { error?: { name?: string; message?: string } }).error;
      this.ledger.trouble = err?.message || err?.name || "the encoder failed";
      this.say(`Recording stopped — ${this.ledger.trouble}`);
      this.stop();
    };

    /*
     * The user can end a screen share from the browser's own bar, and when they
     * do the track simply ends — the recorder carries on writing a stream with
     * nothing in it. Treating the end of the picture as the end of the take is
     * what someone who pressed "Stop sharing" meant.
     */
    if (video) video.addEventListener("ended", () => this.stop(), { once: true });

    /*
     * Started WITHOUT a timeslice, and cut into chunks on our own interval.
     *
     * `rec.start(CHUNK_MS)` is the obvious way to write this and it does not
     * reliably fire. Measured here: a take carrying both a picture and a summed
     * audio track sat at zero `dataavailable` events after 4.6 seconds with a
     * three-second timeslice — encoder in state "recording", every track live and
     * unmuted — and then produced a full chunk the instant `requestData()` was
     * called by hand. Video-only takes on the same engine chunked normally, so
     * the timeslice is not simply broken; it is unreliable in exactly the
     * configuration this feature exists for.
     *
     * Which makes it the same lesson the camera learned about
     * `requestAnimationFrame`: an engine-driven callback is not a clock we
     * control, and the one thing the disk-streaming design cannot tolerate is a
     * cadence that quietly stops. Asking for the data ourselves is one line
     * longer and cannot silently stall — if this interval stops firing, nothing
     * else in the app is running either.
     */
    rec.start();
    this.chunker = window.setInterval(() => {
      if (this.recorder?.state === "recording") this.recorder.requestData();
    }, CHUNK_MS);

    this.started = performance.now();
    this.pausedFor = 0;
    this.pausedAt = 0;
    this.hold.reset();
    this.startTicker();
    this.startMeter();
    this.setup.hidden = true;
    this.live.hidden = false;
    this.card.classList.add("rec-small");
    this.say(
      streaming
        ? "Recording — saving to disk as it goes"
        : this.host.appendFile
          ? "Recording — this format can only be written when you stop"
          : "Recording — held in memory until you stop",
    );
    this.showLedger();
  }

  /**
   * One audio track out of up to two sources.
   *
   * The summing is the point. `MediaRecorder` keeps the first audio track it is
   * handed and drops the rest without a word, so the two-source case has to
   * arrive as one track or half of it is lost — and the half that is lost is
   * whichever the engine happened to order second, which is not something a
   * user could predict or notice until playback.
   *
   * The analyser is tapped off the same graph, so the meter shows what is being
   * recorded rather than one of the two things going into it.
   */
  private async audioTrack(
    display: MediaStream | null,
    user: MediaStream | null,
    mix: boolean,
  ): Promise<MediaStreamTrack | null> {
    this.soundNote = null;
    const fromDisplay = display?.getAudioTracks()[0] ?? null;
    const fromUser = user?.getAudioTracks()[0] ?? null;
    const only = mix ? null : (fromUser ?? fromDisplay);

    let ctx: AudioContext;
    try {
      ctx = this.host.source.audioContext();
    } catch {
      // No WebAudio: a single source can still be recorded straight, and only
      // the mix and the meter are lost. Saying nothing would be wrong; failing
      // the whole take over a meter would be worse.
      if (mix) this.say("Cannot sum two sounds here — recording the microphone only");
      return fromUser ?? fromDisplay;
    }

    /*
     * A new `AudioContext` may arrive suspended — the autoplay policy starts one
     * that way in any document that has not been interacted with, and it stays
     * that way until something resumes it. A suspended graph does not merely run
     * quiet: it produces no samples at all, so the destination track never
     * delivers, `MediaRecorder` sits waiting for audio it will never get, and the
     * whole take comes back as a zero-byte file.
     *
     * That is the worst failure this module has, because there is nothing to see
     * while it happens — the clock runs, the card says "Recording", and the
     * silence is only discovered when the file is opened. Found by a harness that
     * asserted bytes had reached the disk mid-take rather than that the surface
     * looked right.
     */
    if (ctx.state !== "running") {
      /*
       * Raced against a timer, and not for tidiness. `resume()` on a context the
       * autoplay policy will not start does not reject — it returns a promise
       * that simply never settles, waiting for a user gesture that may never
       * come. Awaiting it plainly is worse than the bug it was added to fix: the
       * recorder hangs between "Start" and recording, with the panel still
       * showing setup text and no way to tell that anything is wrong.
       */
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise<void>((r) => setTimeout(r, RESUME_MS)),
      ]);
    }
    if (ctx.state !== "running") {
      /*
       * Better a recording of one source than a silent recording of two — but
       * the warning has to outlive the status line, which `begin()` overwrites
       * with "Recording — …" a moment later. Said only through `say()`, the one
       * thing the user needed to know would show for a few hundred milliseconds
       * and then be gone for the rest of the take. It is parked on a field here
       * because the ledger itself is replaced further down `begin()`.
       */
      this.soundNote = mix
        ? "sound is blocked here — microphone only, no system sound"
        : "sound is blocked here — no level meter";
      this.say(
        mix
          ? "Sound is blocked here — recording the microphone only, without the system sound"
          : "Sound is blocked here — recording without the level meter",
      );
      return fromUser ?? fromDisplay;
    }
    this.audio = ctx;

    const dest = ctx.createMediaStreamDestination();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // Everything that is going to the file also goes to the analyser, so the
    // meter cannot disagree with the recording.
    analyser.connect(dest);
    this.analyser = analyser;
    this.samples = new Float32Array(analyser.fftSize);

    const sources = mix ? [fromDisplay, fromUser] : [only];
    let connected = 0;
    for (const track of sources) {
      if (!track) continue;
      const node = ctx.createMediaStreamSource(new MediaStream([track]));
      node.connect(analyser);
      connected += 1;
    }
    if (connected === 0) return null;
    return dest.stream.getAudioTracks()[0] ?? null;
  }

  // ── Running ─────────────────────────────────────────────────────────────

  private elapsed(): number {
    if (!this.recorder) return 0;
    const paused = this.pausedAt > 0 ? performance.now() - this.pausedAt : 0;
    return (performance.now() - this.started - this.pausedFor - paused) / 1000;
  }

  private startTicker(): void {
    this.timeOut.textContent = clock(0);
    this.ticker = window.setInterval(() => {
      this.timeOut.textContent = clock(this.elapsed());
      this.showLedger();
    }, 250);
  }

  /**
   * The meter runs on a timer, not `requestAnimationFrame`.
   *
   * Same reason as the camera's draw loop: rAF is throttled to about once a
   * second when the window is not being painted, and a screen recorder is
   * *always* behind something while it works. A meter that freezes the moment
   * you switch to the thing you are recording is a meter that is never on
   * screen when it matters.
   */
  private startMeter(): void {
    let last = performance.now();
    this.metering = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const a = this.analyser;
      const buf = this.samples;
      if (!a || !buf) return;
      a.getFloatTimeDomainData(buf);
      const level = rms(buf);
      const top = peak(buf);
      const { hold } = this.hold.push(top, dt);
      this.meterFill.style.left = `${(meterPosition(dbfs(level)) * 100).toFixed(1)}%`;
      this.meterHold.style.left = `${(meterPosition(dbfs(hold)) * 100).toFixed(1)}%`;
      this.meterText.textContent = dbText(dbfs(hold));
      this.meterTrack.classList.toggle("rec-clip", top >= CLIP_AT);
    }, METER_MS);
  }

  private togglePause(): void {
    const rec = this.recorder;
    if (!rec) return;
    if (rec.state === "recording") {
      rec.pause();
      this.pausedAt = performance.now();
      this.pauseBtn.textContent = "Resume";
      this.card.classList.add("rec-paused");
      this.say("Paused — the file continues from here, it is not split");
    } else if (rec.state === "paused") {
      rec.resume();
      this.pausedFor += performance.now() - this.pausedAt;
      this.pausedAt = 0;
      this.pauseBtn.textContent = "Pause";
      this.card.classList.remove("rec-paused");
      this.say("Recording");
    }
  }

  private stop(): void {
    if (this.counting !== null) {
      this.cancelCount?.();
      return;
    }
    const rec = this.recorder;
    if (!rec) return;
    if (rec.state !== "inactive") rec.stop();
  }

  // ── Writing ─────────────────────────────────────────────────────────────

  /**
   * Put one chunk on the write chain.
   *
   * A chain rather than a bare `void write(...)`: chunks arrive every few
   * seconds and each write is an IPC round trip, so two can be in flight at
   * once on a slow disk — and two appends in flight is a file whose clusters
   * are in the wrong order, which is a corrupt recording that looks like a
   * successful one.
   */
  private enqueue(chunk: Blob): void {
    this.writes = this.writes.then(async () => {
      const bytes = new Uint8Array(await chunk.arrayBuffer());
      try {
        if (this.outPath === null) {
          const folder = this.host.folder();
          const wanted = join(folder, takeName(this.mime.startsWith("video") ? "video" : "audio", new Date(), extOfMime(this.mime)));
          // The name that comes *back*: the backend steps to "(2)" when the
          // name is taken, and appending to the name we asked for would append
          // to somebody else's file.
          this.outPath = await this.host.writeFile(wanted, bytes, false);
          this.ledger.path = this.outPath;
        } else {
          await this.host.appendFile!(this.outPath, bytes);
        }
        this.ledger.written += bytes.length;
      } catch (err) {
        /*
         * A failed write does not end the take. The disk filling up or a folder
         * disappearing mid-meeting is exactly when someone least wants the
         * recording to stop, so it falls back to memory and the status line
         * changes from "on disk" to "held in memory" — which is a different
         * promise, and has to read as one.
         */
        this.ledger.trouble = reason(err);
        this.ledger.buffering = true;
        this.buffer.push(chunk);
      }
    });
  }

  private showLedger(): void {
    this.ledgerOut.textContent = ledgerText(this.ledger, this.elapsed());
    this.ledgerOut.classList.toggle("rec-trouble", this.ledger.trouble !== null);
  }

  /** Everything that has to happen once, after the last chunk has fired. */
  private async finish(): Promise<void> {
    const seconds = this.elapsed();
    this.stopClocks();
    this.recorder = null;
    await this.writes;

    if (!worthKeeping(this.ledger.produced)) {
      this.teardown();
      this.backToSetup();
      this.say("The recording produced no data and was not saved");
      return;
    }

    if (this.buffer.length) {
      const blob = new Blob(this.buffer, { type: this.mime });
      this.buffer = [];
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try {
        if (this.outPath === null) {
          const wanted = join(
            this.host.folder(),
            takeName(this.mime.startsWith("video") ? "video" : "audio", new Date(), extOfMime(this.mime)),
          );
          this.outPath = await this.host.writeFile(wanted, bytes, false);
        } else {
          // The tail that piled up after a write failed. Retried once here,
          // because whatever went wrong may have been a moment rather than a
          // state, and the alternative is throwing away the end of the take.
          await this.host.appendFile!(this.outPath, bytes);
        }
        this.ledger.written += bytes.length;
        this.ledger.trouble = null;
      } catch (err) {
        this.teardown();
        this.backToSetup();
        // Named precisely: some of it may be on disk. Saying "not saved" would
        // be as wrong as saying "saved".
        this.say(
          this.outPath
            ? `${size(bytes.length)} of the end could not be written — ${base(this.outPath)} holds what came before. ${reason(err)}`
            : `Could not save the recording: ${reason(err)}`,
        );
        return;
      }
    }

    this.teardown();
    this.backToSetup();
    const where = this.outPath ? base(this.outPath) : "the recording";
    this.say(`Saved ${where} — ${clock(seconds)}, ${size(this.ledger.written)}`);
    this.host.refresh();
  }

  private backToSetup(): void {
    this.setup.hidden = false;
    this.live.hidden = true;
    this.card.classList.remove("rec-small", "rec-paused");
    this.pauseBtn.textContent = "Pause";
  }

  // ── Letting go ──────────────────────────────────────────────────────────

  /**
   * Release every device.
   *
   * Dropping the last reference to a `MediaStream` does not stop it: the screen
   * stays shared and the microphone light stays on until the tab is closed.
   * Both are alarming, and the sharing indicator staying up after someone
   * pressed Stop reads as "it is still recording".
   */
  private teardown(): void {
    this.stopClocks();
    for (const s of this.streams) for (const t of s.getTracks()) t.stop();
    this.streams = [];
    this.analyser = null;
    this.samples = null;
    if (this.audio) void this.audio.close().catch(() => {});
    this.audio = null;
    this.meterFill.style.left = "0%";
    this.meterHold.style.left = "0%";
    this.meterTrack.classList.remove("rec-clip");
    this.meterText.textContent = dbText(-Infinity);
  }

  private stopClocks(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    if (this.metering !== null) window.clearInterval(this.metering);
    if (this.chunker !== null) window.clearInterval(this.chunker);
    this.ticker = null;
    this.metering = null;
    this.chunker = null;
    this.clearCount();
  }

  // ── Words and keys ──────────────────────────────────────────────────────

  private say(message: string): void {
    this.status.textContent = message;
  }

  private wireKeys(): void {
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.isOpen) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.target instanceof HTMLElement && isTyping(e.target)) return;
        switch (e.key) {
          case "Escape":
            this.close();
            break;
          case "r":
          case "R":
            if (this.recorder || this.counting !== null) this.stop();
            else void this.start();
            break;
          case "p":
          case "P":
            this.togglePause();
            break;
          default:
            return;
        }
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  private check(box: HTMLInputElement, label: string, why: string): HTMLElement {
    box.type = "checkbox";
    box.className = "rec-box";
    const l = document.createElement("label");
    l.className = "rec-check";
    l.title = why;
    const text = document.createElement("span");
    text.textContent = label;
    l.append(box, text);
    return l;
  }

  private btn(label: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rec-btn";
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

function isTyping(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && el.type !== "range" && el.type !== "checkbox";
}

function join(folder: string, name: string): string {
  if (!folder) return name;
  return /[\\/]$/.test(folder) ? `${folder}${name}` : `${folder}/${name}`;
}

function base(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * What went wrong, in words that say what to do about it.
 *
 * `NotAllowedError` covers two very different things here and both are common:
 * the share dialog was dismissed, which is not an error at all, and the
 * microphone is blocked in Windows privacy settings, which needs fixing
 * somewhere the app cannot reach. They cannot be told apart from the error, so
 * the message names both rather than guessing.
 */
function reason(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Nothing was shared — either the picker was dismissed, or screen and microphone access is blocked in Windows privacy settings";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone answered. Check it is plugged in and not disabled";
    case "NotReadableError":
      return "The microphone is busy — another program has it open";
    case "AbortError":
      return "The capture stopped before it started";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
