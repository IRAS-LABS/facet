/**
 * The three models, off the main thread (item 30).
 *
 * Everything in here is I/O and inference; every decision worth arguing about
 * lives in `transcript.ts`, which is where it can be checked. This file exists
 * because Whisper on WASM will hold a thread for minutes at a time, and a file
 * explorer that stops repainting while it transcribes an hour of audio is
 * broken regardless of how good the transcript turns out to be.
 *
 * Three models rather than one, because transcription and diarisation are
 * genuinely different questions:
 *
 *   * **Whisper** — what was said, with word timings.
 *   * **pyannote segmentation** — when *somebody* was talking, and roughly how
 *     many people are in play at each moment. Its speaker numbers are local to
 *     the audio it was given and mean nothing across calls.
 *   * **wespeaker** — what a voice *sounds like*, as a vector. This is the one
 *     that makes a name mean the same person on page nine as on page one; see
 *     `clusterSpeakers`.
 *
 * The main thread does the audio decoding, because `decodeAudioData` is not
 * available to a worker, and hands slices of 16 kHz mono samples across. They
 * are transferred, not copied.
 */

import {
  AutoModel,
  AutoModelForAudioFrameClassification,
  AutoProcessor,
  pipeline,
  type PreTrainedModel,
  type Processor,
} from "@huggingface/transformers";

import type { Segment, Turn } from "./transcript";

/** 16 kHz mono is what all three models want, and the only rate this file knows. */
export const RATE = 16_000;

export interface LoadOptions {
  /** Whisper repo. Bigger is better and slower, in that order. */
  words: string;
  /** Set false to skip both speaker models and their downloads entirely. */
  speakers: boolean;
  /** "webgpu" where it exists, "wasm" everywhere else. */
  device: "webgpu" | "wasm";
  /** BCP-47-ish language hint, or null to let Whisper decide. */
  language: string | null;
}

type ToWorker =
  | { type: "load"; options: LoadOptions }
  | { type: "words"; id: number; samples: Float32Array }
  | { type: "voices"; id: number; samples: Float32Array }
  | { type: "print"; id: number; samples: Float32Array };

type FromWorker =
  | { type: "ready"; device: string }
  | { type: "loading"; what: string; done: number }
  | { type: "words"; id: number; segments: Segment[] }
  | { type: "voices"; id: number; turns: Turn[] }
  | { type: "print"; id: number; embedding: number[] }
  | { type: "failed"; id: number | null; message: string };

const post = (m: FromWorker): void => {
  (self as unknown as Worker).postMessage(m);
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<any>;

let asr: Asr | null = null;
let segmenter: PreTrainedModel | null = null;
let segProcessor: Processor | null = null;
let voiceProcessor: Processor | null = null;
let voiceModel: PreTrainedModel | null = null;
let settings: LoadOptions | null = null;

/**
 * Progress arrives per file per model, and there are up to a dozen files. A
 * bar that restarts at zero five times reads as five failures, so the numbers
 * are pooled into one fraction of one download.
 */
function progressFor(what: string): (e: Record<string, unknown>) => void {
  const seen = new Map<string, { at: number; of: number }>();
  return (e) => {
    if (e["status"] !== "progress" && e["status"] !== "done") return;
    const file = String(e["file"] ?? "");
    const of = Number(e["total"] ?? 0);
    const at = e["status"] === "done" ? of : Number(e["loaded"] ?? 0);
    if (of > 0) seen.set(file, { at, of });
    let sum = 0;
    let total = 0;
    for (const v of seen.values()) {
      sum += v.at;
      total += v.of;
    }
    post({ type: "loading", what, done: total > 0 ? sum / total : 0 });
  };
}

async function load(options: LoadOptions): Promise<void> {
  settings = options;
  const device = options.device;

  asr = (await pipeline("automatic-speech-recognition", options.words, {
    device,
    // q4 on the decoder is the difference between "runs on a laptop" and
    // "runs out of memory"; the encoder stays at full width because that is
    // where the transcript's accuracy actually comes from.
    dtype: device === "webgpu"
      ? { encoder_model: "fp32", decoder_model_merged: "q4" }
      : { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: progressFor("Speech model"),
  } as any)) as unknown as Asr;

  if (!options.speakers) return;

  const segId = "onnx-community/pyannote-segmentation-3.0";
  segProcessor = await AutoProcessor.from_pretrained(segId, {
    progress_callback: progressFor("Speaker model"),
  } as any);
  segmenter = await AutoModelForAudioFrameClassification.from_pretrained(segId, {
    progress_callback: progressFor("Speaker model"),
  } as any);

  const voiceId = "onnx-community/wespeaker-voxceleb-resnet34-LM";
  voiceProcessor = await AutoProcessor.from_pretrained(voiceId, {
    progress_callback: progressFor("Voice model"),
  } as any);
  voiceModel = await AutoModel.from_pretrained(voiceId, {
    progress_callback: progressFor("Voice model"),
  } as any);
}

/** Whisper's chunks → our segments, in the window's own time base. */
function toSegments(out: any): Segment[] {
  const chunks: any[] = Array.isArray(out?.chunks) ? out.chunks : [];
  if (chunks.length === 0) {
    const text = String(out?.text ?? "").trim();
    return text ? [{ start: 0, end: 0, text, words: [], speaker: null }] : [];
  }

  const words = chunks
    .map((c) => {
      const span = Array.isArray(c?.timestamp) ? c.timestamp : [null, null];
      return {
        // A null end is Whisper saying it ran out of audio mid-word. Held at
        // the start rather than dropped: the word was said, and a zero-length
        // span is honest about not knowing how long it took.
        start: Number(span[0] ?? 0),
        end: Number(span[1] ?? span[0] ?? 0),
        text: String(c?.text ?? ""),
      };
    })
    .filter((w) => w.text.trim().length > 0);

  /*
   * Words are grouped back into sentences before they leave. Whisper with
   * word timestamps emits one chunk per word, and a transcript of one word
   * per line is unreadable — but the word timings are what let a segment be
   * split at a speaker handover, so they travel along rather than being
   * thrown away.
   */
  const segments: Segment[] = [];
  let current: Segment | null = null;
  for (const w of words) {
    if (!current) {
      current = { start: w.start, end: w.end, text: w.text.trim(), words: [w], speaker: null };
      continue;
    }
    current.end = Math.max(current.end, w.end);
    current.words.push(w);
    current.text = `${current.text} ${w.text.trim()}`.trim();
    if (/[.!?…]["')\]]?$/.test(w.text.trim())) {
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  return segments;
}

async function words(samples: Float32Array): Promise<Segment[]> {
  if (!asr) throw new Error("the speech model is not loaded");
  const out = await asr(samples, {
    return_timestamps: "word",
    chunk_length_s: 0, // windowing is ours; see planWindows
    ...(settings?.language ? { language: settings.language } : {}),
  });
  return toSegments(out);
}

async function voices(samples: Float32Array): Promise<Turn[]> {
  if (!segmenter || !segProcessor) return [];
  const inputs = await (segProcessor as any)(samples);
  const { logits } = (await (segmenter as any)(inputs)) as { logits: unknown };
  const found = (segProcessor as any).post_process_speaker_diarization(
    logits,
    samples.length,
  ) as Array<Array<{ id: number; start: number; end: number; confidence: number }>>;

  /*
   * Low-confidence frames are dropped rather than kept as a hedge. A speaker
   * region is not shown to anybody; it is used to decide whose name goes on a
   * sentence, and a coin-flip region is worse than no region — with none, the
   * sentence stays unattributed, which is honest.
   */
  return (found[0] ?? [])
    .filter((r) => r.confidence >= 0.5 && r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end, speaker: String(r.id) }));
}

async function print(samples: Float32Array): Promise<number[]> {
  if (!voiceModel || !voiceProcessor) return [];
  const inputs = await (voiceProcessor as any)(samples);
  const out = (await (voiceModel as any)(inputs)) as { embeddings?: { data?: ArrayLike<number> } };
  const data = out.embeddings?.data;
  return data ? Array.from(data as ArrayLike<number>, Number) : [];
}

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  const id = "id" in msg ? msg.id : null;

  void (async () => {
    try {
      switch (msg.type) {
        case "load":
          await load(msg.options);
          post({ type: "ready", device: msg.options.device });
          return;
        case "words":
          post({ type: "words", id: msg.id, segments: await words(msg.samples) });
          return;
        case "voices":
          post({ type: "voices", id: msg.id, turns: await voices(msg.samples) });
          return;
        case "print":
          post({ type: "print", id: msg.id, embedding: await print(msg.samples) });
          return;
      }
    } catch (err) {
      post({ type: "failed", id, message: err instanceof Error ? err.message : String(err) });
    }
  })();
});
