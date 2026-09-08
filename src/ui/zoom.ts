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
 * There are two ways to make a document bigger and this file has both, because
 * the surfaces in this app genuinely need different ones:
 *
 *  - **`attachZoom` scales a layer.** The content sits in a layer whose
 *    `transform: scale(k)` grows it from its top-left corner, and the scroller
 *    it sits in does the panning. A transformed box contributes to its
 *    scroller's scrollable overflow, so with `transform-origin: 0 0` there is
 *    nothing to pan to above or left of the origin — every pixel the zoom
 *    creates is reachable by ordinary scrolling, which means momentum,
 *    overscroll and the scrollbars all keep working and none of it has to be
 *    reimplemented here. This is right for a PDF page, a picture, a rendered
 *    web page: things whose layout must not change as they grow.
 *
 *  - **`attachTextZoom` scales the type.** The hex view and the spreadsheet
 *    are virtualised: they draw the forty rows you can see and lie about the
 *    rest with a spacer, and they work out which forty from a measured row
 *    height. Scaling that with a transform desynchronises the arithmetic from
 *    the pixels -- the spacer, the sticky header and the row window all still
 *    believe in the old height, so the header slides off the columns and
 *    scrolling lands on the wrong row. Growing the *font* instead keeps every
 *    one of those honest, because the row height is measured rather than
 *    assumed. It is also what you actually want from a spreadsheet on a
 *    phone: smaller type to get more columns on screen, which a transform
 *    that only goes up cannot give you.
 *
 * Both are driven by the same recogniser, so a pinch means the same thing
 * everywhere and a fix to the gesture is a fix to all of it.
 */

/** Past 8× a photo is a wall of pixels; below 1× the card has empty margins. */
const MIN = 1;
const MAX = 8;

/**
 * Text zooms out as well as in.
 *
 * A picture below 1× is a small picture in a large empty card, which is why
 * `MIN` is 1. A spreadsheet below 1× is four more columns, which on a 6.7-inch
 * phone is the difference between reading the sheet and scrolling around
 * hunting for the column you wanted. Not below half: past that the glyphs stop
 * being glyphs.
 */
const TEXT_MIN = 0.5;
const TEXT_MAX = 4;

/** What a double-tap goes to, and what a second one comes back from. */
const TAP_SCALE = 2.5;

/** ...and for text, where 2.5× of a monospace grid is already very large. */
const TEXT_TAP_SCALE = 1.75;

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

/** What one recogniser needs to know that is not the gesture itself. */
interface ZoomKind {
  min: number;
  max: number;
  /** Where a double-tap goes. */
  tap: number;
  /**
   * Put the content at `next`, keeping whatever is under (`ax`, `ay`) — a
   * point in client coordinates — where it is. Anchoring is the whole
   * difference between a zoom that follows your fingers and one that jumps to
   * the top-left.
   */
  apply(next: number, ax: number, ay: number, was: number): void;
  /** Undo everything `apply` did. */
  clear(): void;
}

/**
 * The gesture, once.
 *
 * Recognising a pinch is fiddly in ways that have nothing to do with what is
 * being pinched -- the synthetic click after the last finger, the double tap a
 * WebView will not report, the trackpad arriving as a ctrl-wheel -- so it is
 * written here and the two zooms above only supply the arithmetic.
 */
function recognize(scroller: HTMLElement, kind: ZoomKind, opts: ZoomOptions): Zoom {
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

  const clamp = (v: number): number => (v < kind.min ? kind.min : v > kind.max ? kind.max : v);

  const to = (next: number, ax: number, ay: number): void => {
    const want = clamp(next);
    if (want === k) return;
    const was = k;
    k = want;
    kind.apply(k, ax, ay, was);
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
      to(k > 1 ? 1 : kind.tap, e.clientX, e.clientY);
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
      kind.clear();
      scroller.style.touchAction = "";
      scroller.scrollTo(0, 0);
    },
    get scale(): number {
      return k;
    },
  };
}

export function attachZoom(scroller: HTMLElement, layer: HTMLElement, opts: ZoomOptions = {}): Zoom {
  return recognize(scroller, {
    min: MIN,
    max: MAX,
    tap: TAP_SCALE,
    apply(k, ax, ay, was): void {
      const box = scroller.getBoundingClientRect();
      const lx = ax - box.left;
      const ly = ay - box.top;
      const cx = (scroller.scrollLeft + lx) / was;
      const cy = (scroller.scrollTop + ly) / was;
      layer.style.transform = k === 1 ? "" : `scale(${k})`;
      // Read back rather than trust the arithmetic: at 1× the scroll range has
      // just collapsed, and the browser clamps for us.
      scroller.scrollLeft = cx * k - lx;
      scroller.scrollTop = cy * k - ly;
    },
    clear(): void {
      layer.style.transform = "";
    },
  }, opts);
}

/** What a font zoom needs from the view it is zooming. */
export interface TextZoomOptions extends ZoomOptions {
  /**
   * Re-measure the row height and redraw at the new size.
   *
   * The whole reason this exists rather than a transform: a virtualised view
   * decides which rows to build from a row height it *measured*, so the size
   * has to change before the redraw and the redraw has to happen before the
   * scroll position means anything. Only the view can do that, so it does.
   *
   * Called after the font scale is on the element and layout is therefore
   * already stale -- so the implementation may read boxes back immediately.
   */
  remeasure(scale: number): void;
}

/**
 * Pinch to change the type size on a virtualised text view.
 *
 * `root` gets `--zoom`, which its stylesheet multiplies into the font size of
 * the rows; nothing here knows what that comes out as in pixels, which is the
 * point -- the view measures the result rather than being told.
 *
 * Anchoring is deliberately coarser than the transform zoom's: the row under
 * the middle of the screen stays put, and the horizontal position is left
 * alone. Following two fingers exactly through a reflow means solving for a
 * scroll offset in a layout that does not exist yet, and the honest version of
 * that is one round trip per frame. A spreadsheet holding its line is what
 * people actually notice.
 */
export function attachTextZoom(
  scroller: HTMLElement,
  root: HTMLElement,
  opts: TextZoomOptions,
): Zoom {
  const size = (k: number): void => {
    // Keep the middle row where it is. Measured as a fraction of the scroll
    // range rather than in pixels, because the pixels are about to change.
    const range = scroller.scrollHeight - scroller.clientHeight;
    const at = range > 0 ? (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight : 0;
    if (k === 1) root.style.removeProperty("--zoom");
    else root.style.setProperty("--zoom", String(k));
    opts.remeasure(k);
    if (at > 0) {
      const back = at * scroller.scrollHeight - scroller.clientHeight / 2;
      scroller.scrollTop = Math.max(0, back);
    }
  };

  return recognize(scroller, {
    min: TEXT_MIN,
    max: TEXT_MAX,
    tap: TEXT_TAP_SCALE,
    apply(k): void { size(k); },
    clear(): void {
      root.style.removeProperty("--zoom");
      opts.remeasure(1);
    },
  }, opts);
}
