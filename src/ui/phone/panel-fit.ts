/**
 * Making the eighteen desktop panels usable with a thumb.
 *
 * The phone shell owns pictures and video. Everything else — the OCR reader,
 * the subtitle editor, the video and audio editors, the 3D scene, the batch
 * queue, the watch folders, the transcriber, the table viewer, settings,
 * shortcuts, places, metadata, the camera, the recorder — is a panel that
 * already exists, already works, and was written for a mouse and a keyboard.
 *
 * Rewriting eighteen panels for a phone is a rewrite of the app. What they
 * actually need is three things, and all three are mechanical:
 *
 *  1. **A word on every button.** Panels label their controls with `title`, the
 *     attribute that only exists if you can hover. A finger cannot hover, so a
 *     row of "✕ ⟲ ⤓ ◐" is a row of riddles. This walks the panel and puts the
 *     title's own text under the glyph.
 *  2. **A way back.** Every panel closes on Escape and none of them knows what
 *     a back gesture is; `PhoneShell` handles the gesture, and this makes sure
 *     the close control is big enough to hit as well.
 *  3. **Room to breathe.** Handled in `phone-panels.css`, which this file is the
 *     other half of.
 *
 * It runs as one observer over the body rather than a hook in each panel,
 * because a panel that gets rebuilt — and they all rebuild their bars when the
 * file changes — would otherwise lose its labels on the second open.
 */

/** Buttons whose entire content is a glyph or two. Anything longer is already
 *  a label and is left alone. */
const GLYPH_MAX = 3;

/** Panels live at these layers; see the z-index map in the desktop styles. */
const PANEL_Z = 40;

let observer: MutationObserver | null = null;
let queued = false;

/**
 * Start labelling. Idempotent — calling it twice does not install two
 * observers, and it is safe to call before any panel has ever been opened.
 */
export function fitPanels(): void {
  if (observer) return;

  sweep();

  observer = new MutationObserver((records) => {
    // The phone shell mutates constantly — a photo grid recycling tiles under a
    // finger is a burst of records every frame, and it is also the moment that
    // most needs the main thread. None of it can ever produce a panel, so it is
    // dropped before anything reads a computed style.
    if (!records.some(fromOutsideTheShell)) return;

    // Panels rebuild whole subtrees at once. Coalescing to one pass per frame
    // turns a burst of a hundred records into a single walk.
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sweep();
    });
  });
  // `attributes` as well as `childList`: every desktop panel is appended at
  // startup and parked with `hidden`, which the first sweep skips. One that
  // opens by clearing `hidden` and nothing else files no childList record, so
  // it would keep its desktop widths and bare glyphs on a 384 px screen.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "style", "class"],
  });
}

/** True when a mutation happened somewhere a panel could plausibly appear —
 *  which is anywhere except inside the phone shell's own chrome. */
function fromOutsideTheShell(record: MutationRecord): boolean {
  const target = record.target;
  const el = target instanceof Element ? target : target.parentElement;
  if (!el) return true;
  return el.closest(".ph, .phv") === null;
}

export function stopFittingPanels(): void {
  observer?.disconnect();
  observer = null;
}

function sweep(): void {
  for (const node of Array.from(document.body.children)) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.classList.contains("ph") || node.classList.contains("phv")) continue;
    if (!isPanel(node)) continue;
    node.classList.add("fct-phone-panel");
    label(node);
  }
}

function isPanel(node: HTMLElement): boolean {
  // Cheap rejection first: `[hidden]` is how every panel in this app parks
  // itself, and there are far more hidden panels than open ones.
  if (node.hidden) return false;
  const style = getComputedStyle(node);
  if (style.position !== "fixed") return false;
  const z = Number.parseInt(style.zIndex, 10);
  return Number.isFinite(z) && z >= PANEL_Z;
}

function label(root: HTMLElement): void {
  for (const btn of Array.from(root.querySelectorAll("button"))) {
    // An explicit opt-out, set by callers that want their glyph left bare.
    if (btn.dataset["fctLabelled"] !== undefined) continue;
    // A label already in place is left alone. This is a query on the button
    // rather than a flag on it, because a flag outlived the thing it stood
    // for: several buttons reassign their own `textContent` as their meaning
    // changes -- ▶ becoming ❚❚, ✕ becoming ↗ when a task finishes -- and that
    // assignment wipes the appended span. Flagged, they stayed bare for the
    // rest of the session. Asked, they get the word back on the next sweep,
    // and the sweep is already running because the assignment mutated the DOM.
    if (btn.querySelector(".fct-blabel") !== null) continue;

    // `title` wins for a button whose accessible name we wrote ourselves out of
    // its title. Several of these buttons change meaning in place and update
    // their tooltip when they do -- batch's ✕ becoming ↗ when the task finishes
    // is the clearest -- and reading back the aria-label we pinned on the first
    // pass would relabel the new glyph with the old word.
    const derived = btn.dataset["fctNameFromTitle"] !== undefined;
    const name = (derived ? btn.title : btn.getAttribute("aria-label") ?? btn.title).trim();
    if (name === "") continue;

    // What the button already shows. A button holding an `svg` reports empty
    // text, which is exactly the case that most needs a word.
    const shown = (btn.textContent ?? "").trim();
    if (shown.length > GLYPH_MAX) continue;

    const text = shorten(name);
    if (text === "" || text.toLowerCase() === shown.toLowerCase()) continue;

    const tag = document.createElement("span");
    tag.className = "fct-blabel";
    tag.textContent = text;
    btn.append(tag);
    btn.classList.add("fct-labelled");

    // The glyph was the whole accessible name a moment ago; now that a real
    // word is inside the button, the name has to stay the full one.
    if (btn.getAttribute("aria-label") === null || derived) {
      btn.setAttribute("aria-label", name);
      btn.dataset["fctNameFromTitle"] = "";
    }
  }
}

/**
 * A button label is written for a tooltip — "Close  (Esc)", "Rotate left
 * (Ctrl+[)". The shortcut is dead weight on a phone and the parenthesis eats
 * the width the word needs.
 */
function shorten(title: string): string {
  const head = title.split(/\s*[(–—]|\s{2,}/)[0] ?? title;
  const clean = head.replace(/[.:…]+$/, "").trim();
  return clean.length > 12 ? `${clean.slice(0, 11)}…` : clean;
}
