/**
 * The zoom gesture, in a real browser, with real pointer events.
 *
 * "lol i cant even zoom in" is the complaint this surface exists to answer, and
 * `attachZoom` is about three hundred lines of gesture bookkeeping with nothing
 * checking it — the whole of it could be deleted and every other harness in the
 * suite would still be green. What makes it worth its own page rather than a
 * Node test is that none of it is arithmetic: it is pointer capture, a scroller
 * that clamps its own scroll offsets, a `click` the browser synthesises after
 * the last finger lifts, and four timers racing each other. A fake DOM would
 * agree with whatever the code did.
 *
 * The three regressions being pinned, all of which shipped at least once:
 *
 *  1. **Zooming toggled full screen.** The card took "show me this bigger" off
 *     a plain `click`, which fires when the *first* finger of a double-tap
 *     lifts. So the gesture that zoomed in also threw you into full screen.
 *  2. **A pinch jumped to the top-left.** Without anchoring, the point under
 *     your fingers is not the point that stays put, and reading a document
 *     becomes a game of hunting for the paragraph you were on.
 *  3. **Zoom stayed put between files.** The scale is per-file; a 4× left over
 *     from the last picture shows the next one cropped with no way to know why.
 *
 * Dev-only. Loaded by /dev/zoomcheck.html, which is not one of the build's
 * inputs.
 */

import "../styles/base.css";

import { attachZoom, type Zoom } from "@ui/zoom";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}   ${detail}`); }
};

/** The timings `zoom.ts` works to. Kept here as literals on purpose: a test
 *  that imports the constant it is checking agrees with a typo in it. */
const TAP_MS = 300;
const CLICK_GRACE = 450;
const SETTLE_MS = 220;

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/**
 * A scroller and a layer laid out like the real card: a fixed viewport with a
 * larger sheet inside it, so there is something to scroll and something to
 * anchor against. Sized in real pixels and attached to the document, because
 * every offset below comes from `getBoundingClientRect`.
 */
function rig(): { scroller: HTMLElement; layer: HTMLElement; kill: () => void } {
  const scroller = document.createElement("div");
  scroller.style.cssText =
    "position:fixed;left:0;top:0;width:400px;height:300px;overflow:auto;background:#111";
  const layer = document.createElement("div");
  layer.style.cssText = "width:400px;height:900px;transform-origin:0 0;background:#222";
  scroller.append(layer);
  document.body.append(scroller);
  return { scroller, layer, kill: () => scroller.remove() };
}

let nextId = 1;
function pointer(el: HTMLElement, type: string, x: number, y: number, id: number): void {
  el.dispatchEvent(new PointerEvent(type, {
    pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "touch",
  }));
}

/** One finger down and up at a point, as a phone delivers it. */
function tap(el: HTMLElement, x: number, y: number): void {
  const id = nextId++;
  pointer(el, "pointerdown", x, y, id);
  pointer(el, "pointerup", x, y, id);
}

/** Two fingers, `from` px apart, spread to `to` px, centred on (cx, cy). */
function pinch(el: HTMLElement, cx: number, cy: number, from: number, to: number): void {
  const a = nextId++;
  const b = nextId++;
  pointer(el, "pointerdown", cx - from / 2, cy, a);
  pointer(el, "pointerdown", cx + from / 2, cy, b);
  // Two moves, not one: the first is what the code samples as the start and a
  // single jump would be indistinguishable from a fling.
  pointer(el, "pointermove", cx - (from + to) / 4, cy, a);
  pointer(el, "pointermove", cx + (from + to) / 4, cy, b);
  pointer(el, "pointermove", cx - to / 2, cy, a);
  pointer(el, "pointermove", cx + to / 2, cy, b);
  pointer(el, "pointerup", cx - to / 2, cy, a);
  pointer(el, "pointerup", cx + to / 2, cy, b);
}

const near = (a: number, b: number, slop = 1.5): boolean => Math.abs(a - b) <= slop;

async function main(): Promise<void> {
  // ── Scale ──────────────────────────────────────────────────────────────
  {
    const { scroller, layer, kill } = rig();
    const z: Zoom = attachZoom(scroller, layer);

    ok("starts at 1x", z.scale === 1, String(z.scale));
    ok("and unscaled means no transform at all", layer.style.transform === "",
      layer.style.transform);

    pinch(scroller, 200, 150, 100, 200);
    ok("a pinch out zooms in", near(z.scale, 2, 0.05), String(z.scale));
    ok("and the layer carries the scale", /scale\(2/.test(layer.style.transform),
      layer.style.transform);

    pinch(scroller, 200, 150, 200, 100);
    ok("a pinch in zooms back out", near(z.scale, 1, 0.05), String(z.scale));

    // The clamp, from both ends. Past 8x a photo is a wall of pixels; below 1x
    // the card has empty margins where the file should be.
    pinch(scroller, 200, 150, 20, 900);
    ok("zoom stops at 8x", z.scale === 8, String(z.scale));
    pinch(scroller, 200, 150, 900, 20);
    ok("and never goes under 1x", z.scale === 1, String(z.scale));
    ok("back at 1x the transform is dropped again", layer.style.transform === "",
      layer.style.transform);

    kill();
  }

  // ── Anchoring ──────────────────────────────────────────────────────────
  // The point under the fingers is the point that must stay put.
  {
    const { scroller, layer, kill } = rig();
    const z = attachZoom(scroller, layer);

    // Pinch about a point 200 px down the sheet. In content coordinates that
    // is y = scrollTop + 200 = 200 at 1x; after a 2x it has to still be under
    // the same place on the glass, which puts scrollTop at 200.
    pinch(scroller, 200, 200, 100, 200);
    ok("a pinch anchors on the fingers, not the corner",
      near(scroller.scrollTop, 200, 8), `scrollTop ${scroller.scrollTop} at ${z.scale}x`);

    kill();
  }

  // ── Double tap ─────────────────────────────────────────────────────────
  {
    const { scroller, layer, kill } = rig();
    const z = attachZoom(scroller, layer);

    tap(scroller, 200, 150);
    tap(scroller, 200, 150);
    ok("a double tap zooms in", near(z.scale, 2.5, 0.01), String(z.scale));
    tap(scroller, 200, 150);
    tap(scroller, 200, 150);
    ok("and a second one comes back", z.scale === 1, String(z.scale));

    // Two taps far apart are two taps, not a gesture.
    tap(scroller, 40, 40);
    tap(scroller, 340, 260);
    ok("two taps in different places are not a double tap", z.scale === 1, String(z.scale));

    // Two taps too far apart in time, likewise.
    tap(scroller, 200, 150);
    await sleep(TAP_MS + 80);
    tap(scroller, 200, 150);
    ok("two slow taps are not a double tap", z.scale === 1, String(z.scale));

    kill();
  }

  // ── Tap vs. zoom: the full-screen bug ──────────────────────────────────
  {
    const { scroller, layer, kill } = rig();
    const taps: number[] = [];
    const z = attachZoom(scroller, layer, { onTap: () => taps.push(Date.now()) });

    tap(scroller, 200, 150);
    ok("a single tap is not reported immediately", taps.length === 0);
    await sleep(TAP_MS + 80);
    ok("it is reported once the double-tap window closes", taps.length === 1,
      String(taps.length));

    // The regression: the first finger of a double-tap must not also count as
    // a tap, or zooming in throws you into full screen on the way.
    tap(scroller, 200, 150);
    tap(scroller, 200, 150);
    await sleep(TAP_MS + CLICK_GRACE + 100);
    ok("a double tap never reports a tap", taps.length === 1, String(taps.length));
    ok("...and it did zoom", near(z.scale, 2.5, 0.01), String(z.scale));

    // A pinch, likewise -- it ends with a synthesised click on some platforms.
    const before = taps.length;
    pinch(scroller, 200, 150, 100, 200);
    await sleep(TAP_MS + CLICK_GRACE + 100);
    ok("a pinch never reports a tap", taps.length === before, String(taps.length));

    // A drag is not a tap either.
    const id = nextId++;
    pointer(scroller, "pointerdown", 100, 100, id);
    pointer(scroller, "pointermove", 100, 220, id);
    pointer(scroller, "pointerup", 100, 220, id);
    const dragged = taps.length;
    await sleep(TAP_MS + 80);
    ok("a drag is not a tap", taps.length === dragged, String(taps.length));

    kill();
  }

  // ── The click a zoom leaves behind ─────────────────────────────────────
  // Reported by the host as "the picture went full screen when I let go".
  {
    const { scroller, layer, kill } = rig();
    attachZoom(scroller, layer);
    let clicks = 0;
    scroller.addEventListener("click", () => { clicks++; });

    pinch(scroller, 200, 150, 100, 200);
    scroller.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    ok("the click that ends a pinch is swallowed", clicks === 0, String(clicks));

    await sleep(CLICK_GRACE + 80);
    scroller.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    ok("a later click gets through", clicks === 1, String(clicks));

    kill();
  }

  // ── Redraw ─────────────────────────────────────────────────────────────
  // "I should be able to zoom in without lowering quality": anything drawn
  // rather than photographed has to be re-rendered at the new scale, and the
  // host is told once the gesture has stopped rather than on every frame.
  {
    const { scroller, layer, kill } = rig();
    const settles: number[] = [];
    const z = attachZoom(scroller, layer, { onSettle: (s) => settles.push(s) });

    pinch(scroller, 200, 150, 100, 200);
    ok("no redraw while the fingers are still moving", settles.length === 0,
      String(settles.length));

    await sleep(SETTLE_MS + 120);
    ok("one redraw once the zoom stops", settles.length === 1, String(settles.length));
    ok("and it carries the scale to redraw at", near(settles[0] ?? 0, z.scale, 0.05),
      `${String(settles[0])} vs ${z.scale}`);

    // A gesture that ends where it started has nothing to redraw.
    const seen = settles.length;
    pinch(scroller, 200, 150, 100, 100);
    await sleep(SETTLE_MS + 120);
    ok("a gesture that changed nothing asks for no redraw", settles.length === seen,
      String(settles.length));

    kill();
  }

  // ── Reset ──────────────────────────────────────────────────────────────
  {
    const { scroller, layer, kill } = rig();
    const z = attachZoom(scroller, layer);

    pinch(scroller, 200, 150, 100, 300);
    ok("zoomed and scrolled before the reset", z.scale > 1 && scroller.scrollTop > 0,
      `${z.scale}x, ${scroller.scrollTop}px`);

    z.reset();
    ok("reset goes back to 1x", z.scale === 1, String(z.scale));
    ok("reset drops the transform", layer.style.transform === "", layer.style.transform);
    ok("reset scrolls back to the top", scroller.scrollTop === 0, String(scroller.scrollTop));
    ok("reset hands scrolling back to the browser", scroller.style.touchAction === "",
      scroller.style.touchAction);

    // A double tap half-finished before a new file must not complete after it.
    tap(scroller, 200, 150);
    z.reset();
    tap(scroller, 200, 150);
    ok("a tap from before the reset does not pair with one after",
      z.scale === 1, String(z.scale));

    kill();
  }

  // ── Ctrl-wheel ─────────────────────────────────────────────────────────
  // What a trackpad pinch and a mouse wheel both arrive as on the desktop.
  {
    const { scroller, layer, kill } = rig();
    const z = attachZoom(scroller, layer);

    const wheel = (dy: number, ctrl: boolean): boolean => {
      const e = new WheelEvent("wheel", {
        deltaY: dy, ctrlKey: ctrl, clientX: 200, clientY: 150,
        bubbles: true, cancelable: true,
      });
      scroller.dispatchEvent(e);
      return e.defaultPrevented;
    };

    ok("a plain wheel still scrolls", !wheel(120, false) && z.scale === 1, String(z.scale));
    const prevented = wheel(-200, true);
    ok("ctrl-wheel up zooms in", z.scale > 1, String(z.scale));
    ok("and the page is not zoomed as well", prevented);
    wheel(200, true);
    ok("ctrl-wheel down zooms back out", near(z.scale, 1, 0.05), String(z.scale));

    kill();
  }

  const line = `zoom: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
  document.title = line;
}

void main().catch((e: unknown) => {
  const line = `zoom: ${pass} passed, ${fail + 1} FAILED — threw: ${String(e)}`;
  document.title = line;
  console.log(line);
  console.error(e);
});
