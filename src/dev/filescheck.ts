/**
 * Checks the Files tab — the one screen in the phone shell with no harness.
 *
 * It got one because a real bug lived in it in plain sight for two releases:
 * tapping "Internal storage" put the word `0` in the title bar, because
 * `/storage/emulated/0` ends in `0` and the heading was the last path segment.
 * That is the failure mode this file is really about — every rule here is a
 * one-line judgement inside a method that draws a whole screen, so nothing
 * fails loudly, it just quietly says the wrong thing.
 *
 * What is worth pinning, and why:
 *
 *  1. **The title names the place you are in.** A storage volume is called
 *     what the Storage list called it; every other folder is its last segment.
 *  2. **Folders lead, whatever the sort.** Sorting a mixed listing by size
 *     otherwise files an empty directory between two photographs.
 *  3. **Numbers sort like numbers.** `file2` before `file10` is the whole
 *     reason the comparator asks for `numeric: true`, and it is exactly the
 *     kind of option a later edit drops without noticing.
 *  4. **Opening a file hands the viewer files.** The sibling list is filtered
 *     on the way out; a folder in it would be a blank page in the swipe run.
 *  5. **A folder that will not open says so.** Android refuses directories all
 *     the time, and the failure has to be a sentence, not an empty screen.
 *
 * Dev-only. Loaded by /dev/filescheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/filescheck.html
 */

import "../styles/base.css";
import "../styles/phone.css";

import type { FileEntry } from "@core/explorer/types";
import { FilesTab } from "@ui/phone/files-tab";
import type { PhoneShell } from "@ui/phone/shell";

let pass = 0;
let fail = 0;
const failed: string[] = [];

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log("ok  ", name); }
  else { fail++; failed.push(`${name} — ${detail}`); console.log("FAIL", name, " ", detail); }
};

/** Two frames, so a draw that awaited an already-resolved promise has landed. */
const tick = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// ── Fixture ─────────────────────────────────────────────────────────────────

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  const dot = name.lastIndexOf(".");
  return {
    path: `/storage/emulated/0/${name}`,
    name,
    kind: dot > 0 ? "image" : "folder",
    ext: dot > 0 ? name.slice(dot + 1) : "",
    size: 1000,
    modified: 1_700_000_000,
    ...over,
  };
}

/** Deliberately mixed: two folders late in the alphabet, files whose numbers
 *  and sizes disagree with their names, and a tie on every column but name. */
const DCIM: FileEntry[] = [
  entry("zebra", { kind: "folder", ext: "", size: 0, modified: 1_700_000_900 }),
  entry("file10.jpg", { size: 50, modified: 1_700_000_300 }),
  entry("file2.jpg", { size: 900, modified: 1_700_000_100 }),
  entry("alpha", { kind: "folder", ext: "", size: 0, modified: 1_700_000_200 }),
  entry("clip.mp4", { kind: "video", ext: "mp4", size: 400, modified: 1_700_000_300 }),
];

const ROOTS = [
  { name: "Internal storage", path: "/storage/emulated/0" },
  { name: "SD card", path: "/storage/1A2B-3C4D" },
];

interface Opened { entry: FileEntry; siblings: readonly FileEntry[] }

/**
 * The listings the stub filesystem serves, by path. A path mapped to `null`
 * throws, which is how Android answers for a folder it will not let the app
 * read — the case the empty-screen failure hides in.
 */
const LISTINGS = new Map<string, FileEntry[] | null>([
  ["/storage/emulated/0", DCIM],
  ["/storage/emulated/0/alpha", []],
  ["/storage/1A2B-3C4D", null],
]);

let rootCalls = 0;
let opened: Opened | null = null;

/** Read through a call, so the compiler does not narrow `opened` to `null`
 *  from the assignment above the click that fills it in. */
const lastOpen = (): Opened | null => opened;

function makeShell(): PhoneShell {
  const fs = {
    async roots() { rootCalls++; return ROOTS; },
    async list(path: string) {
      const found = LISTINGS.get(path);
      if (found === undefined || found === null) throw new Error("EACCES");
      return { entries: found };
    },
    async scanMedia() { return []; },
    async thumbnail() { return null; },
    cancel() { /* nothing was ever queued */ },
  };
  const thumbs = {
    async get() { return null; },
    cancel() {}, retain() {}, release() {},
  };
  return {
    fs,
    thumbs,
    store: { get: () => ({ everything: [] as FileEntry[] }) },
    scroller: document.createElement("div"),
    refreshChrome() {},
    open(e: FileEntry, siblings: readonly FileEntry[]) { opened = { entry: e, siblings }; },
  } as unknown as PhoneShell;
}

/** The visible name of every row, in the order they are drawn. */
const names = (tab: FilesTab): string[] =>
  [...tab.el.querySelectorAll(".ph-row-name")].map((n) => n.textContent ?? "");

const rowFor = (tab: FilesTab, name: string): HTMLElement | null => {
  for (const row of tab.el.querySelectorAll<HTMLElement>(".ph-row")) {
    if (row.querySelector(".ph-row-name")?.textContent === name) return row;
  }
  return null;
};

const pill = (tab: FilesTab, label: string): HTMLElement | null => {
  for (const b of tab.el.querySelectorAll<HTMLElement>(".ph-sort-pill")) {
    if ((b.textContent ?? "").startsWith(label)) return b;
  }
  return null;
};

/** Open the tab and walk into internal storage, which most groups below want. */
async function intoStorage(tab: FilesTab): Promise<void> {
  tab.activate();
  await tick();
  rowFor(tab, "Internal storage")?.click();
  await tick();
}

// ── 1. The title ────────────────────────────────────────────────────────────

async function checkTitle(): Promise<void> {
  const tab = new FilesTab(makeShell());
  document.body.append(tab.el);

  ok("title: the front page is called Files", tab.title() === "Files", tab.title());

  tab.activate();
  await tick();
  ok("home: the storage list arrived", names(tab).includes("Internal storage"), names(tab).join(","));

  tab.el.querySelector<HTMLElement>(".ph-cat")?.click();
  await tick();
  ok("title: a category is called what its tile said", tab.title() === "Downloads", tab.title());
  tab.back();
  await tick();

  rowFor(tab, "Internal storage")?.click();
  await tick();
  ok("title: /storage/emulated/0 is 'Internal storage', not '0'",
     tab.title() === "Internal storage", tab.title());

  rowFor(tab, "alpha")?.click();
  await tick();
  ok("title: an ordinary folder is its last segment", tab.title() === "alpha", tab.title());

  tab.back();
  await tick();
  ok("back: leaving a folder restores the parent's title",
     tab.title() === "Internal storage", tab.title());

  tab.back();
  await tick();
  ok("back: and again lands on the front page", tab.title() === "Files", tab.title());
  ok("back: which refuses to pop further", tab.back() === false);
  ok("back: the front page offers no Back button of its own",
     tab.actions().length === 0, String(tab.actions().length));

  tab.el.remove();
}

// ── 2. Order ────────────────────────────────────────────────────────────────

async function checkOrder(): Promise<void> {
  const tab = new FilesTab(makeShell());
  document.body.append(tab.el);
  await intoStorage(tab);

  const byDate = names(tab);
  ok("sort: folders lead, newest first inside each group",
     byDate.join(",") === "zebra,alpha,file10.jpg,clip.mp4,file2.jpg", byDate.join(","));

  pill(tab, "Name")?.click();
  await tick();
  const byName = names(tab);
  ok("sort: by name, folders still lead",
     byName[0] === "alpha" && byName[1] === "zebra", byName.join(","));
  ok("sort: file2 comes before file10 -- numbers sort like numbers",
     byName.indexOf("file2.jpg") < byName.indexOf("file10.jpg"), byName.join(","));
  ok("sort: a fresh name column starts A-Z, not Z-A",
     (pill(tab, "Name")?.textContent ?? "").includes("↑"), pill(tab, "Name")?.textContent ?? "");

  pill(tab, "Name")?.click();
  await tick();
  ok("sort: pressing the chosen column reverses it",
     names(tab)[0] === "zebra" && (pill(tab, "Name")?.textContent ?? "").includes("↓"),
     names(tab).join(","));

  pill(tab, "Size")?.click();
  await tick();
  const bySize = names(tab);
  // Both folders are zero bytes, so the name breaks the tie -- in the sort's
  // own direction, which is why `zebra` leads a descending column.
  ok("sort: by size, biggest file first, folders still above them",
     bySize.join(",") === "zebra,alpha,file2.jpg,clip.mp4,file10.jpg", bySize.join(","));

  // clip.mp4 and file10.jpg share a timestamp; only the name breaks the tie.
  pill(tab, "Date")?.click();
  await tick();
  const first = names(tab).join(",");
  pill(tab, "Name")?.click();
  await tick();
  pill(tab, "Date")?.click();
  await tick();
  ok("sort: a tie falls back to the name, so redrawing does not reshuffle",
     names(tab).join(",") === first, `${first} vs ${names(tab).join(",")}`);

  ok("sort: exactly one pill reads as chosen",
     tab.el.querySelectorAll(".ph-sort-pill.is-on").length === 1,
     String(tab.el.querySelectorAll(".ph-sort-pill.is-on").length));

  tab.el.remove();
}

// ── 3. Opening ──────────────────────────────────────────────────────────────

async function checkOpen(): Promise<void> {
  const tab = new FilesTab(makeShell());
  document.body.append(tab.el);
  await intoStorage(tab);

  opened = null;
  rowFor(tab, "alpha")?.click();
  await tick();
  ok("open: tapping a folder walks into it and opens no viewer",
     lastOpen() === null && tab.title() === "alpha", tab.title());
  tab.back();
  await tick();

  opened = null;
  rowFor(tab, "file2.jpg")?.click();
  await tick();
  const got = lastOpen();
  ok("open: tapping a file opens that file", got?.entry.name === "file2.jpg", got?.entry.name ?? "(none)");
  ok("open: the swipe run holds the folder's files...",
     got !== null && got.siblings.length === 3, String(got?.siblings.length));
  ok("...and no folders, which would be blank pages in it",
     got !== null && got.siblings.every((s) => s.kind !== "folder"),
     (got?.siblings ?? []).map((s) => s.kind).join(","));
  ok("open: the run is in the order shown, not the order listed",
     (got?.siblings ?? []).map((s) => s.name).join(",") === "file10.jpg,clip.mp4,file2.jpg",
     (got?.siblings ?? []).map((s) => s.name).join(","));

  tab.el.remove();
}

// ── 4. Folders that will not open ───────────────────────────────────────────

async function checkRefused(): Promise<void> {
  const tab = new FilesTab(makeShell());
  document.body.append(tab.el);
  tab.activate();
  await tick();

  rowFor(tab, "SD card")?.click();
  await tick();
  const title = tab.el.querySelector(".ph-note-title")?.textContent ?? "";
  ok("refused: a folder Android will not read says so", title === "Can't open this folder", title);
  ok("refused: ...and says what to make of it",
     /Android may not grant access/.test(tab.el.querySelector(".ph-note-body")?.textContent ?? ""));
  ok("refused: no sort bar over a listing that does not exist",
     tab.el.querySelector(".ph-sort") === null);
  tab.back();
  await tick();

  rowFor(tab, "Internal storage")?.click();
  await tick();
  rowFor(tab, "alpha")?.click();
  await tick();
  ok("empty: an empty folder is named as empty, not broken",
     tab.el.querySelector(".ph-note-title")?.textContent === "Empty folder",
     tab.el.querySelector(".ph-note-title")?.textContent ?? "");
  ok("empty: and offers no sort pills either",
     tab.el.querySelector(".ph-sort") === null);

  tab.el.remove();
}

// ── 5. The front page ───────────────────────────────────────────────────────

async function checkHome(): Promise<void> {
  rootCalls = 0;
  const tab = new FilesTab(makeShell());
  document.body.append(tab.el);
  tab.activate();
  await tick();

  const tiles = tab.el.querySelectorAll<HTMLElement>(".ph-cat");
  ok("home: every category has a tile", tiles.length === 7, String(tiles.length));
  ok("home: Downloads is the hero, because it is why people open a file manager",
     tiles[0]?.getAttribute("data-shape") === "hero", tiles[0]?.getAttribute("data-shape") ?? "");
  ok("home: every tile carries its own hue rather than a class per category",
     [...tiles].every((n) => /--cat-h:/.test(n.getAttribute("style") ?? "")));

  const cats = tab.el.querySelector(".ph-cats");
  const rows = tab.el.querySelector(".ph-rows");
  ok("home: storage sits under the categories, not over them",
     cats !== null && rows !== null
       && (cats.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);

  const before = rootCalls;
  rowFor(tab, "Internal storage")?.click();
  await tick();
  tab.back();
  await tick();
  ok("home: the volume list is fetched once and kept -- it cannot change",
     rootCalls === before, `${before} then ${rootCalls}`);

  tab.el.remove();
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ["title", checkTitle],
    ["order", checkOrder],
    ["open", checkOpen],
    ["refused", checkRefused],
    ["home", checkHome],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      fail++;
      failed.push(`${name} threw — ${String(err)}`);
      console.log("FAIL", name, "threw", err);
    }
  }

  const line = `files: ${pass} passed, ${fail} failed`;
  document.title = line;
  console.log(`%c${line}`, `color:${fail ? "#ff6b6b" : "#3ddc84"}`);
  for (const f of failed) console.log("  ", f);
  document.body.append(Object.assign(document.createElement("pre"), {
    textContent: [line, ...failed].join("\n"),
  }));
}

void run();
