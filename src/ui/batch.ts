/**
 * The batch panel (item 26) — what the queue is doing, and the buttons to
 * interfere with it.
 *
 * A **drawer**, not a modal. Every other panel in FACET takes the screen
 * because it is the thing you are doing; a queue is the opposite — the entire
 * reason to have one is that you walk away and keep browsing while it runs.
 * Covering the file list with it would defeat the feature it is implementing.
 *
 * It repaints on every progress tick, so the repaint has to be cheap: rows are
 * built once per task and afterwards only their four changing parts are
 * written. Rebuilding the list on each tick would drop the selection out of the
 * name field and make the panel flicker at whatever rate ffmpeg reports.
 */

import type { BatchQueue, Task, TaskState } from "@core/batch/queue";

export interface BatchPanelHost {
  /** Show a finished file where it landed. */
  reveal(path: string): Promise<void>;
  /** Called when a task finishes so the folder shows the new file. */
  refresh(): void;
}

interface Row {
  root: HTMLElement;
  title: HTMLElement;
  detail: HTMLElement;
  fill: HTMLElement;
  act: HTMLButtonElement;
  state: TaskState | null;
}

const STATE_WORD: Record<TaskState, string> = {
  queued: "waiting",
  running: "",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

export class BatchPanel {
  private readonly root = document.createElement("aside");
  private readonly head = document.createElement("div");
  private readonly summary = document.createElement("p");
  private readonly list = document.createElement("div");
  private readonly empty = document.createElement("p");
  private readonly foot = document.createElement("div");
  private readonly stopAll = document.createElement("button");
  private readonly clear = document.createElement("button");

  private readonly rows = new Map<string, Row>();
  private off: (() => void) | null = null;
  /** Tasks already reported to the shell, so a refresh fires once per file. */
  private readonly announced = new Set<string>();

  constructor(
    private readonly queue: BatchQueue,
    private readonly host: BatchPanelHost,
  ) {
    this.root.className = "bq";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Batch queue");

    this.head.className = "bq-head";
    const title = document.createElement("h3");
    title.className = "bq-title";
    title.textContent = "Queue";
    this.summary.className = "bq-summary";
    const close = document.createElement("button");
    close.className = "bq-x";
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close (the queue keeps running)";
    close.addEventListener("click", () => this.hide());
    this.head.append(title, this.summary, close);

    this.list.className = "bq-list";
    this.empty.className = "bq-empty";
    this.empty.textContent = "Nothing queued.";

    this.foot.className = "bq-foot";
    this.stopAll.className = "bq-btn";
    this.stopAll.type = "button";
    this.stopAll.textContent = "Stop all";
    this.stopAll.addEventListener("click", () => this.queue.cancelAll());
    this.clear.className = "bq-btn";
    this.clear.type = "button";
    this.clear.textContent = "Clear finished";
    this.clear.addEventListener("click", () => this.queue.clearFinished());
    this.foot.append(this.stopAll, this.clear);

    this.root.append(this.head, this.list, this.empty, this.foot);
    document.body.append(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    if (!this.root.hidden) return;
    this.root.hidden = false;
    // The shell reads this and gives up the width, so the folder narrows rather
    // than hiding behind the drawer. See the note in batch.css.
    document.documentElement.dataset["bq"] = "open";
    // Subscribed only while open. A queue running behind a closed drawer should
    // not be paying for DOM writes nobody can see.
    this.off = this.queue.onChange(() => this.paint());
    this.paint();
  }

  hide(): void {
    this.root.hidden = true;
    delete document.documentElement.dataset["bq"];
    this.off?.();
    this.off = null;
  }

  toggle(): void {
    if (this.root.hidden) this.show();
    else this.hide();
  }

  /**
   * Called on every queue change whether the drawer is open or not, so the
   * folder reloads when a file lands even if nobody is watching the panel.
   * Returns the pending count for the status bar.
   */
  tick(): number {
    let landed = false;
    for (const t of this.queue.tasks()) {
      if (t.state === "done" && !this.announced.has(t.id)) {
        this.announced.add(t.id);
        landed = true;
      }
    }
    if (landed) this.host.refresh();
    return this.queue.pending();
  }

  private paint(): void {
    const tasks = this.queue.tasks();
    this.empty.hidden = tasks.length > 0;

    const seen = new Set<string>();
    for (const task of tasks) {
      seen.add(task.id);
      let row = this.rows.get(task.id);
      if (!row) {
        row = this.buildRow(task);
        this.rows.set(task.id, row);
        this.list.append(row.root);
      }
      this.updateRow(row, task);
    }

    for (const [id, row] of this.rows) {
      if (seen.has(id)) continue;
      row.root.remove();
      this.rows.delete(id);
    }

    const pending = this.queue.pending();
    const failed = tasks.filter((t) => t.state === "failed").length;
    const bits: string[] = [];
    if (pending > 0) bits.push(`${pending} to go · ${Math.round(this.queue.overall() * 100)}%`);
    else if (tasks.length > 0) bits.push("all done");
    if (failed > 0) bits.push(`${failed} failed`);
    this.summary.textContent = bits.join(" · ");
    this.stopAll.disabled = pending === 0;
  }

  private buildRow(task: Task): Row {
    const root = document.createElement("div");
    root.className = "bq-row";

    const title = document.createElement("div");
    title.className = "bq-row-title";
    title.textContent = task.title;
    title.title = task.input || task.title;

    const detail = document.createElement("div");
    detail.className = "bq-row-detail";

    const bar = document.createElement("div");
    bar.className = "bq-bar";
    const fill = document.createElement("span");
    fill.className = "bq-bar-fill";
    bar.append(fill);

    const act = document.createElement("button");
    act.className = "bq-act";
    act.type = "button";
    act.addEventListener("click", () => {
      const now = this.queue.get(task.id);
      if (!now) return;
      if (now.state === "queued" || now.state === "running") this.queue.cancel(now.id);
      else if (now.state === "done") void this.host.reveal(now.output || now.input);
      else this.queue.retry(now.id);
    });

    root.append(title, detail, bar, act);
    return { root, title, detail, fill, act, state: null };
  }

  /** Only the four things that change. See the note at the top of the file. */
  private updateRow(row: Row, task: Task): void {
    const pct = task.state === "done" ? 100 : Math.round(task.fraction * 100);
    row.fill.style.width = `${pct}%`;

    // The detail line carries whatever is truest right now: an error if there
    // is one, the encoder's own speed while running, the outcome afterwards.
    const word = STATE_WORD[task.state];
    let detail = task.error || task.detail || word;
    if (task.state === "running" && !task.detail) detail = `${pct}%`;
    else if (task.state === "running" && task.detail) detail = `${pct}% · ${task.detail}`;
    if (task.state === "done" && task.leftover) detail = `${detail} · partial left behind`;
    row.detail.textContent = detail;
    row.detail.title = task.error || task.output || "";

    if (row.state !== task.state) {
      row.state = task.state;
      row.root.dataset["state"] = task.state;
      const live = task.state === "queued" || task.state === "running";
      row.act.textContent = live ? "✕" : task.state === "done" ? "↗" : "⟲";
      row.act.title = live
        ? "Stop this one"
        : task.state === "done"
          ? "Show the file"
          : // Said out loud because it is the one thing about a resumable queue
            // that surprises people: ffmpeg cannot resume mid-file.
            "Run it again from the start";
    }
  }
}
