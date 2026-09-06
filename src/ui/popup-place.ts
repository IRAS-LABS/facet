/**
 * Where a popup goes.
 *
 * Pulled out of `ContextMenu` when the View menu became the second thing that
 * needed it. The logic is short but it is not obvious, and the failure it
 * prevents is silent: a menu opened near the bottom of the window that simply
 * overflows is a menu whose last three rows cannot be reached, and nothing about
 * it looks wrong — it looks like a menu with three fewer options. A second copy
 * of this would have been a second copy to get subtly different.
 *
 * The order is: place at the pointer, pull back inside the window, then flip
 * above rather than let it run off the bottom, and only if it fits neither way
 * cap the height and let it scroll. Flipping beats scrolling because a menu that
 * opens upward is still one glance; capping beats clipping because a scrollbar
 * says there is more and a clipped edge says nothing at all.
 */

/** Breathing room from the window edge, in px. */
const PAD = 6;

/**
 * Position `root` near (`x`, `y`) in client coordinates.
 *
 * `root` must already be visible — the measurement is a real
 * `getBoundingClientRect`, and a hidden element measures zero, which places
 * every popup in the top-left corner. Callers unhide first, then place.
 */
export function placePopup(root: HTMLElement, x: number, y: number): void {
  root.style.left = "0px";
  root.style.top = "0px";
  root.style.maxHeight = "";

  const box = root.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = x;
  if (left + box.width + PAD > vw) left = Math.max(PAD, x - box.width);

  let top = y;
  if (top + box.height + PAD > vh) {
    // Above the pointer if there is more room there; otherwise pinned to the
    // bottom and scrolling, which is still every row reachable.
    const above = y - PAD;
    const below = vh - y - PAD;
    if (above > below) {
      top = Math.max(PAD, y - box.height);
      if (box.height > above) {
        top = PAD;
        root.style.maxHeight = `${above}px`;
      }
    } else {
      root.style.maxHeight = `${below}px`;
    }
  }

  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
}
