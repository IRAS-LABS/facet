/**
 * A list of the parts of a timeline that survive — the model both the video
 * editor and the audio editor cut with.
 *
 * **Spans to keep, never edits to apply.** Trimming is one span. Cutting a
 * middle out is two. Removing three ad breaks is four. Undo is then just the
 * previous list, and the exporter has one shape to build a filter graph for
 * instead of a taxonomy of operations that interact with each other. It also
 * means a timeline drawing is a direct picture of the model rather than a
 * simulation of it.
 *
 * Everything here is about *time*, and nothing here knows what is playing —
 * pixels, samples and filter graphs all live on the other side of the callers.
 * That is the whole reason the two editors can share it.
 *
 * Every mutator returns whether it changed anything, so a caller can repaint on
 * a real change and stay quiet on a mis-click. Nothing in here repaints, and
 * nothing in here touches the DOM.
 */

export interface Span {
  start: number;
  end: number;
}

/** Below this, a span is a mis-click rather than a cut. */
export const MIN_SPAN = 0.04;

/** Deep enough that undo is never the thing that lost the work. */
const HISTORY = 100;

const copy = (list: readonly Span[]): Span[] => list.map((s) => ({ ...s }));

export class SpanList {
  private spans: Span[] = [];
  private past: Span[][] = [];
  private future: Span[][] = [];

  /** The kept parts, in order. Treat as read-only; mutate through the methods. */
  get list(): readonly Span[] {
    return this.spans;
  }

  get count(): number {
    return this.spans.length;
  }

  /** Seconds that survive, before any speed change is applied. */
  get kept(): number {
    return this.spans.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * Start again on a new file: all of it kept, no history.
   *
   * Distinct from `reset`, which is an *edit* — undoing it should bring the cuts
   * back. Opening a different file is not an edit anyone wants to undo into.
   */
  load(duration: number): void {
    this.spans = duration > 0 ? [{ start: 0, end: duration }] : [];
    this.past = [];
    this.future = [];
  }

  /** Keep all of it again, as an undoable step. */
  reset(duration: number): boolean {
    if (duration <= 0) return false;
    return this.commit([{ start: 0, end: duration }]);
  }

  /** Index of the kept span containing `t`, or -1 inside a removed gap. */
  indexAt(t: number): number {
    return this.spans.findIndex((s) => t >= s.start && t <= s.end);
  }

  /** The next kept span starting after `t`, if the playhead is in a gap. */
  nextAfter(t: number): Span | undefined {
    return this.spans.find((s) => s.start > t);
  }

  /** Pull the near edge of the span under `t` up to `t`. */
  mark(t: number, which: "in" | "out"): boolean {
    const i = this.indexAt(t);
    if (i < 0) return false;
    const next = copy(this.spans);
    const span = next[i];
    if (!span) return false;
    if (which === "in") span.start = t;
    else span.end = t;
    return this.commit(next);
  }

  /**
   * Split the piece under `t` in two.
   *
   * On its own this changes nothing about the output — two adjacent spans
   * concatenate back to what they were. That is the point: it is the setup
   * gesture, and `drop` is the one that removes something. Splitting first and
   * deleting second is how every editor does it, because it lets you look at the
   * boundary before committing to it.
   */
  split(t: number): boolean {
    const i = this.indexAt(t);
    const span = this.spans[i];
    if (!span || t - span.start < MIN_SPAN || span.end - t < MIN_SPAN) return false;
    const next = copy(this.spans);
    next.splice(i, 1, { start: span.start, end: t }, { start: t, end: span.end });
    return this.commit(next);
  }

  /** Remove the piece under `t`. Never removes the last one. */
  drop(t: number): boolean {
    const i = this.indexAt(t);
    if (i < 0 || this.spans.length <= 1) return false;
    return this.commit(this.spans.filter((_, n) => n !== i));
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.spans);
    this.spans = prev;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.spans);
    this.spans = next;
    return true;
  }

  /**
   * Replace the list, pushing the old one onto the undo stack.
   *
   * Spans shorter than `MIN_SPAN` are dropped here rather than at each call
   * site, so a slip of the playhead cannot leave a zero-length piece in the
   * model for the exporter to trip over later.
   */
  private commit(next: Span[]): boolean {
    const kept = next
      .filter((s) => s.end - s.start > MIN_SPAN)
      .sort((a, b) => a.start - b.start);
    if (kept.length === 0) return false;
    this.past.push(copy(this.spans));
    if (this.past.length > HISTORY) this.past.shift();
    this.future = [];
    this.spans = kept;
    return true;
  }
}
