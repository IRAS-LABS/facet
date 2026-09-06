/**
 * Exercises the tabular viewer in a real browser.
 *
 * The readers underneath are already checked in Node against duckdb, openpyxl
 * and Python's csv module — 128 assertions, cell by cell. None of that says
 * whether the grid paints the right cell in the right column, whether clicking
 * a header sorts the whole file rather than the visible page, or whether a
 * 200 000-row CSV still only reads kilobytes once it is open. That is what this
 * is for.
 *
 * Dev-only. Loaded by /tablecheck.html, which is not one of the build's inputs,
 * so none of this reaches the binary.
 *
 * It needs the fixtures staged where the dev server can serve them. The
 * generator lives next door so this stays reproducible after the scratchpad it
 * was written in is gone; it wants duckdb and openpyxl:
 *
 *   .\scripts\fixtures.ps1            # runs mktable.py and stages the output
 *   .\scripts\fixtures.ps1 -Clean     # recycle afterwards
 *
 * They land in `fixtures/`, which nothing copies into a build, rather than in
 * `public/`, which is copied wholesale into `dist/` and baked into the binary.
 *
 * Then open http://localhost:8183/tablecheck.html — the page title becomes the
 * score. Add ?hold to park the run on the awkward CSV so the grid can actually
 * be looked at (window.go() releases it); two layout bugs got through a green
 * run once, and both were obvious the moment anyone saw the thing. Recycle the
 * staged folder afterwards; `public/` is copied wholesale into the build.
 */

import "../styles/base.css";
import "../styles/shell.css";

import { TableView } from "@ui/table";
import { themes } from "@core/theme/theme-engine";
import type { FileEntry } from "@core/explorer/types";

// Without this every colour token is undefined and the surface renders as
// unstyled text — which every assertion below would still happily pass.
themes.init();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}   ${detail}`); }
};

/** Fixtures, fetched once and then served in windows like a real filesystem. */
const files = new Map<string, Uint8Array>();
/** Bytes the viewer has asked for since the last reset — the windowing claim. */
let served = 0;

const load = async (name: string): Promise<FileEntry> => {
  const bytes = new Uint8Array(await (await fetch(`/_tablecheck/${name}`)).arrayBuffer());
  files.set(name, bytes);
  return {
    name, path: name, kind: "tabular", ext: name.split(".").pop() ?? "",
    size: bytes.length, modified: 0, hidden: false,
  };
};

const table = new TableView({
  readRange: async (path, offset, len) => {
    const b = files.get(path) ?? new Uint8Array();
    const end = Math.min(b.length, offset + len);
    served += Math.max(0, end - offset);
    return [...b.subarray(offset, end)];
  },
  readHead: async (path, max) => {
    const b = files.get(path) ?? new Uint8Array();
    served += Math.min(max, b.length);
    return [...b.subarray(0, max)];
  },
  readTail: async (path, len) => {
    const b = files.get(path) ?? new Uint8Array();
    const at = Math.max(0, b.length - len);
    served += b.length - at;
    return [[...b.subarray(at)], at];
  },
});

const q = <T extends Element>(sel: string): T | null => document.querySelector(sel);
const all = (sel: string): Element[] => [...document.querySelectorAll(sel)];
const text = (sel: string): string => q(sel)?.textContent ?? "";
const settle = (ms = 220): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** The grid as it currently stands on screen: header names, then row cells. */
const headers = (): string[] => all(".tbl-head .tbl-hcell").slice(1).map((n) => n.textContent ?? "");
const painted = (): string[][] =>
  all(".tbl-row").map((r) => [...r.querySelectorAll(".tbl-cell")].map((c) => c.textContent ?? ""));
const rowNumbers = (): number[] =>
  all(".tbl-row .tbl-num").map((n) => Number((n.textContent ?? "").replace(/[^0-9]/g, "")));

const type = async (value: string): Promise<void> => {
  const input = q<HTMLInputElement>(".tbl-input");
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(400);
};

async function run(): Promise<void> {
  // ── A small, awkward CSV ──────────────────────────────────────────────────
  const awkward = await load("awkward.csv");
  await table.open(awkward);
  await settle();

  // ?hold parks the run here so the awkward table can actually be looked at.
  // Every assertion below passed once while the columns were visibly wrong, so
  // there has to be a way to see the thing and not only to measure it.
  if (new URLSearchParams(location.search).has("hold")) {
    await new Promise<void>((go) => { (window as unknown as { go: () => void }).go = go; });
  }

  ok("opens", table.isOpen);
  ok("the header row is the file's own first line",
    headers().join("|") === "id|name|note|amount|when", headers().join("|"));
  ok("the title says how big the table is",
    /6 rows.*5 columns/.test(text(".tbl-title")), text(".tbl-title"));

  const rows = painted();
  ok("every data row is painted, and the header is not one of them",
    rows.length === 6, `${rows.length} rows`);
  ok("a field containing the delimiter stayed one field",
    rows[1]?.[1] === "Comma, inside", JSON.stringify(rows[1]));
  ok("a doubled quote came back as one quote",
    rows[1]?.[2] === 'He said "hi"', JSON.stringify(rows[1]?.[2]));
  // On screen it is one line with the break marked; the value underneath is
  // untouched, which the tooltip and the footer readout both still show.
  ok("a newline inside a quoted field did not become a new row",
    rows[2]?.[1] === "Newline ⏎ inside", JSON.stringify(rows[2]?.[1]));
  ok("every row is exactly one line tall, whatever is in it",
    new Set(all(".tbl-row").map((r) => Math.round(r.getBoundingClientRect().height))).size === 1,
    [...new Set(all(".tbl-row").map((r) => Math.round(r.getBoundingClientRect().height)))].join(","));
  // The header and the body are separate elements, so nothing but this says
  // they agree — and a column title sitting over the next column's data is the
  // one bug in a grid that makes every reading of it wrong.
  ok("every body column lines up with its header",
    all(".tbl-head .tbl-hcell").slice(1).every((h, i) => {
      const cell = all(".tbl-row")[0]?.querySelectorAll(".tbl-cell")[i];
      return cell !== undefined &&
        Math.abs(h.getBoundingClientRect().width - cell.getBoundingClientRect().width) < 1.5;
    }),
    all(".tbl-head .tbl-hcell").slice(1).map((h) => Math.round(h.getBoundingClientRect().width)).join(",") +
    "  vs  " + [...(all(".tbl-row")[0]?.querySelectorAll(".tbl-cell") ?? [])]
      .map((c) => Math.round(c.getBoundingClientRect().width)).join(","));
  ok("the untouched value, line break and all, is still on the cell",
    (all(".tbl-row")[2]?.querySelectorAll(".tbl-cell")[1] as HTMLElement | undefined)?.title
      === "Newline\ninside",
    JSON.stringify((all(".tbl-row")[2]?.querySelectorAll(".tbl-cell")[1] as HTMLElement | undefined)?.title));
  // A column is sized from the widest value in it, so nothing on this screen
  // has any business being cut off. An ellipsis here reads as "this value is
  // long", which is a claim about the data rather than about the layout.
  ok("no cell is ellipsised in a column wide enough for it",
    all(".tbl-row .tbl-cell").every((c) => c.scrollWidth <= c.clientWidth),
    all(".tbl-row .tbl-cell").filter((c) => c.scrollWidth > c.clientWidth)
      .map((c) => c.textContent).join(" | "));
  ok("an empty cell is empty rather than missing",
    rows[3]?.[1] === "" && rows[3]?.[2] === "empty name", JSON.stringify(rows[3]));
  ok("non-ascii survives the byte windows", rows[5]?.[1] === "Ünïcodé ✓", rows[5]?.[1] ?? "");
  ok("numbers are right-aligned, text is not",
    all(".tbl-row")[0]?.querySelectorAll(".tbl-cell.is-num").length === 2,
    String(all(".tbl-row")[0]?.querySelectorAll(".tbl-cell.is-num").length));

  // ── Sorting is over the file, not over the screen ─────────────────────────
  const amount = all(".tbl-head .tbl-hcell")[4] as HTMLElement;
  amount.click();
  await settle(400);
  let col = painted().map((r) => r[3] ?? "");
  ok("sorting a numeric column sorts it as numbers, not as text",
    col.join(",") === "-7,0,3.14159,12.5,99.999,1,234.00", col.join(","));
  ok("the sorted column is marked in the header",
    (all(".tbl-head .tbl-hcell")[4]?.textContent ?? "").includes("▴"),
    all(".tbl-head .tbl-hcell")[4]?.textContent ?? "");
  // Data rows are numbered from one, so the header is not row 1 and the first
  // record is — the same convention for a CSV, a sheet and a Parquet file,
  // none of which agree on whether a header even exists.
  ok("the row numbers follow the rows rather than the screen positions",
    rowNumbers().join(",") === "3,4,6,1,5,2", rowNumbers().join(","));

  amount.click();
  await settle(400);
  col = painted().map((r) => r[3] ?? "");
  ok("clicking the same header again reverses it",
    col.join(",") === "1,234.00,99.999,12.5,3.14159,0,-7", col.join(","));

  const when = all(".tbl-head .tbl-hcell")[5] as HTMLElement;
  when.click();
  await settle(400);
  ok("a blank sorts last rather than first, ascending",
    (painted().at(-1)?.[4] ?? "x") === "", JSON.stringify(painted().at(-1)));

  // ── Filtering ─────────────────────────────────────────────────────────────
  await type("unicode");
  ok("plain text filters on every column, case-insensitively",
    painted().length === 1 && painted()[0]?.[0] === "6", JSON.stringify(painted()));

  await type("amount>50");
  ok("a comparison on a named column compares numerically",
    painted().length === 2, JSON.stringify(painted().map((r) => r[3])));
  ok("and 1,234.00 counts as a number bigger than fifty",
    painted().some((r) => r[3] === "1,234.00"), JSON.stringify(painted().map((r) => r[3])));

  await type("note:empty");
  ok("column:value scopes the match to that column",
    painted().length === 1 && painted()[0]?.[0] === "4", JSON.stringify(painted()));

  await type("zzzz");
  ok("a filter matching nothing says so rather than showing a blank grid",
    painted().length === 0 && /Nothing matches/.test(text(".tbl-note")), text(".tbl-note"));

  (q(".tbl-btn") as HTMLElement).click();
  await settle(400);
  ok("Reset clears both the filter and the sort",
    painted().length === 6 && (painted()[0]?.[0] ?? "") === "1", JSON.stringify(painted()[0]));

  // ── 200 000 rows ──────────────────────────────────────────────────────────
  const big = await load("big.csv");
  served = 0;
  await table.open(big);
  await settle(600);

  const indexCost = served;
  ok("the index pass reads the file once and no more",
    indexCost <= (big.size ?? 0) * 1.05 + 200000,
    `${indexCost} bytes for a ${big.size}-byte file`);
  ok("200 000 rows are counted", /200,000 rows/.test(text(".tbl-title")), text(".tbl-title"));
  ok("only a screenful of rows exists in the DOM",
    all(".tbl-row").length < 120, `${all(".tbl-row").length} row elements`);

  served = 0;
  const scroll = q<HTMLElement>(".tbl-scroll");
  if (scroll) {
    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event("scroll"));
  }
  await settle(500);
  ok("jumping to the last row costs kilobytes, not megabytes",
    served < 400000, `${served} bytes`);
  ok("and the last row really is the last one",
    rowNumbers().at(-1) === 200000, String(rowNumbers().at(-1)));
  ok("the row under the cursor is a real row of the file",
    /^[0-9a-f]{16}$/.test(painted().at(-1)?.[1] ?? ""), JSON.stringify(painted().at(-1)));

  // A filter over 200 000 rows is a full pass; it must be right, not fast.
  await type("has, comma");
  await settle(1200);
  ok("filtering the whole file finds every match, not the loaded ones",
    painted().length > 0 && /200 shown/.test(text(".tbl-title")), text(".tbl-title"));
  ok("a match keeps its original row number",
    (rowNumbers()[0] ?? 0) === 1, String(rowNumbers()[0]));

  // ── A workbook ────────────────────────────────────────────────────────────
  const book = await load("book.xlsx");
  served = 0;
  await table.open(book);
  await settle(400);

  const picker = q<HTMLSelectElement>(".tbl-select");
  ok("every sheet is offered", picker?.options.length === 3, String(picker?.options.length));
  ok("sheets are named, not numbered",
    [...(picker?.options ?? [])].map((o) => o.textContent).join("|") === "Data|Second tab|Sparse",
    [...(picker?.options ?? [])].map((o) => o.textContent).join("|"));
  ok("shared strings were resolved rather than shown as indices",
    painted()[0]?.[1] === "row 1", JSON.stringify(painted()[0]));
  ok("a date-formatted number came back as a date",
    /^2024-01-02$/.test(painted()[0]?.[3] ?? ""), painted()[0]?.[3] ?? "");
  ok("a boolean is a word", ["TRUE", "FALSE"].includes(painted()[0]?.[4] ?? ""), painted()[0]?.[4] ?? "");

  if (picker) {
    picker.value = "2";
    picker.dispatchEvent(new Event("change"));
  }
  await settle(400);
  ok("switching sheets loads the other one",
    (painted()[0]?.[0] ?? "") === "" || headers()[0] === "left", `${headers().join("|")}`);
  const sparse = painted();
  ok("a sparse sheet keeps its empty rows in place",
    sparse.length >= 6, `${sparse.length} rows`);
  ok("a cell four columns right of anything else lands in column four",
    (sparse[0]?.[2] ?? "") === "far right" || headers()[3] === "far right",
    JSON.stringify(sparse[0]));
  ok("XML escapes are unescaped",
    sparse.some((r) => r.some((c) => c === 'quote " and <tag>')), JSON.stringify(sparse.at(-1)));

  // ── Parquet ───────────────────────────────────────────────────────────────
  const pq = await load("snappy.parquet");
  served = 0;
  await table.open(pq);
  await settle(500);

  ok("the parquet footer alone tells the grid its shape",
    /25,000 rows.*9 columns/.test(text(".tbl-title")), text(".tbl-title"));
  ok("opening it read a fraction of the file",
    served < (pq.size ?? 0) * 0.6, `${served} of ${pq.size} bytes`);
  ok("column names came from the schema",
    headers().join("|") === "id|name|score|flag|day|ts|big|category|money", headers().join("|"));

  const first = painted()[0] ?? [];
  ok("row one decodes correctly all the way across",
    first.join("|") === "1|name 1|1.5|false|2020-01-02|2020-01-01 00:01:00|1000000000|cat1|0.0100",
    first.join("|"));
  ok("a null is an empty cell, not a zero",
    (painted()[6]?.[2] ?? "x") === "", JSON.stringify(painted()[6]));

  served = 0;
  const pqScroll = q<HTMLElement>(".tbl-scroll");
  if (pqScroll) {
    pqScroll.scrollTop = pqScroll.scrollHeight;
    pqScroll.dispatchEvent(new Event("scroll"));
  }
  await settle(600);
  ok("the last row of a parquet file costs one row group",
    served < (pq.size ?? 0) * 0.5, `${served} of ${pq.size} bytes`);
  ok("and it is row 25 000", rowNumbers().at(-1) === 25000, String(rowNumbers().at(-1)));

  await type("category:cat3");
  await settle(1500);
  // 6 250 rows have category cat3, and a fifth of those are null instead —
  // the nulls are the reason this number is not the obvious one.
  ok("filtering a parquet file scans every row group",
    /5,000 shown/.test(text(".tbl-title")), text(".tbl-title"));

  await type("");
  await settle(600);
  const score = all(".tbl-head .tbl-hcell")[3] as HTMLElement;
  score.click();
  await settle(1500);
  score.click();
  await settle(1500);
  ok("sorting 25 000 rows by a float puts the biggest first",
    (painted()[0]?.[2] ?? "") === "37500.0", painted()[0]?.[2] ?? "");
  ok("the nulls did not sort as zero and did not vanish",
    /25,000 rows/.test(text(".tbl-title")) && painted().every((r) => r[2] !== ""),
    text(".tbl-title"));

  // ── Keys ──────────────────────────────────────────────────────────────────
  const key = (k: string): boolean => table.key(new KeyboardEvent("keydown", { key: k }));
  ok("the grid claims the arrow keys", key("ArrowDown") && key("ArrowRight"));
  ok("it does not claim keys it has no use for", !key("q"));
  ok("Escape closes it", key("Escape") && !table.isOpen);

  await table.open(awkward);
  await settle(300);
  document.title = fail === 0 ? `table: ${pass} passed` : `table: ${fail} FAILED of ${pass + fail}`;
  console.log(document.title);
}

void run().catch((e: unknown) => {
  document.title = `table: threw — ${String(e)}`;
  console.error(e);
});
