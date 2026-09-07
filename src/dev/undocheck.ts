/**
 * Checks that undo outlives the process.
 *
 * The claim in item 24 is one word — "survives a restart" — and it is not a
 * claim any in-process test can make. So this harness runs in two phases with a
 * real page reload between them: phase one writes, phase two is a different
 * document object in a different JavaScript realm reading what the first one
 * left behind. Everything the first phase held in memory is gone by then, which
 * is the whole point.
 *
 * Dev-only. Loaded by /dev/undocheck.html, which is not one of the build's inputs.
 * Needs no fixtures — the photo it edits is a data URL built here.
 *
 *   http://localhost:8183/dev/undocheck.html
 *
 * The page title becomes the score once both phases have run.
 */

import "../styles/base.css";
import "../styles/shell.css";
import "../styles/viewer.css";

import { Viewer } from "@ui/viewer";
import { themes } from "@core/theme/theme-engine";
import { all, clear, drop, flush, load, save, type EditDoc } from "@core/undo/store";
import type { FileEntry } from "@core/explorer/types";

themes.init();

// The score has to cross the reload, so it lives where the reload cannot reach
// it: sessionStorage, which is per-tab and survives a same-tab navigation.
const PHASE = "undocheck-phase";
const TALLY = "undocheck-tally";

const tally = JSON.parse(sessionStorage.getItem(TALLY) ?? '{"pass":0,"fail":0}') as
  { pass: number; fail: number };

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { tally.pass++; console.log("ok  ", name); }
  else { tally.fail++; console.log("FAIL", name, " ", detail); }
  sessionStorage.setItem(TALLY, JSON.stringify(tally));
};

const settle = (ms = 60): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** A 4×4 PNG, so the viewer has something real to decode. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHUlEQVQI12P8" +
  "z8Dwn4EIwESMolGFowpHFQ4rhQBQBgQBk5m8ZAAAAABJRU5ErkJggg==";

const PHOTO: FileEntry = {
  path: "C:/undocheck/photo.png",
  name: "photo.png",
  kind: "image",
  ext: "png",
  size: 4096,
  modified: 1_700_000_000_000,
};

const viewer = new Viewer({
  fileUrl: () => Promise.resolve(PNG),
  writeFile: (p) => Promise.resolve(p),
  openExternal: () => Promise.resolve(),
});

const doc = (key: string, state: string, at: number, extra: Partial<EditDoc> = {}): EditDoc => ({
  key, kind: "photo", state, undo: [], redo: [], at, ...extra,
});

const q = <T extends Element>(sel: string): T | null => document.querySelector(sel);
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>(".viewer button")]
    .find((b) => b.textContent === label);

/**
 * The layer list as the user reads it. The names are `<input value>`, not text
 * nodes, so the panel's textContent does not contain a single region name.
 */
const layers = (): string[] =>
  [...document.querySelectorAll<HTMLInputElement>(".viewer-panel .vp-name")].map((i) => i.value);

/** One pointerdown/up on the overlay, which is a complete new-region gesture. */
function drawRegion(): void {
  const overlay = q<HTMLElement>(".viewer-overlay");
  if (!overlay) return;
  const box = overlay.getBoundingClientRect();
  const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  overlay.dispatchEvent(new PointerEvent("pointerdown", { ...at, button: 0, bubbles: true }));
  window.dispatchEvent(new PointerEvent("pointerup", { ...at, button: 0, bubbles: true }));
}

// ── Phase one: write ────────────────────────────────────────────────────────

async function first(): Promise<void> {
  await clear();

  // Round trip.
  save(doc("a", '["one"]', 1000));
  await flush();
  const got = await load("a", {});
  ok("what was saved comes back", got?.state === '["one"]', String(got?.state));

  // Coalescing. Three changes in one gesture must not be three writes, and the
  // one that lands has to be the last one, not the first.
  save(doc("b", "first", 1));
  save(doc("b", "second", 2));
  save(doc("b", "third", 3));
  await flush();
  ok("rapid changes coalesce to the newest",
    (await load("b", {}))?.state === "third", String((await load("b", {}))?.state));

  // Staleness. All three cases matter: an entry that was never stat'd must not
  // make every saved edit look suspect.
  save(doc("c", "x", 5, { size: 100, modified: 200 }));
  await flush();
  ok("a file that has not changed is not stale",
    (await load("c", { size: 100, modified: 200 }))?.stale === false);
  ok("a file whose size changed is stale",
    (await load("c", { size: 101, modified: 200 }))?.stale === true);
  ok("a file whose mtime changed is stale",
    (await load("c", { size: 100, modified: 999 }))?.stale === true);
  ok("an unstat'd entry is not called stale",
    (await load("c", {}))?.stale === false);

  // Trimming. A long brush session is megabytes of points; the document has to
  // shed history rather than fail to write at all.
  const fat = "x".repeat(300_000);
  save(doc("d", fat, 6, { undo: Array.from({ length: 30 }, () => fat), redo: [fat, fat] }));
  await flush();
  const trimmed = await load("d", {});
  ok("an oversized document still holds its current state",
    trimmed?.state.length === fat.length, String(trimmed?.state.length));
  ok("it sheds redo before undo", trimmed?.redo.length === 0, String(trimmed?.redo.length));
  ok("it keeps some undo rather than all or nothing",
    (trimmed?.undo.length ?? 0) >= 5 && (trimmed?.undo.length ?? 99) < 30,
    String(trimmed?.undo.length));

  // Pruning. Forty documents is a working set; five hundred is a leak.
  for (let i = 0; i < 50; i++) save(doc(`p${i}`, "s", 10_000 + i));
  await flush();
  const kept = await all();
  ok("the store does not grow without bound", kept.length <= 40, String(kept.length));
  ok("it is the oldest that go, not the newest",
    (await load("p49", {})) !== null && (await load("p0", {})) === null);
  ok("all() comes back newest first",
    kept.every((d, i) => i === 0 || (kept[i - 1]?.at ?? 0) >= d.at));

  await drop("a");
  ok("drop removes a document", (await load("a", {})) === null);

  // ── The editor itself ─────────────────────────────────────────────────────
  await clear();
  await viewer.open([PHOTO], PHOTO);
  await settle(120);
  ok("the viewer opened the photo", viewer.isOpen);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
  await settle();
  const rect = q<HTMLButtonElement>(".vp-tools button");
  rect?.click();
  drawRegion();
  await settle();
  ok("a region was drawn", layers().some((l) => l.startsWith("rect")), layers().join(","));

  // Closing must flush, or the last half-second of a session is the half that
  // is lost — which is the only half anyone notices.
  viewer.close();
  await settle(120);
  const persisted = await load(PHOTO.path, PHOTO);
  ok("closing the viewer wrote the edit out", persisted !== null);
  ok("and what it wrote is the region, not an empty list",
    (persisted?.state ?? "").includes("rect"), String(persisted?.state).slice(0, 60));

  sessionStorage.setItem(PHASE, "2");
  location.reload();
}

// ── Phase two: a different realm entirely ───────────────────────────────────

async function second(): Promise<void> {
  sessionStorage.removeItem(PHASE);

  const survived = await load(PHOTO.path, PHOTO);
  ok("the edit survived a restart", survived !== null);
  ok("with its region intact", (survived?.state ?? "").includes("rect"));

  await viewer.open([PHOTO], PHOTO);
  await settle(200);
  // The layer list only exists in edit mode, and `close()` left edit mode off —
  // as it should, since reopening a photo to look at it should not put anyone
  // in an editor.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
  await settle();
  ok("reopening the photo brings the region back",
    layers().some((l) => l.startsWith("rect")), layers().join(","));
  // Silently compositing week-old regions onto a photo is how someone exports
  // an edit they never made. It comes back, and it says that it came back.
  ok("and says so rather than doing it silently",
    (q(".viewer-restored")?.textContent ?? "").includes("restored"),
    q(".viewer-restored")?.textContent ?? "(no note)");
  ok("the note is not the alarming variant for an unchanged file",
    q(".viewer-restored")?.classList.contains("is-stale") === false);

  button("Discard")?.click();
  await settle(120);
  ok("Discard clears the regions", layers().length === 0, layers().join(","));
  ok("and forgets them for next time", (await load(PHOTO.path, PHOTO)) === null);

  // Same photo, different bytes: the case where applying the old edit blind is
  // actively wrong.
  save(doc(PHOTO.path, '[{"shape":"rect","id":"r9","label":"rect 1"}]', Date.now() - 86_400_000,
    { size: 999, modified: 1 }));
  await flush();
  viewer.close();
  await viewer.open([PHOTO], PHOTO);
  await settle(200);
  ok("a file that changed underneath gets the loud note",
    q(".viewer-restored")?.classList.contains("is-stale") === true,
    q(".viewer-restored")?.className ?? "(no note)");
  ok("and the note says the file changed",
    (q(".viewer-restored")?.textContent ?? "").includes("changed on disk"));

  await clear();
  viewer.close();

  const line = tally.fail === 0 ? `undo: ${tally.pass} passed` : `undo: ${tally.fail} FAILED of ${tally.pass + tally.fail}`;
  console.log(line);
  document.title = line;
  sessionStorage.removeItem(TALLY);
}

void (sessionStorage.getItem(PHASE) === "2" ? second() : first());
