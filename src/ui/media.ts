/**
 * Video and audio player.
 *
 * One surface for both, because the transport is the same instrument: the only
 * real difference is whether there are pixels above the scrubber. Splitting them
 * would mean writing loop points, frame-stepping and speed control twice and
 * having them drift.
 *
 * Two decisions worth knowing about:
 *
 * 1. Playback never goes through WebAudio. Routing the element into a
 *    `MediaElementAudioSourceNode` would give a live spectrum, but the media
 *    comes off `asset://`, a different origin from the app, and a tainted
 *    element in the graph plays *silence* — a failure with no exception to
 *    catch. The waveform below is decoded separately from the file's bytes, so
 *    the worst case is a missing drawing rather than a dead player.
 *
 * 2. The waveform is a peak scan, not an FFT. For a seek bar that is what you
 *    actually want: it shows where the takes and the gaps are, which is how you
 *    navigate a two-hour meeting recording. It is also the groundwork the noise
 *    removal and speaker-separation modules will draw their selections on.
 */

import { formatSize, type FileEntry } from "@core/explorer/types";

export interface MediaHost {
  fileUrl(path: string): Promise<string>;
  openExternal(path: string): Promise<void>;
}

/** Chromium clamps `playbackRate` to this range; going outside it throws. */
const MIN_RATE = 0.0625;
const MAX_RATE = 16;

/**
 * Rungs for the speed stepper. Powers of two either side of 1 so the ladder is
 * symmetrical, with the halves people actually use filled in around normal.
 */
const RATES = [0.0625, 0.125, 0.25, 0.35, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16];

/** Above this the decoded PCM is bigger than it is worth holding in the heap. */
const WAVEFORM_MAX_BYTES = 60 * 1024 * 1024;

export class MediaPlayer {
  private readonly root: HTMLElement;
  private readonly video = document.createElement("video");
  private readonly audio = document.createElement("audio");
  private readonly wave = document.createElement("canvas");
  private readonly seek = document.createElement("div");
  private readonly played = document.createElement("i");
  private readonly buffered = document.createElement("i");
  private readonly loopBand = document.createElement("i");
  private readonly cursor = document.createElement("i");
  private readonly title = document.createElement("div");
  private readonly clock = document.createElement("div");
  private readonly rateOut = document.createElement("output");
  private readonly playBtn: HTMLButtonElement;
  private readonly stage = document.createElement("div");

  private entries: FileEntry[] = [];
  private index = 0;
  private el: HTMLMediaElement = this.video;

  /** Peaks in [0..1], two per bucket (min/max folded to a single magnitude). */
  private peaks: Float32Array | null = null;
  private peakToken = 0;

  /** A/B loop, in seconds. Both set means the transport wraps between them. */
  private loopA: number | null = null;
  private loopB: number | null = null;

  private raf = 0;

  constructor(private readonly host: MediaHost) {
    this.root = document.createElement("div");
    this.root.className = "media";
    this.root.hidden = true;

    this.video.className = "media-video";
    this.video.playsInline = true;
    this.audio.className = "media-audio";
    // Both elements exist for the whole session so that switching from a song
    // to a clip does not tear down and rebuild a decoder pipeline mid-folder.
    this.stage.className = "media-stage";
    this.wave.className = "media-wave";
    this.stage.append(this.video, this.audio, this.wave);

    const bar = document.createElement("header");
    bar.className = "media-bar";
    this.title.className = "media-title";
    bar.append(
      this.btn("‹", "Previous  (page up)", () => this.step(-1)),
      this.btn("›", "Next  (page down)", () => this.step(1)),
      this.title,
      this.btn("↗", "Open in the default app", () => void this.openExternal()),
      this.btn("✕", "Close  (Esc)", () => this.close()),
    );

    // ── Scrubber ───────────────────────────────────────────────────────────
    this.seek.className = "media-seek";
    this.buffered.className = "ms-buffered";
    this.played.className = "ms-played";
    this.loopBand.className = "ms-loop";
    this.cursor.className = "ms-cursor";
    this.seek.append(this.buffered, this.loopBand, this.played, this.cursor);
    this.wireSeek();

    // ── Transport ──────────────────────────────────────────────────────────
    this.playBtn = this.btn("▶", "Play / pause  (space)", () => this.toggle());
    this.playBtn.classList.add("media-play");
    this.clock.className = "media-clock";
    this.rateOut.className = "media-rate";

    const transport = document.createElement("div");
    transport.className = "media-transport";
    transport.append(
      this.btn("⏮", "Back 10s  (J)", () => this.nudge(-10)),
      this.playBtn,
      this.btn("⏭", "Forward 10s  (L)", () => this.nudge(10)),
      this.clock,
      this.btn("−", "Slower  (shift+,)", () => this.stepRate(-1)),
      this.rateOut,
      this.btn("+", "Faster  (shift+.)", () => this.stepRate(1)),
      this.btn("1×", "Back to normal speed", () => this.setRate(1)),
      this.pitchToggle(),
      this.volume(),
      this.btn("A", "Set loop start here  (A)", () => this.mark("a")),
      this.btn("B", "Set loop end here  (B)", () => this.mark("b")),
      this.btn("⟲", "Clear the loop", () => this.mark("clear")),
      this.btn("⛶", "Fullscreen  (F)", () => this.fullscreen()),
    );

    const foot = document.createElement("footer");
    foot.className = "media-foot";
    foot.append(this.seek, transport);

    this.root.append(bar, this.stage, foot);
    document.body.appendChild(this.root);

    this.wireMedia(this.video);
    this.wireMedia(this.audio);
    this.wireKeys();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Opens `entry` and keeps its siblings of the *same kind* as the reel. Mixing
   * a podcast into the middle of a video playlist because they share a folder
   * is not what pressing "next" is asking for.
   */
  async open(entries: FileEntry[], entry: FileEntry): Promise<void> {
    const kind = entry.kind;
    this.entries = entries.filter((e) => e.kind === kind);
    this.index = Math.max(0, this.entries.findIndex((e) => e.path === entry.path));
    this.root.hidden = false;
    await this.load();
  }

  close(): void {
    this.el.pause();
    // Dropping the src frees the demuxer; leaving a paused 4K stream attached
    // to a hidden element keeps its buffers alive for the rest of the session.
    this.video.removeAttribute("src");
    this.audio.removeAttribute("src");
    this.video.load();
    this.audio.load();
    this.root.hidden = true;
    this.peaks = null;
    this.loopA = null;
    this.loopB = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** What this surface is showing, for the session record. Null when closed. */
  get openPath(): string | null {
    return this.isOpen ? (this.current()?.path ?? null) : null;
  }

  private current(): FileEntry | null {
    return this.entries[this.index] ?? null;
  }

  private async load(): Promise<void> {
    const entry = this.current();
    if (!entry) return;

    const isVideo = entry.kind === "video";
    const next = isVideo ? this.video : this.audio;
    if (next !== this.el) this.el.pause();
    this.el = next;
    this.root.dataset["mode"] = isVideo ? "video" : "audio";

    this.loopA = null;
    this.loopB = null;
    this.peaks = null;
    this.drawWave();
    this.title.textContent = `${entry.name}   ${formatSize(entry.size)}`;

    try {
      const url = await this.host.fileUrl(entry.path);
      this.el.src = url;
      this.el.playbackRate = clampRate(this.el.playbackRate || 1);
      this.showRate();
      await this.el.play().catch(() => {
        // Autoplay refusal is not an error worth surfacing — the transport is
        // right there and the first click starts it.
      });
      if (!isVideo) void this.buildWaveform(url, entry, ++this.peakToken);
    } catch (e) {
      this.title.textContent = `${entry.name} — cannot play (${String(e)})`;
    }
    this.tick();
  }

  private step(dir: number): void {
    if (this.entries.length === 0) return;
    this.index = (this.index + dir + this.entries.length) % this.entries.length;
    void this.load();
  }

  private async openExternal(): Promise<void> {
    const e = this.current();
    if (e) await this.host.openExternal(e.path);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private toggle(): void {
    if (this.el.paused) void this.el.play().catch(() => undefined);
    else this.el.pause();
  }

  private nudge(seconds: number): void {
    const d = this.el.duration;
    if (!Number.isFinite(d)) return;
    this.el.currentTime = Math.max(0, Math.min(d, this.el.currentTime + seconds));
  }

  /**
   * One video frame, assumed 30 fps.
   *
   * The real frame rate is not exposed to a plain `<video>`; `requestVideoFrame
   * Callback` can measure it but only while playing, and guessing wrong by a few
   * fps still lands within the frame you were aiming for. When the video editor
   * lands with a demuxer it will replace this with the container's actual rate.
   */
  private frameStep(dir: number): void {
    this.el.pause();
    this.nudge(dir / 30);
  }

  private setRate(rate: number): void {
    this.el.playbackRate = clampRate(rate);
    this.showRate();
  }

  private stepRate(dir: number): void {
    const now = this.el.playbackRate;
    const i = RATES.findIndex((r) => r > now + 1e-6);
    const at = dir > 0 ? (i === -1 ? RATES.length - 1 : i) : Math.max(0, (i === -1 ? RATES.length : i) - 2);
    this.setRate(RATES[Math.max(0, Math.min(RATES.length - 1, at))] ?? 1);
  }

  private showRate(): void {
    const r = this.el.playbackRate;
    this.rateOut.textContent = r < 1 ? `1/${(1 / r).toFixed(r >= 0.25 ? 1 : 0)}×` : `${r}×`;
    this.rateOut.title = `${r}× — ${this.el.preservesPitch ? "pitch held" : "pitch follows speed"}`;
  }

  /**
   * Slow motion sounds like slow motion only when the pitch is allowed to fall
   * with it. Browsers default to correcting it, which keeps speech intelligible
   * at 2× but makes a 1/8× pass sound like a stutter rather than a tape.
   */
  private pitchToggle(): HTMLButtonElement {
    const b = this.btn("♪", "Hold pitch when the speed changes", () => {
      const on = !this.el.preservesPitch;
      this.video.preservesPitch = on;
      this.audio.preservesPitch = on;
      b.dataset["on"] = String(on);
      this.showRate();
    });
    this.video.preservesPitch = true;
    this.audio.preservesPitch = true;
    b.dataset["on"] = "true";
    return b;
  }

  private volume(): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "media-vol";
    const mute = this.btn("🔊", "Mute  (M)", () => {
      const m = !this.el.muted;
      this.video.muted = m;
      this.audio.muted = m;
      mute.textContent = m ? "🔇" : "🔊";
    });
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "1";
    range.step = "0.01";
    range.value = "1";
    range.addEventListener("input", () => {
      this.video.volume = Number(range.value);
      this.audio.volume = Number(range.value);
    });
    wrap.append(mute, range);
    return wrap;
  }

  private fullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.root.requestFullscreen().catch(() => undefined);
  }

  // ── A/B loop ──────────────────────────────────────────────────────────────

  private mark(which: "a" | "b" | "clear"): void {
    if (which === "clear") {
      this.loopA = null;
      this.loopB = null;
    } else if (which === "a") {
      this.loopA = this.el.currentTime;
      if (this.loopB !== null && this.loopB <= this.loopA) this.loopB = null;
    } else {
      this.loopB = this.el.currentTime;
      if (this.loopA !== null && this.loopA >= this.loopB) this.loopA = null;
    }
    this.paint();
  }

  // ── Scrubbing ─────────────────────────────────────────────────────────────

  private wireSeek(): void {
    const seekTo = (clientX: number): void => {
      const d = this.el.duration;
      if (!Number.isFinite(d)) return;
      const box = this.seek.getBoundingClientRect();
      const t = ((clientX - box.left) / box.width) * d;
      this.el.currentTime = Math.max(0, Math.min(d, t));
      this.paint();
    };
    this.seek.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.seek.setPointerCapture(e.pointerId);
      seekTo(e.clientX);
      const move = (m: PointerEvent): void => seekTo(m.clientX);
      const up = (): void => {
        this.seek.removeEventListener("pointermove", move);
        this.seek.removeEventListener("pointerup", up);
      };
      this.seek.addEventListener("pointermove", move);
      this.seek.addEventListener("pointerup", up);
    });
  }

  private wireMedia(el: HTMLMediaElement): void {
    el.addEventListener("play", () => {
      this.playBtn.textContent = "❚❚";
      this.tick();
    });
    el.addEventListener("pause", () => { this.playBtn.textContent = "▶"; });
    el.addEventListener("ended", () => {
      // Rolling on to the next file is what a folder of clips implies; a loop
      // that is set is a deliberate instruction and outranks it.
      if (this.loopA === null || this.loopB === null) this.step(1);
    });
    el.addEventListener("loadedmetadata", () => {
      const entry = this.current();
      if (!entry) return;
      const dims =
        el instanceof HTMLVideoElement && el.videoWidth > 0
          ? `   ${el.videoWidth}×${el.videoHeight}`
          : "";
      this.title.textContent =
        `${entry.name}${dims}   ${formatTime(el.duration)}   ${formatSize(entry.size)}`;
      this.paint();
      this.drawWave();
    });
    // A media element reports a failed load by firing `error`, not by rejecting
    // play() — so without this a codec the webview cannot decode, or a file that
    // moved out from under us, would leave a black surface and no explanation.
    el.addEventListener("error", () => {
      const entry = this.current();
      if (!entry) return;
      this.title.textContent = `${entry.name} — ${describeMediaError(el.error)}`;
    });
  }

  /** One rAF loop for the whole transport; nothing polls on a timer. */
  private tick = (): void => {
    cancelAnimationFrame(this.raf);
    this.paint();
    if (!this.root.hidden && !this.el.paused) {
      this.raf = requestAnimationFrame(this.tick);
    }
  };

  private paint(): void {
    const d = this.el.duration;
    const t = this.el.currentTime;

    if (this.loopA !== null && this.loopB !== null && t >= this.loopB) {
      this.el.currentTime = this.loopA;
    }

    const pct = Number.isFinite(d) && d > 0 ? (t / d) * 100 : 0;
    this.played.style.width = `${pct}%`;
    this.cursor.style.left = `${pct}%`;

    if (Number.isFinite(d) && d > 0 && this.el.buffered.length > 0) {
      const end = this.el.buffered.end(this.el.buffered.length - 1);
      this.buffered.style.width = `${(end / d) * 100}%`;
    } else {
      this.buffered.style.width = "0%";
    }

    if (this.loopA !== null && this.loopB !== null && Number.isFinite(d) && d > 0) {
      this.loopBand.hidden = false;
      this.loopBand.style.left = `${(this.loopA / d) * 100}%`;
      this.loopBand.style.width = `${((this.loopB - this.loopA) / d) * 100}%`;
    } else {
      this.loopBand.hidden = true;
    }

    this.clock.textContent = `${formatTime(t)} / ${formatTime(d)}`;
  }

  // ── Waveform ──────────────────────────────────────────────────────────────

  /**
   * Decodes the file once and reduces it to one magnitude per horizontal pixel.
   *
   * `token` guards against the user walking the folder faster than a big FLAC
   * decodes: a scan that finishes after the next track started must not paint
   * the previous track's shape under it.
   */
  private async buildWaveform(url: string, entry: FileEntry, token: number): Promise<void> {
    if ((entry.size ?? 0) > WAVEFORM_MAX_BYTES) return;
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const buf = await ctx.decodeAudioData(bytes);
      if (token !== this.peakToken) return;

      const buckets = 1400;
      const peaks = new Float32Array(buckets);
      const data = buf.getChannelData(0);
      const per = Math.max(1, Math.floor(data.length / buckets));
      for (let i = 0; i < buckets; i++) {
        let max = 0;
        const from = i * per;
        const to = Math.min(data.length, from + per);
        // Stride rather than reading every sample: at 48 kHz a one-hour file is
        // 173 million floats and the extra precision is invisible at this size.
        const stride = Math.max(1, Math.floor((to - from) / 512));
        for (let j = from; j < to; j += stride) {
          const v = Math.abs(data[j] ?? 0);
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      this.peaks = peaks;
      this.drawWave();
    } catch {
      // An unsupported codec means no drawing, not a broken player — playback
      // is the element's job and is unaffected by this having failed.
      this.peaks = null;
    }
  }

  private drawWave(): void {
    const c = this.wave;
    const box = c.getBoundingClientRect();
    if (box.width < 2) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(box.width * dpr);
    c.height = Math.round(box.height * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    const peaks = this.peaks;
    if (!peaks) return;

    const style = getComputedStyle(this.root);
    g.fillStyle = style.getPropertyValue("--fct-accent").trim() || "#7c7cff";
    const mid = c.height / 2;
    const n = peaks.length;
    for (let x = 0; x < c.width; x++) {
      const p = peaks[Math.floor((x / c.width) * n)] ?? 0;
      const h = Math.max(1, p * mid * 0.94);
      g.fillRect(x, mid - h, 1, h * 2);
    }
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  private wireKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (this.root.hidden) return;
      if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
      switch (e.key) {
        case " ": e.preventDefault(); this.toggle(); break;
        case "Escape": e.preventDefault(); this.close(); break;
        case "ArrowLeft": e.preventDefault(); e.shiftKey ? this.frameStep(-1) : this.nudge(-5); break;
        case "ArrowRight": e.preventDefault(); e.shiftKey ? this.frameStep(1) : this.nudge(5); break;
        case "ArrowUp": e.preventDefault(); this.bumpVolume(0.05); break;
        case "ArrowDown": e.preventDefault(); this.bumpVolume(-0.05); break;
        case "PageUp": e.preventDefault(); this.step(-1); break;
        case "PageDown": e.preventDefault(); this.step(1); break;
        case "j": case "J": this.nudge(-10); break;
        case "k": case "K": this.toggle(); break;
        case "l": case "L": this.nudge(10); break;
        case "m": case "M": {
          const m = !this.el.muted;
          this.video.muted = m;
          this.audio.muted = m;
          break;
        }
        case "f": case "F": this.fullscreen(); break;
        case "a": case "A": this.mark("a"); break;
        case "b": case "B": this.mark("b"); break;
        case "<": this.stepRate(-1); break;
        case ">": this.stepRate(1); break;
        default: break;
      }
    });
    window.addEventListener("resize", () => this.drawWave());
  }

  private bumpVolume(d: number): void {
    const v = Math.max(0, Math.min(1, this.el.volume + d));
    this.video.volume = v;
    this.audio.volume = v;
  }

  private btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "media-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clampRate(r: number): number {
  return Math.max(MIN_RATE, Math.min(MAX_RATE, r));
}

/**
 * Turn a MediaError into something worth reading. The distinction that matters
 * to the user is "this file is broken or gone" versus "this webview cannot
 * decode this format" — the second is the common one here, because a desktop
 * codec pack does not help a webview, and it is the case a transcode would fix.
 */
function describeMediaError(err: MediaError | null): string {
  switch (err?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "playback was cancelled";
    case MediaError.MEDIA_ERR_NETWORK:
      return "the file could not be read — it may have moved";
    case MediaError.MEDIA_ERR_DECODE:
      return "the file is damaged, or its codec is not one this app can decode";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "this format is not playable here yet";
    default:
      return "cannot play this file";
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
