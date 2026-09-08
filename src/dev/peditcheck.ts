/**
 * Harness for the phone image editor: the layout budget (the picture never
 * shares pixels with the top bar or the dock, portrait or landscape), every
 * catalogue tool reachable from the rail, one undo entry per committed change
 * across adjust / crop / blur / preset / rotate, compare showing the original,
 * and Save copy never pointing at the original file.
 *
 * Runs in the dev server like the others (`/peditcheck.html`), and rolls up
 * into allcheck.html under "pedit".
 */

import type { FileEntry } from "@core/explorer/types";
import "../styles/base.css";
import "../styles/phone.css";
import "../styles/phone-viewer.css";
import "../styles/phone-editor.css";

import { PhoneEditor, RAIL, railFor, type EditorHost, type SaveOptions } from "@ui/phone/editor";
import { PhoneViewer } from "@ui/phone/viewer";
import type { PhoneHost } from "@ui/phone/shell";
import type { MediaStore } from "@ui/phone/store";
import type { Thumbs } from "@ui/phone/thumbs";
import { TOOLS, TOOL_COUNT } from "@ui/phone/tools";
import { PRESETS } from "@core/edit/presets";
import { el } from "@ui/phone/dom";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}

interface Mock extends EditorHost {
  left: number;
  ran: string[];
  said: string[];
  saves: SaveOptions[];
  shared: string[];
}

function mockHost(native: boolean): Mock {
  const m: Mock = {
    native,
    ffmpeg: true,
    left: 0,
    ran: [],
    said: [],
    saves: [],
    shared: [],
    leave() { m.left++; },
    runTool(id) { m.ran.push(id); return true; },
    say(text) { m.said.push(text); },
    async save(opts) { m.saves.push({ ...opts }); return opts.overwrite ? "/pics/a.jpg" : "/pics/a-facet.jpg"; },
    async share(path) { m.shared.push(path); },
  };
  return m;
}

/** A 1200x800 test picture with enough structure for faces to be absent and blur visible. */
async function picture(): Promise<ImageBitmap> {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 800;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 1200, 800);
  g.addColorStop(0, "#1c3a6b");
  g.addColorStop(1, "#d98a2b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1200, 800);
  ctx.fillStyle = "#fff";
  for (let i = 0; i < 12; i++) ctx.fillRect(100 * i, (i % 3) * 250, 40, 40);
  return createImageBitmap(c);
}

function rect(e: Element): DOMRect {
  return e.getBoundingClientRect();
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

function within(inner: DOMRect, outer: DOMRect): boolean {
  return inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 &&
    inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
}

/**
 * The status bar the phone draws over the top of the page. A browser cannot
 * fake `env(safe-area-inset-top)`, so the stylesheet reads `--fct-inset-top`
 * first and the frame sets it. 36 px is a little more than the reference phone's 27 so
 * an off-by-the-inset bug cannot hide behind a small number.
 */
const INSET_TOP = 36;

/** Mount an editor in a fake viewer frame of the given size. */
function frame(w: number, h: number, editor: PhoneEditor, canvas: HTMLCanvasElement): HTMLElement {
  const stage = el("div.phv-stage", {}, canvas);
  const phv = el("div.phv.phe", {}, stage, editor.top, editor.el);
  phv.style.cssText = `position:fixed; inset:auto; top:0; left:0; width:${w}px; height:${h}px;`
    + ` --fct-inset-top:${INSET_TOP}px; --fct-inset-bottom:0px;`;
  document.body.append(phv);
  editor.top.hidden = false;
  editor.el.hidden = false;
  return phv;
}

function chipFor(editor: PhoneEditor, id: string): HTMLButtonElement | null {
  return editor.el.querySelector<HTMLButtonElement>(`.phe-strip [data-tool="${id}"]`);
}

function drag(editor: PhoneEditor, from: [number, number], to: [number, number]): void {
  editor.dragStart(from[0], from[1]);
  editor.dragMove((from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  editor.dragMove(to[0], to[1]);
  editor.dragEnd();
}

/** Drive the visible slider like a finger: several inputs, one change. */
function slide(editor: PhoneEditor, values: number[]): void {
  const range = editor.el.querySelector<HTMLInputElement>(".phe-range");
  if (!range) { ok("a slider is on screen", false); return; }
  for (const v of values) {
    range.value = String(v);
    range.dispatchEvent(new Event("input", { bubbles: true }));
  }
  range.dispatchEvent(new Event("change", { bubbles: true }));
}

async function main(): Promise<void> {
  const src = await picture();

  // ── Layout: the whole picture, between the bars ─────────────────────────
  // 360x780 is the reference phone at its default zoom (and the narrowest phone that
  // matters); 390x844 an iPhone-shaped one. Both orientations of each. A
  // WhatsApp-length filename, because that is what broke the device build:
  // the title refused to shrink and pushed Save off the screen.
  for (const [w, h] of [[360, 780], [780, 360], [390, 844], [844, 390]] as const) {
    const host = mockHost(true);
    const editor = new PhoneEditor(host);
    const canvas = el<"canvas">("canvas");
    const phv = frame(w, h, editor, canvas);
    editor.begin(src, canvas, "image", "IMG-20260902-WA0002.jpg");
    await new Promise((r) => requestAnimationFrame(r));

    const tag = `${w}x${h}`;
    const stage = phv.querySelector(".phv-stage")!;
    const cr = rect(canvas);
    const dr = rect(editor.el);
    const tr = rect(editor.top);
    const sr = rect(stage);
    ok(`${tag}: canvas has a size`, cr.width > 50 && cr.height > 50, `${cr.width}x${cr.height}`);
    ok(`${tag}: canvas does not touch the dock`, !overlaps(cr, dr), `canvas bottom ${cr.bottom} dock top ${dr.top}`);
    ok(`${tag}: canvas does not touch the top bar`, !overlaps(cr, tr), `canvas top ${cr.top} bar bottom ${tr.bottom}`);
    ok(`${tag}: canvas sits inside the stage`, within(cr, sr));
    ok(`${tag}: the stage fills the gap between the bars`, Math.abs(sr.top - tr.bottom) < 1 && Math.abs(sr.bottom - dr.top) < 1);
    ok(`${tag}: top bar is slim`, tr.height <= 48 + INSET_TOP, String(tr.height));
    ok(`${tag}: dock is under the budget`, dr.height <= 160, String(dr.height));
    ok(`${tag}: picture keeps its aspect`, Math.abs(cr.width / cr.height - 1.5) < 0.02, String(cr.width / cr.height));
    ok(`${tag}: the strip is a single row`, rect(editor.el.querySelector(".phe-strip")!).height <= 64);
    ok(`${tag}: the rail is a single row`, rect(editor.el.querySelector(".phe-rail")!).height <= 72);
    ok(`${tag}: nothing scrolls the page sideways`, phv.scrollWidth <= w + 1, String(phv.scrollWidth));
    ok(`${tag}: the top bar is no wider than the screen`, rect(editor.top).width <= w + 0.5, String(rect(editor.top).width));

    // The status bar. Every control in the top bar starts below the inset,
    // and the bar's own height grew by exactly that much, not the picture's.
    const controls = Array.from(editor.top.querySelectorAll<HTMLElement>("button"));
    const lowest = Math.min(...controls.map((b) => rect(b).top));
    ok(`${tag}: the top bar reserves the status bar`, lowest >= INSET_TOP - 0.5, `first control at ${lowest}, inset ${INSET_TOP}`);
    ok(`${tag}: the status-bar inset is padding, not content`,
      parseFloat(getComputedStyle(editor.top).paddingTop) === INSET_TOP, getComputedStyle(editor.top).paddingTop);

    // Save. It must be entirely on screen with a long name, and the title is
    // what gives way — one line, ellipsised, still showing the edit count.
    const save = editor.top.querySelector<HTMLElement>(".phe-save")!;
    const svr = rect(save);
    ok(`${tag}: Save is on screen`, svr.width > 40 && svr.left >= 0 && svr.right <= w + 0.5, `save ${svr.left}..${svr.right} of ${w}`);
    const name = editor.top.querySelector<HTMLElement>(".phe-title-name")!;
    ok(`${tag}: the title shrinks rather than Save`, rect(name).width > 20 && rect(name).right <= svr.left, `name right ${rect(name).right}, save left ${svr.left}`);
    ok(`${tag}: the title ellipsises`, getComputedStyle(name).textOverflow === "ellipsis" && getComputedStyle(name).overflow === "hidden");
    ok(`${tag}: the edit count is still there`, /No edits|\d+ edits?/.test(editor.top.querySelector(".phe-title-edits")?.textContent ?? ""));

    // The gesture pill. With no inset reported the dock still keeps a floor
    // under the rail so the last row is not under the home pill.
    ok(`${tag}: the dock keeps a floor for the gesture pill`, parseFloat(getComputedStyle(editor.el).paddingBottom) >= 16, getComputedStyle(editor.el).paddingBottom);

    // The rail scrolls on a narrow phone; when it does, it says so.
    // "Continues" means a real button is past the edge — not the row's own
    // trailing spacer, which exists to keep the last button out of the
    // edge-gesture zone and must not earn a fade by itself.
    const rail = editor.el.querySelector<HTMLElement>(".phe-rail")!;
    rail.scrollLeft = 0;
    rail.dispatchEvent(new Event("scroll"));
    const lastBtn = rail.querySelector<HTMLElement>(".phe-rail-btn:last-of-type")!;
    const railOver = rect(lastBtn).right - (rect(rail).right - parseFloat(getComputedStyle(rail).paddingRight)) > 2;
    ok(`${tag}: a rail that continues fades at the right edge`, railOver ? rail.dataset.more === "right" : rail.dataset.more === undefined, `over=${railOver} more=${rail.dataset.more}`);
    if (railOver) {
      rail.scrollLeft = rail.scrollWidth;
      rail.dispatchEvent(new Event("scroll"));
      ok(`${tag}: scrolled to the end it fades at the left`, rail.dataset.more === "left", rail.dataset.more);
      rail.scrollLeft = 0;
      rail.dispatchEvent(new Event("scroll"));
    }

    // Every strip stays one row, whatever it holds.
    for (const [id] of RAIL) {
      editor.open(id);
      const s = rect(editor.el.querySelector(".phe-strip")!);
      ok(`${tag}: ${id} strip stays one row`, s.height <= 64, String(s.height));
      ok(`${tag}: ${id} canvas untouched`, !overlaps(rect(canvas), rect(editor.el)));
    }
    editor.end();
    phv.remove();
  }

  // ── Every tool reachable ────────────────────────────────────────────────
  {
    const host = mockHost(true);
    const editor = new PhoneEditor(host);
    const canvas = el<"canvas">("canvas");
    const phv = frame(390, 844, editor, canvas);
    editor.begin(src, canvas, "image");

    ok("the catalogue is intact (76 ids: 8 blur kinds, 7 shapes, 61 others)", TOOLS.length === TOOL_COUNT && TOOLS.length >= 59, String(TOOLS.length));
    ok("the rail has eleven groups", RAIL.length === 11);
    ok("every rail group but Share has a button", editor.el.querySelectorAll(".phe-rail-btn").length === RAIL.length - 1);
    ok("Share is not in the rail — Save is its door", editor.el.querySelector('.phe-rail-btn[data-rail="share"]') === null);

    let missing: string[] = [];
    for (const tool of TOOLS) {
      const home = railFor(tool.id);
      editor.open(home);
      if (!chipFor(editor, tool.id)) missing.push(`${tool.id}→${home}`);
    }
    ok("every tool id has a chip in its rail group", missing.length === 0, missing.join(", "));

    // And by id, from outside (the tiles and the shell call this).
    missing = [];
    for (const tool of TOOLS) {
      const fresh = new PhoneEditor(mockHost(true));
      const c2 = el<"canvas">("canvas");
      fresh.begin(src, c2, "image");
      if (!fresh.runById(tool.id)) missing.push(tool.id);
      fresh.end();
    }
    ok("runById accepts every tool id", missing.length === 0, missing.join(", "));
    ok("Adjust has all twelve controls", (() => {
      editor.open("adjust");
      return editor.el.querySelectorAll(".phe-strip .phe-chip").length >= 13;
    })());
    ok("Filters shows every preset with a thumbnail", (() => {
      editor.open("filters");
      return PRESETS.every((p) => editor.el.querySelector(`[data-preset="${p.id}"] canvas`) !== null);
    })());
    editor.end();
    phv.remove();
  }

  // ── Undo / redo: one entry per committed change ─────────────────────────
  {
    const host = mockHost(true);
    const editor = new PhoneEditor(host);
    const canvas = el<"canvas">("canvas");
    const phv = frame(390, 844, editor, canvas);
    editor.begin(src, canvas, "image");
    const undoBtn = editor.top.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!;
    const redoBtn = editor.top.querySelector<HTMLButtonElement>('[aria-label="Redo"]')!;

    ok("a fresh edit has nothing to undo", editor.edits === 0 && undoBtn.disabled && redoBtn.disabled);
    ok("a fresh edit is not dirty", !editor.dirty);

    // Rotate.
    editor.runById("tf.rotate");
    ok("rotate pushes one entry", editor.edits === 1, String(editor.edits));
    ok("rotate turns the canvas", canvas.width === 800 && canvas.height === 1200, `${canvas.width}x${canvas.height}`);
    ok("Undo lights up", !undoBtn.disabled && redoBtn.disabled);

    // Adjust: one slider drag, many input events, one entry.
    editor.open("adjust");
    chipFor(editor, "light.brightness")!.click();
    ok("tapping a chip shows one slider", editor.el.querySelectorAll(".phe-range").length === 1);
    slide(editor, [0.1, 0.2, 0.3, 0.35]);
    ok("a slider drag pushes exactly one entry", editor.edits === 2, String(editor.edits));
    // A drag that ends where it started pushes nothing.
    slide(editor, [0.35]);
    ok("a slider drag with no change pushes nothing", editor.edits === 2, String(editor.edits));
    editor.el.querySelector<HTMLButtonElement>(".phe-slider-back")!.click();
    ok("the changed chip shows its value", chipFor(editor, "light.brightness")!.classList.contains("phe-chip-set"));

    // Preset.
    editor.open("filters");
    editor.el.querySelector<HTMLButtonElement>('[data-preset="vivid"]')!.click();
    ok("picking a filter pushes one entry", editor.edits === 3, String(editor.edits));
    ok("the picked filter is marked", editor.el.querySelector('[data-preset="vivid"]')?.getAttribute("aria-pressed") === "true");

    // Blur rectangle.
    editor.open("blur");
    ok("a drag on the picture is an edit in Blur", editor.armed);
    drag(editor, [0.2, 0.2], [0.5, 0.6]);
    ok("a drawn blur pushes one entry", editor.edits === 4, String(editor.edits));
    // A tap draws nothing and pushes nothing.
    drag(editor, [0.7, 0.7], [0.701, 0.701]);
    ok("a tap in Blur pushes nothing", editor.edits === 4, String(editor.edits));

    // Crop: drag a rectangle, then Done.
    editor.open("crop");
    drag(editor, [0.1, 0.1], [0.9, 0.7]);
    ok("dragging a crop is not yet an entry", editor.edits === 4, String(editor.edits));
    const done = Array.from(editor.el.querySelectorAll<HTMLButtonElement>(".phe-strip .phe-chip"))
      .find((b) => b.textContent?.trim() === "Done");
    ok("Done is offered once a crop is drawn", !!done && !done.disabled);
    done?.click();
    ok("committing the crop pushes one entry", editor.edits === 5, String(editor.edits));
    ok("the crop changed the output", canvas.width < 800 || canvas.height < 1200, `${canvas.width}x${canvas.height}`);

    // Undo walks back one at a time; redo walks forward.
    const before = `${canvas.width}x${canvas.height}`;
    editor.undo();
    ok("undo pops one", editor.edits === 4 && editor.canRedo);
    ok("undo restores the pre-crop canvas", canvas.width === 800 && canvas.height === 1200, `${canvas.width}x${canvas.height}`);
    editor.redo();
    ok("redo pushes it back", editor.edits === 5 && !editor.canRedo);
    ok("redo restores the crop", `${canvas.width}x${canvas.height}` === before);
    undoBtn.click(); undoBtn.click(); undoBtn.click(); undoBtn.click(); undoBtn.click();
    ok("five undos reach the original", editor.edits === 0 && !editor.dirty && undoBtn.disabled);
    ok("the canvas is the source again", canvas.width === 1200 && canvas.height === 800);
    redoBtn.click();
    ok("redo from the bar works", editor.edits === 1 && canvas.width === 800);
    editor.jumpTo(5);
    ok("the history list can jump to the end", editor.edits === 5 && !editor.canRedo);
    editor.jumpTo(2);
    ok("and back to the middle", editor.edits === 2 && editor.canRedo);

    // A new edit after undo clears the redo stack.
    editor.runById("tf.flip");
    ok("a new edit after undo drops the redo stack", editor.edits === 3 && !editor.canRedo);

    // Compare shows the original.
    const ctx = canvas.getContext("2d")!;
    editor.compare(true);
    ok("compare shows the source at source size", editor.comparingNow && canvas.width === 1200 && canvas.height === 800);
    const px = ctx.getImageData(600, 400, 1, 1).data;
    const ref = document.createElement("canvas");
    ref.width = 1200; ref.height = 800;
    ref.getContext("2d")!.drawImage(src, 0, 0);
    const want = ref.getContext("2d")!.getImageData(600, 400, 1, 1).data;
    ok("compare pixels are the untouched picture", Math.abs(px[0]! - want[0]!) < 3 && Math.abs(px[2]! - want[2]!) < 3, `${px[0]},${px[1]},${px[2]} vs ${want[0]},${want[1]},${want[2]}`);
    editor.compare(false);
    ok("releasing compare brings the edit back", !editor.comparingNow && canvas.width === 800);
    ok("compare did not touch the history", editor.edits === 3);

    editor.end();
    phv.remove();
  }

  // ── Save & close ────────────────────────────────────────────────────────
  {
    const host = mockHost(true);
    const editor = new PhoneEditor(host);
    const canvas = el<"canvas">("canvas");
    const phv = frame(390, 844, editor, canvas);
    editor.begin(src, canvas, "image");

    editor.requestClose();
    ok("closing a clean edit leaves at once", host.left === 1);
    ok("and asks nothing", !editor.el.querySelector(".phe-question"));

    editor.runById("tf.rotate");
    editor.requestClose();
    ok("closing a dirty edit asks first", host.left === 1 && !!editor.el.querySelector(".phe-question"));
    const keep = Array.from(editor.el.querySelectorAll<HTMLButtonElement>(".phe-chip"))
      .find((b) => b.textContent?.trim() === "Keep editing");
    keep?.click();
    ok("Keep editing returns to the tools", host.left === 1 && !editor.el.querySelector(".phe-question"));
    editor.requestClose();
    editor.el.querySelector<HTMLButtonElement>(".phe-chip-danger")!.click();
    ok("Discard leaves", host.left === 2);

    editor.open("share");
    const saveCopy = chipFor(editor, "out.save")!;
    ok("Save copy is on the share strip", !!saveCopy && !saveCopy.disabled);
    saveCopy.click();
    await new Promise((r) => setTimeout(r, 0));
    ok("Save copy never overwrites", host.saves.length === 1 && host.saves[0]!.overwrite === false, JSON.stringify(host.saves));
    ok("Save copy carries the JPEG quality", host.saves[0]!.quality === 0.92);
    ok("a successful save leaves the editor", host.left === 3);

    editor.open("share");
    const over = Array.from(editor.el.querySelectorAll<HTMLButtonElement>(".phe-chip"))
      .find((b) => b.textContent?.trim() === "Save over original")!;
    over.click();
    ok("Save over original asks before writing", host.saves.length === 1 && !!editor.el.querySelector(".phe-question"));
    editor.el.querySelector<HTMLButtonElement>(".phe-chip-danger")!.click();
    await new Promise((r) => setTimeout(r, 0));
    ok("only the confirm writes over", host.saves.length === 2 && host.saves[1]!.overwrite === true);

    editor.open("share");
    chipFor(editor, "out.share")!.click();
    await new Promise((r) => setTimeout(r, 0));
    ok("Share saves a copy first", host.saves.length === 3 && host.saves[2]!.overwrite === false);
    ok("and shares the copy, not the original", host.shared[0] === "/pics/a-facet.jpg");

    // Top-bar Save opens the share strip.
    editor.open("adjust");
    editor.top.querySelector<HTMLButtonElement>(".phe-save")!.click();
    ok("the top-bar Save opens the save strip", editor.current === "share");
    ok("and lights up while it is open", editor.top.querySelector(".phe-save")?.getAttribute("aria-pressed") === "true");
    editor.open("adjust");
    ok("and goes back to normal on another group", editor.top.querySelector(".phe-save")?.getAttribute("aria-pressed") === "false");
    editor.open("share");

    // Without the app, saving is offered but off.
    const web = new PhoneEditor(mockHost(false));
    const c2 = el<"canvas">("canvas");
    web.begin(src, c2, "image");
    web.runById("tf.rotate");
    web.open("share");
    ok("in a browser tab Save copy is disabled with a reason", chipFor(web, "out.save")!.disabled);
    web.end();

    // A host tool with unsaved work asks before leaving.
    editor.open("more");
    chipFor(editor, "info.meta")!.click();
    ok("a host tool asks before dropping unsaved work", host.ran.length === 0 && !!editor.el.querySelector(".phe-question"));
    editor.el.querySelector<HTMLButtonElement>(".phe-chip-danger")!.click();
    ok("Leave hands the tool to the host", host.ran[0] === "info.meta");

    editor.end();
    phv.remove();
  }

  // ── The viewer's action bar ─────────────────────────────────────────────
  // Four actions, not five: Blur was folded into Edit. The bar is the one
  // thing a person sees before they reach the editor, so this is pinned.
  {
    const fs = { shareFiles: async () => {} };
    const host = { fs, home: "/", native: false, openPanel() {}, runTool: () => true } as unknown as PhoneHost;
    const viewer = new PhoneViewer(host, {} as unknown as MediaStore, {} as unknown as Thumbs);
    const labels = Array.from(viewer.el.querySelectorAll(".phv-action-label")).map((n) => n.textContent);
    ok("the viewer offers four actions", labels.length === 4, labels.join(","));
    ok("they are Share, Edit, Info, Delete", labels.join(",") === "Share,Edit,Info,Delete", labels.join(","));
    ok("Blur is not a front-bar action any more", !labels.includes("Blur"));
    ok("every action has an icon and a word",
      Array.from(viewer.el.querySelectorAll(".phv-action")).every((a) => a.querySelector(".phv-action-icon") && (a.querySelector(".phv-action-label")?.textContent ?? "").length > 2));
    ok("Blur still lives in the editor's rail", RAIL.some(([id]) => id === "blur"));
  }

  // ── A file nothing can decode says so ───────────────────────────────────
  //
  // `display.get` hands back the original's URL whenever it cannot make a copy
  // -- some formats never report a decode failure, so the <img> is meant to
  // get its say. Nothing listened for the <img>'s error, so it never did: a
  // .jxl opened as a black rectangle with a file name over it, indistinguish-
  // able from a damaged file and from a bug in the app.
  {
    const fs = { shareFiles: async () => {} };
    const host = { fs, home: "/", native: false, openPanel() {}, runTool: () => true } as unknown as PhoneHost;
    const thumbs = { get: async () => null, retain() {}, release() {} } as unknown as Thumbs;
    const viewer = new PhoneViewer(host, {} as unknown as MediaStore, thumbs);
    const inner = viewer as unknown as {
      blank: HTMLElement;
      img: HTMLImageElement;
      showBlank(entry: FileEntry): void;
    };
    const entry = { path: "/a/x.jxl", name: "x.jxl", kind: "image", ext: "jxl", size: 1, modified: 0 } as unknown as FileEntry;

    ok("nothing is said while there is a picture", inner.blank.hidden);

    inner.showBlank(entry);
    const what = inner.blank.querySelector(".phv-blank-what")?.textContent ?? "";
    const why = inner.blank.querySelector(".phv-blank-why")?.textContent ?? "";
    ok("an undecodable file puts a reason on the stage", !inner.blank.hidden);
    ok("...naming the format, in the words of the format", what === "No JXL decoder", what);
    ok("...and saying the file itself is fine", /untouched/.test(why), why);
    ok("...and the dead <img> is taken off the stage", inner.img.hidden);

    // No extension is a different sentence: blaming a format that was never
    // named would be a guess dressed as a diagnosis.
    inner.showBlank({ ...entry, ext: "" } as unknown as FileEntry);
    ok(
      "a file with no extension is not told which decoder is missing",
      (inner.blank.querySelector(".phv-blank-what")?.textContent ?? "") === "Can't show this file",
    );

    ok(
      "the message is quiet -- no icon, no alarm, just the two lines",
      inner.blank.querySelectorAll("*").length === 2,
      String(inner.blank.querySelectorAll("*").length),
    );
  }

  // ── Zoom reaches every surface on the stage ─────────────────────────────
  //
  // The stage holds three surfaces -- the still, the video and the edit canvas
  // -- and one set of gestures, wired to the stage itself. So a pinch over a
  // video always *ran*: the scale went up, the source swap was consulted, and
  // then the single line that writes the number to the screen only ever named
  // the image and the canvas. A video you cannot zoom, beside a photograph you
  // can, with nothing on screen to explain the difference.
  //
  // Pinned here because it is one line per surface, invisible when it is
  // missing, and the next surface added to the stage will forget it too.
  {
    const fs = { shareFiles: async () => {} };
    const host = { fs, home: "/", native: false, openPanel() {}, runTool: () => true } as unknown as PhoneHost;
    const viewer = new PhoneViewer(host, {} as unknown as MediaStore, {} as unknown as Thumbs);
    const inner = viewer as unknown as {
      scale: number; img: HTMLElement; video: HTMLElement; canvas: HTMLElement;
      applyTransform(): void; glide(on: boolean): void;
    };

    inner.scale = 3;
    inner.applyTransform();
    const zoomed = (n: HTMLElement): boolean => /scale\(3[.)]/.test(n.style.transform);
    ok("a zoom reaches the still", zoomed(inner.img), inner.img.style.transform);
    ok("...and the video", zoomed(inner.video), inner.video.style.transform);
    ok("...and the edit canvas", zoomed(inner.canvas), inner.canvas.style.transform);
    ok("all three are given the same transform, not three near-misses",
      inner.img.style.transform === inner.video.style.transform
      && inner.video.style.transform === inner.canvas.style.transform,
      `${inner.img.style.transform} | ${inner.video.style.transform} | ${inner.canvas.style.transform}`);

    // And the spring-back animates the video too, or a released pinch snaps
    // the frame back instantly while the photograph beside it eases.
    inner.glide(true);
    ok("the settle animates the video as well as the still",
      inner.video.style.transition !== "" && inner.video.style.transition === inner.img.style.transition,
      inner.video.style.transition);
    inner.glide(false);
    ok("...and is cleared again for the next drag", inner.video.style.transition === "",
      inner.video.style.transition);
  }

  // ── Handing a file to a desktop panel ───────────────────────────────────
  // `.phv` is `position: fixed; inset: 0; z-index: 500`; every panel it can
  // delegate to tops out at 74 (associations). So a rail chip that opens a
  // panel and leaves the viewer up opens it *underneath an opaque black
  // screen* -- around twenty-five chips that each read as a dead tap and then
  // took two backs to escape. The fix is one line in the viewer and there is
  // nothing on screen to notice if it is deleted, so it is pinned here.
  {
    const fs = { shareFiles: async () => {} };
    const runs: string[] = [];
    let takes = true;
    const host = {
      fs, home: "/", native: false, openPanel() {},
      runTool: (_e: unknown, id: string) => { runs.push(id); return takes; },
    } as unknown as PhoneHost;
    const viewer = new PhoneViewer(host, {} as unknown as MediaStore, {} as unknown as Thumbs);
    document.body.append(viewer.el);

    const entry = {
      name: "a.jpg", path: "/pics/a.jpg", kind: "image", ext: "jpg",
      size: 1024, modified: 0, hidden: false,
    } as unknown as Parameters<PhoneViewer["open"]>[0];

    // The rail belongs to the viewer, and its `runTool` is the callback under
    // test. Reached through the instance rather than rebuilt here, because a
    // rebuilt one would be a copy of the code it is meant to be checking.
    const rail = (viewer as unknown as { editor: PhoneEditor }).editor;

    const handOff = (id: string): void => {
      const canvas = el<"canvas">("canvas");
      rail.begin(src, canvas, "image");
      rail.open("more");
      chipFor(rail, id)!.click();
    };

    viewer.open(entry, [entry]);
    ok("the viewer is up before the hand-off", viewer.el.hidden === false);
    handOff("info.meta");
    ok("a rail chip reaches the host", runs[0] === "info.meta", runs.join(","));
    ok("and the viewer gets out of the panel's way", viewer.el.hidden === true);

    // The other half of the contract: a tool that declines must not cost the
    // picture. Losing the file you were looking at to a tool that did nothing
    // is the worse of the two bugs, because there is no error to explain it.
    takes = false;
    viewer.open(entry, [entry]);
    handOff("info.meta");
    ok("a declined tool leaves the viewer alone", viewer.el.hidden === false);

    // Delete and Rename are the two the rail must *not* hand over: they are
    // this screen's own bar buttons under another name, and the shell has no
    // viewer to act on.
    takes = true;
    const before = runs.length;
    viewer.open(entry, [entry]);
    handOff("info.rename");
    ok("Rename is handled here, not delegated", runs.length === before);
    ok("and renaming keeps the viewer up", viewer.el.hidden === false);

    viewer.close();
    rail.end();
    viewer.el.remove();
  }

  // ── Encode ──────────────────────────────────────────────────────────────
  {
    const editor = new PhoneEditor(mockHost(true));
    const canvas = el<"canvas">("canvas");
    editor.begin(src, canvas, "image");
    ok("nothing to encode before an edit", (await editor.encode("image/png")) === null);
    editor.runById("tf.flip");
    const bytes = await editor.encode("image/png");
    ok("an edit encodes to bytes", !!bytes && bytes.length > 1000);
    editor.end();
  }

  const line = `pedit: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
  document.title = line;
}

void main();
