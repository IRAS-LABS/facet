/**
 * The batch queue (item 26).
 *
 * One queue, any operation, survives a restart.
 *
 * The design decision everything else follows from: **a task is a description,
 * not a closure.** A closure cannot be written to disk and cannot be picked up
 * by the next launch, so a task is a plain serialisable record — kind, paths,
 * parameters — and a separate registry maps a `kind` to the function that runs
 * it. That indirection is the entire reason the queue is resumable, and it is
 * why enqueueing takes a string rather than a callback.
 *
 * What "resumable" honestly means here: the *queue* resumes, not the individual
 * encode. ffmpeg cannot restart four minutes into a file, so a task that was
 * running when the app died comes back **queued** and starts over. The UI says
 * so rather than implying a half-finished file is waiting somewhere. The
 * partial itself is not orphaned silently either: the encoder stages to
 * `<name>.facet-part` and renames on success, so a killed run leaves a partial
 * and no output, and the leftover path is recorded on the task.
 */

export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  /** Registry key. Decides which runner executes this. */
  kind: string;
  /** What the row says. Written once at enqueue so a resumed task still reads. */
  title: string;
  input: string;
  output: string;
  /** Runner-specific, and required to be JSON-serialisable — see the note above. */
  params: Record<string, unknown>;
  state: TaskState;
  /** 0..1. Deliberately not persisted; see `#save`. */
  fraction: number;
  /** The live right-hand line: "3.2× · 48 fps", "12 of 40". */
  detail: string;
  error: string;
  /** A partial file this task left behind, if the runner reported one. */
  leftover: string;
  added: number;
  finished: number;
}

export interface RunContext {
  /** Report progress. Cheap to call often — nothing here touches storage. */
  progress(fraction: number, detail?: string): void;
  /** Aborts when the task is cancelled. Runners that spawn a child await it. */
  signal: AbortSignal;
}

export interface RunResult {
  /** Where the result actually landed, if the runner chose the name. */
  output?: string;
  /** A partial left behind. Reported even on success, so the UI can be honest. */
  leftover?: string;
  /** Replaces the detail line on completion: "2.1 MB of metadata removed". */
  note?: string;
}

export type Runner = (task: Task, ctx: RunContext) => Promise<RunResult | void>;

export interface QueueOptions {
  /**
   * How many tasks run at once. **One** by default, and that is not timidity:
   * ffmpeg saturates the CPU, so four encodes at once finish later than four in
   * sequence *and* make every progress bar meaningless. Cheap I/O work
   * (metadata) is enqueued with its own lane count.
   */
  lanes?: number;
  /** Where to persist. Injectable so the harness does not fight localStorage. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  key?: string;
  now?: () => number;
}

const KEY = "facet.batch.v1";

/** Tasks kept after they finish. Enough to answer "did that work?", not a log. */
const KEEP_DONE = 60;

export class BatchQueue {
  #tasks: Task[] = [];
  #runners = new Map<string, Runner>();
  #aborts = new Map<string, AbortController>();
  #listeners = new Set<() => void>();
  #lanes: number;
  #store: Pick<Storage, "getItem" | "setItem"> | null;
  #key: string;
  #now: () => number;
  #seq = 0;
  #started = false;

  constructor(opts: QueueOptions = {}) {
    this.#lanes = Math.max(1, opts.lanes ?? 1);
    this.#store = opts.storage === undefined ? safeStorage() : opts.storage;
    this.#key = opts.key ?? KEY;
    this.#now = opts.now ?? (() => Date.now());
    this.#load();
  }

  /** Register the function that runs a kind. Must happen before `start()`. */
  register(kind: string, run: Runner): void {
    this.#runners.set(kind, run);
  }

  /**
   * Begin working. Separate from the constructor on purpose: a restored queue
   * must not start executing while the app is still registering its runners,
   * or the first restored task fails with "no runner" through no fault of its
   * own.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#pump();
  }

  add(spec: {
    kind: string;
    title: string;
    input?: string;
    output?: string;
    params?: Record<string, unknown>;
  }): Task {
    const task: Task = {
      id: `t${++this.#seq}-${this.#now().toString(36)}`,
      kind: spec.kind,
      title: spec.title,
      input: spec.input ?? "",
      output: spec.output ?? "",
      params: spec.params ?? {},
      state: "queued",
      fraction: 0,
      detail: "",
      error: "",
      leftover: "",
      added: this.#now(),
      finished: 0,
    };
    this.#tasks.push(task);
    this.#save();
    this.#emit();
    this.#pump();
    return task;
  }

  /** Enqueue a run of the same kind over many files, as one task each. */
  addMany(
    kind: string,
    inputs: readonly string[],
    make: (input: string, index: number) => {
      title: string;
      output?: string;
      params?: Record<string, unknown>;
    },
  ): Task[] {
    return inputs.map((input, i) => this.add({ kind, input, ...make(input, i) }));
  }

  tasks(): readonly Task[] {
    return this.#tasks;
  }

  get(id: string): Task | undefined {
    return this.#tasks.find((t) => t.id === id);
  }

  /** Queued, running, or both — what the status bar counts. */
  pending(): number {
    return this.#tasks.filter((t) => t.state === "queued" || t.state === "running").length;
  }

  running(): number {
    return this.#tasks.filter((t) => t.state === "running").length;
  }

  /**
   * Overall progress across everything still to do, 0..1.
   *
   * Counted in whole tasks plus the running one's fraction rather than in bytes
   * or seconds: the queue does not know how long a file takes until it runs, and
   * a bar that jumps because file nine was longer than file eight is worse than
   * one that steps evenly.
   */
  overall(): number {
    const live = this.#tasks.filter((t) => t.state !== "cancelled");
    if (live.length === 0) return 1;
    let sum = 0;
    for (const t of live) {
      if (t.state === "done" || t.state === "failed") sum += 1;
      else if (t.state === "running") sum += t.fraction;
    }
    return sum / live.length;
  }

  /**
   * Stop a task. A running one is aborted through its runner's signal; a queued
   * one simply never starts. Either way it stays in the list as `cancelled`,
   * because a row that vanishes when you press stop leaves you wondering
   * whether it stopped or finished.
   */
  cancel(id: string): void {
    const t = this.get(id);
    if (!t || t.state === "done" || t.state === "failed" || t.state === "cancelled") return;
    this.#aborts.get(id)?.abort();
    this.#aborts.delete(id);
    t.state = "cancelled";
    t.finished = this.#now();
    this.#save();
    this.#emit();
    this.#pump();
  }

  cancelAll(): void {
    for (const t of [...this.#tasks]) {
      if (t.state === "queued" || t.state === "running") this.cancel(t.id);
    }
  }

  /** Put a failed or cancelled task back at the end of the queue. */
  retry(id: string): void {
    const t = this.get(id);
    if (!t || t.state === "queued" || t.state === "running") return;
    t.state = "queued";
    t.fraction = 0;
    t.error = "";
    t.detail = "";
    t.finished = 0;
    this.#save();
    this.#emit();
    this.#pump();
  }

  /** Drop the finished rows. Never touches anything still queued or running. */
  clearFinished(): void {
    this.#tasks = this.#tasks.filter(
      (t) => t.state === "queued" || t.state === "running",
    );
    this.#save();
    this.#emit();
  }

  /** Remove one row outright. Cancels first if it is still live. */
  remove(id: string): void {
    this.cancel(id);
    this.#tasks = this.#tasks.filter((t) => t.id !== id);
    this.#save();
    this.#emit();
  }

  /**
   * Change how many tasks may run at once, live (item 43).
   *
   * Raising it starts more immediately; lowering it never kills anything that
   * is already running, because an encode two minutes in would be two minutes
   * wasted and the user asked for fewer *at once*, not for one to be thrown
   * away. The extras drain and the new ceiling applies from then on.
   */
  setLanes(n: number): void {
    this.#lanes = Math.max(1, Math.floor(n));
    this.#pump();
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #pump(): void {
    if (!this.#started) return;
    while (this.running() < this.#lanes) {
      const next = this.#tasks.find((t) => t.state === "queued");
      if (!next) return;
      void this.#run(next);
    }
  }

  async #run(task: Task): Promise<void> {
    const runner = this.#runners.get(task.kind);
    if (!runner) {
      // A restored task whose kind no longer exists — a build that dropped an
      // operation, say. Failing it by name beats silently discarding work the
      // user asked for.
      task.state = "failed";
      task.error = `no runner for "${task.kind}"`;
      task.finished = this.#now();
      this.#save();
      this.#emit();
      return;
    }

    const abort = new AbortController();
    this.#aborts.set(task.id, abort);
    task.state = "running";
    task.fraction = 0;
    task.error = "";
    this.#save();
    this.#emit();

    const ctx: RunContext = {
      progress: (fraction, detail) => {
        // Progress is not persisted and does not restart the queue — it fires
        // several times a second and writing that to storage would make the
        // encode slower than the encode.
        if (task.state !== "running") return;
        task.fraction = Math.max(0, Math.min(1, fraction));
        if (detail !== undefined) task.detail = detail;
        this.#emit();
      },
      signal: abort.signal,
    };

    try {
      const result = (await runner(task, ctx)) ?? {};
      // A task cancelled mid-run must not be resurrected as "done" by a runner
      // that returned anyway — the state set by `cancel` wins.
      if (task.state !== "running") return;
      if (result.output) task.output = result.output;
      task.leftover = result.leftover ?? "";
      task.detail = result.note ?? "";
      task.fraction = 1;
      task.state = "done";
    } catch (e) {
      if (task.state !== "running") return;
      task.state = "failed";
      task.error = String(e instanceof Error ? e.message : e).slice(0, 200);
    } finally {
      this.#aborts.delete(task.id);
      task.finished = this.#now();
      this.#trim();
      this.#save();
      this.#emit();
      // One failure does not stop the run. A queue that aborts on the third of
      // forty files leaves you with no idea which of the other thirty-seven
      // were done.
      this.#pump();
    }
  }

  #trim(): void {
    const finished = this.#tasks.filter((t) => t.state !== "queued" && t.state !== "running");
    if (finished.length <= KEEP_DONE) return;
    const drop = new Set(finished.slice(0, finished.length - KEEP_DONE).map((t) => t.id));
    this.#tasks = this.#tasks.filter((t) => !drop.has(t.id));
  }

  #emit(): void {
    for (const cb of this.#listeners) cb();
  }

  #save(): void {
    if (!this.#store) return;
    try {
      // Progress and the live detail line are dropped on the way out: they are
      // true only of a process that no longer exists once this file is read.
      const out = this.#tasks.map((t) => ({
        ...t,
        fraction: t.state === "done" ? 1 : 0,
        detail: t.state === "running" ? "" : t.detail,
        state: t.state === "running" ? "queued" : t.state,
      }));
      this.#store.setItem(this.#key, JSON.stringify({ v: 1, seq: this.#seq, tasks: out }));
    } catch {
      // A full or disabled store must not take the queue down with it. Losing
      // the ability to resume is a worse day than it sounds like, but it is a
      // much better day than losing the running batch.
    }
  }

  #load(): void {
    if (!this.#store) return;
    let raw: string | null = null;
    try {
      raw = this.#store.getItem(this.#key);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { seq?: number; tasks?: unknown };
      if (!Array.isArray(parsed.tasks)) return;
      this.#seq = typeof parsed.seq === "number" ? parsed.seq : 0;
      this.#tasks = parsed.tasks
        .map((t) => normalise(t))
        .filter((t): t is Task => t !== null);
    } catch {
      // Corrupt state is dropped rather than crashing the launch. The queue is
      // a convenience; the file explorer behind it is not.
      this.#tasks = [];
    }
  }
}

/**
 * A restored row, checked field by field.
 *
 * Anything that was `running` when the process died comes back **queued**: the
 * encoder it belonged to is gone, and marking it running would show a progress
 * bar for a process that does not exist.
 */
function normalise(raw: unknown): Task | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["kind"] !== "string") return null;
  const state = r["state"];
  const ok = state === "done" || state === "failed" || state === "cancelled";
  return {
    id: r["id"],
    kind: r["kind"],
    title: typeof r["title"] === "string" ? r["title"] : r["kind"],
    input: typeof r["input"] === "string" ? r["input"] : "",
    output: typeof r["output"] === "string" ? r["output"] : "",
    params:
      typeof r["params"] === "object" && r["params"] !== null
        ? (r["params"] as Record<string, unknown>)
        : {},
    state: ok ? (state as TaskState) : "queued",
    fraction: state === "done" ? 1 : 0,
    detail: typeof r["detail"] === "string" ? r["detail"] : "",
    error: typeof r["error"] === "string" ? r["error"] : "",
    leftover: typeof r["leftover"] === "string" ? r["leftover"] : "",
    added: typeof r["added"] === "number" ? r["added"] : 0,
    finished: typeof r["finished"] === "number" ? r["finished"] : 0,
  };
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
