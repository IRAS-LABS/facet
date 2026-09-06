/**
 * The driver: audio in, a finished transcript out (item 30).
 *
 * This is the part that knows the *order* things happen in. The worker knows
 * how to run three models and nothing else; `transcript.ts` knows all the
 * arithmetic and none of the I/O; this file walks a recording through both and
 * says how far along it is while doing it.
 *
 * Decoding happens here rather than in the worker because `decodeAudioData`
 * does not exist off the main thread — it is a `BaseAudioContext` method, and
 * workers do not get one. That is also the reason the samples cross the wire
 * as transfers: an hour of 16 kHz mono is 230 MB, and copying it per window
 * would be the slowest thing in the run by a wide margin.
 *
 * Why a window at a time rather than handing transformers.js the whole file
 * and letting it chunk: the whole file has to be one `Float32Array` for that,
 * so two hours is half a gigabyte resident before a single model has loaded —
 * and there is no way to show progress through it, which on a WASM machine
 * means twenty minutes of a spinner and no way to tell a slow run from a
 * hung one.
 */

import {
  assignSpeakers,
  clusterSpeakers,
  mergeWindows,
  planWindows,
  speechRegions,
  type LocalTurns,
  type Segment,
  type Voiced,
  type WindowResult,
} from "./transcript";

export const RATE = 16_000;

/**
 * Below this a voice print is noise. wespeaker will return a vector for a
 * quarter-second of audio, but it is a vector of that quarter second's room
 * tone as much as of anybody's voice, and one such region joining the wrong
 * cluster renames a speaker for the rest of the transcript.
 */
const MIN_VOICE = 0.6;

/** The three sizes, smallest first. Names are the user's, ids are the hub's. */
export const QUALITIES = [
  {
    id: "fast",
    label: "Fast",
    note: "~80 MB · good for clear speech",
    repo: "onnx-community/whisper-tiny_timestamped",
  },
  {
    id: "balanced",
    label: "Balanced",
    note: "~150 MB · the usual choice",
    repo: "onnx-community/whisper-base_timestamped",
  },
  {
    id: "best",
    label: "Best",
    note: "~500 MB · accents, noise, several voices",
    repo: "onnx-community/whisper-small_timestamped",
  },
] as const;

export type QualityId = (typeof QUALITIES)[number]["id"];

export interface ScribeOptions {
  quality: QualityId;
  /** Off, on, or on with a known head count. Off skips two model downloads. */
  speakers: boolean;
  /** How many people, if the user knows. 0 means "work it out". */
  people: number;
  /** A language hint for Whisper, or null to let it decide. */
  language: string | null;
}

export const DEFAULTS: ScribeOptions = {
  quality: "balanced",
  speakers: true,
  people: 0,
  language: null,
};

export interface Progress {
  /** What is happening, in words the panel can show as-is. */
  note: string;
  /** 0–1, or null when there is genuinely no way to know. */
  done: number | null;
  /** Segments finished so far, so the panel can fill in as it goes. */
  segments: readonly Segment[];
}

export type OnProgress = (p: Progress) => void;

/** Whether this build can transcribe at all. */
export function supported(): boolean {
  return typeof Worker === "function" && typeof AudioContext !== "undefined";
}

/**
 * WebGPU where it exists, WASM where it does not.
 *
 * The difference is not small — Whisper base on a discrete GPU runs an hour of
 * audio in a couple of minutes, and the same model on WASM takes closer to
 * real time. Worth asking about rather than assuming, and worth *saying* on
 * screen, because "this will take an hour" and "this will take two minutes"
 * are different enough that the user should get to decide whether to start.
 */
export async function bestDevice(): Promise<"webgpu" | "wasm"> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return "wasm";
  try {
    return (await gpu.requestAdapter()) ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

/**
 * Any audio or video file → 16 kHz mono samples.
 *
 * Two passes rather than one: `decodeAudioData` decodes at the file's own rate
 * and will not be told otherwise, so an `OfflineAudioContext` at 16 kHz does
 * the resampling afterwards. Asking for one output channel is also what does
 * the downmix — a stereo interview becomes the sum of both sides, which is
 * what we want, rather than the left channel and whoever happened to be
 * sitting on the right going missing.
 */
export async function decode(bytes: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    // decodeAudioData detaches the buffer it is given. Anything the caller
    // still holds a reference to would come back zero-length, so it gets a
    // copy — cheap next to the decode itself, and it has surprised people.
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    if (buffer.sampleRate === RATE && buffer.numberOfChannels === 1) {
      return new Float32Array(buffer.getChannelData(0));
    }
    const frames = Math.max(1, Math.ceil(buffer.duration * RATE));
    const off = new OfflineAudioContext(1, frames, RATE);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return new Float32Array(out.getChannelData(0));
  } finally {
    void ctx.close();
  }
}

/** A slice of the recording, copied so it can be transferred without loss. */
function slice(samples: Float32Array, from: number, to: number): Float32Array {
  const a = Math.max(0, Math.round(from * RATE));
  const b = Math.min(samples.length, Math.round(to * RATE));
  return b > a ? samples.slice(a, b) : new Float32Array(0);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * One worker, one recording at a time.
 *
 * Deliberately not a pool. Three models loaded once is already most of a
 * gigabyte of memory on the `best` setting, and two of them at once on a
 * machine without a GPU is how a transcription run becomes an out-of-memory
 * crash that takes the file explorer down with it.
 */
export class Scribe {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #next = 1;
  #loaded: string | null = null;
  #onLoading: ((what: string, done: number) => void) | null = null;

  /** True once a model is in memory, so the panel can skip its download line. */
  get ready(): boolean {
    return this.#loaded !== null;
  }

  /**
   * The free `decode` above, as a method.
   *
   * It has nothing to do with the worker and could stay a bare function — but
   * then the panel would depend on two things instead of one, and the harness
   * would have to stub a module import rather than pass an object. One seam is
   * cheaper to fake than two.
   */
  decode(bytes: ArrayBuffer): Promise<Float32Array> {
    return decode(bytes);
  }

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./scribe-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (e: MessageEvent) => {
      const msg = e.data as { type: string; id?: number; message?: string } & Record<string, unknown>;
      if (msg.type === "loading") {
        this.#onLoading?.(String(msg["what"] ?? ""), Number(msg["done"] ?? 0));
        return;
      }
      if (msg.type === "failed") {
        const err = new Error(String(msg.message ?? "transcription failed"));
        // A failure with no id is a load failure, which nothing is waiting on
        // in particular and everything is waiting on in general.
        if (msg.id == null) {
          for (const p of this.#pending.values()) p.reject(err);
          this.#pending.clear();
        } else {
          this.#pending.get(msg.id)?.reject(err);
          this.#pending.delete(msg.id);
        }
        return;
      }
      if (typeof msg.id !== "number") return;
      const waiting = this.#pending.get(msg.id);
      if (!waiting) return;
      this.#pending.delete(msg.id);
      waiting.resolve(msg);
    });
    worker.addEventListener("error", (e: ErrorEvent) => {
      const err = new Error(e.message || "the transcription worker stopped");
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      this.#loaded = null;
    });
    this.#worker = worker;
    return worker;
  }

  #ask<T>(type: string, samples: Float32Array): Promise<T> {
    const worker = this.#start();
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ type, id, samples }, [samples.buffer]);
    });
  }

  /**
   * Downloads and warms the models. Safe to call again; only a change of
   * settings costs anything.
   */
  async load(opts: ScribeOptions, onLoading?: (what: string, done: number) => void): Promise<void> {
    const quality = QUALITIES.find((q) => q.id === opts.quality) ?? QUALITIES[1];
    const device = await bestDevice();
    const key = `${quality.repo}|${opts.speakers}|${device}|${opts.language ?? ""}`;
    if (this.#loaded === key) return;

    const worker = this.#start();
    this.#onLoading = onLoading ?? null;
    await new Promise<void>((resolve, reject) => {
      const done = (e: MessageEvent) => {
        const msg = e.data as { type: string; message?: string };
        if (msg.type === "ready") {
          worker.removeEventListener("message", done);
          resolve();
        } else if (msg.type === "failed") {
          worker.removeEventListener("message", done);
          reject(new Error(String(msg.message ?? "the models could not be loaded")));
        }
      };
      worker.addEventListener("message", done);
      worker.postMessage({
        type: "load",
        options: {
          words: quality.repo,
          speakers: opts.speakers,
          device,
          language: opts.language,
        },
      });
    });
    this.#onLoading = null;
    this.#loaded = key;
  }

  /**
   * The whole run: samples in, named segments out.
   *
   * Cancellation is checked between windows rather than inside them. A model
   * call cannot be interrupted once it has started, so the honest granularity
   * is one window — half a minute of audio, a few seconds of compute — and
   * pretending otherwise would mean a Stop button that lies about when it
   * takes effect.
   */
  async run(
    samples: Float32Array,
    opts: ScribeOptions,
    onProgress: OnProgress,
    signal?: AbortSignal,
  ): Promise<Segment[]> {
    const duration = samples.length / RATE;
    const plan = planWindows(duration);
    const heard: WindowResult[] = [];
    const perWindow: LocalTurns[] = [];
    let sofar: Segment[] = [];

    await this.load(opts, (what, done) => {
      onProgress({ note: `${what} — ${Math.round(done * 100)}%`, done, segments: sofar });
    });

    for (const window of plan) {
      if (signal?.aborted) break;
      onProgress({
        note: `Listening — ${clockish(window.start)} of ${clockish(duration)}`,
        done: plan.length > 0 ? window.index / plan.length : null,
        segments: sofar,
      });

      const audio = slice(samples, window.start, window.end);
      if (audio.length === 0) continue;

      // Two calls, two copies: both are transferred, so the same array cannot
      // serve them both.
      const forWords = audio;
      const forVoices = opts.speakers ? audio.slice() : null;

      const words = await this.#ask<{ segments: Segment[] }>("words", forWords);
      heard.push({ window, segments: words.segments });

      if (forVoices) {
        const voices = await this.#ask<{ turns: LocalTurns["turns"] }>("voices", forVoices);
        perWindow.push({ window, turns: voices.turns });
      }

      // Merged fresh each window rather than appended, because a segment that
      // straddles the seam is only decided once the next window has spoken.
      sofar = mergeWindows(heard);
    }

    let segments = mergeWindows(heard);
    if (!opts.speakers || perWindow.length === 0 || signal?.aborted) return segments;

    // ── Who was talking ─────────────────────────────────────────────────────
    const regions = speechRegions(perWindow).filter((r) => r.end - r.start >= MIN_VOICE);
    const voiced: Voiced[] = [];
    for (let i = 0; i < regions.length; i++) {
      if (signal?.aborted) break;
      const r = regions[i];
      if (!r) continue;
      onProgress({
        note: `Telling voices apart — ${i + 1} of ${regions.length}`,
        done: regions.length > 0 ? i / regions.length : null,
        segments,
      });
      const print = await this.#ask<{ embedding: number[] }>("print", slice(samples, r.start, r.end));
      voiced.push({ ...r, embedding: print.embedding });
    }

    if (voiced.length === 0) return segments;
    const turns = clusterSpeakers(voiced, opts.people > 0 ? { speakers: opts.people } : {});
    segments = assignSpeakers(segments, turns);
    onProgress({ note: "Done", done: 1, segments });
    return segments;
  }

  /** Frees the models. The next run pays for the load again, not the download. */
  close(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#loaded = null;
    for (const p of this.#pending.values()) p.reject(new Error("transcription stopped"));
    this.#pending.clear();
  }
}

/** m:ss for progress lines. Not the transcript's clock — that one keeps hours. */
function clockish(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
