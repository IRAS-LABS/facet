/**
 * Is this a phone?
 *
 * The question the shell actually needs answered is not "is this Android" and
 * not "is the window narrow" — it is "should this be laid out for a thumb on a
 * small screen". Those come apart in both directions and getting either one
 * alone produces a visible bug:
 *
 * * Width alone gives the phone layout to a desktop window someone dragged
 *   narrow, taking away the folder tree and the keyboard-driven chrome from a
 *   person who has a mouse and wants them.
 * * `IS_ANDROID` alone gives it to a tablet and to an Android desktop-mode
 *   session, where there is room for the real shell and the phone one wastes
 *   two thirds of the screen.
 *
 * So: a coarse pointer *and* not much room. `pointer: coarse` is the media
 * query for "the primary input is a finger", which is the half that says the
 * targets must be 48 px; the width is the half that says the tree cannot fit.
 *
 * 820 px rather than the 640 px the older rules used. 640 was picked to be the
 * width below which the desktop shell broke; this is the width below which the
 * desktop shell is *worth having*, which is a different and larger number — a
 * folder tree, a breadcrumb, a filter box and four mode buttons in one row need
 * more than 640 px before any of them stops being cramped.
 */

/**
 * Recomputed on resize and rotation; read `isPhone()`, not a frozen boolean.
 *
 * Two queries, not one, because a phone turned sideways is still a phone. The
 * The reference phone is 384 CSS px wide in portrait and 853 in landscape; a single
 * `max-width: 820px` test handed the landscape session the desktop shell,
 * which is built for a mouse and shows a broken folder tree on a 384 px tall
 * screen. The second test is Android's own `sw600dp` line: any coarse-pointer
 * device whose *shorter* side is under 600 px is a phone in either rotation,
 * while a tablet's shorter side is 600 px or more in both.
 */
const QUERIES = [
  "(max-width: 820px) and (pointer: coarse)",
  "(max-height: 599px) and (pointer: coarse)",
];

/**
 * A dev override, because the phone layout has to be workable in a desktop
 * browser to be worked on at all. `?phone=1` forces it on, `?phone=0` forces it
 * off, and the choice sticks for the tab so a reload during a fix does not
 * bounce back to the desktop shell.
 *
 * Read once at module load: a value that changed under the app mid-session
 * would let the two shells disagree about which is mounted.
 */
function override(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get("phone");
    if (q === "1" || q === "0") {
      sessionStorage.setItem("fct.phone", q);
      return q === "1";
    }
    const saved = sessionStorage.getItem("fct.phone");
    if (saved === "1" || saved === "0") return saved === "1";
  } catch {
    // Private-mode sessionStorage throws on write. A dev affordance is not
    // worth failing boot over.
  }
  return null;
}

const FORCED = override();

export function isPhone(): boolean {
  if (FORCED !== null) return FORCED;
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return QUERIES.some((q) => window.matchMedia(q).matches);
}

/**
 * Call `cb` when the answer changes — a rotation, a fold opening, a window
 * dragged wider. Returns the unsubscribe.
 *
 * Nothing swaps shells at runtime today; the shell that boots is the shell you
 * get until reload, because tearing down a mounted viewer and its WebGL context
 * mid-session to rebuild the other one is a large amount of risk for a case
 * that happens when someone unfolds a phone. What this drives instead is the
 * one thing that must stay live: the column count and safe-area padding.
 */
export function onPhoneChange(cb: (phone: boolean) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mqs = QUERIES.map((q) => window.matchMedia(q));
  const handler = (): void => cb(isPhone());
  for (const mq of mqs) mq.addEventListener("change", handler);
  return () => { for (const mq of mqs) mq.removeEventListener("change", handler); };
}

/**
 * True when a horizontal swipe near the screen edge belongs to the system.
 *
 * Android 10+ gesture navigation claims a strip down both edges for its back
 * gesture, and a web view cannot opt out of it. This is not a detail: the
 * first phone build put the view-mode buttons at the right end of a
 * horizontally-scrolling top bar, and reaching for the last one navigated
 * back, or at the root closed the app.
 *
 * The strip is 140 *device* pixels on the reference phone (`dumpsys window`, the
 * `systemGestures` inset, with the back-gesture size at 1.66x), and
 * this constant is compared with `clientX`, which is CSS pixels. The first
 * value here was the device number used as-is: at 2.8 dpr that made a third
 * of the screen dead on each side, so a swipe that started anywhere but the
 * middle 120 px of a 384 px screen was silently dropped -- which reads as a
 * viewer that ignores you. Converted here, with a little margin for a bigger
 * setting.
 *
 * Nothing in the phone shell may rely on a horizontal drag to reveal content.
 * Tool surfaces are grids and sheets, never carousels. This flag exists so that
 * rule is checkable in code rather than only written in a comment.
 */
export const EDGE_GESTURE_DEVICE_PX = 160;
export const EDGE_GESTURE_PX = edgeGestureCssPx(
  typeof window === "undefined" ? 1 : window.devicePixelRatio,
);

/** The back-gesture strip in CSS px for a display of `dpr`; never wider than 130. */
export function edgeGestureCssPx(dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(130, Math.ceil(EDGE_GESTURE_DEVICE_PX / d));
}

/**
 * Bottom inset for the gesture pill / navigation bar.
 *
 * `env(safe-area-inset-bottom)` is the right answer and CSS uses it directly.
 * This is the JS-side reading for the cases that need a number — sheet snap
 * points, scroll-into-view maths — with a floor rather than a zero, because a
 * WebView that reports 0 on a device that does have a pill is a bar drawn under
 * the pill, and a too-large inset only ever costs padding.
 */
export function bottomInset(): number {
  if (typeof window === "undefined") return 0;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;bottom:0;height:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}
