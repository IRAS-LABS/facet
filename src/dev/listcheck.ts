/**
 * Checks the details list against the two claims that justify it.
 *
 * The list exists because a wall of identical tiles is unreadable, so most of
 * what makes it good is a judgement call about density and alignment — not
 * something a harness can score. Two things are not judgement calls, and both
 * are the kind of thing that quietly stops being true six commits later:
 *
 *  1. **It virtualises.** Forty thousand files must not be forty thousand
 *     nodes. This is the claim the whole view rests on, and the failure mode is
 *     invisible during development — a hundred test files mount fine either way
 *     and the folder that kills it is on somebody else's machine.
 *  2. **Rows do not order previews for files a 22 px square cannot tell apart.**
 *     A row asking for a preview of every .dll it scrolls past is a thousand
 *     queued decodes nobody will ever look at. Only the pane asks for those.
 *
 * The rest of the phases cover the ordinary things that break: keyboard
 * movement, shift-range, the pane following the cursor, the header arrow, and
 * the pane surviving a preview that arrives after the selection was made.
 *
 * Dev-only. Loaded by /dev/listcheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/listcheck.html
 */

import { DEFAULT_CARD, DEFAULT_COLUMNS } from "@core/explorer/fields";
import "../styles/base.css";
import "../styles/list.css";

import { ListView } from "@ui/list-view";
import type { FileEntry, Preview, SortKey, ViewConfig } from "@core/explorer/types";

let pass = 0;
let fail = 0;
const failed: string[] = [];

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log("ok  ", name); }
  else { fail++; failed.push(`${name} — ${detail}`); console.log("FAIL", name, " ", detail); }
};

/** One frame, so a scroll event and the ResizeObserver have both landed. */
const tick = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// ── Fixture ─────────────────────────────────────────────────────────────────
//
// Big enough that a non-virtualised list would be obvious, and mixed enough
// that the "only ask for previews you can see" rule has something to be wrong
// about: one file in ten is a picture and the rest are things a 22 px square
// says nothing about.

const N = 40_000;

function fixture(n: number): FileEntry[] {
  const out: FileEntry[] = [];
  for (let i = 0; i < n; i++) {
    const pic = i % 10 === 0;
    out.push({
      path: `C:/fixture/file-${String(i).padStart(5, "0")}.${pic ? "jpg" : "dll"}`,
      name: `file-${String(i).padStart(5, "0")}.${pic ? "jpg" : "dll"}`,
      kind: pic ? "image" : "binary",
      ext: pic ? "jpg" : "dll",
      size: 1024 * (i + 1),
      modified: Date.UTC(2026, 0, 1) + i * 60_000,
    });
  }
  return out;
}

const cfg: ViewConfig = {
  sort: "name", ascending: true,
  group: "none", foldersFirst: true, showHidden: false,
  cardSize: 190, nameLines: 2,
  columns: DEFAULT_COLUMNS, cardFields: DEFAULT_CARD,
};

const host = document.createElement("div");
host.style.cssText = "position:fixed;inset:0;";
document.body.appendChild(host);

const rowAsks: string[] = [];
const paneAsks: string[] = [];
const sorts: SortKey[] = [];
let selected: FileEntry[] = [];

const list = new ListView(host, cfg, {
  onOpen() { /* not exercised here */ },
  onSelect(sel) { selected = sel; },
  onWantPreview(e) { rowAsks.push(e.path); },
  onWantFullPreview(e) { paneAsks.push(e.path); },
  onSort(k) { sorts.push(k); },
});

const rows = (): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>(".lv-row"));
const scroller = (): HTMLElement => host.querySelector<HTMLElement>(".lv-scroll")!;
const paneText = (): string => host.querySelector<HTMLElement>(".lv-pane")?.textContent ?? "";

/** Fire the same event a real scroll would, since setting scrollTop in code
 *  dispatches it asynchronously and the harness needs to wait for it anyway. */
async function scrollTo(px: number): Promise<void> {
  scroller().scrollTop = px;
  await tick();
}

function key(k: string, mods: Partial<KeyboardEventInit> = {}): void {
  scroller().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
}

function clickRow(i: number, mods: Partial<MouseEventInit> = {}): void {
  const node = rows().find((r) => r.dataset["index"] === String(i));
  if (!node) throw new Error(`row ${i} is not mounted`);
  node.querySelector(".lv-c[data-field='name']")!.dispatchEvent(
    new MouseEvent("click", { bubbles: true, ...mods }),
  );
}

async function run(): Promise<void> {
  const all = fixture(N);
  list.setEntries(all);
  await tick();

  // 1 — virtualisation
  const mounted = rows().length;
  ok("a huge folder mounts a handful of rows", mounted > 0 && mounted < 120,
     `${mounted} rows in the DOM for ${N} files`);
  ok("the scroll height is the whole folder",
     scroller().scrollHeight > N * 20,
     `scrollHeight ${scroller().scrollHeight}`);

  // 2 — previews are only ordered for kinds a 22px square distinguishes
  ok("rows ask for pictures", rowAsks.length > 0);
  ok("rows never ask for a .dll",
     rowAsks.every((p) => p.endsWith(".jpg")),
     rowAsks.find((p) => !p.endsWith(".jpg")) ?? "");
  ok("rows ask only for what is on screen",
     rowAsks.length < 40,
     `${rowAsks.length} asks for ${mounted} mounted rows`);

  // 3 — scrolling far away recycles rather than accumulates
  await scrollTo(600_000);
  const after = rows().length;
  ok("scrolling does not accumulate rows", after < 120, `${after} rows after a long scroll`);
  ok("the rows on screen are the ones scrolled to",
     rows().every((r) => Number(r.dataset["index"]) > 19_000),
     rows()[0]?.dataset["index"] ?? "none");

  await scrollTo(0);

  // 4 — selection and the pane
  clickRow(3);
  await tick();
  ok("clicking selects one file", selected.length === 1 && selected[0]!.name.includes("00003"),
     selected.map((e) => e.name).join(","));
  ok("the pane shows the selected file", paneText().includes("file-00003"), paneText().slice(0, 60));
  ok("the pane shows the full path", paneText().includes("C:/fixture/file-00003.dll"));
  ok("the pane asks for a preview the row would not",
     paneAsks.includes("C:/fixture/file-00003.dll"), paneAsks.join(","));

  // 5 — keyboard
  key("ArrowDown");
  await tick();
  ok("arrow down moves the cursor", selected[0]?.name.includes("00004") === true,
     selected[0]?.name ?? "none");
  ok("the pane follows the cursor", paneText().includes("file-00004"));

  key("ArrowDown", { shiftKey: true });
  key("ArrowDown", { shiftKey: true });
  await tick();
  ok("shift extends a range", selected.length === 3, `${selected.length} selected`);
  ok("the pane shows the end of the range, not the start",
     paneText().includes("file-00006"), paneText().slice(0, 60));

  key("End");
  await tick();
  ok("End goes to the last file", selected[0]?.name.includes(String(N - 1)) === true,
     selected[0]?.name ?? "none");
  ok("End scrolls the last file into view",
     rows().some((r) => Number(r.dataset["index"]) === N - 1));

  key("Home");
  await tick();
  ok("Home comes back", selected[0]?.name.includes("00000") === true, selected[0]?.name ?? "none");

  key("a", { ctrlKey: true });
  await tick();
  ok("ctrl+A selects the folder", selected.length === N, `${selected.length}`);

  // 6 — a preview that arrives after the selection was made
  clickRow(0);
  await tick();
  const first = all[0]!;
  const preview: Preview = { type: "text", lines: ["late arrival", "second line"] };
  first.preview = preview;
  list.refresh(first.path);
  await tick();
  ok("a late preview repaints the pane", paneText().includes("late arrival"), paneText().slice(0, 80));

  // 7 — the header
  const heads = Array.from(host.querySelectorAll<HTMLElement>(".lv-th"));
  ok("there is one arrow, on the sorted column",
     heads.filter((h) => /[▲▼]/.test(h.textContent ?? "")).length === 1,
     heads.map((h) => h.textContent).join(" | "));
  heads[2]!.click();
  ok("clicking a header asks the shell to sort", sorts.length === 1 && sorts[0] === "size",
     sorts.join(","));
  list.setConfig({ ...cfg, sort: "size", ascending: false });
  const arrowed = Array.from(host.querySelectorAll<HTMLElement>(".lv-th"))
    .find((h) => /[▲▼]/.test(h.textContent ?? ""));
  ok("the arrow moves with the sort",
     arrowed?.textContent?.includes("Size") === true && arrowed.textContent.includes("▼"),
     arrowed?.textContent ?? "none");

  // 8 — an empty folder says so instead of showing a blank pane
  list.setEntries([]);
  await tick();
  ok("an empty folder is a message, not a void", paneText().includes("Nothing here"), paneText());

  // 9 — nothing selected in a full folder is its own message
  list.setEntries(all.slice(0, 50));
  await tick();
  ok("nothing selected says what to do", paneText().includes("Select a file"), paneText());

  report();
}

function report(): void {
  const line = `${pass} passed, ${fail} failed`;
  document.title = fail === 0 ? `list: ${line}` : `LIST FAILED: ${line}`;
  const box = document.createElement("pre");
  box.style.cssText =
    "position:fixed;inset:auto 0 0 0;z-index:9;margin:0;padding:10px;max-height:40vh;" +
    "overflow:auto;background:#0b0d12;color:#e8ecf5;font:12px/1.5 ui-monospace,monospace;" +
    "border-top:2px solid " + (fail === 0 ? "#3ddc97" : "#d6282e");
  box.textContent = fail === 0 ? `all good — ${line}` : `${line}\n\n${failed.join("\n")}`;
  document.body.appendChild(box);
  console.log(line);
}

void run();
