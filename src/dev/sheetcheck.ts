/**
 * Swipe the sheet down to close it.
 *
 * The Details sheet had exactly one way out: a Close button in the top right
 * corner of a bottom sheet, which is the furthest point on the screen from the
 * thumb of the hand holding the phone. Every other app on the device closes a
 * sheet by pushing it back down, so FACET does now too.
 *
 * A dismissal gesture is the kind of thing that is easy to make work and hard
 * to make *not fire when it shouldn't*, and that is what is checked here. The
 * four ways it can go wrong, in the order they bite:
 *
 *  - **A tap becomes a close.** Every finger moves a few pixels. If the sheet
 *    starts sliding on 2 px of travel, tapping a row in the facts list closes
 *    the sheet instead, and the user has no idea why.
 *  - **A scroll becomes a close.** The Details body scrolls. Dragging down
 *    from the middle of a scrolled list is "go back up", not "get out"; only
 *    from the very top do the two mean the same thing.
 *  - **A flick that isn't far enough springs back.** Distance alone reads as
 *    the app ignoring a deliberate throw, so speed closes it too.
 *  - **Letting go over a button presses it.** A drag that ends over Close is
 *    harmless; the same drag on a sheet with Delete in it is not.
 *
 * Dev-only. Loaded by /dev/sheetcheck.html, which is not a build input.
 */

import "../styles/base.css";

import { dragToDismiss, shouldDismiss } from "@ui/phone/sheet-drag";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}   ${detail}`); }
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A sheet the size of a real one, with a scrolling body and a button in it. */
interface Rig {
  sheet: HTMLElement;
  body: HTMLElement;
  button: HTMLButtonElement;
  clicks: number;
  closes: number;
  off(): void;
  drop(): void;
}

function rig(): Rig {
  const sheet = document.createElement("div");
  sheet.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;height:400px;background:#222";
  const head = document.createElement("div");
  head.className = "phv-sheet-head";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Close";
  head.append(button);
  const body = document.createElement("div");
  body.className = "phv-sheet-body";
  body.style.cssText = "height:200px;overflow-y:auto";
  const tall = document.createElement("div");
  tall.style.height = "2000px";
  body.append(tall);
  sheet.append(head, body);
  document.body.append(sheet);

  const out: Rig = {
    sheet, body, button, clicks: 0, closes: 0,
    off: () => {},
    drop: () => { off(); sheet.remove(); },
  };
  button.addEventListener("click", () => { out.clicks++; });
  const off = dragToDismiss(sheet, {
    dismiss: () => { out.closes++; },
    scroller: () => sheet.querySelector(".phv-sheet-body"),
  });
  out.off = off;
  return out;
}

function point(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, isPrimary: true, pointerType: "touch",
    clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
}

/**
 * One drag, in `steps` moves over `ms`, from `(x, y0)` to `(x, y0 + dy)`.
 *
 * Real elapsed time between the moves, because velocity is computed from the
 * events' own timestamps and a synchronous burst of them all happens in the
 * same millisecond -- which reads as a drag at zero speed.
 */
async function drag(
  el: Element,
  opts: { from?: [number, number]; dx?: number; dy: number; ms?: number; steps?: number; hold?: boolean },
): Promise<void> {
  const [x0, y0] = opts.from ?? [200, 100];
  const steps = opts.steps ?? 6;
  const ms = opts.ms ?? 120;
  const dx = opts.dx ?? 0;
  point(el, "pointerdown", x0, y0);
  for (let i = 1; i <= steps; i++) {
    await wait(ms / steps);
    point(el, "pointermove", x0 + (dx * i) / steps, y0 + (opts.dy * i) / steps);
  }
  if (opts.hold !== true) point(el, "pointerup", x0 + dx, y0 + opts.dy);
}

function main(): Promise<void> {
  return (async () => {
    // ── The rule itself ──────────────────────────────────────────────────
    {
      ok("an upward drag never closes", !shouldDismiss(-200, 400, 5));
      ok("standing still never closes", !shouldDismiss(0, 400, 0));
      ok("a slow 40 px drag springs back", !shouldDismiss(40, 400, 0.1));
      ok("a slow drag past a third of the sheet closes", shouldDismiss(140, 400, 0.05));
      ok("a fast flick closes without going far", shouldDismiss(30, 400, 1.2));
      ok("a fast twitch of 10 px does not close", !shouldDismiss(10, 400, 3));
      // The edit sheet's stub is 4.5rem tall; 28% of it is 20 px, which every
      // tap clears.
      ok("a short sheet still needs a real push", !shouldDismiss(40, 72, 0.1));
      ok("...and closes when it gets one", shouldDismiss(70, 72, 0.1));
    }

    // ── Taps are not drags ───────────────────────────────────────────────
    {
      const r = rig();
      point(r.button, "pointerdown", 200, 100);
      point(r.button, "pointermove", 201, 103);
      point(r.button, "pointerup", 201, 103);
      r.button.click();
      await wait(30);
      ok("a 3 px wobble does not close the sheet", r.closes === 0, String(r.closes));
      ok("...and the button under it still fires", r.clicks === 1, String(r.clicks));
      ok("...and the sheet was never moved", r.sheet.style.transform === "",
        r.sheet.style.transform);
      r.drop();
    }

    // ── A real drag ──────────────────────────────────────────────────────
    {
      const r = rig();
      await drag(r.sheet, { dy: 200, ms: 120 });
      await wait(300);
      ok("a long drag down closes the sheet", r.closes === 1, String(r.closes));
      ok("...and the transform is handed back afterwards",
        r.sheet.style.transform === "" && r.sheet.style.opacity === "",
        `${r.sheet.style.transform} / ${r.sheet.style.opacity}`);
      ok("...leaving no drag classes behind",
        !r.sheet.classList.contains("phv-dragging")
        && !r.sheet.classList.contains("phv-dropping"),
        r.sheet.className);
      r.drop();
    }

    {
      const r = rig();
      // 45 px in 400 ms: neither far enough nor fast enough.
      await drag(r.sheet, { dy: 45, ms: 400, steps: 8 });
      await wait(60);
      ok("a short slow drag springs back instead", r.closes === 0, String(r.closes));
      ok("...and the sheet is left where it was", r.sheet.style.transform === "",
        r.sheet.style.transform);
      r.drop();
    }

    {
      const r = rig();
      // 60 px in 30 ms is a flick: under the distance bar, over the speed one.
      await drag(r.sheet, { dy: 60, ms: 30, steps: 4 });
      await wait(300);
      ok("a flick closes it even though it did not travel far",
        r.closes === 1, String(r.closes));
      r.drop();
    }

    // ── Mid-drag the sheet actually moves ────────────────────────────────
    {
      const r = rig();
      await drag(r.sheet, { dy: 90, ms: 60, steps: 3, hold: true });
      ok("the sheet follows the finger", /translateY\(9\d(\.\d+)?px\)/.test(r.sheet.style.transform),
        r.sheet.style.transform);
      ok("...and fades as it goes", Number(r.sheet.style.opacity) < 1,
        r.sheet.style.opacity);
      ok("...with the transition off while it is under the finger",
        r.sheet.classList.contains("phv-dragging"), r.sheet.className);
      point(r.sheet, "pointercancel", 200, 190);
      ok("a cancelled drag puts it straight back",
        r.sheet.style.transform === "" && r.closes === 0, r.sheet.style.transform);
      r.drop();
    }

    // ── Scrolling wins ───────────────────────────────────────────────────
    {
      const r = rig();
      r.body.scrollTop = 300;
      ok("the body really is scrolled", r.body.scrollTop === 300, String(r.body.scrollTop));
      await drag(r.body, { dy: 200, ms: 120 });
      await wait(300);
      ok("dragging down inside a scrolled body scrolls, it does not close",
        r.closes === 0, String(r.closes));
      r.body.scrollTop = 0;
      await drag(r.body, { dy: 200, ms: 120 });
      await wait(300);
      ok("...and the same drag from the top does close",
        r.closes === 1, String(r.closes));
      r.drop();
    }

    // ── Directions that are not "down" ───────────────────────────────────
    {
      const r = rig();
      await drag(r.sheet, { dx: 250, dy: 20, ms: 120 });
      await wait(300);
      ok("a sideways swipe is not a dismissal", r.closes === 0, String(r.closes));
      r.drop();
    }
    {
      const r = rig();
      await drag(r.sheet, { dy: -200, ms: 120 });
      await wait(300);
      ok("an upward drag is not a dismissal", r.closes === 0, String(r.closes));
      // ...and having given up on it, the sheet must not lurch when the finger
      // comes back down through where it started.
      ok("...and nothing moved on the way", r.sheet.style.transform === "",
        r.sheet.style.transform);
      r.drop();
    }

    // ── The click after a drag ───────────────────────────────────────────
    {
      const r = rig();
      point(r.button, "pointerdown", 200, 100);
      await wait(20);
      point(r.button, "pointermove", 200, 160);
      await wait(20);
      point(r.button, "pointermove", 200, 220);
      point(r.button, "pointerup", 200, 220);
      r.button.click();
      await wait(300);
      ok("a drag that ends on a button does not press it", r.clicks === 0, String(r.clicks));
      ok("...it closes the sheet, once", r.closes === 1, String(r.closes));
      // And the swallow is spent: the next real tap works.
      r.button.click();
      ok("...and the next tap is a tap again", r.clicks === 1, String(r.clicks));
      r.drop();
    }

    // ── Undoing it ───────────────────────────────────────────────────────
    {
      const r = rig();
      r.off();
      await drag(r.sheet, { dy: 250, ms: 120 });
      await wait(300);
      ok("an unwired sheet ignores the gesture entirely", r.closes === 0, String(r.closes));
      r.sheet.remove();
    }

    const line = `sheet: ${pass} passed, ${fail} failed`;
    console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
    const banner = document.createElement("h2");
    banner.textContent = line;
    banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
    document.body.prepend(banner);
    document.title = line;
  })();
}

void main().catch((e: unknown) => {
  const line = `sheet: ${pass} passed, ${fail + 1} FAILED — threw: ${String(e)}`;
  document.title = line;
  console.log(line);
  console.error(e);
});
