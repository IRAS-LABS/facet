/**
 * Pinch, double-tap and ctrl-wheel zoom for a scrolling preview.
 *
 * The app turns the browser's own page zoom off — `user-scalable=no` in the
 * viewport meta, `touch-action: none` on the body — because the 2D canvas owns
 * every gesture and a page that rubber-bands under it is unusable. That is the
 * right call for the canvas and the wrong one everywhere a document is being
 * read, which is how a file manager ended up unable to do the one thing every
 * gallery on the phone can do. This puts it back, scoped to the surface that
 * wants it, without handing the gesture back to the browser.
 *
 * The mechanics: the content sits in a layer whose `transform: scale(k)` grows
 * it from its top-left corner, and the scroller it sits in does the panning.
 * A transformed box contributes to its scroller's scrollable overflow, so with
 * `transform-origin: 0 0` there is nothing to pan to above or left of the
 * origin — every pixel the zoom creates is reachable by ordinary scrolling,
 * which means momentum, overscroll and the scrollbars all keep working and
 * none of it has to be reimplemented here.
 */

/** Past 8× a photo is a wall of pixels; below 1× the card has empty margins. */
const MIN = 1;
const MAX = 8;

/** What a double-tap goes to, and what a second one comes back from. */
const TAP_SCALE = 2.5;

/** Two taps this close together, in ms and in CSS pixels, are one gesture. */
const TAP_MS = 300;
const TAP_SLOP = 32;

/**
 * Long enough for the `click` the browser synthesises after the last finger
 * lifts. Without it a pinch ends by toggling full screen, because the card
 * reads a tap on the preview as "show me this bigger".
 */
const CLICK_GRACE = 450;

/** How long after a zoom stops moving before the host is told to redraw. */
const SETTLE_MS = 220;

export interface ZoomOptions {
  /**
   * A tap that was definitely a tap: one finger, no travel, and no second tap
   * behind it. The host used to take this off a plain `click`, which fires the
   * instant the first finger of a double-tap lifts -- so zooming in also
   * toggled full screen, every time. Held for `TAP_MS` and cancelled by the
   * second tap, so the two gestures stop fighting.
   */
  onTap?(target: EventTarget | null): void;
  /**
   * The zoom has stopped moving, at `scale`. Where anything drawn rather than
   * photographed gets redrawn: a canvas rasterised for 1x and then stretched
   * to 4x is four times too coarse, and no amount of scaling fixes pixels that
   * were never rendered.
   */
  onSettle?(scale: number): void;
}

export interface Zoom {
  /** Back to 1×, scrolled to the top. Called for every new file. */
  reset(): void;
  readonly scale: number;
}

export function attachZoom(scroller: HTMLElement, layer: HTMLElement, opts: ZoomOptions = {}): Zoom {
  const live = new Map<number, { x: number; y: number }>();
  let k = 1;
  let pinching = false;
  let startDist = 0;
  let startK = 1;
  let quietUntil = 0;
  let lastTap = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let downX = 0;
  let downY = 0;
  let tapTimer = 0;
  let settleTimer = 0;
  let settledAt = 1;

  /** Tell the host once the scale has actually stopped changing. */
  const settle = (): void => {
    if (!opts.onSettle) return;
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      if (k === settledAt) return;
      settledAt = k;
      opts.onSettle?.(k);
    }, SETTLE_MS);
  };

  const clamp = (v: number): number => (v < MIN ? MIN : v > MAX ? MAX : v);

  /**
   * Zoom to `next`, keeping the content under (`ax`, `ay`) — a point in client
   * coordinates — where it is. Anchoring is the whole difference between a
   * zoom that follows your fingers and one that jumps to the top-left.
   */
  const to = (next: number, ax: number, ay: number): void => {
    const want = clamp(next);
    if (want === k) return;
    const box = scroller.getBoundingClientRect();
    const lx = ax - box.left;
    const ly = ay - box.top;
    const cx = (scroller.scrollLeft + lx) / k;
    const cy = (scroller.scrollTop + ly) / k;
    k = want;
    layer.style.transform = k === 1 ? "" : `scale(${k})`;
    // Read back rather than trust the arithmetic: at 1× the scroll range has
    // just collapsed, and the browser clamps for us.
    scroller.scrollLeft = cx * k - lx;
    scroller.scrollTop = cy * k - ly;
  };

  const centre = (): { x: number; y: number; d: number } => {
    const [a, b] = [...live.values()];
    if (!a || !b) return { x: 0, y: 0, d: 0 };
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      d: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  scroller.addEventListener(
    "pointerdown",
    (e) => {
      live.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (live.size === 1) {
        downX = e.clientX;
        downY = e.clientY;
      }
      if (live.size !== 2) return;
      // A pinch starting cancels the tap that was waiting to be a tap.
      window.clearTimeout(tapTimer);
      const c = centre();
      if (c.d === 0) return;
      pinching = true;
      startDist = c.d;
      startK = k;
      // The scroller must stop scrolling for the duration or the two fingers
      // pan and pinch at once, which reads as the content fighting the hand.
      scroller.style.touchAction = "none";
    },
    { passive: true },
  );

  scroller.addEventListener(
    "pointermove",
    (e) => {
      const p = live.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (!pinching || live.size < 2) return;
      const c = centre();
      if (c.d === 0) return;
      to(startK * (c.d / startDist), c.x, c.y);
      quietUntil = Date.now() + CLICK_GRACE;
      settle();
    },
    { passive: true },
  );

  const lift = (e: PointerEvent): void => {
    const had = live.size;
    live.delete(e.pointerId);
    if (pinching && live.size < 2) {
      pinching = false;
      scroller.style.touchAction = "";
      quietUntil = Date.now() + CLICK_GRACE;
      settle();
      return;
    }
    // A single finger down and up, twice, in the same spot: the other way
    // everyone zooms. `dblclick` is not reliable in a WebView and never fires
    // for touch at all, so the double tap is counted here.
    if (had !== 1 || e.type !== "pointerup") return;
    const now = Date.now();
    if (now - lastTap < TAP_MS && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < TAP_SLOP) {
      lastTap = 0;
      window.clearTimeout(tapTimer);
      to(k > 1 ? 1 : TAP_SCALE, e.clientX, e.clientY);
      quietUntil = now + CLICK_GRACE;
      settle();
      return;
    }
    lastTap = now;
    lastTapX = e.clientX;
    lastTapY = e.clientY;

    // A drag is not a tap, and neither is the first half of a double-tap --
    // which is why this waits out the window rather than reporting now.
    if (!opts.onTap) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) >= TAP_SLOP) return;
    const target = e.target;
    window.clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => {
      if (Date.now() < quietUntil) return;
      opts.onTap?.(target);
    }, TAP_MS);
  };
  scroller.addEventListener("pointerup", lift, { passive: true });
  scroller.addEventListener("pointercancel", lift, { passive: true });

  // Ctrl-wheel is what a trackpad pinch and a mouse wheel both arrive as on
  // the desktop, so the same surface zooms there without a second gesture.
  scroller.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      to(k * Math.exp(-e.deltaY / 400), e.clientX, e.clientY);
      settle();
    },
    { passive: false },
  );

  // Taken in the capture phase, before the card's own handler sees it: the
  // click that ends a pinch or a double tap is part of the zoom, not a
  // request to go full screen.
  scroller.addEventListener(
    "click",
    (e) => {
      if (Date.now() >= quietUntil) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  return {
    reset(): void {
      live.clear();
      window.clearTimeout(tapTimer);
      window.clearTimeout(settleTimer);
      pinching = false;
      lastTap = 0;
      quietUntil = 0;
      k = 1;
      settledAt = 1;
      layer.style.transform = "";
      scroller.style.touchAction = "";
      scroller.scrollTo(0, 0);
    },
    get scale(): number {
      return k;
    },
  };
}
