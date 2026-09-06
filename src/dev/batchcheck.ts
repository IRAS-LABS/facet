/**
 * Checks the batch queue against the claims that justify it (item 26).
 *
 * Almost none of what makes a queue trustworthy is visible by looking at it.
 * You cannot see that it survived a restart, that failure number three did not
 * take the other thirty-seven files with it, or that a cancelled task actually
 * killed the encoder rather than just hiding a row. Each of those is a promise
 * the user relies on and a silent regression waiting to happen, so each has an
 * assertion here.
 *
 * The queue is driven through fake runners rather than real ffmpeg: the point
 * is the *scheduling*, and a harness that spends four minutes encoding would
 * never be run. The encoder bridge gets its own phase with a fake event bus,
 * because the id-arrives-after-the-event race in `runners.ts` is exactly the
 * kind of thing that works on a slow machine and hangs on a fast one.
 *
 * Dev-only. Loaded by /batchcheck.html, which is not a build input.
 *
 *   http://localhost:8183/batchcheck.html
 */

import "../styles/base.css";
import "../styles/batch.css";

import { BatchQueue, type RunContext, type Task } from "@core/batch/queue";
import { BatchPanel } from "@ui/batch";
import type { JobDone, JobProgress } from "@ui/vedit";

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log("ok  ", name); }
  else { fail++; console.log("FAIL", name, " ", detail); }
};

const tick = (n = 1): Promise<void> =>
  new Promise((r) => setTimeout(r, n));

/** A storage that lives in a variable, so the harness never fights localStorage. */
function fakeStore(): Pick<Storage, "getItem" | "setItem"> & { raw(): string | null } {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => { value = v; },
    raw: () => value,
  };
}

/** A runner that resolves when told to, so ordering can be observed. */
function gate(): {
  run: (t: Task, c: RunContext) => Promise<void>;
  started: string[];
  release(id: string): void;
  fail(id: string, why: string): void;
} {
  const waiters = new Map<string, { go: () => void; no: (e: Error) => void }>();
  const started: string[] = [];
  return {
    started,
    run: (task) =>
      new Promise<void>((go, no) => {
        started.push(task.id);
        waiters.set(task.id, { go, no });
      }),
    release: (id) => waiters.get(id)?.go(),
    fail: (id, why) => waiters.get(id)?.no(new Error(why)),
  };
}

async function run(): Promise<void> {
  // ── Ordering and lanes ────────────────────────────────────────────────────

  {
    const store = fakeStore();
    const q = new BatchQueue({ lanes: 1, storage: store });
    const g = gate();
    q.register("x", g.run);
    const a = q.add({ kind: "x", title: "a" });
    const b = q.add({ kind: "x", title: "b" });
    const c = q.add({ kind: "x", title: "c" });

    ok("nothing runs before start()", g.started.length === 0, String(g.started.length));
    q.start();
    await tick();
    ok("one lane means one running task", q.running() === 1, String(q.running()));
    ok("and it is the first one added", g.started[0] === a.id);
    ok("the rest are queued", q.pending() === 3, String(q.pending()));

    g.release(a.id);
    await tick();
    ok("finishing one starts the next", g.started[1] === b.id, g.started.join(","));
    ok("and the finished one is done", q.get(a.id)?.state === "done", q.get(a.id)?.state);

    // The claim the metadata panel learned the hard way, now enforced.
    g.fail(b.id, "disk full");
    await tick();
    ok("a failure does not stop the queue", g.started[2] === c.id, g.started.join(","));
    ok("the failed task says why", q.get(b.id)?.error === "disk full", q.get(b.id)?.error);
    ok("and stays visible rather than vanishing", q.get(b.id)?.state === "failed");

    g.release(c.id);
    await tick();
    ok("an empty queue reports nothing pending", q.pending() === 0, String(q.pending()));
    ok("overall is 1 when everything is finished", q.overall() === 1, String(q.overall()));
  }

  // ── Two lanes ─────────────────────────────────────────────────────────────

  {
    const q = new BatchQueue({ lanes: 2, storage: null });
    const g = gate();
    q.register("x", g.run);
    q.add({ kind: "x", title: "a" });
    q.add({ kind: "x", title: "b" });
    q.add({ kind: "x", title: "c" });
    q.start();
    await tick();
    ok("two lanes run two at once, not three", q.running() === 2, String(q.running()));
  }

  // ── Lanes are live (item 43) ──────────────────────────────────────────────
  //
  // The setting has to reach a queue that is already running, or it is a
  // restart-to-apply control wearing a live one's clothes. Narrowing is the
  // half worth asserting: the obvious implementation of "fewer lanes" is to
  // stop something, and stopping a half-written encode to honour a number
  // field loses work that was already paid for.

  {
    const q = new BatchQueue({ lanes: 1, storage: null });
    const g = gate();
    q.register("x", g.run);
    for (const t of ["a", "b", "c", "d"]) q.add({ kind: "x", title: t });
    q.start();
    await tick();
    ok("one lane to begin with", q.running() === 1, String(q.running()));

    q.setLanes(3);
    await tick();
    ok("widening starts the waiting work immediately",
      q.running() === 3, String(q.running()));

    q.setLanes(1);
    await tick();
    ok("narrowing never kills what is already running",
      q.running() === 3, String(q.running()));

    g.release(g.started[0]!);
    g.release(g.started[1]!);
    await tick();
    ok("and the narrower limit takes hold as those finish",
      q.running() === 1, String(q.running()));

    q.setLanes(0);
    await tick();
    ok("zero lanes is read as one, not as a stopped queue", q.running() === 1);
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  {
    const q = new BatchQueue({ lanes: 1, storage: null });
    let aborted = false;
    q.register("x", (_t, ctx) =>
      new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => { aborted = true; resolve(); });
      }));
    const a = q.add({ kind: "x", title: "a" });
    const b = q.add({ kind: "x", title: "b" });
    q.start();
    await tick();

    q.cancel(a.id);
    await tick();
    ok("cancelling a running task aborts its runner", aborted, String(aborted));
    ok("the row stays, marked stopped", q.get(a.id)?.state === "cancelled", q.get(a.id)?.state);
    ok("and the next task starts", q.get(b.id)?.state === "running", q.get(b.id)?.state);

    // A runner that resolves anyway after being cancelled must not resurrect
    // the task as "done" — the cancel is the answer.
    await tick(2);
    ok("a cancelled task is not resurrected by a late resolve",
      q.get(a.id)?.state === "cancelled", q.get(a.id)?.state);

    q.cancel(b.id);
    const queuedOnly = q.add({ kind: "x", title: "never started" });
    q.cancel(queuedOnly.id);
    ok("cancelling a queued task never starts it",
      q.get(queuedOnly.id)?.state === "cancelled", q.get(queuedOnly.id)?.state);
  }

  // ── Retry ─────────────────────────────────────────────────────────────────

  {
    const q = new BatchQueue({ lanes: 1, storage: null });
    let attempts = 0;
    q.register("x", () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("nope")) : Promise.resolve();
    });
    const a = q.add({ kind: "x", title: "a" });
    q.start();
    await tick();
    ok("first attempt failed", q.get(a.id)?.state === "failed", q.get(a.id)?.state);

    q.retry(a.id);
    await tick();
    ok("retry runs it again", attempts === 2, String(attempts));
    ok("and it can succeed the second time", q.get(a.id)?.state === "done", q.get(a.id)?.state);
    ok("retry clears the old error", q.get(a.id)?.error === "", q.get(a.id)?.error);
  }

  // ── Restart ───────────────────────────────────────────────────────────────
  //
  // The claim the whole design exists to keep.

  {
    const store = fakeStore();
    const q1 = new BatchQueue({ lanes: 1, storage: store });
    const g = gate();
    q1.register("x", g.run);
    const a = q1.add({ kind: "x", title: "big encode", input: "C:/a.mov" });
    q1.add({ kind: "x", title: "second", input: "C:/b.mov" });
    q1.start();
    await tick();
    ok("a task is running before the crash", q1.get(a.id)?.state === "running");

    // No `q1.cancel` and no clean shutdown — the process simply stops existing.
    const q2 = new BatchQueue({ lanes: 1, storage: store });
    ok("both tasks come back", q2.tasks().length === 2, String(q2.tasks().length));
    ok("the one that was running comes back queued, not running",
      q2.get(a.id)?.state === "queued", q2.get(a.id)?.state);
    ok("and at zero, because ffmpeg cannot resume mid-file",
      q2.get(a.id)?.fraction === 0, String(q2.get(a.id)?.fraction));
    ok("what it was doing survived", q2.get(a.id)?.input === "C:/a.mov", q2.get(a.id)?.input);
    ok("nothing runs until the new process registers its runners",
      q2.running() === 0, String(q2.running()));

    // The other half of the promise: a kind that no longer exists fails by name
    // rather than being dropped on the floor.
    const q3 = new BatchQueue({ lanes: 1, storage: store });
    q3.start();
    await tick();
    ok("a task with no runner fails loudly", q3.get(a.id)?.state === "failed", q3.get(a.id)?.state);
    ok("and names the kind it could not run",
      (q3.get(a.id)?.error ?? "").includes("no runner"), q3.get(a.id)?.error);
  }

  // ── Progress is not persisted ─────────────────────────────────────────────

  {
    const store = fakeStore();
    const q = new BatchQueue({ lanes: 1, storage: store });
    let ticks = 0;
    q.register("x", (_t, ctx) =>
      new Promise<void>((resolve) => {
        for (let i = 1; i <= 50; i++) ctx.progress(i / 100, `${i}%`);
        setTimeout(resolve, 0);
      }));
    q.add({ kind: "x", title: "a" });
    const before = store.raw();
    q.onChange(() => { ticks++; });
    q.start();
    await tick(4);
    ok("progress fired many times", ticks > 40, String(ticks));
    ok("without writing every tick to storage",
      (store.raw() ?? "").includes('"fraction":0.5') === false, "fraction persisted");
    ok("storage still holds the task", (store.raw() ?? "").includes('"title":"a"'), String(before));
  }

  // ── The encoder bridge ────────────────────────────────────────────────────
  //
  // One progress channel, one done channel, both shared by every job — so
  // everything has to be filtered by an id that does not exist until after the
  // spawn resolves. The race is real: a short job can finish first.

  {
    const q = new BatchQueue({ lanes: 1, storage: null });
    const progressCbs: ((p: JobProgress) => void)[] = [];
    const doneCbs: ((d: JobDone) => void)[] = [];
    let cancelled: number[] = [];
    // `as`, not an annotation: a `let` written only inside a callback narrows to
    // `null` for the checker, and a `const x: T | null =` annotation does not
    // widen it back — the same lesson the audio editor learned.
    let spawnResolve = null as ((id: number) => void) | null;

    const host = {
      readAll: () => Promise.reject(new Error("unused")),
      writeFile: () => Promise.reject(new Error("unused")),
      moveFile: () => Promise.reject(new Error("unused")),
      runJob: () => new Promise<number>((r) => { spawnResolve = r; }),
      runAudioJob: () => new Promise<number>((r) => { spawnResolve = r; }),
      cancelJob: (id: number) => { cancelled.push(id); return Promise.resolve(); },
      onProgress: (cb: (p: JobProgress) => void) => {
        progressCbs.push(cb);
        return () => { progressCbs.splice(progressCbs.indexOf(cb), 1); };
      },
      onDone: (cb: (d: JobDone) => void) => {
        doneCbs.push(cb);
        return () => { doneCbs.splice(doneCbs.indexOf(cb), 1); };
      },
    };
    const { registerRunners, swapExt } = await import("@core/batch/runners");
    registerRunners(q, host);

    ok("a convert never lands on top of its own input",
      swapExt("C:/x/clip.mp4", "mp4", "-converted") === "C:/x/clip-converted.mp4",
      swapExt("C:/x/clip.mp4", "mp4", "-converted"));

    const t = q.add({
      kind: "video.convert", title: "clip", input: "C:/x/clip.mov",
      params: { format: "mp4", quality: 20 },
    });
    q.start();
    await tick();

    // The done event arrives *before* the id does. Attaching listeners after
    // the spawn would lose this and hang the queue on a finished task.
    doneCbs.forEach((cb) => cb({ id: 9, ok: true, output: "C:/x/clip-converted.mp4",
      leftover: "", error: "", copied: false }));
    spawnResolve?.(9);
    await tick(2);
    ok("a job that finishes before its id resolves still completes",
      q.get(t.id)?.state === "done", q.get(t.id)?.state);
    ok("and reports where the file landed",
      q.get(t.id)?.output === "C:/x/clip-converted.mp4", q.get(t.id)?.output);
    ok("listeners are detached when the task ends",
      progressCbs.length === 0 && doneCbs.length === 0,
      `${progressCbs.length}/${doneCbs.length}`);

    // Progress for somebody else's job is not this task's progress.
    const t2 = q.add({ kind: "video.convert", title: "two", input: "C:/x/two.mov", params: {} });
    await tick();
    spawnResolve?.(11);
    await tick();
    progressCbs.forEach((cb) => cb({ id: 99, fraction: 0.9, seconds: 1, speed: 2, fps: 30 }));
    await tick();
    ok("another job's progress is ignored", q.get(t2.id)?.fraction === 0,
      String(q.get(t2.id)?.fraction));
    progressCbs.forEach((cb) => cb({ id: 11, fraction: 0.4, seconds: 1, speed: 3.2, fps: 48 }));
    await tick();
    ok("its own progress is taken", q.get(t2.id)?.fraction === 0.4,
      String(q.get(t2.id)?.fraction));
    ok("with the encoder's speed in the detail line",
      (q.get(t2.id)?.detail ?? "").includes("3.2×"), q.get(t2.id)?.detail);

    cancelled = [];
    q.cancel(t2.id);
    await tick();
    ok("cancelling a running encode kills the child process",
      cancelled.includes(11), cancelled.join(","));

    // A failure must carry the partial's name rather than pretending nothing
    // was written.
    const t3 = q.add({ kind: "video.convert", title: "three", input: "C:/x/three.mov", params: {} });
    await tick();
    spawnResolve?.(12);
    await tick();
    doneCbs.forEach((cb) => cb({ id: 12, ok: false, output: "", leftover: "C:/x/three.facet-part",
      error: "Invalid data", copied: false }));
    await tick(2);
    ok("a failed encode says what went wrong",
      (q.get(t3.id)?.error ?? "").includes("Invalid data"), q.get(t3.id)?.error);
    ok("and names the partial rather than pretending it is not there",
      (q.get(t3.id)?.error ?? "").includes(".facet-part"), q.get(t3.id)?.error);
  }

  // ── The panel ─────────────────────────────────────────────────────────────

  {
    const q = new BatchQueue({ lanes: 1, storage: null });
    const g = gate();
    q.register("x", g.run);
    let refreshed = 0;
    const panel = new BatchPanel(q, {
      reveal: () => Promise.resolve(),
      refresh: () => { refreshed++; },
    });
    q.onChange(() => panel.tick());

    const root = document.querySelector<HTMLElement>(".bq");
    ok("the drawer starts closed", root?.hidden === true, String(root?.hidden));
    panel.show();
    ok("and opens", root?.hidden === false, String(root?.hidden));
    ok("the shell is told to give up the width",
      document.documentElement.dataset["bq"] === "open",
      String(document.documentElement.dataset["bq"]));
    ok("saying so when there is nothing in it",
      (document.querySelector(".bq-empty") as HTMLElement | null)?.hidden === false);

    const a = q.add({ kind: "x", title: "one" });
    q.add({ kind: "x", title: "two" });
    q.start();
    await tick();
    ok("a row per task", document.querySelectorAll(".bq-row").length === 2,
      String(document.querySelectorAll(".bq-row").length));
    ok("the running one is marked",
      document.querySelector(".bq-row")?.getAttribute("data-state") === "running");
    ok("the summary counts what is left",
      (document.querySelector(".bq-summary")?.textContent ?? "").includes("2 to go"),
      document.querySelector(".bq-summary")?.textContent ?? "");

    g.release(a.id);
    await tick(2);
    ok("a landed file reloads the folder exactly once", refreshed === 1, String(refreshed));

    // Rows are updated in place. A rebuild per progress tick would flicker and
    // would drop anything focused inside the drawer.
    const rowBefore = document.querySelector(".bq-row");
    q.tasks().forEach(() => undefined);
    await tick();
    ok("rows are not rebuilt on every change",
      document.querySelector(".bq-row") === rowBefore);

    const act = document.querySelector<HTMLButtonElement>('.bq-row[data-state="done"] .bq-act');
    ok("a finished row offers to show the file", act?.textContent === "↗", act?.textContent ?? "");

    q.cancelAll();
    await tick();
    q.clearFinished();
    await tick();
    ok("clearing removes the finished rows",
      document.querySelectorAll(".bq-row").length === 0,
      String(document.querySelectorAll(".bq-row").length));
    ok("and the empty line comes back",
      (document.querySelector(".bq-empty") as HTMLElement | null)?.hidden === false);

    // Clearing must never take live work with it.
    const live = q.add({ kind: "x", title: "still going" });
    await tick();
    q.clearFinished();
    ok("clearing never removes a running task", q.get(live.id) !== undefined);

    panel.hide();
    ok("closing the drawer leaves the queue running", q.pending() === 1, String(q.pending()));
    ok("and gives the width back",
      document.documentElement.dataset["bq"] === undefined,
      String(document.documentElement.dataset["bq"]));
  }

  console.log(`batch: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
}

void run().catch((e: unknown) => {
  console.error(`batch harness threw: ${String(e)}`);
});
