/**
 * Checks the four ways to look at a folder (item 34).
 *
 * Five claims, each of which is a way this could go wrong somewhere nobody
 * would think to look.
 *
 * **1. The mode list is the only list.** There used to be four places that each
 * named the modes themselves, and adding a fifth mode would have meant finding
 * all of them. So: the settings choices are generated from `MODES`, the ring is
 * generated from `MODES`, and this asserts they cannot drift apart.
 *
 * **2. Nothing that arrives from disk can make a folder unopenable.** A layout
 * comes out of a settings file and a per-folder rule, neither of which this
 * build wrote — the rule store is *older* than two of these modes. A saved
 * `"grid"` has to degrade to a working view, not throw on the way to painting.
 *
 * **3. Both new views are virtualised.** The point of virtualising is that the
 * folder you are afraid of — a `node_modules`, a camera roll of 40 000 — costs
 * a screenful. That is asserted by counting DOM nodes, because it is the kind
 * of property that is quietly lost in a refactor and never noticed until a
 * folder that size is opened.
 *
 * **4. The columns view actually walks.** Picking a folder opens it to the
 * right, picking a different one throws away the branch you are no longer on,
 * and picking a file peeks at it instead. That is the whole feature.
 *
 * **5. A slow listing that lands late must not overwrite a live column.** The
 * one race in this view: by the time a folder on a cold disk answers, the user
 * has usually clicked something else, and the answer to the question nobody is
 * asking any more must be dropped rather than painted.
 *
 * Dev-only. Loaded by /modecheck.html, which is not a build input.
 *
 *   http://localhost:8183/modecheck.html
 */

import "../styles/base.css";
import "../styles/columns.css";
import "../styles/gallery.css";

import {
  isMode,
  MODES,
  modeBlurb,
  modeChoices,
  modeGlyph,
  modeLabel,
  nextMode,
  parseMode,
  type ViewMode,
} from "@core/explorer/modes";
import { memoryRules, RulesStore } from "@core/explorer/rules";
import type { FileEntry, ViewConfig } from "@core/explorer/types";
import { ColumnsView } from "@ui/columns-view";
import { GalleryView } from "@ui/gallery-view";

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.error("FAIL", name, detail);
  }
};

const tick = (n = 1): Promise<void> =>
  new Promise((r) => {
    let left = n;
    const step = (): void => {
      if (--left <= 0) r();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

const CFG: ViewConfig = {
  sort: "name",
  ascending: true,
  group: "none",
  foldersFirst: true,
  showHidden: false,
  cardSize: 180,
  nameLines: 2,
  columns: "name,kind,size,modified",
  cardFields: "ext,size",
};

function file(name: string, kind: FileEntry["kind"] = "binary", parent = "C:/x"): FileEntry {
  const dot = name.lastIndexOf(".");
  return {
    path: `${parent}/${name}`,
    name,
    kind,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    size: 1024,
    modified: 1_700_000_000_000,
  };
}

function folder(name: string, parent = "C:/x"): FileEntry {
  return { path: `${parent}/${name}`, name, kind: "folder", ext: "" };
}

/** A host with a real size, because both views are arithmetic on a rectangle. */
function host(w: number, h: number): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:relative;width:${w}px;height:${h}px;overflow:hidden`;
  document.body.appendChild(el);
  return el;
}

function click(el: Element, init: MouseEventInit = {}): void {
  for (const type of ["mousedown", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  }
}

async function main(): Promise<void> {
  // ── 1. One list, four modes ───────────────────────────────────────────────

  ok("there are four modes", MODES.length === 4);
  ok("every id is unique", new Set(MODES.map((m) => m.id)).size === MODES.length);
  ok("every mode has a label, a glyph and a blurb",
    MODES.every((m) => m.label !== "" && m.glyph !== "" && m.blurb !== ""));
  ok("every mode parses as itself", MODES.every((m) => parseMode(m.id) === m.id));
  ok("every mode is recognised", MODES.every((m) => isMode(m.id)));
  ok("the list starts with the details list, which is the default",
    MODES[0]?.id === "list");

  ok("the settings choices are the modes, in order",
    JSON.stringify(modeChoices()) === JSON.stringify(MODES.map((m) => [m.id, m.label])));
  ok("…so a mode added to the list appears in settings without editing settings",
    modeChoices().length === MODES.length);

  ok("labels come from the list", modeLabel("gallery") === "Gallery");
  ok("glyphs come from the list", modeGlyph("columns") === MODES[2]?.glyph);
  ok("blurbs come from the list", modeBlurb("canvas") !== "");
  // Unknown ids reach these from a rule off disk on the way to a tooltip.
  ok("an unknown label is the id rather than a crash",
    modeLabel("grid" as ViewMode) === "grid");
  ok("an unknown glyph falls back to something printable",
    modeGlyph("grid" as ViewMode) !== "");

  // ── 2. Nothing off disk can strand a folder ───────────────────────────────

  ok("a mode from an older build parses to the fallback", parseMode("grid") === "list");
  ok("…and so does nothing at all", parseMode(undefined) === "list");
  ok("…and null", parseMode(null) === "list");
  ok("…and a number", parseMode(3) === "list");
  ok("…and an object", parseMode({ id: "gallery" }) === "list");
  ok("the fallback is honoured when given", parseMode("grid", "gallery") === "gallery");
  ok("a real mode ignores the fallback", parseMode("columns", "gallery") === "columns");
  ok("nothing is recognised that is not a mode",
    !isMode("grid") && !isMode("") && !isMode(undefined) && !isMode(0));

  // The ring: pressing the shortcut n times gets you home, and visits each one.
  let seen: ViewMode = "list";
  const walked: ViewMode[] = [];
  for (let i = 0; i < MODES.length; i++) {
    seen = nextMode(seen);
    walked.push(seen);
  }
  ok("cycling once per mode returns to where it started", seen === "list");
  ok("…having visited every mode exactly once",
    new Set(walked).size === MODES.length);
  ok("an unknown mode enters the ring at the start rather than sticking",
    nextMode("grid" as ViewMode) === MODES[0]?.id);

  // The rule store predates two of these modes and is the thing that reads them
  // back off disk, so it is checked against the same list.
  const rules = new RulesStore(memoryRules());
  for (const m of MODES) {
    rules.set(`C:/r/${m.id}`, { mode: m.id });
    ok(`a folder remembers ${m.id}`, rules.get(`C:/r/${m.id}`)?.mode === m.id);
  }
  const stale = new RulesStore(
    memoryRules(JSON.stringify({
      version: 1,
      folders: { "c:/old": { mode: "grid", sort: "size" } },
    })),
  );
  const kept = stale.get("C:/old");
  ok("a rule naming a layout this build cannot draw loses the layout",
    kept?.mode === undefined);
  ok("…and keeps the rest of the rule, which is still perfectly good",
    kept?.sort === "size");

  // ── 3. The gallery ────────────────────────────────────────────────────────

  const many: FileEntry[] = [];
  for (let i = 0; i < 4000; i++) many.push(file(`shot-${String(i).padStart(4, "0")}.jpg`, "image"));

  let asked = 0;
  const askedFor = new Set<string>();
  let resized = -1;
  const gHost = host(900, 600);
  const gallery = new GalleryView(gHost, { ...CFG }, {
    onOpen: () => undefined,
    onSelect: () => undefined,
    onWantPreview: (e) => {
      asked++;
      askedFor.add(e.path);
    },
    onResize: (px) => {
      resized = px;
    },
  });
  gallery.setEntries(many);
  await tick(2);

  const tiles = (): HTMLElement[] => [...gHost.querySelectorAll<HTMLElement>(".gv-tile")];
  ok("the gallery draws tiles", tiles().length > 0);
  ok("…but nothing like four thousand of them",
    tiles().length < 200, `${tiles().length} mounted`);
  // Every mounted tile asks, which is the difference between this and the list:
  // a gallery with no pictures in it is not a gallery.
  //
  // Counted per path, not against the current tile count. The first layout
  // mounts a screenful more than it settles on and then recycles down, so the
  // running total of asks is legitimately higher than the number of tiles left
  // on screen — which is all the old form of this check was measuring. What
  // has to hold is that nothing on screen is waiting on an ask that never
  // happened, and that no file is asked for twice.
  const unasked = tiles().filter((t) => !askedFor.has(t.title));
  ok("…and every mounted tile asks for its picture",
    askedFor.size > 0 && unasked.length === 0,
    `${unasked.length} of ${tiles().length} never asked`);
  ok("…and no picture is asked for twice",
    asked === askedFor.size, `${asked} asks, ${askedFor.size} paths`);

  const lefts = new Set(tiles().map((t) => t.style.left));
  ok("tiles are laid out in a grid, not a column", lefts.size > 1);
  const rowTop = tiles()[0]?.style.top;
  const perRow = tiles().filter((t) => t.style.top === rowTop).length;
  ok("…with more than one tile to a row", perRow > 1, `perRow=${perRow}`);
  ok("…and the row width is what fits, not a guess",
    perRow === Math.floor((900 - 16) / (180 + 16)), `perRow=${perRow}`);

  gallery.selectPaths([many[3]!.path]);
  await tick();
  ok("the gallery paints the shell's selection",
    gHost.querySelector('.gv-tile[aria-selected="true"]') !== null);

  gHost.querySelector<HTMLElement>(".gv-scroll")?.focus();
  gHost.querySelector<HTMLElement>(".gv-scroll")
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
  ok("zoom is stepped, and tells the shell so it is remembered",
    resized > CFG.cardSize, `${resized}`);

  gallery.destroy();
  gHost.remove();

  // ── 4. The columns walk ───────────────────────────────────────────────────

  const ROOT = [folder("Pictures"), folder("Music"), file("notes.txt", "document")];
  const PICTURES = [folder("2024", "C:/x/Pictures"), file("a.jpg", "image", "C:/x/Pictures")];
  const MUSIC = [file("track.mp3", "audio", "C:/x/Music")];

  /** Listings the harness can hold open, to test the race deliberately. */
  const held = new Map<string, (v: FileEntry[]) => void>();
  let holdNext = false;

  let selected: FileEntry[] = [];
  let opened: FileEntry | null = null;
  const cHost = host(1100, 600);
  const columns = new ColumnsView(cHost, { ...CFG }, {
    onOpen: (e) => {
      opened = e;
    },
    onSelect: (sel) => {
      selected = sel;
    },
    cwd: () => "C:/x",
    onList: (path) =>
      new Promise<FileEntry[]>((resolve) => {
        const answer =
          path === "C:/x/Pictures" ? PICTURES : path === "C:/x/Music" ? MUSIC : [];
        if (holdNext) held.set(path, resolve);
        else resolve(answer.slice());
      }),
  });
  columns.setEntries(ROOT);
  await tick(2);

  const cols = (): HTMLElement[] => [...cHost.querySelectorAll<HTMLElement>(".cv-col")];
  const rowsIn = (i: number): HTMLElement[] =>
    [...(cols()[i]?.querySelectorAll<HTMLElement>(".cv-row") ?? [])];

  ok("the columns view starts with one column", cols().length === 1);
  ok("…named after the folder the shell is in",
    cols()[0]?.querySelector(".cv-head")?.textContent === "x");
  ok("…holding the folder's entries", rowsIn(0).length === ROOT.length);
  ok("folders are the ones marked as having something to the right",
    rowsIn(0).filter((r) => r.querySelector(".cv-chev") !== null).length === 2);

  click(rowsIn(0)[0]!);
  await tick(2);
  ok("picking a folder opens it to the right", cols().length === 2);
  ok("…showing that folder's children",
    rowsIn(1).map((r) => r.dataset["path"]).join() === PICTURES.map((e) => e.path).join());
  ok("…and tells the shell what is selected, not what is showing",
    selected.length === 1 && selected[0]?.path === "C:/x/Pictures");
  ok("…without navigating anywhere", opened === null);

  click(rowsIn(0)[1]!);
  await tick(2);
  ok("picking a different folder throws away the branch you left",
    cols().length === 2 && rowsIn(1)[0]?.dataset["path"] === "C:/x/Music/track.mp3");

  click(rowsIn(0)[2]!);
  await tick(2);
  ok("picking a file peeks at it instead of opening a column",
    cols().length === 1 && cHost.querySelector(".cv-peek") !== null);
  ok("…and the peek is about that file",
    cHost.querySelector<HTMLElement>(".cv-peek")?.dataset["path"] === "C:/x/notes.txt");
  ok("…and offers to open it, since a peek is not an open",
    cHost.querySelector(".cv-open") !== null);

  click(cHost.querySelector(".cv-open")!);
  ok("…which is what actually opens it", (opened as FileEntry | null)?.name === "notes.txt");

  // Empty space clears the column, which also drops what it had opened.
  click(rowsIn(0)[0]!);
  await tick(2);
  click(cols()[0]!.querySelector(".cv-list")!);
  await tick();
  ok("clicking past the end of a column clears it, and the branch with it",
    cols().length === 1 && selected.length === 0);

  // Virtualised, same as the gallery and for the same reason.
  const huge: FileEntry[] = [];
  for (let i = 0; i < 5000; i++) huge.push(file(`f${i}.bin`));
  columns.setEntries(huge);
  await tick(2);
  ok("a column of five thousand files mounts a screenful",
    rowsIn(0).length > 0 && rowsIn(0).length < 120, `${rowsIn(0).length} rows`);
  ok("…while still reserving the height of all of them",
    Math.round(
      Number.parseFloat(
        cols()[0]?.querySelector<HTMLElement>(".cv-spacer")?.style.height ?? "0",
      ),
    ) === 5000 * 24);

  // ── 5. The race ───────────────────────────────────────────────────────────

  columns.setEntries(ROOT);
  await tick(2);
  holdNext = true;
  click(rowsIn(0)[0]!); // Pictures — held open, still "reading…"
  await tick(2);
  ok("a folder that has not answered yet says so rather than showing nothing",
    cols().length === 2 && cols()[1]?.querySelector(".cv-note")?.textContent === "Reading…");

  holdNext = false;
  click(rowsIn(0)[1]!); // Music — answers immediately, replacing the held column
  await tick(2);
  ok("clicking on while it thinks moves on",
    rowsIn(1)[0]?.dataset["path"] === "C:/x/Music/track.mp3");

  held.get("C:/x/Pictures")?.(PICTURES.slice());
  await tick(3);
  ok("…and the slow answer, arriving late, is dropped rather than painted",
    cols().length === 2 && rowsIn(1)[0]?.dataset["path"] === "C:/x/Music/track.mp3");

  columns.destroy();
  cHost.remove();

  const line = `mode: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail ? "#ff6b6b" : "#3ddc84"}`);
  document.title = line;
}

void main();
