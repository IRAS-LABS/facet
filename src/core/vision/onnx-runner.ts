/**
 * Main-thread handle on the ONNX worker: load a bundled model by name, run it,
 * get typed tensors back. One worker per page, created on first use, models
 * kept warm until `unload`. If the worker cannot start (no WASM, no Worker,
 * a blocked asset) `available()` says so once and every category falls back
 * to whatever it can do without a model — the cascade for faces, nothing
 * for screens and plates — and the UI can say which.
 */

import type { TensorLike, WorkerReply, WorkerRequest } from "./onnx-worker";

export type ModelName = "yolox" | "plates" | "yunet";

/** File under public/models for each model; fetched once, from the bundle. */
export const MODEL_FILES: Record<ModelName, string> = {
  yolox: "yolox-nano.onnx",
  plates: "plates.onnx",
  yunet: "yunet.onnx",
};

/** Fixed input edge each model was exported with. */
export const MODEL_SIZE: Record<ModelName, number> = {
  yolox: 416,
  plates: 384,
  yunet: 640,
};

export interface RunResult {
  outputs: Record<string, TensorLike>;
  /** Pure inference time inside the worker, ms. */
  ms: number;
}

export interface RunnerStats {
  /** Last inference time per model, ms. */
  last: Partial<Record<ModelName, number>>;
  /** Milliseconds each model took to load. */
  load: Partial<Record<ModelName, number>>;
  threads: number;
}

/** Where a model file lives at run time; absolute so the worker can fetch it. */
export function modelUrl(name: ModelName): string {
  const rel = `${import.meta.env.BASE_URL}models/${MODEL_FILES[name]}`;
  if (typeof document !== "undefined") return new URL(rel, document.baseURI).href;
  return rel;
}

type Pending = { resolve: (r: WorkerReply) => void; reject: (e: Error) => void };

export class OnnxRunner {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly loaded = new Map<ModelName, Promise<void>>();
  private ready: Promise<boolean> | null = null;
  readonly stats: RunnerStats = { last: {}, load: {}, threads: 1 };

  constructor(private readonly makeWorker: () => Worker = defaultWorker) {}

  /** True once the worker answered a ping; false (and never retried) if it cannot. */
  available(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        const r = await this.call({ id: 0, op: "ping" }, 15_000);
        if (r.ok && r.op === "ping") this.stats.threads = r.threads;
        return r.ok;
      } catch {
        return false;
      }
    })();
    return this.ready;
  }

  /** Load (once) a bundled model. */
  load(name: ModelName): Promise<void> {
    let p = this.loaded.get(name);
    if (!p) {
      const t0 = performance.now();
      p = this.call({ id: 0, op: "load", model: name, url: modelUrl(name) }, 120_000).then((r) => {
        if (!r.ok) throw new Error(r.error);
        this.stats.load[name] = performance.now() - t0;
      });
      p.catch(() => this.loaded.delete(name));
      this.loaded.set(name, p);
    }
    return p;
  }

  /** Run a loaded model. Input buffers are transferred, not copied. */
  async run(name: ModelName, feeds: Record<string, TensorLike>): Promise<RunResult> {
    await this.load(name);
    const r = await this.call({ id: 0, op: "run", model: name, feeds }, 120_000, Object.values(feeds).map((t) => t.data.buffer as ArrayBuffer));
    if (!r.ok) throw new Error(r.error);
    if (r.op !== "run") throw new Error("unexpected reply");
    this.stats.last[name] = r.ms;
    return { outputs: r.outputs, ms: r.ms };
  }

  async unload(name: ModelName): Promise<void> {
    if (!this.loaded.has(name)) return;
    this.loaded.delete(name);
    await this.call({ id: 0, op: "unload", model: name }, 10_000);
  }

  /** Tear the worker down; the next call starts a fresh one. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loaded.clear();
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new Error("runner disposed"));
    this.pending.clear();
  }

  private call(req: WorkerRequest, timeoutMs: number, transfer: ArrayBuffer[] = []): Promise<WorkerReply> {
    const id = ++this.seq;
    const w = this.ensure();
    return new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`onnx worker: ${req.op} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      w.postMessage({ ...req, id }, transfer);
    });
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = this.makeWorker();
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      p.resolve(e.data);
    };
    w.onerror = (e) => {
      const err = new Error(`onnx worker failed: ${e.message || "unknown"}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.ready = Promise.resolve(false);
    };
    this.worker = w;
    return w;
  }
}

function defaultWorker(): Worker {
  return new Worker(new URL("./onnx-worker.ts", import.meta.url), { type: "module" });
}

let shared: OnnxRunner | null = null;

/** The page's one runner. */
export function getRunner(): OnnxRunner {
  if (!shared) shared = new OnnxRunner();
  return shared;
}
