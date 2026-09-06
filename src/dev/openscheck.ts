/**
 * Checks file associations — what FACET opens what with (item 40).
 *
 * Four claims, and every one of them is a way this feature could quietly ruin
 * an afternoon rather than fail loudly.
 *
 * **1. Specific beats general, and setting the general never disturbs the
 * specific.** An extension beats a kind beats the built-in. Somebody who has
 * pinned `.json` to the table view and then sets *all* code to the inspector
 * must still get the table view for `.json` — otherwise a broad decision
 * silently eats every narrow one they made first, and there is no way to
 * discover that except by noticing the wrong screen opened.
 *
 * **2. A preference is matched against reality, never trusted over it.** The
 * table view is native-only and takes some extensions and not others; the
 * editors are front ends for a child process. None of that is knowable when the
 * preference is written, so `resolveOpen` is given what is actually available
 * and falls down the layers until something answers. A stored choice that cannot
 * run must never mean "then nothing opens".
 *
 * **3. A file off disk cannot poison the store.** It is small and hand-editable
 * on purpose, so one unknown handler, one bad kind or one `.PNG` written with a
 * dot and a capital must cost exactly its own line.
 *
 * **4. The sheet cannot disagree with what happens.** It asks the same resolver
 * the double-click asks — asserted here by driving the real panel and checking
 * the chip that lights up against what `resolveOpen` returns.
 *
 * Dev-only. Loaded by /openscheck.html, which is not a build input.
 *
 *   http://localhost:8183/openscheck.html
 */

import "../styles/base.css";
import "../styles/opens.css";

import {
  builtInFor,
  BUILT_IN,
  HANDLERS,
  handlerLabel,
  isHandler,
  memoryOpens,
  normalizeExt,
  OpensStore,
  resolveOpen,
  type HandlerId,
} from "@core/explorer/opens";
import type { FileEntry, FileKind } from "@core/explorer/types";
import { OpensPanel } from "@ui/opens-panel";

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.log("FAIL", name, " ", detail);
  }
};

/** Off the screen, not merely `[hidden]` — a stylesheet's `display` outranks it. */
const gone = (el: Element | null): boolean =>
  el !== null && getComputedStyle(el).display === "none";

const file = (kind: FileKind, ext: string): Pick<FileEntry, "kind" | "ext"> => ({ kind, ext });

/** A store with nothing in it, and one seeded from a literal file. */
const empty = (): OpensStore => new OpensStore(memoryOpens());
const seeded = (doc: unknown): OpensStore =>
  new OpensStore(memoryOpens(typeof doc === "string" ? doc : JSON.stringify(doc)));

/** Everything, so a resolve is about preference rather than about availability. */
const ALL: readonly HandlerId[] = HANDLERS.map((h) => h.id);

async function main(): Promise<void> {
  const tick = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

  // ── 1. what FACET ships believing ──────────────────────────────────────

  ok("a picture opens in the viewer", builtInFor("image") === "viewer");
  ok("a video opens in the player", builtInFor("video") === "player");
  ok("audio opens in the same player", builtInFor("audio") === "player");
  ok("a table opens in the table view", builtInFor("tabular") === "table");
  ok("a document goes out to Windows", builtInFor("document") === "system");
  ok("code goes out to Windows", builtInFor("code") === "system");
  ok(
    "…and every kind but folder has a shipped answer",
    Object.keys(BUILT_IN).length === 9 && !("folder" in BUILT_IN),
  );
  ok(
    "…all of which are real handlers",
    Object.values(BUILT_IN).every((h) => isHandler(h)),
  );
  ok("a folder is not opened *with* anything, so it gets the escape hatch",
    builtInFor("folder") === "system");
  ok("every handler has a label and a sentence",
    HANDLERS.every((h) => h.label !== "" && h.blurb !== ""));
  ok("…and no two share an id", new Set(HANDLERS.map((h) => h.id)).size === HANDLERS.length);
  ok("a handler id off disk that this build does not know is refused",
    !isHandler("holodeck") && !isHandler("") && !isHandler(null) && !isHandler(7));
  ok("handlerLabel answers for every id", HANDLERS.every((h) => handlerLabel(h.id) === h.label));

  // ── 2. however the extension arrived ───────────────────────────────────

  ok("a leading dot is not part of the extension", normalizeExt(".PNG") === "png");
  ok("…nor are several", normalizeExt("...tar") === "tar");
  ok("case does not matter", normalizeExt("JPEG") === "jpeg");
  ok("neither does surrounding space", normalizeExt("  webp  ") === "webp");
  ok("an empty extension stays empty", normalizeExt("") === "" && normalizeExt(".") === "");

  {
    const s = empty();
    s.setExt(".JSON", "table");
    ok("so a pin written one way is found written another",
      s.forExt("json") === "table" && s.forExt(".Json") === "table");
    ok("…and is stored once, normalised", s.extensions().length === 1);
    ok("…under the normalised key", s.extensions()[0]?.[0] === "json");
  }

  // ── 3. the three layers ────────────────────────────────────────────────

  {
    const s = empty();
    ok("with nothing set, the built-in answers",
      s.choose(file("image", "png")).handler === "viewer" &&
      s.choose(file("image", "png")).from === "built-in");

    s.setKind("code", "inspector");
    ok("a kind beats the built-in", s.choose(file("code", "ts")).handler === "inspector");
    ok("…and says so", s.choose(file("code", "ts")).from === "kind");
    ok("…and touches nothing else", s.choose(file("image", "png")).handler === "viewer");

    s.setExt("json", "table");
    ok("an extension beats the kind", s.choose(file("code", "json")).handler === "table");
    ok("…and says so", s.choose(file("code", "json")).from === "ext");
    ok("…and the rest of the kind is unmoved",
      s.choose(file("code", "ts")).handler === "inspector");

    // The one that matters: a broad decision made second.
    s.setKind("code", "quicklook");
    ok("changing the kind afterwards does not eat the extension you pinned first",
      s.choose(file("code", "json")).handler === "table");
    ok("…while the rest of the kind does move",
      s.choose(file("code", "ts")).handler === "quicklook");

    s.setExt("json", null);
    ok("dropping the extension falls back to the kind",
      s.choose(file("code", "json")).handler === "quicklook");
    s.setKind("code", null);
    ok("…and dropping the kind falls back to the built-in",
      s.choose(file("code", "json")).handler === "system" &&
      s.choose(file("code", "json")).from === "built-in");
  }

  {
    const s = empty();
    s.setExt("png", "inspector");
    ok("an extension applies whatever kind the file turned out to be",
      s.choose(file("image", "png")).handler === "inspector" &&
      s.choose(file("binary", "png")).handler === "inspector");
  }

  {
    const s = empty();
    s.setKind("folder", "inspector");
    ok("a folder cannot be given a handler — it would never be read",
      s.forKind("folder") === undefined);
  }

  // ── 4. matched against what is actually available ──────────────────────

  {
    const s = empty();
    ok("the preferred handler wins when it can run",
      resolveOpen(file("image", "png"), s, ALL) === "viewer");

    ok("…and when it cannot, the built-in for the kind answers",
      resolveOpen(file("image", "png"), s, ["quicklook", "meta"]) === "meta" ||
      resolveOpen(file("image", "png"), s, ["quicklook", "meta"]) === "quicklook");

    s.setExt("csv", "table");
    ok("a pinned extension whose handler is not available falls through to Windows",
      resolveOpen(file("tabular", "csv"), s, ["system", "meta"]) === "system");

    s.setKind("tabular", "quicklook");
    ok("…to the KIND before the built-in, so both decisions are honoured in order",
      resolveOpen(file("tabular", "csv"), s, ["quicklook", "system"]) === "quicklook");

    ok("…and to the built-in when neither can run",
      resolveOpen(file("tabular", "csv"), s, ["system"]) === "system");

    ok("when even the built-in cannot run, something on offer still answers",
      resolveOpen(file("tabular", "csv"), s, ["meta"]) === "meta");

    ok("…and it is stable, in HANDLERS order rather than the caller's",
      resolveOpen(file("tabular", "csv"), s, ["meta", "inspector"]) === "inspector");

    ok("…but Windows outranks that order, being the answer that is never wrong",
      resolveOpen(file("tabular", "csv"), s, ["meta", "inspector", "system"]) === "system");

    ok("nothing available is the only way to get null",
      resolveOpen(file("tabular", "csv"), s, []) === null);
  }

  {
    // The browser preview: no native, so almost nothing is on offer. This is
    // the case that made the menu look broken during item 39 and it is worth
    // pinning down rather than rediscovering.
    const s = empty();
    const browser: readonly HandlerId[] = ["viewer", "player", "meta", "quicklook"];
    ok("in the browser a picture still opens in the viewer",
      resolveOpen(file("image", "png"), s, browser) === "viewer");
    ok("…a video still plays", resolveOpen(file("video", "mp4"), s, browser) === "player");
    ok("…and a spreadsheet, whose table view is native-only, does not open nothing",
      resolveOpen(file("tabular", "csv"), s, browser) !== null);
  }

  // ── 5. a choice that matches the default is not a change ───────────────

  {
    const s = empty();
    ok("an untouched store says so", !s.touched());
    s.setKind("image", "viewer");
    ok("…and setting a kind to what it already was still records it here",
      s.forKind("image") === "viewer");
    s.setKind("image", null);
    ok("…until it is cleared", s.forKind("image") === undefined && !s.touched());
    s.setExt("png", "meta");
    ok("a pinned extension counts as touched", s.touched());
    s.reset();
    ok("reset clears both halves",
      !s.touched() && s.extensions().length === 0 && s.forKind("image") === undefined);
  }

  // ── 6. what it writes, and what it reads back ──────────────────────────

  {
    const backend = memoryOpens();
    const s = new OpensStore(backend);
    s.setKind("code", "inspector");
    s.setExt("json", "table");
    const raw = JSON.parse(backend.read() ?? "{}") as Record<string, unknown>;
    ok("the saved file is version 1", raw["version"] === 1);
    ok("…and holds exactly the two maps", Object.keys(raw).sort().join(",") === "byExt,byKind,version");
    ok("…with the extension under a normalised key",
      JSON.stringify(raw["byExt"]) === '{"json":"table"}');
    ok("…and the kind under its own name",
      JSON.stringify(raw["byKind"]) === '{"code":"inspector"}');

    const back = new OpensStore(memoryOpens(backend.read()));
    ok("a fresh store reads it back", back.choose(file("code", "json")).handler === "table");
    ok("…including the kind", back.choose(file("code", "ts")).handler === "inspector");
  }

  // ── 7. a file somebody hand-edited ─────────────────────────────────────

  const junk: Array<[string, unknown]> = [
    ["not JSON at all", "{{{"],
    ["empty text", ""],
    ["null", "null"],
    ["a bare array", "[]"],
    ["a number", "42"],
    ["no version", { byExt: { json: "table" } }],
    ["a version from the future", { version: 9, byExt: { json: "table" } }],
    ["byExt as a string", { version: 1, byExt: "json" }],
    ["byExt as null", { version: 1, byExt: null }],
    ["byKind as an array", { version: 1, byKind: ["code"] }],
    ["handlers that do not exist", { version: 1, byExt: { json: "holodeck" }, byKind: { code: "warp" } }],
    ["a kind that does not exist", { version: 1, byKind: { spreadsheet: "table" } }],
    ["a handler that is a number", { version: 1, byExt: { json: 7 } }],
    ["an empty extension key", { version: 1, byExt: { "": "table" } }],
    ["a folder given a handler", { version: 1, byKind: { folder: "inspector" } }],
  ];
  for (const [what, doc] of junk) {
    let threw = false;
    let answer: HandlerId | undefined;
    try {
      const s = seeded(doc);
      answer = s.choose(file("code", "json")).handler;
      s.extensions();
      s.touched();
    } catch {
      threw = true;
    }
    ok(`a file that is ${what} does not throw`, !threw);
    ok(`…and still opens a .json somehow`, answer !== undefined);
  }

  {
    // The important half of the rule: one bad line, not one bad file.
    const s = seeded({
      version: 1,
      byExt: { json: "holodeck", csv: "table", ".PNG": "meta" },
      byKind: { code: "warp", image: "quicklook" },
    });
    ok("a bad extension line costs only itself", s.forExt("json") === undefined);
    ok("…and the good one beside it survives", s.forExt("csv") === "table");
    ok("…even written with a dot and a capital", s.forExt("png") === "meta");
    ok("a bad kind line costs only itself", s.forKind("code") === undefined);
    ok("…and the good one beside it survives", s.forKind("image") === "quicklook");
  }

  {
    const s = seeded({ version: 1, byKind: { folder: "inspector", image: "meta" } });
    ok("a folder handler in the file is dropped on the way in", s.forKind("folder") === undefined);
    ok("…without costing the line after it", s.forKind("image") === "meta");
  }

  // ── 8. the sheet ───────────────────────────────────────────────────────

  const store = empty();
  const panel = new OpensPanel();
  const el = panel.element;

  ok("the sheet starts closed", !panel.isOpen && gone(el));

  /** The same shape main.ts hands it, over the same store. */
  const available = (kind: FileKind, ext: string): HandlerId[] => {
    const out: HandlerId[] = [];
    if (kind === "image") out.push("viewer");
    if (kind === "video" || kind === "audio") out.push("player");
    if (ext === "csv" || ext === "tsv" || ext === "parquet") out.push("table");
    out.push("inspector", "meta", "quicklook", "system");
    return out;
  };
  // Extension and the kind the explorer gives it, the way a folder listing
  // arrives — a .png is a picture whether or not anyone has pinned it.
  const ALL_NEARBY: ReadonlyArray<readonly [string, FileKind]> = [
    ["png", "image"],
    ["csv", "tabular"],
    ["json", "code"],
  ];
  let nearby: ReadonlyArray<readonly [string, FileKind]> = ALL_NEARBY;
  const open = (focus?: string): void => {
    panel.open(
      {
        forKind: (k) => store.forKind(k),
        setKind: (k, h) => store.setKind(k, h),
        extensions: () => store.extensions(),
        setExt: (e, h) => store.setExt(e, h),
        reset: () => store.reset(),
        availableFor: available,
        nearby: () => nearby,
        explain: (kind, ext) => ({
          ...store.choose({ kind, ext }),
          actual: resolveOpen({ kind, ext }, store, available(kind, ext)),
        }),
      },
      focus,
    );
  };

  open();
  await tick();
  ok("…and opens", panel.isOpen && !gone(el));

  const kindRows = el.querySelectorAll<HTMLElement>(".opn-list .opn-row[data-kind]");
  ok("every openable kind has a row", kindRows.length === 9);
  ok("…and none of them is folder",
    [...kindRows].every((r) => r.dataset["kind"] !== "folder"));

  const rowFor = (kind: string): HTMLElement | null =>
    el.querySelector<HTMLElement>(`.opn-row[data-kind="${kind}"]`);
  const lit = (row: HTMLElement | null): string =>
    row?.querySelector<HTMLElement>('.opn-chip[data-on="true"]')?.dataset["handler"] ?? "";

  ok("the picture row shows the viewer", lit(rowFor("image")) === "viewer");
  ok("…the table row shows the table view", lit(rowFor("tabular")) === "table");
  ok("…and the code row shows Windows", lit(rowFor("code")) === "system");
  ok("…which is what the resolver says too",
    lit(rowFor("image")) === resolveOpen(file("image", "png"), store, available("image", "png")));

  ok("a handler that cannot take this kind is shown, disabled",
    rowFor("code")?.querySelector<HTMLButtonElement>('.opn-chip[data-handler="viewer"]')?.disabled === true);
  ok("…and the one that can is not",
    rowFor("code")?.querySelector<HTMLButtonElement>('.opn-chip[data-handler="meta"]')?.disabled === false);
  ok("every row offers the whole list, so it reads the same all the way down",
    [...kindRows].every((r) => r.querySelectorAll(".opn-chip").length === HANDLERS.length));

  rowFor("code")?.querySelector<HTMLButtonElement>('.opn-chip[data-handler="inspector"]')?.click();
  await tick();
  ok("clicking a chip writes it", store.forKind("code") === "inspector");
  ok("…and the row redraws lit on the new one", lit(rowFor("code")) === "inspector");
  ok("…and says it has been changed",
    rowFor("code")?.querySelector(".opn-note")?.textContent === "changed");

  rowFor("code")?.querySelector<HTMLButtonElement>('.opn-chip[data-handler="system"]')?.click();
  await tick();
  ok("choosing what it already shipped as clears the row rather than storing it",
    store.forKind("code") === undefined);
  ok("…so the file stays a list of decisions", !store.touched());
  ok("…and the row stops claiming a change",
    rowFor("code")?.querySelector(".opn-note")?.textContent === "");

  ok("no extension is pinned yet", el.querySelectorAll(".opn-ext").length === 0);
  ok("…and the sheet says so in words",
    el.querySelector(".opn-list .opn-none")?.textContent?.includes("follows its kind") === true);

  const addRows = el.querySelectorAll<HTMLElement>(".opn-addrow");
  ok("the folder on screen offers its extensions", addRows.length === 3);
  ok("…with a dot, the way anyone would say them, and in an order that does not"
    + " depend on which file happened to sort first in the folder",
    [...addRows].map((b) => b.textContent).join(",") === ".csv,.json,.png");

  el.querySelector<HTMLButtonElement>('.opn-addrow[data-ext="json"]')?.click();
  await tick();
  ok("adding one raises a row for it", el.querySelectorAll(".opn-ext").length === 1);
  ok("…named after the extension", el.querySelector(".opn-ext .opn-name")?.textContent === ".json");
  ok("…marked as not decided yet",
    el.querySelector<HTMLElement>(".opn-ext")?.dataset["pending"] === "true");
  ok("…but writes nothing, because looking is not deciding", !store.touched());
  ok("…and it stops being offered as something to add",
    el.querySelector('.opn-addrow[data-ext="json"]') === null);
  ok("…showing what a .json does today",
    el.querySelector<HTMLElement>('.opn-ext[data-ext="json"] .opn-chip[data-on="true"]')
      ?.dataset["handler"] === resolveOpen(file("code", "json"), store, available("code", "json")));
  ok("…and saying so in a sentence that admits it is not an exception yet",
    el.querySelector('.opn-ext[data-ext="json"] .opn-why')?.textContent?.includes("exception") === true);
  ok("…with nothing to remove, there being nothing there",
    el.querySelector('.opn-ext[data-ext="json"] .opn-tick') === null);

  const extRow = el.querySelector<HTMLElement>('.opn-ext[data-ext="json"] .opn-row');
  extRow?.querySelector<HTMLButtonElement>('.opn-chip[data-handler="meta"]')?.click();
  await tick();
  ok("picking on that row is what writes it", store.forExt("json") === "meta");
  ok("…and it beats the kind",
    store.choose(file("code", "json")).handler === "meta");
  ok("…and the row stops being provisional",
    el.querySelector<HTMLElement>('.opn-ext[data-ext="json"]')?.dataset["pending"] === undefined);
  ok("…and can now be taken away",
    el.querySelector('.opn-ext[data-ext="json"] .opn-tick') !== null);

  el.querySelector<HTMLButtonElement>('.opn-ext[data-ext="json"] .opn-tick')?.click();
  await tick();
  ok("dropping it takes the row away", el.querySelectorAll(".opn-ext").length === 0);
  ok("…and the store with it", store.forExt("json") === undefined);
  ok("…and it comes back on offer", el.querySelector('.opn-addrow[data-ext="json"]') !== null);

  nearby = [];
  panel.sync();
  await tick();
  ok("a folder with nothing new in it says where else to set one",
    el.querySelector(".opn-add .opn-none")?.textContent?.includes("right-click") === true);
  nearby = ALL_NEARBY;

  store.setKind("image", "meta");
  store.setExt("csv", "quicklook");
  panel.sync();
  await tick();
  ok("↺ is offered", el.querySelector(".opn-reset") !== null);
  el.querySelector<HTMLButtonElement>(".opn-reset")?.click();
  await tick();
  ok("…and puts everything back", !store.touched());
  ok("…including the rows on screen",
    lit(rowFor("image")) === "viewer" && el.querySelectorAll(".opn-ext").length === 0);

  // Arriving from "Always open .csv with…". The sheet was asked about one
  // extension and has to answer about that extension, pinned or not.
  open("csv");
  await tick();
  ok("opening on an extension gives it a row even when nothing is pinned",
    el.querySelector('.opn-ext[data-ext="csv"]') !== null);
  ok("…expanded, so you land on the question you asked",
    el.querySelector('.opn-ext[data-ext="csv"] .opn-why') !== null);
  ok("…and only it", el.querySelectorAll(".opn-why").length === 1);
  ok("…lit on what a .csv does today",
    el.querySelector<HTMLElement>('.opn-ext[data-ext="csv"] .opn-chip[data-on="true"]')
      ?.dataset["handler"] === "table");
  ok("…while still writing nothing", !store.touched());
  ok("…and the sheet no longer claims every extension follows its kind",
    el.querySelector(".opn-list .opn-none") === null);

  panel.close();
  open("csv");
  await tick();
  ok("reopening on the same one still shows exactly one row",
    el.querySelectorAll(".opn-ext").length === 1);
  panel.close();
  open();
  await tick();
  ok("…and reopening without an extension leaves none behind",
    el.querySelectorAll(".opn-ext").length === 0);

  store.setExt("csv", "meta");
  open("csv");
  await tick();
  ok("opening on one that is pinned expands the real row",
    el.querySelector('.opn-ext[data-ext="csv"] .opn-tick') !== null);
  ok("…and it is not provisional",
    el.querySelector<HTMLElement>('.opn-ext[data-ext="csv"]')?.dataset["pending"] === undefined);
  ok("…and does not appear twice",
    el.querySelectorAll('.opn-ext[data-ext="csv"]').length === 1);

  panel.close();
  await tick();
  ok("closing hides the sheet", !panel.isOpen && gone(el));

  const line = `opens: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail ? "#ff6b6b" : "#3ddc84"}`);
  document.title = line;
}

void main();
