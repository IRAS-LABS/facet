/**
 * What the batch queue can actually do (item 26).
 *
 * Each runner is registered against a `kind` string and receives the plain task
 * record the queue restored from disk — never a closure captured at enqueue
 * time. That is the constraint that makes the queue resumable, and it means
 * everything a runner needs must be in `task.params` as JSON: a path, a bitrate,
 * a mode. Anything live (the ffmpeg bridge, the filesystem) is bound once here
 * and shared by every task of that kind.
 *
 * The split between these and the editors is deliberate. Editing *one* file
 * wants immediate feedback and a waveform to aim at; converting *forty* wants a
 * queue you can walk away from. Same engine underneath, different surface.
 */

import type { BlurKind } from "@core/edit/blur";
import { strip } from "@core/meta/exif";
import { blurFacesInImage, PHOTO_DETECT, type BlurImageOptions } from "@core/vision/apply";
import { autoBlurImage } from "@core/vision/autoblur-image";
import { AUTO_CATEGORIES, defaultConfig, enabledCategories, type AutoBlurConfig, type AutoCategory } from "@core/vision/autoblur-config";
import { sanitize } from "@core/phone/autoblur-prefs";
import { getRunner } from "@core/vision/onnx-runner";
import { Tesseract, type Recogniser } from "@core/ocr/engine";
import type { AudioJob } from "@ui/aedit";
import type { Job, JobDone, JobProgress } from "@ui/vedit";
import type { BatchQueue, RunContext, RunResult, Task } from "./queue";

export interface BatchHost {
  readAll(path: string, max: number): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
  moveFile(from: string, to: string, overwrite: boolean): Promise<{ path: string; copied: boolean }>;
  runJob(job: Job): Promise<number>;
  runAudioJob(job: AudioJob): Promise<number>;
  cancelJob(id: number): Promise<void>;
  onProgress(cb: (p: JobProgress) => void): () => void;
  onDone(cb: (d: JobDone) => void): () => void;
}

/** Metadata reading wants the whole file; `read_head` clamps to the real length. */
const MAX_BYTES = 64 * 1024 * 1024;

export function registerRunners(queue: BatchQueue, host: BatchHost): void {
  queue.register("meta.clean", cleanRunner(host));
  queue.register("faces.blur", faceRunner(host));
  queue.register("auto.blur", autoRunner(host));
  queue.register("audio.convert", audioRunner(host));
  queue.register("video.convert", videoRunner(host));
  queue.register("file.move", moveRunner(host));
}

// ── Files ───────────────────────────────────────────────────────────────────

/**
 * Move, and therefore also rename — a rename is a move that stays put.
 *
 * Instant compared to an encode, so it reports the two honest points rather
 * than a bar, and the interesting part is what it says afterwards: a move
 * across drives comes back as a copy with the original still in place, and the
 * row says "copied" instead of quietly implying the source is gone.
 */
function moveRunner(host: BatchHost): (t: Task, c: RunContext) => Promise<RunResult> {
  return async (task, ctx) => {
    if (!task.output) throw new Error("no destination");
    ctx.progress(0.2, "moving");
    if (ctx.signal.aborted) throw new Error("cancelled");
    const r = await host.moveFile(task.input, task.output, task.params["overwrite"] === true);
    return {
      output: r.path,
      note: r.copied ? "copied — different drive, original left in place" : "moved",
    };
  };
}

// ── Metadata ────────────────────────────────────────────────────────────────

/**
 * Strip every identifying tag out of a picture (item 22, over a selection).
 *
 * Runs entirely in the front end — the stripper is a byte rewriter, not an
 * encoder — so the only progress it can honestly report is "started" and
 * "finished". It reports those rather than faking a smooth bar.
 */
function cleanRunner(host: BatchHost): (t: Task, c: RunContext) => Promise<RunResult> {
  return async (task, ctx) => {
    const inPlace = task.params["mode"] === "inplace";
    ctx.progress(0.1, "reading");
    const bytes = await host.readAll(task.input, MAX_BYTES);
    if (ctx.signal.aborted) throw new Error("cancelled");

    ctx.progress(0.5, "stripping");
    const r = strip(bytes);
    // Not an error: a PNG with nothing in it and a format the stripper does not
    // know are different facts, and neither is a failure of this task. Both say
    // so in the row instead of showing a red one.
    if (!r) return { note: "no metadata to remove" };
    if (ctx.signal.aborted) throw new Error("cancelled");

    ctx.progress(0.8, "writing");
    const out = inPlace
      ? await host.writeFile(task.input, r.bytes, true)
      : await writeSuffixed(host, task.input, r.bytes, "-clean");

    const saved = r.saved > 0 ? `, ${formatSize(r.saved)} smaller` : "";
    return { output: out, note: `${r.removed.length || "no"} tags removed${saved}` };
  };
}

// ── Faces ───────────────────────────────────────────────────────────────────

/**
 * Find every face and blur it, over a whole selection or a watch folder
 * (item 19, unattended half).
 *
 * The one runner here that always writes a copy and never offers an in-place
 * mode. Everything else in this file either moves a file or rewrites bytes it
 * can reconstruct; this one destroys picture information permanently, and it
 * does so on the say-so of a cascade classifier that nobody watched. A missed
 * face means an unblurred copy sitting beside the original, which is a nuisance
 * — an in-place mistake means the original is gone.
 *
 * Zero faces is a result, not a failure: the row says so and nothing is
 * written. Writing an identical copy would turn a queue of forty holiday photos
 * into eighty files and hide the four that actually had somebody in them.
 */
function faceRunner(host: BatchHost): (t: Task, c: RunContext) => Promise<RunResult> {
  return async (task, ctx) => {
    ctx.progress(0.1, "reading");
    const bytes = await host.readAll(task.input, MAX_BYTES);
    if (ctx.signal.aborted) throw new Error("cancelled");

    ctx.progress(0.35, "looking for faces");
    const opts: Partial<BlurImageOptions> = { detect: PHOTO_DETECT, face: {} };
    const amount = num(task.params["amount"]);
    const kind = str(task.params["kind"]);
    if (amount !== undefined) opts.face = { ...opts.face, amount };
    if (kind !== undefined) opts.face = { ...opts.face, kind: kind as BlurKind };

    const result = await blurFacesInImage(bytes, mimeOf(task.input), opts);
    if (!result) throw new Error("could not decode or re-encode this image");
    if (ctx.signal.aborted) throw new Error("cancelled");
    if (result.faces === 0) return { note: "no faces found — nothing written" };

    ctx.progress(0.85, "writing");
    // The extension has to follow the bytes, not the input: everything that is
    // not already a lossy photo comes back re-encoded as PNG, and a PNG called
    // .bmp is a file that half the world refuses to open.
    const inExt = extFor(task.input);
    const outExt = inExt === "jpg" || inExt === "jpeg" || inExt === "webp" ? inExt : "png";
    const out = await writeSuffixed(host, task.input, result.bytes, "-blurred", outExt);
    return {
      output: out,
      note: `${result.faces} ${result.faces === 1 ? "face" : "faces"} blurred`,
    };
  };
}

/**
 * Auto-blur over one file: every category in `task.params.categories` (or
 * every one switched on in the config), the config itself carried in
 * `task.params.config` so a queue restored tomorrow runs with the settings
 * it was queued with. Writes `-blurred` beside the original, like faces.
 */
function autoRunner(host: BatchHost): (t: Task, c: RunContext) => Promise<RunResult> {
  let ocr: Recogniser | null = null;
  return async (task, ctx) => {
    ctx.progress(0.05, "reading");
    const bytes = await host.readAll(task.input, MAX_BYTES);
    if (ctx.signal.aborted) throw new Error("cancelled");

    const config: AutoBlurConfig = sanitize(task.params["config"] ?? defaultConfig());
    const asked = task.params["categories"];
    const categories: AutoCategory[] = Array.isArray(asked)
      ? (asked as unknown[]).filter((c): c is AutoCategory => (AUTO_CATEGORIES as readonly unknown[]).includes(c))
      : enabledCategories(config);
    if (categories.length === 0) return { note: "no categories switched on — nothing written" };
    const needOcr = categories.some((c) => c === "terminals" || c === "cards" || c === "text");
    if (needOcr && !ocr) ocr = new Tesseract();

    ctx.progress(0.2, "looking");
    const result = await autoBlurImage(bytes, mimeOf(task.input), categories, config, {
      runner: getRunner(),
      ocr: needOcr ? ocr : null,
      signal: ctx.signal,
      onProgress: (f, m) => ctx.progress(0.2 + f * 0.6, m),
    });
    if (!result) throw new Error("could not decode or re-encode this image");
    if (ctx.signal.aborted) throw new Error("cancelled");
    if (result.regions.length === 0) return { note: "nothing found — nothing written" };

    ctx.progress(0.85, "writing");
    const inExt = extFor(task.input);
    const outExt = inExt === "jpg" || inExt === "jpeg" || inExt === "webp" ? inExt : "png";
    const out = await writeSuffixed(host, task.input, result.bytes, "-blurred", outExt);
    const by = new Map<string, number>();
    for (const d of result.found) by.set(d.category, (by.get(d.category) ?? 0) + 1);
    return {
      output: out,
      note: [...by].map(([c, n]) => `${n} ${c}`).join(", ") + " blurred",
    };
  };
}

/**
 * What the browser will admit to being able to decode, from the extension.
 *
 * `createImageBitmap` sniffs the bytes and mostly ignores this, but a Blob with
 * no type at all makes some builds refuse outright, so it is worth being
 * approximately right. HEIC is listed because the shell claims to open it; if
 * the WebView cannot, the runner fails with a decode error naming the file,
 * which is the honest outcome.
 */
function mimeOf(path: string): string {
  const ext = extFor(path);
  switch (ext) {
    case "jpg": case "jpeg": case "jfif": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "avif": return "image/avif";
    case "heic": case "heif": return "image/heic";
    default: return "";
  }
}

function extFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}

/**
 * `<name>-clean.<ext>`, stepping to `-clean-2` rather than overwriting.
 *
 * The same rule the metadata panel uses, and for the same reason: losing the
 * first cleaned copy to the second would be a silent data loss inside the one
 * operation whose whole promise is that it does not touch what exists.
 *
 * The suffix is a parameter because `rules.ts` reserves a fixed set of them —
 * `-clean`, `-blurred`, `-converted`, `-fixed` — and treats any file wearing
 * one as FACET's own output that a watch rule must never fire on again. A
 * runner inventing its own suffix would slip that net and loop.
 */
async function writeSuffixed(
  host: BatchHost,
  path: string,
  bytes: Uint8Array,
  suffix: string,
  ext?: string,
): Promise<string> {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const hasExt = dot > slash;
  const stem = hasExt ? path.slice(0, dot) : path;
  // An explicit extension for the case where the output format is not the
  // input's — a blurred PNG written beside a BMP is still a PNG.
  const tail = ext !== undefined ? (ext ? `.${ext}` : "") : hasExt ? path.slice(dot) : "";
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? `${stem}${suffix}${tail}` : `${stem}${suffix}-${n}${tail}`;
    try {
      return await host.writeFile(candidate, bytes, false);
    } catch {
      // Taken. Try the next number.
    }
  }
  throw new Error(`twenty ${suffix.replace(/^-/, "")} copies already exist beside this file`);
}

// ── Encoders ────────────────────────────────────────────────────────────────

function audioRunner(host: BatchHost): (t: Task, c: RunContext) => Promise<RunResult> {
  return (task, ctx) => {
    const format = String(task.params["format"] ?? "mp3");
    const output = task.output || swapExt(task.input, format, "-converted");
    // Optional keys are assigned rather than passed as `undefined`:
    // `exactOptionalPropertyTypes` makes an explicit undefined a different type
    // from an absent key, and the Rust side treats absent as "leave it alone".
    const job: AudioJob = {
      inputs: [task.input],
      output,
      normalize: task.params["normalize"] === true,
      mono: task.params["mono"] === true,
    };
    const bitrate = num(task.params["bitrate"]);
    if (bitrate !== undefined) job.bitrate = bitrate;
    const denoise = str(task.params["denoise"]);
    if (denoise !== undefined) job.denoise = denoise;
    return encode(host, ctx, () => host.runAudioJob(job), output);
  };
}

function videoRunner(host: BatchHost): (t: Task, c: RunContext) => Promise<RunResult> {
  return (task, ctx) => {
    const format = String(task.params["format"] ?? "mp4");
    const output = task.output || swapExt(task.input, format, "-converted");
    const scale = task.params["scale"];
    const job: Job = {
      inputs: [task.input],
      output,
      scale: Array.isArray(scale) ? (scale as [number, number]) : null,
      mute: task.params["mute"] === true,
    };
    const quality = num(task.params["quality"]);
    if (quality !== undefined) job.quality = quality;
    return encode(host, ctx, () => host.runJob(job), output);
  };
}

/**
 * Drive one ffmpeg run and resolve when *that* run finishes.
 *
 * Both encoders share one progress channel and one done channel, so every
 * message has to be filtered by the job id — and the id only exists after the
 * job has started. The listeners are therefore attached *before* the spawn and
 * buffer against a null id, because a short job can finish before the promise
 * that produced its id has resolved. Attaching afterwards loses that job's
 * completion and hangs the queue on a task that is already done.
 */
function encode(
  host: BatchHost,
  ctx: RunContext,
  spawn: () => Promise<number>,
  output: string,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let id: number | null = null;
    let settled = false;
    let pending: JobDone | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      offProgress();
      offDone();
      ctx.signal.removeEventListener("abort", onAbort);
      fn();
    };

    const offProgress = host.onProgress((p) => {
      if (id !== null && p.id === id) {
        const speed = p.speed > 0 ? `${p.speed.toFixed(1)}×` : "";
        const fps = p.fps > 0 ? `${Math.round(p.fps)} fps` : "";
        ctx.progress(p.fraction, [speed, fps].filter(Boolean).join(" · "));
      }
    });

    const settleWith = (d: JobDone): void => {
      if (d.ok) {
        finish(() =>
          resolve({
            output: d.output || output,
            leftover: d.leftover,
            note: d.copied ? "copied, original bytes" : "",
          }),
        );
      } else {
        finish(() =>
          reject(new Error(d.leftover ? `${d.error} (partial: ${d.leftover})` : d.error)),
        );
      }
    };

    const offDone = host.onDone((d) => {
      if (id === null) pending = d;
      else if (d.id === id) settleWith(d);
    });

    const onAbort = (): void => {
      if (id !== null) void host.cancelJob(id);
      finish(() => reject(new Error("cancelled")));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    if (ctx.signal.aborted) {
      onAbort();
      return;
    }

    spawn().then(
      (jobId) => {
        id = jobId;
        // If the run finished while we were still waiting for its id, the
        // buffered message is the answer.
        if (pending && pending.id === jobId) settleWith(pending);
        else if (ctx.signal.aborted) onAbort();
      },
      (e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

// ── Small helpers ───────────────────────────────────────────────────────────

/**
 * A new extension beside the original, with a suffix so a convert-to-the-same-
 * format never lands on top of its own input. Overwriting the source of a batch
 * halfway through it is not a recoverable mistake.
 */
export function swapExt(path: string, ext: string, suffix: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const stem = dot > slash ? path.slice(0, dot) : path;
  return `${stem}${suffix}.${ext}`;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
