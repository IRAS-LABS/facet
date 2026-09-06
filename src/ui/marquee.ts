/**
 * Rubber-band selection — drag a box over empty space, take what it touches.
 *
 * ## Why the views hit-test and this file does not
 *
 * The obvious implementation asks the DOM which elements the band overlaps. It
 * cannot work here: both views are virtualised, so the rows and tiles outside
 * the viewport have no elements at all — and a band that auto-scrolls past them
 * is *precisely* the case that has to work. Sweeping a thousand files and
 * getting the eleven that happened to be mounted would be worse than no
 * marquee.
 *
 * So the band is geometry and nothing else. This file owns the gesture: the
 * pointer capture, the visible box, the auto-scroll, and what the modifier keys
 * mean. The view owns `hit()`, because only the view knows where its items are
 * — the list can answer in one division, the gallery walks its position table.
 *
 * ## Coordinates
 *
 * Everything is in *content* space: pixels from the top-left of the scrolled
 * layer, the same space the views already place rows and tiles in. Client space
 * would need converting on every move and would drift the moment auto-scroll
 * changed `scrollTop` between two pointer events.
 *
 * ## Modifiers
 *
 * Plain replaces, Ctrl toggles, Shift adds — Explorer's rules. Toggling has to
 * be against the selection *as it was when the drag started*, not against the
 * running one: a live toggle against itself flickers each item on and off as
 * the band jitters over it. Hence `onStart`, which is the view's cue to
 * snapshot.
 */

export type SweepMode = "replace" | "add" | "toggle";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MarqueeHost {
  /** The element that scrolls. */
  scroll: HTMLElement;
  /** The positioned layer items live in; the band is appended here. */
  layer: HTMLElement;
  /**
   * Does a press here begin a band?
   *
   * False over an item — that press is the start of a click or a file drag.
   * The view answers because only it knows what an item looks like.
   */
  startsOn(target: HTMLElement | null): boolean;
  /** Indices whose box overlaps the rect, in content space. */
  hit(box: Rect): number[];
  /** The gesture began; snapshot whatever `toggle` and `add` build on. */
  onStart(): void;
  onSweep(indices: readonly number[], mode: SweepMode): void;
  /** The gesture ended. Fires even for a band that selected nothing. */
  onEnd(): void;
}

/** Movement before a press counts as a drag rather than a click on the floor. */
const SLOP = 4;

/** How close to an edge the pointer has to get before the view scrolls. */
const EDGE = 28;

/** Pixels per frame at the very edge. Ramped down as you back away from it. */
const SPEED = 18;

export function enableMarquee(host: MarqueeHost): () => void {
  let band: HTMLElement | null = null;
  let anchor: { x: number; y: number } | null = null;
  let at = { x: 0, y: 0 };
  let live = false;
  let pointer = -1;
  let timer = 0;
  /** Pointer position in client space, kept for the auto-scroll ticker. */
  let client = { x: 0, y: 0 };

  const point = (e: PointerEvent): { x: number; y: number } => {
    const box = host.scroll.getBoundingClientRect();
    return {
      x: e.clientX - box.left + host.scroll.scrollLeft,
      y: e.clientY - box.top + host.scroll.scrollTop,
    };
  };

  const modeOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SweepMode =>
    e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "add" : "replace";

  const boxOf = (): Rect => ({
    x0: Math.min(anchor!.x, at.x),
    y0: Math.min(anchor!.y, at.y),
    x1: Math.max(anchor!.x, at.x),
    y1: Math.max(anchor!.y, at.y),
  });

  const paint = (mode: SweepMode): void => {
    const r = boxOf();
    if (band === null) {
      band = document.createElement("div");
      band.className = "marquee";
      host.layer.appendChild(band);
    }
    band.style.left = `${r.x0}px`;
    band.style.top = `${r.y0}px`;
    band.style.width = `${r.x1 - r.x0}px`;
    band.style.height = `${r.y1 - r.y0}px`;
    host.onSweep(host.hit(r), mode);
  };

  /**
   * Auto-scroll.
   *
   * On a timer rather than driven by `pointermove`, because the case it exists
   * for is a pointer held still against the bottom edge — where no move events
   * arrive and an event-driven version simply stops.
   */
  const tick = (): void => {
    if (!live || anchor === null) return;
    const box = host.scroll.getBoundingClientRect();
    let dy = 0;
    if (client.y < box.top + EDGE) dy = -ramp(box.top + EDGE - client.y);
    else if (client.y > box.bottom - EDGE) dy = ramp(client.y - (box.bottom - EDGE));
    let dx = 0;
    if (client.x < box.left + EDGE) dx = -ramp(box.left + EDGE - client.x);
    else if (client.x > box.right - EDGE) dx = ramp(client.x - (box.right - EDGE));

    if (dx !== 0 || dy !== 0) {
      const wasTop = host.scroll.scrollTop;
      const wasLeft = host.scroll.scrollLeft;
      host.scroll.scrollTop += dy;
      host.scroll.scrollLeft += dx;
      // The corner the pointer is at moves with the content, so the band grows
      // instead of sliding. Measured rather than assumed: at the end of the
      // range the scroller does not move and the band must not either.
      at.y += host.scroll.scrollTop - wasTop;
      at.x += host.scroll.scrollLeft - wasLeft;
      paint(mode);
    }
    timer = requestAnimationFrame(tick);
  };

  const ramp = (over: number): number => Math.min(SPEED, Math.max(2, Math.round(over / 2)));

  let mode: SweepMode = "replace";

  const down = (e: PointerEvent): void => {
    if (e.button !== 0 || e.pointerType !== "mouse") return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!host.startsOn(target)) return;
    anchor = point(e);
    at = { ...anchor };
    client = { x: e.clientX, y: e.clientY };
    mode = modeOf(e);
    live = false;
    pointer = e.pointerId;
  };

  const move = (e: PointerEvent): void => {
    if (anchor === null || e.pointerId !== pointer) return;
    at = point(e);
    client = { x: e.clientX, y: e.clientY };
    if (!live) {
      if (Math.abs(at.x - anchor.x) < SLOP && Math.abs(at.y - anchor.y) < SLOP) return;
      live = true;
      host.scroll.setPointerCapture(pointer);
      host.onStart();
      timer = requestAnimationFrame(tick);
    }
    paint(mode);
  };

  const stop = (e: PointerEvent): void => {
    if (e.pointerId !== pointer) return;
    if (live) {
      // The click that follows a band would otherwise land on whatever is under
      // the release and clear everything just selected.
      e.preventDefault();
      e.stopPropagation();
      host.onEnd();
    }
    finish();
  };

  const finish = (): void => {
    if (timer !== 0) cancelAnimationFrame(timer);
    timer = 0;
    if (band !== null) band.remove();
    band = null;
    if (live && pointer >= 0 && host.scroll.hasPointerCapture(pointer)) {
      host.scroll.releasePointerCapture(pointer);
    }
    anchor = null;
    live = false;
    pointer = -1;
  };

  /** A band in progress swallows the click that ends it. */
  const swallow = (e: MouseEvent): void => {
    if (!live) return;
    e.preventDefault();
    e.stopPropagation();
  };

  host.scroll.addEventListener("pointerdown", down);
  host.scroll.addEventListener("pointermove", move);
  host.scroll.addEventListener("pointerup", stop);
  host.scroll.addEventListener("pointercancel", stop);
  host.scroll.addEventListener("click", swallow, true);

  return () => {
    finish();
    host.scroll.removeEventListener("pointerdown", down);
    host.scroll.removeEventListener("pointermove", move);
    host.scroll.removeEventListener("pointerup", stop);
    host.scroll.removeEventListener("pointercancel", stop);
    host.scroll.removeEventListener("click", swallow, true);
  };
}

/**
 * Fold a sweep into a snapshot.
 *
 * Shared by both views because getting `toggle` subtly wrong — folding against
 * the running selection instead of the snapshot — produces a marquee that
 * flickers, and one copy of that bug is enough.
 */
export function foldSweep(
  base: ReadonlySet<string>,
  swept: readonly string[],
  mode: SweepMode,
): Set<string> {
  if (mode === "replace") return new Set(swept);
  const out = new Set(base);
  for (const path of swept) {
    if (mode === "add") out.add(path);
    else if (out.has(path)) out.delete(path);
    else out.add(path);
  }
  return out;
}
