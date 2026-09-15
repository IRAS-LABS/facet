/**
 * Kokoro inference, off the main thread.
 *
 * The same reasoning as the vision worker: a synthesis takes a few hundred
 * milliseconds and the page must stay responsive through it, and a WASM
 * out-of-memory on an old phone should take a worker down rather than the
 * whole app. The difference is that this one is fed its model as bytes rather
 * than a URL, because the model lives in IndexedDB after the user downloaded
 * it, not in the bundle.
 *
 * Protocol (one request, one reply, matched by `id`):
 *   { id, op: "load", model }                → { id, ok, sampleRate }
 *   { id, op: "speak", tokens, style, speed} → { id, ok, audio, ms }
 *   { id, op: "unload" }                     → { id, ok }
 *   { id, op: "ping" }                       → { id, ok }
 */

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

export type KokoroRequest =
  | { id: number; op: "ping" }
  | { id: number; op: "load"; model: ArrayBuffer }
  | { id: number; op: "speak"; tokens: number[]; style: Float32Array; speed: number }
  | { id: number; op: "unload" };

export type KokoroReply =
  | { id: number; ok: true; op: "ping" }
  | { id: number; ok: true; op: "load"; sampleRate: number }
  | { id: number; ok: true; op: "speak"; audio: Float32Array; ms: number }
  | { id: number; ok: true; op: "unload" }
  | { id: number; ok: false; error: string };

/**
 * A request without its id.
 *
 * Written as a conditional so it distributes over the union: a plain
 * `Omit<KokoroRequest, "id">` would collapse to the keys every member shares,
 * which is none of the interesting ones.
 */
export type Ask<T> = T extends { id: number } ? Omit<T, "id"> : never;

/** Kokoro's output rate. Fixed by the model, not a choice. */
export const SAMPLE_RATE = 24_000;

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.proxy = false;
if (typeof SharedArrayBuffer === "undefined") ort.env.wasm.numThreads = 1;

let session: ort.InferenceSession | null = null;

async function handle(req: KokoroRequest): Promise<KokoroReply> {
  switch (req.op) {
    case "ping":
      return { id: req.id, ok: true, op: "ping" };

    case "load": {
      await session?.release();
      session = await ort.InferenceSession.create(new Uint8Array(req.model), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      return { id: req.id, ok: true, op: "load", sampleRate: SAMPLE_RATE };
    }

    case "unload": {
      const s = session;
      session = null;
      await s?.release();
      return { id: req.id, ok: true, op: "unload" };
    }

    case "speak": {
      if (!session) throw new Error("The voice model is not loaded");

      // The model takes int64 token ids. BigInt64Array is the only way to hand
      // 64-bit integers to the runtime, and the ids are small enough that the
      // conversion is exact.
      const ids = BigInt64Array.from(req.tokens.map((n) => BigInt(n)));

      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor("int64", ids, [1, ids.length]),
        style: new ort.Tensor("float32", req.style, [1, req.style.length]),
        speed: new ort.Tensor("float32", new Float32Array([req.speed]), [1]),
      };

      const t0 = performance.now();
      const out = await session.run(feeds);
      const ms = performance.now() - t0;

      // The output name has changed between exports of this model, so take the
      // first float tensor rather than trusting a name. There is only one.
      const first = Object.values(out).find((t) => t.data instanceof Float32Array);
      if (!first) throw new Error("The voice model returned no audio");

      return { id: req.id, ok: true, op: "speak", audio: first.data as Float32Array, ms };
    }
  }
}

self.onmessage = async (e: MessageEvent<KokoroRequest>): Promise<void> => {
  const req = e.data;
  try {
    const reply = await handle(req);
    // The audio buffer is large and is never touched again here, so it is
    // transferred rather than copied.
    const transfer = reply.ok && reply.op === "speak" ? [reply.audio.buffer] : [];
    (self as unknown as Worker).postMessage(reply, transfer as Transferable[]);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ id: req.id, ok: false, error } satisfies KokoroReply);
  }
};
