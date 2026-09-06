/**
 * The recorder, minus the microphone (item 29).
 *
 * Same split as `camera.ts`: what is in here is arithmetic, strings and
 * decisions — which sources to ask for, whether two audio tracks have to be
 * mixed, what the file is called, how loud the meter should read, when a chunk
 * goes to disk. Nothing touches `navigator` or `document`, so the whole of it
 * can be checked on a machine with nothing plugged in.
 *
 * Three things here are load-bearing and none of them are obvious.
 *
 * **`MediaRecorder` records one audio track.** Not "prefers one" — hand it a
 * stream with the microphone *and* the system's output in it and it silently
 * takes the first and drops the other. The recording someone made of a call,
 * with themselves on the mic and the other person coming out of the speakers,
 * comes back as half a conversation, and they find out afterwards. So whenever
 * both are wanted, `plan()` says the two have to be summed into one track
 * first, and the surface obeys it.
 *
 * **A take goes to disk while it is being made**, not at stop. That is a
 * property of the container rather than a preference: WebM is a header followed
 * by clusters with nothing to patch at the end, so the chunks concatenated in
 * order *are* the file, and a recording cut short is a shorter recording rather
 * than a corrupt one. MP4 keeps its index at the end and does not have that
 * property, which is why `bestMime` orders WebM first and why choosing MP4 is
 * allowed to change how the file is written rather than being a silent
 * downgrade.
 *
 * **A level meter that reads the last sample is unreadable.** Peaks are held
 * and decay; the number under it is dBFS, not a percentage, because "-6" means
 * something to anyone who has recorded anything and "72%" does not.
 */

// ── What is being recorded ──────────────────────────────────────────────────

/**
 * The three switches, independently.
 *
 * Deliberately not an enum of the sensible combinations. "Just video, video and
 * audio, or just audio" was the ask, and the honest way to offer that is three
 * checkboxes plus a function that says what the combination means — an enum
 * would have to guess which pairings are worth naming, and the one somebody
 * wants is always the one that got left out.
 */
export interface Sources {
  /** The screen, a window, or a tab — whichever the OS picker lands on. */
  screen: boolean;
  /** What the machine is playing. Windows offers it, and it is per-source. */
  system: boolean;
  /** The microphone. */
  mic: boolean;
}

export const NOTHING: Sources = { screen: false, system: false, mic: false };

export type Take = "video" | "audio";

/** What the surface has to do to honour a set of switches. */
export interface Plan {
  /** Nothing is selected — the record button has to be off, not merely fail. */
  empty: boolean;
  /** A file with pictures in it, or a file with only sound. */
  kind: Take;
  /** `getDisplayMedia` is needed (for the picture, the system sound, or both). */
  display: boolean;
  /** Ask the display capture for its audio too. */
  displayAudio: boolean;
  /** `getUserMedia` is needed for the microphone. */
  user: boolean;
  /**
   * Two audio sources are in play and have to be summed before recording.
   * See the header: handing `MediaRecorder` two audio tracks loses one.
   */
  mix: boolean;
  /** One line for the status bar, in words rather than field names. */
  says: string;
}

export function plan(s: Sources): Plan {
  const empty = !s.screen && !s.system && !s.mic;
  const mix = s.system && s.mic;
  return {
    empty,
    kind: s.screen ? "video" : "audio",
    display: s.screen || s.system,
    displayAudio: s.system,
    user: s.mic,
    mix,
    says: describe(s),
  };
}

function describe(s: Sources): string {
  if (!s.screen && !s.system && !s.mic) return "Nothing selected — pick a source";
  const audio = s.system && s.mic ? "system sound and the microphone" : s.system ? "system sound" : s.mic ? "the microphone" : "";
  if (!s.screen) return `Recording ${audio}`;
  return audio ? `Recording the screen with ${audio}` : "Recording the screen, silently";
}

/**
 * Whether the system-sound switch can be honoured on this platform.
 *
 * Chromium on Windows can capture the audio of a chosen screen or tab; on
 * macOS it can only do a tab's. Rather than fail at the picker, the surface
 * asks first and says so, because a checkbox that is on and does nothing is
 * worse than one that is off with a reason next to it.
 */
export function systemAudioLikely(platform: string): boolean {
  const p = platform.toLowerCase();
  return p.includes("win") || p.includes("linux") || p.includes("cros");
}

// ── The container ───────────────────────────────────────────────────────────

/**
 * Ordered by what can be written straight to disk while recording, then by what
 * survives being handed to ffmpeg — which is what the rest of FACET does to
 * anything this produces.
 */
export const VIDEO_MIMES: readonly string[] = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export const AUDIO_MIMES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function bestMime(kind: Take, supported: (mime: string) => boolean): string | null {
  const list = kind === "video" ? VIDEO_MIMES : AUDIO_MIMES;
  return list.find((m) => supported(m)) ?? null;
}

export function extOfMime(mime: string): string {
  if (mime.startsWith("video/mp4")) return "mp4";
  if (mime.startsWith("audio/mp4")) return "m4a";
  if (mime.startsWith("audio/ogg")) return "ogg";
  if (mime.startsWith("audio/")) return "weba";
  return "webm";
}

/**
 * Whether chunks of this container can be appended to a file as they arrive.
 *
 * True for WebM and Ogg, which are a header followed by self-contained pages or
 * clusters. False for MP4, whose index is written at stop — append its chunks
 * and the result is a file no player will open, which is a far worse outcome
 * than holding it in memory. The recorder reads this and changes *how it
 * writes*, so picking MP4 costs memory and crash-safety and nothing else.
 */
export function streamable(mime: string): boolean {
  return mime.includes("webm") || mime.includes("ogg");
}

// ── Quality ─────────────────────────────────────────────────────────────────

export type Quality = "high" | "balanced" | "small";

export const QUALITIES: ReadonlyArray<readonly [Quality, string, string]> = [
  ["high", "High", "For screen text that has to stay readable. Big files."],
  ["balanced", "Balanced", "What a meeting should be recorded at."],
  ["small", "Small", "Long recordings you mostly need the words out of."],
];

/**
 * Bits per second for video and audio.
 *
 * Video scales with the pixels, because a fixed bitrate is either wasteful on a
 * 720p window or mush on a 4K screen, and a screen recording is judged entirely
 * on whether the text in it can be read. Audio does not scale with anything:
 * Opus is transparent enough for speech well below where the file size starts
 * to matter, and a meeting recorded at 320 kbps is a bigger file that says the
 * same words.
 */
export function bitrates(q: Quality, width: number, height: number): { video: number; audio: number } {
  const pixels = Math.max(1, width * height);
  const perPixel = q === "high" ? 0.18 : q === "balanced" ? 0.1 : 0.05;
  // 30 fps assumed: the frame rate is requested, not guaranteed, and sizing the
  // budget to a rate the driver may not give would under-run every capture on a
  // machine that lands on 24.
  const video = Math.round(Math.min(24_000_000, Math.max(400_000, pixels * 30 * perPixel)));
  const audio = q === "high" ? 192_000 : q === "balanced" ? 128_000 : 64_000;
  return { video, audio };
}

// ── The file ────────────────────────────────────────────────────────────────

/**
 * `Screen 2026-08-16 21-04-33.webm`, `Audio 2026-08-16 21-04-33.weba`.
 *
 * Words rather than a slug, because these land in the same folder as everything
 * else and "Screen" is what someone scanning a folder is looking for. Still
 * sorts chronologically within a kind, which is the property that matters when
 * there are nine of them from one afternoon.
 */
export function takeName(kind: Take, when: Date, ext: string): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ` +
    `${p(when.getHours())}-${p(when.getMinutes())}-${p(when.getSeconds())}`;
  return `${kind === "video" ? "Screen" : "Audio"} ${stamp}.${ext}`;
}

/** `1:04`, `1:02:05`. Same shape as the camera's, and the same reason. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n: number): string => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

/** `4.2 MB`. Rounded to something a person can read at a glance while it grows. */
export function size(bytes: number): string {
  const b = Math.max(0, bytes);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * How long a recording can run before the disk is the problem.
 *
 * Shown next to the size, not enforced. A recorder that stops itself at an hour
 * because of a guess about free space is a recorder that ate someone's meeting;
 * a recorder that says "about 40 minutes at this rate" lets them decide.
 */
export function runway(freeBytes: number, bytesPerSecond: number): number {
  if (!(bytesPerSecond > 0) || !(freeBytes > 0)) return Infinity;
  return freeBytes / bytesPerSecond;
}

// ── The meter ───────────────────────────────────────────────────────────────

/** Root mean square of a block of samples — loudness, not the last sample. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** The largest excursion in a block, which is what clipping is judged on. */
export function peak(samples: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]!);
    if (v > m) m = v;
  }
  return m;
}

/** Amplitude to dBFS. Silence is `-Infinity` and is the caller's to render. */
export function dbfs(amplitude: number): number {
  if (amplitude <= 0) return -Infinity;
  return 20 * Math.log10(Math.min(1, amplitude));
}

/** dBFS as text, with a floor — nobody needs to read "-83.4". */
export function dbText(db: number): string {
  if (!Number.isFinite(db) || db <= METER_FLOOR) return "−∞";
  return `${db >= 0 ? "" : "−"}${Math.abs(db).toFixed(1)} dB`;
}

/** Where the meter bottoms out. Below this, a speech mic is off or muted. */
export const METER_FLOOR = -60;

/**
 * dBFS to a 0–1 bar position.
 *
 * Not linear in amplitude and not linear in dB either. A linear-amplitude meter
 * spends nine tenths of its travel in the top 20 dB and shows speech as a
 * twitch near zero; a linear-dB one gives as much room to −60..−40, where
 * nothing is happening, as to −20..0, where the decision about whether you are
 * clipping is made. This bends toward the top, so normal speech sits around
 * two thirds of the way along and the last stretch is the part worth watching.
 */
export function meterPosition(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const t = (Math.max(METER_FLOOR, Math.min(0, db)) - METER_FLOOR) / -METER_FLOOR;
  return Math.pow(t, 0.6);
}

/**
 * A held peak that falls back.
 *
 * The instantaneous value is unreadable — it is at 30 or 60 Hz and the eye
 * integrates it into a blur that never quite touches the top. Holding the peak
 * and decaying it at a fixed rate is what every meter in every recorder does,
 * and it is the difference between "was that clipping?" and knowing.
 */
export class PeakHold {
  private value = 0;
  private held = 0;

  /** `dt` in seconds. `decay` is how far the hold falls per second, 0–1. */
  push(level: number, dt: number, decay = 0.6): { level: number; hold: number } {
    this.value = level;
    const fallen = this.held - decay * Math.max(0, dt);
    this.held = Math.max(level, fallen, 0);
    return { level: this.value, hold: this.held };
  }

  reset(): void {
    this.value = 0;
    this.held = 0;
  }
}

/** Above this, the take is clipping and the meter has to say so in colour. */
export const CLIP_AT = 0.99;

// ── Getting it to disk ──────────────────────────────────────────────────────

/**
 * How often `MediaRecorder` is asked for a chunk, in milliseconds.
 *
 * Every chunk is a write, so this is a trade between syscalls and how much of a
 * take a crash can cost. Three seconds is under a rounding error of writes for
 * an hour-long recording (1,200 of them) and is the most anyone can lose.
 */
export const CHUNK_MS = 3000;

/**
 * The running account of a take: what has reached the disk, what has not, and
 * whether anything went wrong on the way.
 *
 * Kept as a value rather than as fields on the surface because "did this
 * recording actually save" is the one question the recorder has to be able to
 * answer honestly, and answering it from three booleans scattered across a view
 * class is how it ends up answering "yes" wrongly.
 */
export interface Ledger {
  /** Bytes handed to us by `MediaRecorder`. */
  produced: number;
  /** Bytes the filesystem has confirmed. */
  written: number;
  /** Where it is going, once the first chunk has landed. */
  path: string | null;
  /** Set the first time a write fails; the take then falls back to memory. */
  trouble: string | null;
  /** True while chunks are being kept in memory instead of streamed. */
  buffering: boolean;
  /**
   * Something the user should know about the take for as long as it runs, which
   * is not about where the bytes are going — sound the engine refused to start,
   * a source that had no audio to give. Separate from `trouble` on purpose:
   * `trouble` means the file fell back to memory and says so, and a sound
   * warning routed through it would claim a disk problem that has not happened.
   * Separate from the status line too, which the next thing to happen overwrites.
   */
  note: string | null;
}

export function emptyLedger(buffering: boolean): Ledger {
  return { produced: 0, written: 0, path: null, trouble: null, buffering, note: null };
}

/**
 * What the status line says about where the take is going.
 *
 * Three genuinely different states and all three are worth distinguishing: on
 * disk and safe, in memory because the container demands it, and in memory
 * because a write failed — the last of which is the one that must never be
 * displayed as if it were the first.
 */
export function ledgerText(l: Ledger, seconds: number): string {
  const rate = seconds > 0 ? l.produced / seconds : 0;
  const at = rate > 0 ? ` · ${size(rate)}/s` : "";
  const note = l.note ? ` · ${l.note}` : "";
  if (l.trouble) return `${size(l.produced)} held in memory — ${l.trouble}${at}${note}`;
  if (l.buffering) return `${size(l.produced)} in memory, saved when you stop${at}${note}`;
  return `${size(l.written)} on disk${at}${note}`;
}

/**
 * Whether a take that has just stopped is worth keeping.
 *
 * A zero-byte recording is a failure and has to be reported as one. The
 * alternative — writing an empty file, or writing nothing and saying nothing —
 * is indistinguishable from success until the folder is opened, which is the
 * one property a recorder cannot have.
 */
export function worthKeeping(bytes: number): boolean {
  return bytes > 0;
}
