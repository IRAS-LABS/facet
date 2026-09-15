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
 * How much of the bottom of the window the system owns.
 *
 * `window.innerHeight` on Android includes the strip the gesture bar is drawn
 * over, so a popup clamped to it is clamped to a line three rows below the
 * last one a thumb can reach. Observed on a test phone: the audio dock's Automatic
 * menu ended with Transcribe sitting underneath the gesture bar -- reachable
 * only by scrolling a menu that did not look scrollable.
 *
 * `env()` is not readable from script, so it is measured: a probe sized to the
 * inset, read once, and cached. Zero everywhere that has no inset, which is
 * every desktop.
 */
let safeBottom: number | null = null;

function bottomInset(): number {
  if (safeBottom !== null) return safeBottom;
  try {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;" +
      "height:env(safe-area-inset-bottom,0px)";
    document.body.append(probe);
    safeBottom = Math.round(probe.getBoundingClientRect().height) || 0;
    probe.remove();
  } catch {
    safeBottom = 0;
  }
  return safeBottom;
}

/**
 * Position `root` near (`x`, `y`) in client coordinates.
 *
 * `root` must already be visible — the measurement is a real
 * `getBoundingClientRect`, and a hidden element measures zero, which places
 * every popup in the top-left corner. Callers unhide first, then place.
 */
export function placePopup(
  root: HTMLElement,
  x: number,
  y: number,
  opts: { above?: number } = {},
): void {
  root.style.left = "0px";
  root.style.top = "0px";
  root.style.maxHeight = "";

  const box = root.getBoundingClientRect();
  const vw = window.innerWidth;
  // The smallest of the three heights a WebView reports. On a test phone the menu
  // never flipped, so one of them is taller than the glass; the smallest one
  // is the one a thumb can actually reach.
  const vh =
    Math.min(
      window.innerHeight,
      document.documentElement.clientHeight || Infinity,
      window.visualViewport?.height ?? Infinity,
    ) - bottomInset();

  let left = x;
  if (left + box.width + PAD > vw) left = Math.max(PAD, x - box.width);

  // `above` is the top edge of the thing that opened the popup. Given, and
  // that thing sitting in the lower half of the screen, the popup goes over it
  // outright instead of trying below first: a docked bar near the bottom has
  // almost no room under it, and a menu that opens downward there covers the
  // tab bar even when the arithmetic says it fits.
  if (opts.above !== undefined && opts.above > vh / 2) {
    const room = opts.above - PAD;
    root.style.left = `${Math.round(left)}px`;
    if (box.height > room) {
      root.style.maxHeight = `${room}px`;
      root.style.top = `${PAD}px`;
    } else {
      root.style.top = `${Math.round(opts.above - box.height)}px`;
    }
    return;
  }

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
