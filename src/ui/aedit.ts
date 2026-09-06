/**
 * Audio editor — item 5.
 *
 * Trim, cut, join, gain, normalise, fades, speed, mono, and an export in
 * whatever format the user names. Opens over the audio player with **E**, the
 * same key the photo and video editors use, because "the thing I am looking at,
 * but editable" should be one gesture and not three.
 *
 * It cuts with the same `SpanList` the video editor does — spans to *keep*,
 * never edits to apply — so undo is the previous list and the timeline is a
 * direct drawing of the model. See `@core/edit/spans` for why that shape was
 * chosen.
 *
 * Two things are specific to audio and worth saying out loud.
 *
 * **The waveform is drawn from a scan done in Rust, not from `decodeAudioData`.**
 * The player decodes the whole file in the browser, which is fine for a song and
 * impossible for a two-hour meeting recording. `peaks` streams 8 kHz mono
 * through a pipe and never holds the file in memory — and it can draw anything
 * ffmpeg opens rather than anything the WebView happens to support.
 *
 * **Level is the one thing you cannot see, so the editor says it in numbers.**
 * Gain is in dB, normalisation is EBU R128 and is labelled as such, and the
 * preview applies the gain to playback so "is that too loud" can be answered
 * before a four-minute encode rather than after one. A boost above 0 dB cannot
 * be previewed — an `<audio>` element's volume does not go past 1 — and the note
 * says so instead of quietly lying about it.
 *
 * Nothing here touches the source file. Export writes a new file beside it.
 */

import { SpanList, type Span } from "@core/edit/spans";
import { formatTime } from "./media";
import { suggestName, type JobDone, type JobProgress, type Media } from "./vedit";

export interface AudioJob {
  inputs: string[];
  output: string;
  spans?: Span[];
  gainDb?: number;
  normalize?: boolean;
  speed?: number;
  fadeIn?: number;
  fadeOut?: number;
  mono?: boolean;
  bitrate?: number;
  sampleRate?: number | null;
  /** One of `DENOISE`'s keys. Empty means leave the noise alone. */
  denoise?: string;
}

export interface AudioEditHost {
  fileUrl(path: string): Promise<string>;
  probe(path: string): Promise<Media>;
  peaks(path: string, buckets: number): Promise<number[]>;
  runAudioJob(job: AudioJob): Promise<number>;
  cancelJob(id: number): Promise<void>;
  onProgress(cb: (p: JobProgress) => void): () => void;
  onDone(cb: (d: JobDone) => void): () => void;
  refresh(): void;
}

/** Coarse enough to be one draw, fine enough that a word is visible in it. */
const BUCKETS = 1400;

/** Anything past 4× and `atempo` stops sounding like a person. */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const FORMATS: [string, string][] = [
  ["mp3", "MP3"],
  ["m4a", "M4A (AAC)"],
  ["opus", "Opus"],
  ["flac", "FLAC (lossless)"],
  ["wav", "WAV (uncompressed)"],
];

const BITRATES = [96, 128, 160, 192, 256, 320];

/**
 * The noise ladder (item 18), named for the recording you have rather than for
 * a filter setting. "Room tone" means something to somebody holding a file;
 * `afftdn=nr=12:nf=-40` does not.
 *
 * Each rung's number is measured, not asserted: on a fixture of speech over a
 * −35 dBFS floor, the ffmpeg side takes the floor down by roughly 5, 18, 24 and
 * 56 dB in this order, and the speech itself loses under 1 dB in every case.
 * The tests that produced those figures are in `ffmpeg.rs`.
 */
const DENOISE: [string, string][] = [
  ["", "Off"],
  ["room", "Room tone"],
  ["traffic", "Traffic"],
  ["voice", "Voice"],
  ["strong", "Strong"],
];

/** What each rung is actually for, shown under the picker as you change it. */
const DENOISE_NOTE: Record<string, string> = {
  "": "",
  room: "Hiss and hum under a clean recording. Gentle — nothing else changes.",
  traffic: "Rumble, engines, wind. Cuts everything below 110 Hz as well.",
  voice: "Tuned for speech: the floor drops hard and the voice stays.",
  strong:
    "For a bad recording. Takes the noise down about 56 dB — and if the talker " +
    "is as quiet as the noise, takes a lot of the talker with it. Listen first.",
};

/** Formats with no bitrate to set — the control is meaningless for them. */
const CONSTANT_QUALITY = new Set(["wav", "flac"]);

export class AudioEditor {
  private readonly root = document.createElement("div");
  private readonly audio = document.createElement("audio");
  private readonly wave = document.createElement("canvas");
  private readonly stage = document.createElement("div");
  private readonly playhead = document.createElement("i");
  private readonly clock = document.createElement("div");
  private readonly note = document.createElement("div");
  private readonly titleEl = document.createElement("div");
  private readonly bar = document.createElement("div");
  private readonly barFill = document.createElement("i");
  private readonly gainOut = document.createElement("output");
  private readonly speedOut = document.createElement("output");
  private readonly nameIn = document.createElement("input");
  private readonly fmtSel = document.createElement("select");
  private readonly rateSel = document.createElement("select");
  private readonly noiseSel = document.createElement("select");
  private readonly noiseNote = document.createElement("span");
  private readonly exportBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;

  private path = "";
  private media: Media | null = null;
  private readonly model = new SpanList();
  private shape: number[] | null = null;
  private scanToken = 0;

  private gainDb = 0;
  private normalize = false;
  private speed = 1;
  private fade = false;
  private mono = false;
  private bitrate = 192;
  private denoise = "";

  private job: number | null = null;

  constructor(private readonly host: AudioEditHost) {
    this.root.className = "aedit";
    this.root.hidden = true;

    const head = document.createElement("header");
    head.className = "aedit-bar";
    this.titleEl.className = "aedit-title";
    this.note.className = "aedit-note";
    head.append(this.titleEl, this.note, this.btn("✕", "Close  (Esc)", () => this.close()));

    this.stage.className = "aedit-stage";
    this.wave.className = "aedit-wave";
    this.playhead.className = "aedit-head";
    this.stage.append(this.wave, this.playhead);
    this.wireSeek();

    const time = document.createElement("div");
    time.className = "aedit-time";
    this.clock.className = "aedit-clock";
    time.append(this.clock);

    const cuts = this.group("Cut", [
      this.btn("▶", "Play / pause  (space)", () => this.toggle()),
      this.btn("[", "Start here  (I)", () => this.mark("in")),
      this.btn("]", "End here  (O)", () => this.mark("out")),
      this.btn("✂", "Split here  (S)", () => this.split()),
      this.btn("⌫", "Remove this piece  (Del)", () => this.drop()),
      this.btn("⟲", "Undo  (ctrl+Z)", () => this.undo()),
      this.btn("⟳", "Redo  (ctrl+shift+Z)", () => this.redo()),
      this.btn("⤢", "Keep all of it again", () => this.resetSpans()),
    ]);

    this.gainOut.className = "aedit-read";
    this.speedOut.className = "aedit-read";
    const level = this.group("Level", [
      this.btn("−", "Quieter by 1 dB", () => this.stepGain(-1)),
      this.gainOut,
      this.btn("+", "Louder by 1 dB", () => this.stepGain(1)),
      this.check("Normalise", "Match broadcast loudness (EBU R128, −16 LUFS)", (v) => {
        this.normalize = v;
        this.paint();
      }),
    ]);

    // Item 18. Its own group rather than a line in Level, because it is the one
    // control here that changes what the recording *is* rather than how loud or
    // how fast it is — and because the note under it needs the room.
    this.noiseNote.className = "aedit-hint";
    const noise = this.group("Noise", [
      this.pick(this.noiseSel, "Remove noise", DENOISE, "", (v) => {
        this.denoise = v;
        this.paint();
      }),
      this.noiseNote,
    ]);

    const time2 = this.group("Time", [
      this.btn("−", "Slower", () => this.stepSpeed(-1)),
      this.speedOut,
      this.btn("+", "Faster", () => this.stepSpeed(1)),
      this.check("Fade", "One second in and out", (v) => {
        this.fade = v;
        this.paint();
      }),
    ]);

    const outp = this.group("Output", [
      this.check("Mono", "Fold both channels into one — halves the size of speech", (v) => {
        this.mono = v;
        this.paint();
      }),
      this.pick(this.fmtSel, "Format", FORMATS, "mp3", (v) => this.setFormat(v)),
      this.pick(
        this.rateSel,
        "Bitrate",
        BITRATES.map((b) => [String(b), `${b} kbps`] as [string, string]),
        "192",
        (v) => {
          this.bitrate = Number(v);
        },
      ),
    ]);

    this.nameIn.className = "aedit-name";
    this.nameIn.spellcheck = false;
    this.bar.className = "aedit-progress";
    this.barFill.className = "aedit-progress-fill";
    this.bar.append(this.barFill);
    this.bar.hidden = true;
    this.exportBtn = this.btn("Export a copy", "Writes a new file — the original is never touched", () =>
      void this.run(),
    );
    this.exportBtn.classList.add("aedit-go");
    this.cancelBtn = this.btn("Stop", "Cancel the export", () => void this.stop());
    this.cancelBtn.hidden = true;

    const foot = document.createElement("footer");
    foot.className = "aedit-foot";
    foot.append(this.nameIn, this.bar, this.cancelBtn, this.exportBtn);

    const rows = document.createElement("div");
    rows.className = "aedit-controls";
    rows.append(cuts, level, noise, time2, outp);

    // Kept inside the panel and hidden with it: an element parked on `document`
    // outlives the editor, and a detached one is a stray sound source with no
    // owner. Hidden rather than absent because it still has to play.
    this.audio.hidden = true;
    this.audio.preload = "auto";
    this.root.append(head, this.stage, time, rows, foot, this.audio);
    document.body.appendChild(this.root);

    this.audio.addEventListener("timeupdate", () => this.tick());
    this.audio.addEventListener("loadedmetadata", () => this.tick());
    window.addEventListener("resize", () => {
      if (this.isOpen) this.draw();
    });
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
            ? `Saved without re-encoding — ${d.output.split("/").pop() ?? ""} keeps the original bytes`
            : `Saved ${d.output.split("/").pop() ?? ""}`,
        );
        this.host.refresh();
      } else {
        this.say(
          d.leftover ? `${d.error}  ·  the partial file is at ${d.leftover}` : d.error || "Export failed",
          true,
        );
      }
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get openPath(): string | null {
    return this.root.hidden ? null : this.path;
  }

  async open(path: string): Promise<void> {
    this.path = path;
    this.root.hidden = false;
    this.resetAll();
    const name = path.split("/").pop() ?? path;
    this.titleEl.textContent = name;
    this.nameIn.value = suggestName(name);
    this.setFormat(this.extOf(this.nameIn.value) || "mp3", true);
    this.say("Reading the file…");

    try {
      this.media = await this.host.probe(path);
    } catch (e) {
      this.say(`Cannot read this file — ${String(e)}`, true);
      return;
    }
    this.model.load(this.media.duration);
    this.audio.src = await this.host.fileUrl(path);
    const a = this.media.tracks.find((t) => t.kind === "audio");
    this.say(
      `${formatTime(this.media.duration)}  ·  ${a?.codec ?? "?"}` +
        `${a?.sampleRate ? `  ·  ${(a.sampleRate / 1000).toFixed(1)} kHz` : ""}` +
        `${a?.channels === 1 ? "  ·  mono" : a?.channels ? `  ·  ${a.channels} ch` : ""}`,
    );
    this.paint();
    void this.scan();
  }

  close(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.root.hidden = true;
    // A running export is deliberately not cancelled — see the video editor.
  }

  private resetAll(): void {
    this.model.load(0);
    this.shape = null;
    this.gainDb = 0;
    this.normalize = false;
    this.speed = 1;
    this.fade = false;
    this.mono = false;
    this.denoise = "";
    this.noiseSel.value = "";
  }

  // ── The span model ────────────────────────────────────────────────────────

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
    if (this.model.mark(this.audio.currentTime, which)) this.paint();
  }

  private split(): void {
    if (this.model.split(this.audio.currentTime)) this.paint();
  }

  private drop(): void {
    if (this.model.drop(this.audio.currentTime)) this.paint();
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private toggle(): void {
    if (this.audio.paused) void this.audio.play();
    else this.audio.pause();
  }

  /** Preview skips the parts you cut — the whole point of cutting on a line. */
  private tick(): void {
    const t = this.audio.currentTime;
    if (this.model.count > 0 && this.model.indexAt(t) < 0) {
      const nxt = this.model.nextAfter(t);
      if (nxt) this.audio.currentTime = nxt.start;
      else this.audio.pause();
    }
    const total = this.media?.duration ?? this.audio.duration ?? 0;
    this.playhead.style.left = `${total > 0 ? (t / total) * 100 : 0}%`;
    this.clock.textContent =
      `${formatTime(t)} / ${formatTime(total)}   →   ${formatTime(this.outSeconds())} out`;
  }

  private outSeconds(): number {
    return this.speed > 0 ? this.model.kept / this.speed : this.model.kept;
  }

  private stepGain(dir: number): void {
    this.gainDb = Math.max(-24, Math.min(24, this.gainDb + dir));
    this.paint();
  }

  private stepSpeed(dir: number): void {
    const i = SPEEDS.indexOf(this.speed);
    const n = Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir));
    this.speed = SPEEDS[n] ?? 1;
    // Playback follows, so the speed control is auditioned rather than guessed.
    this.audio.playbackRate = Math.max(0.25, Math.min(4, this.speed));
    this.paint();
  }

  private setFormat(ext: string, quiet = false): void {
    this.fmtSel.value = ext;
    const name = this.nameIn.value.trim();
    const dot = name.lastIndexOf(".");
    this.nameIn.value = `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
    // A bitrate box next to "WAV" is a control that does nothing, and a control
    // that does nothing is worse than one that is missing.
    this.rateSel.disabled = CONSTANT_QUALITY.has(ext);
    if (!quiet) this.paint();
  }

  private extOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  private paint(): void {
    this.gainOut.textContent = `${this.gainDb > 0 ? "+" : ""}${this.gainDb} dB`;
    this.speedOut.textContent = this.speed === 1 ? "1×" : `${this.speed}×`;
    // The warning about `strong` is on the control, not in a dialog nobody
    // reads: the cost only bites when the talker is as quiet as the noise, and
    // that is a thing about *this* recording that the person holding it knows.
    const noiseNote = DENOISE_NOTE[this.denoise] ?? "";
    this.noiseNote.textContent = noiseNote;
    // The visible note is clamped to two lines; the tooltip is not, so nothing
    // it says can be lost to a narrow window.
    this.noiseSel.title = noiseNote === "" ? "Remove noise" : noiseNote;
    this.exportBtn.textContent = this.losslessLikely() ? "Export (no re-encode)" : "Export a copy";

    // Preview the gain. An element's volume cannot exceed 1, so a boost is
    // audibly a no-op here — said out loud rather than left to be discovered
    // when the export comes back louder than the preview was.
    const linear = Math.pow(10, this.gainDb / 20);
    this.audio.volume = Math.max(0, Math.min(1, linear));
    // Not while an export is running — that line is carrying the progress.
    if (this.gainDb > 0 && this.job === null) {
      this.say("Preview cannot play louder than the original — the export will be.");
    }

    this.draw();
    this.tick();
  }

  /** Mirrors `AudioJob::copyable` in Rust so the button can promise what it does. */
  private losslessLikely(): boolean {
    return (
      this.model.count <= 1 &&
      this.gainDb === 0 &&
      !this.normalize &&
      this.speed === 1 &&
      !this.fade &&
      !this.mono &&
      this.denoise === "" &&
      this.extOf(this.nameIn.value) === this.extOf(this.path)
    );
  }

  /**
   * The waveform, with the cut parts greyed rather than removed.
   *
   * Removed audio is still drawn, dimmed: a timeline that deletes what it cut
   * gives you nothing to aim at when you want it back, and "put that bit back"
   * is the second most common thing anyone does in an audio editor.
   */
  private draw(): void {
    const box = this.stage.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    this.wave.width = Math.round(box.width * dpr);
    this.wave.height = Math.round(box.height * dpr);
    const g = this.wave.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, this.wave.width, this.wave.height);

    const style = getComputedStyle(this.root);
    const accent = style.getPropertyValue("--fct-accent").trim() || "#7c7cff";
    const dim = style.getPropertyValue("--fct-text-muted").trim() || "#666";
    const shape = this.shape;
    if (!shape || shape.length === 0) return;

    const total = this.media?.duration ?? 0;
    const mid = this.wave.height / 2;

    // Drawn only once there is a shape, which makes it load-bearing rather than
    // decorative: a silent recording still shows a line, so "nothing there" and
    // "the scan failed" stop looking identical.
    g.fillStyle = dim;
    g.globalAlpha = 0.35;
    g.fillRect(0, Math.round(mid), this.wave.width, 1);

    for (let x = 0; x < this.wave.width; x++) {
      const frac = x / this.wave.width;
      const p = shape[Math.min(shape.length - 1, Math.floor(frac * shape.length))] ?? 0;
      const kept = total > 0 ? this.model.indexAt(frac * total) >= 0 : true;
      g.fillStyle = kept ? accent : dim;
      g.globalAlpha = kept ? 1 : 0.28;
      const h = Math.max(1, p * mid * 0.94);
      g.fillRect(x, mid - h, 1, h * 2);
    }
    g.globalAlpha = 1;
  }

  /**
   * Ask Rust for the shape of the file.
   *
   * Tokened, because walking a folder of recordings with the editor open must
   * not paint the last file's waveform under this one's.
   */
  private async scan(): Promise<void> {
    const token = ++this.scanToken;
    try {
      const p = await this.host.peaks(this.path, BUCKETS);
      if (token !== this.scanToken) return;
      this.shape = p;
      this.draw();
    } catch {
      // No shape is a cosmetic loss; every cut still works against the clock.
      this.shape = null;
    }
  }

  private wireSeek(): void {
    const seek = (e: PointerEvent) => {
      const total = this.media?.duration ?? 0;
      if (total <= 0) return;
      const r = this.stage.getBoundingClientRect();
      this.audio.currentTime = Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total));
      this.tick();
    };
    this.stage.addEventListener("pointerdown", (e) => {
      // Seek first, capture second: capturing a pointer id that is not actually
      // down throws, and a synthetic event losing its seek to that is a harness
      // that tests nothing.
      seek(e);
      try {
        this.stage.setPointerCapture(e.pointerId);
      } catch {
        // Nothing to capture — the drag simply ends at the element boundary.
      }
    });
    this.stage.addEventListener("pointermove", (e) => {
      if (e.buttons & 1) seek(e);
    });
  }

  // ── Export ────────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    if (!this.media || this.job !== null) return;
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    const name = this.nameIn.value.trim() || suggestName(this.path.split("/").pop() ?? "out.mp3");
    const job: AudioJob = {
      inputs: [this.path],
      output: `${dir}/${name}`,
      spans: this.model.list.map((s) => ({ ...s })),
      gainDb: this.gainDb,
      normalize: this.normalize,
      speed: this.speed,
      fadeIn: this.fade ? 1 : 0,
      fadeOut: this.fade ? 1 : 0,
      mono: this.mono,
      bitrate: this.bitrate,
      denoise: this.denoise,
    };
    this.exportBtn.disabled = true;
    this.cancelBtn.hidden = false;
    this.say("Starting…");
    try {
      this.job = await this.host.runAudioJob(job);
    } catch (e) {
      this.exportBtn.disabled = false;
      this.cancelBtn.hidden = true;
      this.say(String(e), true);
    }
  }

  private async stop(): Promise<void> {
    if (this.job === null) return;
    try {
      await this.host.cancelJob(this.job);
    } catch {
      // A job that has already finished cannot be cancelled, and saying so
      // would be answering a question nobody asked.
    }
  }

  private say(msg: string, bad = false): void {
    this.note.textContent = msg;
    this.note.classList.toggle("bad", bad);
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private btn(label: string, title: string, on: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "aedit-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", on);
    return b;
  }

  private group(label: string, items: HTMLElement[]): HTMLElement {
    const d = document.createElement("div");
    d.className = "aedit-group";
    const l = document.createElement("span");
    l.className = "aedit-group-label";
    l.textContent = label;
    d.append(l, ...items);
    return d;
  }

  private check(label: string, title: string, on: (v: boolean) => void): HTMLElement {
    const l = document.createElement("label");
    l.className = "aedit-check";
    l.title = title;
    const i = document.createElement("input");
    i.type = "checkbox";
    i.addEventListener("change", () => on(i.checked));
    l.append(i, document.createTextNode(label));
    return l;
  }

  private pick(
    sel: HTMLSelectElement,
    label: string,
    options: [string, string][],
    initial: string,
    on: (v: string) => void,
  ): HTMLElement {
    const l = document.createElement("label");
    l.className = "aedit-check";
    l.title = label;
    for (const [v, t] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      if (v === initial) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => on(sel.value));
    l.append(document.createTextNode(label), sel);
    return l;
  }

  private wireKeys(): void {
    // Capture, so the editor takes these keys before the player underneath.
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.root.hidden) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
          if (e.key === "Escape") (e.target as HTMLElement).blur();
          return;
        }
        const keys: Record<string, () => void> = {
          " ": () => this.toggle(),
          i: () => this.mark("in"),
          o: () => this.mark("out"),
          s: () => this.split(),
          Delete: () => this.drop(),
          Backspace: () => this.drop(),
          Escape: () => this.close(),
        };
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) this.redo();
          else this.undo();
          return;
        }
        const fn = keys[e.key];
        if (!fn || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        fn();
      },
      true,
    );
  }
}
