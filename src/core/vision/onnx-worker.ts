/**
 * The only file that imports onnxruntime-web. Runs in a Worker so a 200 ms
 * inference never stalls the editor's gestures, and so a WASM crash (out of
 * memory on an old phone) takes the worker down, not the page.
 *
 * Protocol (one request → one reply, matched by `id`):
 *   { id, op: "load",   model, url }               → { id, ok, inputs, outputs }
 *   { id, op: "run",    model, feeds }             → { id, ok, outputs, ms }
 *   { id, op: "unload", model }                    → { id, ok }
 *   { id, op: "ping" }                             → { id, ok, threads, simd }
 *
 * The WASM binary is a Vite asset resolved from the installed package at
 * build time (`?url`), so the exact runtime version shipping in the APK is
 * the one in package-lock, never something fetched from a CDN at run time.
 * Threads need SharedArrayBuffer, which needs cross-origin isolation; the
 * Tauri WebView does not grant it, so this runs single-threaded there and
 * the runtime works that out on its own (`numThreads` collapses to 1).
 */

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

export interface TensorLike {
  data: Float32Array;
  dims: number[];
}

export type WorkerRequest =
  | { id: number; op: "load"; model: string; url: string }
  | { id: number; op: "run"; model: string; feeds: Record<string, TensorLike> }
  | { id: number; op: "unload"; model: string }
  | { id: number; op: "ping" };

export type WorkerReply =
  | { id: number; ok: true; op: "load"; inputs: { name: string; dims: readonly (number | string)[] }[]; outputs: string[] }
  | { id: number; ok: true; op: "run"; outputs: Record<string, TensorLike>; ms: number }
  | { id: number; ok: true; op: "unload" }
  | { id: number; ok: true; op: "ping"; threads: number; simd: boolean }
  | { id: number; ok: false; error: string };

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// Already in a worker: a second proxy worker would only add a hop.
ort.env.wasm.proxy = false;
if (typeof SharedArrayBuffer === "undefined") ort.env.wasm.numThreads = 1;

const sessions = new Map<string, ort.InferenceSession>();

async function load(model: string, url: string): Promise<ort.InferenceSession> {
  const have = sessions.get(model);
  if (have) return have;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model ${model}: HTTP ${res.status} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  sessions.set(model, session);
  return session;
}

async function handle(req: WorkerRequest): Promise<WorkerReply> {
  switch (req.op) {
    case "ping":
      return { id: req.id, ok: true, op: "ping", threads: ort.env.wasm.numThreads ?? 1, simd: ort.env.wasm.simd !== false };
    case "load": {
      const s = await load(req.model, req.url);
      return {
        id: req.id,
        ok: true,
        op: "load",
        inputs: s.inputNames.map((name) => ({ name, dims: [] })),
        outputs: [...s.outputNames],
      };
    }
    case "unload": {
      const s = sessions.get(req.model);
      if (s) {
        sessions.delete(req.model);
        await s.release();
      }
      return { id: req.id, ok: true, op: "unload" };
    }
    case "run": {
      const s = sessions.get(req.model);
      if (!s) throw new Error(`model ${req.model} is not loaded`);
      const feeds: Record<string, ort.Tensor> = {};
      for (const [name, t] of Object.entries(req.feeds)) feeds[name] = new ort.Tensor("float32", t.data, t.dims);
      const t0 = performance.now();
      const out = await s.run(feeds);
      const ms = performance.now() - t0;
      const outputs: Record<string, TensorLike> = {};
      for (const [name, t] of Object.entries(out)) {
        const data = t.data instanceof Float32Array ? t.data : Float32Array.from(t.data as ArrayLike<number>);
        outputs[name] = { data, dims: [...t.dims] };
        t.dispose?.();
      }
      return { id: req.id, ok: true, op: "run", outputs, ms };
    }
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  handle(req).then(
    (reply) => {
      const transfer: ArrayBuffer[] = [];
      if (reply.ok && reply.op === "run") for (const t of Object.values(reply.outputs)) transfer.push(t.data.buffer as ArrayBuffer);
      (self as unknown as Worker).postMessage(reply, transfer);
    },
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      (self as unknown as Worker).postMessage({ id: req.id, ok: false, error } satisfies WorkerReply);
    },
  );
};
