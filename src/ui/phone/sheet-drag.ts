/**
 * Swipe a bottom sheet down to close it.
 *
 * Every sheet in this app already had a labelled way out -- Close, Cancel, the
 * hardware back button -- and every one of them was a deliberate tap in the top
 * right corner, which on a 6.7-inch phone held in one hand is the single
 * furthest point from the thumb. The gesture everyone already knows is to push
 * the sheet back down where it came from, so that is what this adds. The
 * buttons stay: a gesture with no visible equivalent is a feature only the
 * people who already know about it have.
 *
 * The rules that make it feel right rather than merely work:
 *
 *  - **A drag has to prove itself.** Nothing moves until the finger has gone
 *    8 px and gone further down than sideways. Below that it is a tap, and a
 *    tap on a sheet full of buttons must stay a tap.
 *  - **Scrolling wins.** If the sheet's own body is scrolled even one pixel,
 *    a downward drag is the user scrolling back up, not closing. Only from the
 *    very top does the drag become a dismissal.
 *  - **Flicks count.** A short fast push closes; a long slow one closes;
 *    a slow short one springs back. Distance alone means a quick flick that
 *    only travelled 40 px snaps back, which reads as the app ignoring you.
 *  - **The click after a drag is swallowed.** Letting go over the Close button
 *    otherwise fires it, which is harmless for Close and destructive for
 *    whatever else a sheet puts under your thumb.
 */

/** Below this the finger has not said anything yet. */
const START_PX = 8;

/** A flick this fast closes regardless of how far it got. */
const FLICK = 0.55;

/** ...as long as it went at least this far, so a stray twitch is not a flick. */
const FLICK_PX = 24;

/** A slow drag closes past this share of the sheet's own height. */
const FAR = 0.28;

/** ...with a floor, for the 4.5 rem stub, where 28% is a few pixels. */
const FAR_MIN = 64;

/**
 * Does this drag close the sheet?
 *
 * Split out from the wiring because it is the whole of the behaviour and it
 * needs no DOM: every rule above is one comparison here.
 *
 * @param dy       how far down the finger travelled, in px. Negative is up.
 * @param height   the sheet's height in px.
 * @param velocity px per ms over the tail of the drag. Positive is downward.
 */
export function shouldDismiss(dy: number, height: number, velocity: number): boolean {
  if (dy <= 0) return false;
  if (velocity >= FLICK && dy >= FLICK_PX) return true;
  return dy >= Math.max(FAR_MIN, height * FAR);
}

export interface DragDismissOptions {
  /** Called once, when the sheet has been dragged far enough to go. */
  dismiss(): void;
  /**
   * The scrolling region inside the sheet, looked up per drag because the
   * sheet's contents are rebuilt every time it opens.
   */
  scroller?: () => Element | null;
}

/** Nothing inside these is ever a sheet drag; they have their own gestures. */
const KEEPS_ITS_OWN = "input, textarea, select, [contenteditable], [role='slider']";

/**
 * Make `sheet` closable by dragging it down. Returns the way to undo it.
 */
export function dragToDismiss(sheet: HTMLElement, opts: DragDismissOptions): () => void {
  let id: number | null = null;
  let startY = 0;
  let startX = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let dragging = false;
  let dragged = false;
  let gone = false;

  const reset = (): void => {
    id = null;
    dragging = false;
    sheet.classList.remove("phv-dragging");
    sheet.style.transform = "";
    sheet.style.opacity = "";
  };

  const down = (ev: PointerEvent): void => {
    if (id !== null || !ev.isPrimary || gone) return;
    const target = ev.target;
    if (target instanceof Element && target.closest(KEEPS_ITS_OWN)) return;
    id = ev.pointerId;
    startY = lastY = ev.clientY;
    startX = ev.clientX;
    lastT = ev.timeStamp;
    velocity = 0;
    dragging = false;
    dragged = false;
  };

  const move = (ev: PointerEvent): void => {
    if (ev.pointerId !== id) return;
    const dy = ev.clientY - startY;

    if (!dragging) {
      if (dy < START_PX || Math.abs(ev.clientX - startX) > dy) {
        // Sideways, upward, or still too small to mean anything. An upward
        // drag is given up on entirely: it is a scroll, and re-arming halfway
        // through would make the sheet jump when the finger came back down.
        if (dy < -START_PX) id = null;
        return;
      }
      // Only from the top. Anywhere else this is the body scrolling.
      const box = opts.scroller?.();
      if (box && box.scrollTop > 0) { id = null; return; }
      dragging = true;
      dragged = true;
      sheet.classList.add("phv-dragging");
      try { sheet.setPointerCapture(ev.pointerId); } catch { /* not captured, still works */ }
    }

    const dt = ev.timeStamp - lastT;
    if (dt > 0) velocity = (ev.clientY - lastY) / dt;
    lastY = ev.clientY;
    lastT = ev.timeStamp;

    // No rubber band on the way down -- the sheet is going where the finger
    // puts it -- but it does not travel up past where it started.
    const at = Math.max(0, dy);
    sheet.style.transform = `translateY(${at}px)`;
    sheet.style.opacity = String(Math.max(0.35, 1 - at / (sheet.offsetHeight || 1)));
    ev.preventDefault();
  };

  const finish = (ev: PointerEvent): void => {
    if (ev.pointerId !== id) return;
    const wasDragging = dragging;
    const dy = ev.clientY - startY;
    const h = sheet.offsetHeight || 1;
    reset();
    if (!wasDragging) return;

    if (!shouldDismiss(dy, h, velocity)) return;

    gone = true;
    // Out through the bottom edge rather than vanishing on the spot, then the
    // caller's own close runs and puts the sheet back to hidden. The timer is
    // the safety net for a transitionend that never fires -- reduced motion
    // turns the transition off, and then there is no event at all.
    sheet.classList.add("phv-dropping");
    sheet.style.transform = `translateY(${h}px)`;
    sheet.style.opacity = "0";
    let done = false;
    const land = (): void => {
      if (done) return;
      done = true;
      sheet.removeEventListener("transitionend", land);
      sheet.classList.remove("phv-dropping");
      sheet.style.transform = "";
      sheet.style.opacity = "";
      gone = false;
      opts.dismiss();
    };
    sheet.addEventListener("transitionend", land);
    setTimeout(land, 220);
  };

  const cancel = (ev: PointerEvent): void => {
    if (ev.pointerId !== id) return;
    reset();
  };

  // Capture, so a drag that ends over a button eats that button's click. The
  // flag is cleared here rather than on pointerup because the click comes
  // after it.
  const swallow = (ev: Event): void => {
    if (!dragged) return;
    dragged = false;
    ev.stopPropagation();
    ev.preventDefault();
  };

  sheet.addEventListener("pointerdown", down);
  sheet.addEventListener("pointermove", move);
  sheet.addEventListener("pointerup", finish);
  sheet.addEventListener("pointercancel", cancel);
  sheet.addEventListener("click", swallow, true);

  return () => {
    sheet.removeEventListener("pointerdown", down);
    sheet.removeEventListener("pointermove", move);
    sheet.removeEventListener("pointerup", finish);
    sheet.removeEventListener("pointercancel", cancel);
    sheet.removeEventListener("click", swallow, true);
    reset();
  };
}
