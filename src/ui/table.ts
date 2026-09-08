/**
 * The tabular viewer — CSV, TSV, Excel and Parquet in one grid.
 *
 * The rule this is built around is that the file is never loaded whole. A CSV
 * is read once to find where its rows begin, and from then on any row anywhere
 * costs one read at one offset; a Parquet file is read a row group at a time;
 * a workbook is unzipped one sheet at a time and the other tabs are never
 * touched. Opening a 200 MB export should feel exactly like opening a 2 KB one,
 * and mostly it does — the difference is a progress bar during the first pass.
 *
 * Sorting and filtering are the part that is easy to get quietly wrong. A grid
 * that sorts only what is currently on screen looks like it works and is
 * useless: the answer it gives is the largest of the fifty rows you happened to
 * be looking at. So both do a real pass over the whole file, streaming, with a
 * progress bar and a cancel, and what they keep is one column of keys and a
 * list of row numbers — never the rows themselves.
 *
 * The source underneath is an interface with three implementations, and the
 * grid does not know which one it is talking to. That is what lets the same
 * screen serve four formats whose only shared property is being rectangular.
 */

import {
  buildIndex, decode, isNumeric, numeric, parseRows, sniff,
  type Dialect, type RowIndex,
} from "@core/table/csv";
import { openParquet, type ParquetFile } from "@core/table/parquet";
import { openWorkbook, type Sheet, type Workbook } from "@core/table/xlsx";
import { formatSize, type FileEntry } from "@core/explorer/types";
import { attachTextZoom } from "@ui/zoom";
import { PREF } from "@core/settings/registry";
import { settings } from "@core/settings/store";

export interface TableHost {
  readRange(path: string, offset: number, len: number): Promise<number[]>;
  readHead(path: string, max: number): Promise<number[]>;
  readTail(path: string, len: number): Promise<[number[], number]>;
}

/**
 * A rectangle of text, however it is stored.
 *
 * Deliberately narrow. `getMany` takes row numbers rather than a range because
 * a sorted view asks for scattered rows, and every backend can coalesce them
 * better than the grid could — a CSV by merging nearby byte ranges, a Parquet
 * file by row group, a sheet by not needing to.
 */
interface TableSource {
  readonly columns: string[];
  readonly rows: number;
  /** Sheets, row groups — whatever this format divides itself into. Often empty. */
  readonly parts: string[];
  readonly part: number;
  /** One line about what this file actually is, shown in the bar. */
  readonly note: string;
  choose(index: number): Promise<void>;
  getMany(rowNumbers: number[]): Promise<string[][]>;
  /** A sequential pass over every row, for sorting and filtering. */
  scan(onRows: (first: number, rows: string[][]) => void, cancelled: () => boolean): Promise<void>;
}

/** Rows per cached block. Big enough to amortise a hop, small enough to evict. */
const BLOCK = 200;
/** Blocks kept before the oldest goes. Read live so item 43's control bites. */
const blockCache = (): number => settings.get<number>(PREF.tableBlocks);
/**
 * Above this, sorting is refused rather than attempted.
 *
 * Sorting needs one whole column in memory at once; ten million strings is a
 * gigabyte and a frozen window. Saying so is better than a spinner that never
 * ends. Filtering has no such limit — it keeps only the row numbers that match.
 */
const SORT_CAP = 3_000_000;

export class TableView {
  private readonly root = document.createElement("div");
  private readonly title = document.createElement("div");
  private readonly parts = document.createElement("select");
  private readonly filter = document.createElement("input");
  private readonly head = document.createElement("div");
  private readonly gutter = document.createElement("div");
  private readonly scroll = document.createElement("div");
  private readonly spacer = document.createElement("div");
  private readonly rowLayer = document.createElement("div");
  private readonly note = document.createElement("div");
  private readonly cellText = document.createElement("div");
  private readonly bar = document.createElement("progress");

  private source: TableSource | null = null;
  private entry: FileEntry | null = null;

  /**
   * View row → source row, or null when they are the same thing.
   *
   * An identity view costs nothing and is the common case, so it is a null
   * rather than a four-byte-per-row array that says `i` at position `i`.
   */
  private order: Int32Array | null = null;
  private sortCol = -1;
  private sortDesc = false;
  private query = "";

  private readonly blocks = new Map<number, string[][]>();
  private readonly inflight = new Set<number>();
  private widths: number[] = [];
  private rowH = 22;
  private cursor: [number, number] = [0, 0];
  /** Bumped on open, close, sheet change and every new sort — a late read from
   *  the previous view must never paint over the current one. */
  private token = 0;
  private working = false;
  private cancelWork = false;

  constructor(private readonly host: TableHost) {
    this.root.className = "tbl";
    this.root.hidden = true;

    const bar = document.createElement("div");
    bar.className = "tbl-bar";
    this.title.className = "tbl-title";

    this.parts.className = "tbl-select";
    this.parts.hidden = true;
    this.parts.addEventListener("change", () => void this.pick(Number(this.parts.value)));

    this.filter.className = "tbl-input";
    this.filter.placeholder = "filter — text, or >100, or col:value";
    this.filter.spellcheck = false;
    this.filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.stopPropagation(); void this.applyFilter(this.filter.value); }
      if (e.key === "Escape") { e.stopPropagation(); this.filter.blur(); }
    });

    const reset = document.createElement("button");
    reset.className = "tbl-btn";
    reset.textContent = "Reset";
    reset.title = "Clear the sort and the filter";
    reset.addEventListener("click", () => {
      this.filter.value = "";
      this.query = "";
      this.sortCol = -1;
      void this.rebuild();
    });

    const close = document.createElement("button");
    close.className = "tbl-btn";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());

    this.bar.className = "tbl-progress";
    this.bar.max = 1;
    this.bar.hidden = true;

    bar.append(this.title, this.parts, this.filter, reset, this.bar, close);

    this.head.className = "tbl-head";
    this.gutter.className = "tbl-gutter";

    this.scroll.className = "tbl-scroll";
    this.spacer.className = "tbl-spacer";
    this.rowLayer.className = "tbl-rows";
    this.spacer.append(this.rowLayer);
    this.scroll.append(this.spacer);
    // The header scrolls sideways with the body and never vertically, which is
    // the entire reason it is a separate element instead of a <thead>.
    this.scroll.addEventListener("scroll", () => {
      this.head.style.transform = `translateX(${-this.scroll.scrollLeft}px)`;
      this.paint();
    });

    // Pinch to change the type size. On a phone the useful direction is *out*
    // -- four more columns on screen -- which is why this one goes below 1x
    // and the picture zoom does not.
    //
    // The font rather than a transform, for two reasons that both matter here.
    // The grid is virtualised off a measured `rowH`, and the header is a
    // separate element sitting over the body: scale the row layer and the
    // spacer, the row window and the column titles all keep believing the old
    // height, so the header ends up over the wrong data. And the column widths
    // are handed out in `ch`, so a font change resizes the columns correctly
    // for free -- which is the whole reason `--tbl-fs` is one token shared by
    // the header and the body.
    attachTextZoom(this.scroll, this.root, {
      remeasure: () => {
        this.measureRow();
        this.spacer.style.height = `${this.spacerHeight(this.shown())}px`;
        this.renderHead();
        this.paint();
      },
    });

    const grid = document.createElement("div");
    grid.className = "tbl-grid";
    grid.append(this.head, this.scroll);

    this.note.className = "tbl-note";
    this.cellText.className = "tbl-cell-text";
    this.cellText.addEventListener("click", () => {
      const [r, c] = this.cursor;
      const v = this.cell(r, c);
      if (v !== null) void navigator.clipboard.writeText(v);
    });
    const foot = document.createElement("div");
    foot.className = "tbl-foot";
    foot.append(this.note, this.cellText);

    this.root.append(bar, grid, foot);
    document.body.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** What this surface is showing, for the session record. Null when closed. */
  get openPath(): string | null {
    return this.isOpen ? (this.entry?.path ?? null) : null;
  }

  close(): void {
    this.root.hidden = true;
    this.token++;
    this.cancelWork = true;
    this.blocks.clear();
    this.inflight.clear();
    this.source = null;
    this.entry = null;
    this.order = null;
  }

  toggle(entry: FileEntry | undefined): void {
    if (this.isOpen) this.close();
    else if (entry) void this.open(entry);
  }

  /**
   * The extensions that open here on a double-click.
   *
   * Narrower than what the reader can handle. `.db` and `.json` are "tabular"
   * to the explorer and are not this; `.txt` is usually prose and occasionally
   * a tab-delimited export, and guessing wrong on every text file in a folder
   * is the worse of the two mistakes. Anything else can still be opened here
   * deliberately, from the palette.
   */
  static handles(ext: string): boolean {
    return ["csv", "tsv", "tab", "xlsx", "xlsm", "parquet", "pq"].includes(ext.toLowerCase());
  }

  async open(entry: FileEntry): Promise<void> {
    if (entry.kind === "folder") return;
    const mine = ++this.token;
    this.entry = entry;
    this.source = null;
    this.order = null;
    this.sortCol = -1;
    this.query = "";
    this.filter.value = "";
    this.blocks.clear();
    this.inflight.clear();
    this.cursor = [0, 0];
    this.root.hidden = false;
    this.parts.hidden = true;
    this.title.textContent = `${entry.name} — reading…`;
    this.note.textContent = "";
    this.cellText.textContent = "";
    this.head.replaceChildren();
    this.rowLayer.replaceChildren();
    this.measureRow();

    try {
      const source = await this.build(entry, mine);
      if (this.token !== mine || !source) return;
      this.source = source;
      this.renderParts();
      this.fitColumns();
      await this.rebuild();
    } catch (e) {
      if (this.token !== mine) return;
      this.title.textContent = entry.name;
      this.note.textContent = `Could not read this file — ${String(e)}`;
    }
  }

  // ── Opening ───────────────────────────────────────────────────────────────

  private async build(entry: FileEntry, mine: number): Promise<TableSource | null> {
    const ext = entry.ext.toLowerCase();
    const size = entry.size ?? 0;
    if (ext === "parquet" || ext === "pq") {
      const file = await openParquet(this.host, entry.path, size);
      return this.token === mine ? parquetSource(file) : null;
    }
    if (ext === "xlsx" || ext === "xlsm") {
      const wb = await openWorkbook(this.host, entry.path);
      return this.token === mine ? await sheetSource(wb) : null;
    }
    return await this.delimited(entry, size, mine);
  }

  private async delimited(entry: FileEntry, size: number, mine: number): Promise<TableSource | null> {
    const head = new Uint8Array(await this.host.readHead(entry.path, Math.min(size, 128 * 1024)));
    if (this.token !== mine) return null;
    const dialect = sniff(head);

    // The index pass is the only thing here that is O(file), so it is the only
    // thing that gets a progress bar — and a cancel, because changing your mind
    // about a two-gigabyte CSV should not mean waiting for it.
    this.bar.hidden = false;
    this.bar.value = 0;
    const { index } = await buildIndex(
      async (o, l) => new Uint8Array(await this.host.readRange(entry.path, o, l)),
      size,
      dialect,
      {
        onProgress: (done, rows) => {
          if (this.token !== mine) return;
          this.bar.value = size > 0 ? done / size : 1;
          this.title.textContent = `${entry.name} — ${rows.toLocaleString()} rows so far…`;
        },
        cancelled: () => this.token !== mine,
      },
    );
    this.bar.hidden = true;
    if (this.token !== mine) return null;
    return delimitedSource(this.host, entry.path, size, dialect, index);
  }

  // ── The view: sort and filter ─────────────────────────────────────────────

  /**
   * Rebuild `order` from the current sort and filter, then repaint.
   *
   * With neither, this is instant and allocates nothing. With either, it is one
   * streaming pass over the file — which is the honest cost, and the reason it
   * shows a bar rather than pretending to be free.
   */
  private async rebuild(): Promise<void> {
    const source = this.source;
    if (!source) return;
    const mine = ++this.token;
    this.blocks.clear();
    this.inflight.clear();

    if (this.sortCol < 0 && this.query === "") {
      this.order = null;
      this.afterRebuild(source.rows);
      return;
    }
    if (this.sortCol >= 0 && source.rows > SORT_CAP) {
      this.sortCol = -1;
      this.note.textContent =
        `Sorting holds one whole column in memory, and this file has ` +
        `${source.rows.toLocaleString()} rows. Filter it down first.`;
      this.order = null;
      this.afterRebuild(source.rows);
      return;
    }

    const test = compile(this.query, source.columns);
    const keep: number[] = [];
    // Keys are collected in parallel with the row numbers so the sort does not
    // need a second pass to look them up.
    const keys: string[] = [];
    const col = this.sortCol;

    this.working = true;
    this.cancelWork = false;
    this.bar.hidden = false;
    this.bar.value = 0;
    this.note.textContent = "Reading the whole file…";

    try {
      await source.scan((first, rows) => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] as string[];
          if (test && !test(row)) continue;
          keep.push(first + i);
          if (col >= 0) keys.push(row[col] ?? "");
        }
        if (this.token === mine && source.rows > 0) {
          this.bar.value = Math.min(1, (first + rows.length) / source.rows);
        }
      }, () => this.cancelWork || this.token !== mine);
    } finally {
      this.working = false;
      this.bar.hidden = true;
    }
    if (this.token !== mine) return;

    if (col >= 0) {
      // Numeric when the column is numeric, textual otherwise — and worked out
      // from the data rather than from a header, because "amount" is a name and
      // "1,234.00" is a number. Blanks sort last either way; they are absent
      // values, not small ones, and burying them at the top of a descending
      // sort is how a hole in the data goes unnoticed.
      const sampled = keys.filter((k) => k !== "").slice(0, 200);
      const asNumbers = sampled.length > 0 && sampled.every((k) => isNumeric(k));
      const dir = this.sortDesc ? -1 : 1;
      const at = new Map<number, string>();
      for (let i = 0; i < keep.length; i++) at.set(keep[i] as number, keys[i] as string);
      keep.sort((a, b) => {
        const x = at.get(a) ?? "";
        const y = at.get(b) ?? "";
        if (x === "" || y === "") return x === y ? a - b : x === "" ? 1 : -1;
        if (asNumbers) {
          const d = numeric(x) - numeric(y);
          return (d === 0 ? a - b : d) * dir;
        }
        const d = x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
        return (d === 0 ? a - b : d) * dir;
      });
    }

    this.order = Int32Array.from(keep);
    this.afterRebuild(keep.length);
  }

  private afterRebuild(shown: number): void {
    const source = this.source;
    if (!source) return;
    this.cursor = [Math.min(this.cursor[0], Math.max(0, shown - 1)), this.cursor[1]];
    this.spacer.style.height = `${this.spacerHeight(shown)}px`;
    this.scroll.scrollTop = 0;
    this.renderHead();
    this.paint();
    this.status(shown);
  }

  private status(shown: number): void {
    const source = this.source;
    const entry = this.entry;
    if (!source || !entry) return;
    const bits = [
      `${source.rows.toLocaleString()} rows`,
      `${source.columns.length} columns`,
      formatSize(entry.size),
    ];
    if (shown !== source.rows) bits.push(`${shown.toLocaleString()} shown`);
    if (source.note) bits.push(source.note);
    this.title.textContent = `${entry.name} — ${bits.join("  ·  ")}`;
    if (shown === 0) {
      this.note.textContent = this.query
        ? `Nothing matches “${this.query}”.`
        : "This file has no rows.";
    } else if (!this.working) {
      this.note.textContent = "";
    }
  }

  /**
   * The sheet picker, shown only when there is more than one.
   *
   * A workbook with a single tab is a table, and putting a one-item dropdown
   * next to it is furniture that says nothing.
   */
  private renderParts(): void {
    const names = this.source?.parts ?? [];
    this.parts.hidden = names.length < 2;
    if (this.parts.hidden) return;
    this.parts.replaceChildren();
    names.forEach((name, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = name;
      this.parts.append(opt);
    });
    this.parts.value = String(this.source?.part ?? 0);
  }

  private async applyFilter(text: string): Promise<void> {
    const next = text.trim();
    if (next === this.query) return;
    this.query = next;
    await this.rebuild();
  }

  private async pick(index: number): Promise<void> {
    const source = this.source;
    if (!source || index === source.part) return;
    await source.choose(index);
    this.order = null;
    this.sortCol = -1;
    this.query = "";
    this.filter.value = "";
    this.cursor = [0, 0];
    this.renderParts();
    this.fitColumns();
    await this.rebuild();
  }

  // ── Rows ──────────────────────────────────────────────────────────────────

  /** How many rows the current view has. */
  private shown(): number {
    return this.order ? this.order.length : (this.source?.rows ?? 0);
  }

  /** View row → source row. */
  private sourceRow(view: number): number {
    return this.order ? (this.order[view] ?? 0) : view;
  }

  private cell(view: number, col: number): string | null {
    const block = this.blocks.get(Math.floor(view / BLOCK));
    if (!block) return null;
    return block[view % BLOCK]?.[col] ?? "";
  }

  private need(from: number, to: number): void {
    const source = this.source;
    if (!source) return;
    const first = Math.floor(from / BLOCK);
    const last = Math.floor(Math.max(from, to - 1) / BLOCK);
    for (let b = first; b <= last; b++) {
      if (this.blocks.has(b) || this.inflight.has(b)) continue;
      const start = b * BLOCK;
      const count = Math.min(BLOCK, this.shown() - start);
      if (count <= 0) continue;
      const wanted: number[] = [];
      for (let i = 0; i < count; i++) wanted.push(this.sourceRow(start + i));
      this.inflight.add(b);
      const mine = this.token;
      void source
        .getMany(wanted)
        .then((rows) => {
          if (this.token !== mine) return;
          this.blocks.set(b, rows);
          // Re-read every time, so lowering the budget frees memory on the next
          // fetch rather than staying at the size it happened to reach.
          while (this.blocks.size > blockCache()) {
            const oldest = this.blocks.keys().next().value;
            if (oldest === undefined) break;
            this.blocks.delete(oldest);
          }
          this.paint();
        })
        .catch((e: unknown) => {
          if (this.token === mine) this.note.textContent = String(e);
        })
        .finally(() => this.inflight.delete(b));
    }
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  private measureRow(): void {
    const probe = document.createElement("div");
    probe.className = "tbl-row";
    const c = document.createElement("i");
    c.textContent = "0";
    probe.append(c);
    this.rowLayer.append(probe);
    this.rowH = probe.getBoundingClientRect().height || 22;
    probe.remove();
  }

  /**
   * Column widths, from the header and whatever rows are already loaded.
   *
   * Measured in characters rather than pixels because the grid is monospace,
   * and clamped at both ends: three characters is unreadable even for a column
   * of `Y`/`N`, and one 4 000-character JSON blob must not push every other
   * column off the screen.
   */
  private fitColumns(): void {
    const source = this.source;
    if (!source) return;
    this.widths = source.columns.map((c) => Math.max(6, Math.min(24, c.length + 2)));
  }

  private growColumns(rows: string[][]): void {
    let changed = false;
    for (const row of rows) {
      for (let c = 0; c < this.widths.length; c++) {
        const len = oneLine(row[c] ?? "").length + 2;
        const want = Math.max(this.widths[c] as number, Math.min(40, len));
        if (want !== this.widths[c]) { this.widths[c] = want; changed = true; }
      }
    }
    if (changed) this.renderHead();
  }

  private renderHead(): void {
    const source = this.source;
    if (!source) return;
    const cells: HTMLElement[] = [];

    const corner = document.createElement("i");
    corner.className = "tbl-hcell tbl-num";
    corner.textContent = "#";
    cells.push(corner);

    source.columns.forEach((name, c) => {
      const cell = document.createElement("i");
      cell.className = "tbl-hcell";
      cell.style.width = colWidth(this.widths[c]);
      cell.title = `${name} — click to sort`;
      const label = document.createElement("b");
      label.textContent = name;
      cell.append(label);
      if (this.sortCol === c) {
        const arrow = document.createElement("u");
        arrow.textContent = this.sortDesc ? " ▾" : " ▴";
        cell.append(arrow);
        cell.classList.add("is-sorted");
      }
      cell.addEventListener("click", () => {
        if (this.working) return;
        if (this.sortCol === c) this.sortDesc = !this.sortDesc;
        else { this.sortCol = c; this.sortDesc = false; }
        void this.rebuild();
      });
      cells.push(cell);
    });
    this.head.replaceChildren(...cells);
  }

  /** Same clamp as the hex dump: browsers stop honouring an element's height
   *  somewhere north of 33 million pixels, and one pixel of clamping makes the
   *  end of the file unreachable. */
  private spacerHeight(rows: number): number {
    return Math.min(Math.max(1, rows) * this.rowH, 20_000_000);
  }

  private pageRows(): number {
    return Math.max(1, Math.floor(this.scroll.clientHeight / this.rowH));
  }

  private firstRow(): number {
    const total = this.shown();
    const span = Math.max(0, this.spacerHeight(total) - this.scroll.clientHeight);
    if (span <= 0) return 0;
    const frac = Math.min(1, Math.max(0, this.scroll.scrollTop / span));
    return Math.round(frac * Math.max(0, total - this.pageRows()));
  }

  private paint(): void {
    const source = this.source;
    if (!this.isOpen || !source) return;
    const total = this.shown();
    const first = this.firstRow();
    const pad = Math.min(2, first);
    const from = first - pad;
    const last = Math.min(total, first + this.pageRows() + 2);

    this.need(from, last);
    this.rowLayer.style.transform = `translateY(${this.scroll.scrollTop - pad * this.rowH}px)`;

    // Widths are grown from what has arrived *before* anything is drawn with
    // them. Doing it afterwards repaints the header and leaves the body on the
    // old numbers, and a header that does not line up with its own column is
    // the most confusing thing a grid can do.
    const loaded: string[][] = [];
    for (let r = from; r < last; r++) {
      const row = this.blocks.get(Math.floor(r / BLOCK))?.[r % BLOCK];
      if (row) loaded.push(row);
    }
    if (loaded.length > 0) this.growColumns(loaded);

    const out: HTMLElement[] = [];
    for (let r = from; r < last; r++) {
      const row = document.createElement("div");
      row.className = "tbl-row";

      const num = document.createElement("i");
      num.className = "tbl-num";
      // The source row number, not the position on screen. Under a sort those
      // are different, and the one worth knowing is where the row came from.
      num.textContent = (this.sourceRow(r) + 1).toLocaleString();
      row.append(num);

      for (let c = 0; c < source.columns.length; c++) {
        const cell = document.createElement("i");
        cell.className = "tbl-cell";
        cell.style.width = colWidth(this.widths[c]);
        const v = this.cell(r, c);
        // A cell that has not arrived shows nothing at all. Rendering it as an
        // empty string would be indistinguishable from a genuinely empty cell,
        // which in a data grid is a different and important fact.
        if (v === null) cell.classList.add("is-waiting");
        else {
          cell.textContent = oneLine(v);
          cell.title = v;
          if (v !== "" && isNumeric(v)) cell.classList.add("is-num");
        }
        if (r === this.cursor[0] && c === this.cursor[1]) cell.classList.add("is-cursor");
        cell.addEventListener("mousedown", () => this.setCursor(r, c));
        row.append(cell);
      }
      if (r === this.cursor[0]) row.classList.add("is-currentrow");
      out.push(row);
    }
    this.rowLayer.replaceChildren(...out);
    this.showCell();
  }

  /**
   * The selected cell, in full, at the bottom.
   *
   * Columns are clipped to keep the grid readable, so there has to be one place
   * that shows the whole value — otherwise a truncated cell is a lie about the
   * data, and this is the one screen where that matters most.
   */
  private showCell(): void {
    const source = this.source;
    if (!source) return;
    const [r, c] = this.cursor;
    const v = this.cell(r, c);
    const name = source.columns[c] ?? "";
    this.cellText.textContent = v === null ? "" : `${name}  =  ${v}`;
    this.cellText.title = "Click to copy";
  }

  private setCursor(row: number, col: number): void {
    this.cursor = [row, col];
    this.paint();
  }

  private jump(row: number, col: number): void {
    const total = this.shown();
    const r = Math.max(0, Math.min(row, Math.max(0, total - 1)));
    const c = Math.max(0, Math.min(col, Math.max(0, (this.source?.columns.length ?? 1) - 1)));
    this.cursor = [r, c];
    const first = this.firstRow();
    const rows = this.pageRows();
    if (r < first + 1 || r > first + rows - 2) {
      const want = Math.max(0, r - Math.floor(rows / 2));
      const span = Math.max(0, this.spacerHeight(total) - this.scroll.clientHeight);
      const reach = Math.max(1, total - rows);
      this.scroll.scrollTop = Math.min(span, (want / reach) * span);
    }
    this.paint();
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  /** True when the key was consumed. */
  key(e: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (e.target === this.filter || e.target === this.parts) {
      if (e.key === "Escape") { (e.target as HTMLElement).blur(); return true; }
      return false;
    }
    const [r, c] = this.cursor;
    const page = Math.max(1, this.pageRows() - 1);
    switch (e.key) {
      case "Escape": this.close(); return true;
      case "ArrowDown": this.jump(r + 1, c); return true;
      case "ArrowUp": this.jump(r - 1, c); return true;
      case "ArrowRight": this.jump(r, c + 1); return true;
      case "ArrowLeft": this.jump(r, c - 1); return true;
      case "PageDown": this.jump(r + page, c); return true;
      case "PageUp": this.jump(r - page, c); return true;
      case "Home": this.jump(e.ctrlKey ? 0 : r, 0); return true;
      case "End": this.jump(e.ctrlKey ? this.shown() - 1 : r, (this.source?.columns.length ?? 1) - 1); return true;
      case "/": e.preventDefault(); this.filter.focus(); this.filter.select(); return true;
      case "c": case "C": {
        if (!e.ctrlKey && !e.metaKey) return false;
        const v = this.cell(r, c);
        if (v !== null) void navigator.clipboard.writeText(v);
        return true;
      }
      default: return false;
    }
  }
}

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * Turn what someone typed into a row test.
 *
 * Three forms, in the order people reach for them: plain text matches anywhere
 * in the row; `column:text` matches inside one column; and a comparison —
 * `>100`, `amount<=5`, `name!=x` — does the obvious thing, numerically when
 * both sides look numeric. Anything unparseable falls back to plain text rather
 * than to an error, because a filter box that rejects input is a filter box
 * people stop using.
 */
function compile(query: string, columns: string[]): ((row: string[]) => boolean) | null {
  const q = query.trim();
  if (q === "") return null;

  const col = (name: string): number =>
    columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());

  const cmp = /^([^<>=!]*?)\s*(>=|<=|!=|=|>|<)\s*(.*)$/.exec(q);
  if (cmp) {
    const which = (cmp[1] ?? "").trim();
    const op = cmp[2] as string;
    const rhs = (cmp[3] ?? "").trim();
    const index = which === "" ? -1 : col(which);
    if (which === "" || index >= 0) {
      const asNumber = isNumeric(rhs);
      const want = numeric(rhs);
      const test = (v: string): boolean => {
        if (asNumber && isNumeric(v)) {
          const n = numeric(v);
          switch (op) {
            case ">": return n > want;
            case "<": return n < want;
            case ">=": return n >= want;
            case "<=": return n <= want;
            case "!=": return n !== want;
            default: return n === want;
          }
        }
        const a = fold(v);
        const b = fold(rhs);
        switch (op) {
          case "!=": return a !== b;
          case "=": return a === b;
          // A text value has no order worth comparing against a number, so a
          // `>` against text matches nothing rather than something arbitrary.
          default: return false;
        }
      };
      // A bare `>100` applies to every column, which is what someone typing it
      // into a box labelled "filter" means: show me rows with a big number in.
      return index >= 0
        ? (row) => test(row[index] ?? "")
        : (row) => row.some((v) => test(v));
    }
  }

  const scoped = /^([^:]+):(.*)$/.exec(q);
  if (scoped) {
    const index = col((scoped[1] ?? "").trim());
    if (index >= 0) {
      const needle = fold((scoped[2] ?? "").trim());
      return (row) => fold(row[index] ?? "").includes(needle);
    }
  }

  const needle = fold(q);
  return (row) => row.some((v) => fold(v).includes(needle));
}

/**
 * A cell value on one line.
 *
 * A CSV field is allowed to contain a newline, and one that does would push
 * every row after it down the screen and desynchronise the virtual scroll from
 * the row height it is built on. The break is shown rather than swallowed —
 * `⏎` says the line ending is in the data, which is a different thing from a
 * space — and the full value is still in the tooltip and in the footer.
 */
/**
 * A column width, in characters, as a CSS length.
 *
 * The 16px is the cells' own left and right padding. Both boxes are
 * border-box, so without it the padding eats into the characters the width was
 * measured for and every column ellipsises its longest value by one or two
 * letters — which looks exactly like data that is genuinely too long.
 */
function colWidth(chars: number | undefined): string {
  return `calc(${chars ?? 12}ch + 16px)`;
}

function oneLine(v: string): string {
  return v.includes("\n") || v.includes("\r") ? v.replace(/\r\n|[\r\n]/g, " ⏎ ") : v;
}

/**
 * The form a value is matched in: lower case, and without its accents.
 *
 * Someone typing `unicode` into a filter box means to find `Ünïcodé`, and a
 * grid that hides the row because of two dots over a U is a grid that quietly
 * tells them their data is not there. Sorting already ignores accents — this is
 * the same rule applied to the other half of the screen.
 *
 * Decomposing is skipped for pure ASCII, which is almost every cell in almost
 * every file, and this runs once per cell across the whole file on a filter.
 */
function fold(s: string): string {
  const lower = s.toLowerCase();
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(lower)
    ? lower
    : lower.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

// ── Sources ─────────────────────────────────────────────────────────────────

/**
 * Delimited text, addressed by the row index.
 *
 * Every read here is a byte range worked out from the index, which is why a
 * row in the middle of a two-gigabyte file costs the same as the first one.
 */
async function delimitedSource(
  host: TableHost, path: string, size: number, dialect: Dialect, index: RowIndex,
): Promise<TableSource> {
  const headerRow = dialect.hasHeader ? 0 : -1;
  const dataAt = (row: number): number => row + (dialect.hasHeader ? 1 : 0);
  const total = Math.max(0, index.length - (dialect.hasHeader ? 1 : 0));

  const span = (row: number): [number, number] => {
    const at = index[row] ?? size;
    const to = row + 1 < index.length ? (index[row + 1] as number) : size;
    return [at, Math.max(0, to - at)];
  };

  const readSpan = async (from: number, to: number): Promise<string[][]> => {
    const start = index[from] ?? size;
    const end = to < index.length ? (index[to] as number) : size;
    if (end <= start) return [];
    const bytes = new Uint8Array(await host.readRange(path, start, end - start));
    return parseRows(decode(bytes, dialect.encoding), dialect.delimiter, true).rows;
  };

  let columns: string[] = [];
  // Resolved before the source is handed back: the grid draws its header the
  // moment it has a source, and a header that appears a frame later reads as a
  // flicker rather than as loading.
  const ready = (async () => {
    if (headerRow >= 0 && index.length > 0) {
      const [at, len] = span(headerRow);
      const bytes = new Uint8Array(await host.readRange(path, at, len));
      columns = parseRows(decode(bytes, dialect.encoding), dialect.delimiter, true).rows[0] ?? [];
    }
    if (columns.length === 0) {
      const [at, len] = span(0);
      const bytes = new Uint8Array(await host.readRange(path, at, len));
      const first = parseRows(decode(bytes, dialect.encoding), dialect.delimiter, true).rows[0] ?? [];
      // Unnamed columns get a number, not a blank. "Column 3" is something you
      // can say out loud and type into the filter box.
      columns = first.map((_, i) => `Column ${i + 1}`);
    }
  })();

  const name = dialect.delimiter === "\t" ? "tab-separated"
    : dialect.delimiter === ";" ? "semicolon-separated"
      : dialect.delimiter === "|" ? "pipe-separated" : "comma-separated";

  const source: TableSource = {
    get columns() { return columns; },
    rows: total,
    parts: [],
    part: 0,
    note: `${name}${dialect.encoding === "utf-8" ? "" : `, ${dialect.encoding}`}`,
    async choose() { /* one table per file */ },

    async getMany(wanted) {
      await ready;
      if (wanted.length === 0) return [];
      // Rows that are next to each other in the file are fetched together. A
      // page of an unsorted view is one contiguous read; a page of a sorted one
      // is a handful, instead of fifty.
      const order = wanted.map((r, i) => ({ r, i })).sort((a, b) => a.r - b.r);
      const out: string[][] = new Array(wanted.length);
      let k = 0;
      while (k < order.length) {
        let j = k;
        let bytes = 0;
        while (j + 1 < order.length) {
          const next = order[j + 1] as { r: number; i: number };
          const here = order[j] as { r: number; i: number };
          const gap = (index[dataAt(next.r)] ?? size) - (index[dataAt(here.r)] ?? size);
          if (gap < 0 || bytes + gap > 512 * 1024) break;
          bytes += gap;
          j++;
        }
        const first = (order[k] as { r: number }).r;
        const lastRow = (order[j] as { r: number }).r;
        const rows = await readSpan(dataAt(first), dataAt(lastRow) + 1);
        for (let t = k; t <= j; t++) {
          const item = order[t] as { r: number; i: number };
          out[item.i] = rows[item.r - first] ?? [];
        }
        k = j + 1;
      }
      return out;
    },

    async scan(onRows, cancelled) {
      await ready;
      const WINDOW = 4 * 1024 * 1024;
      let row = 0;
      while (row < total) {
        if (cancelled()) return;
        // Windows are chosen in rows and cut at row boundaries, so every read
        // is a whole number of rows and nothing has to be carried across.
        const start = index[dataAt(row)] ?? size;
        let end = row;
        while (end < total && ((index[dataAt(end) + 1] ?? size) - start) <= WINDOW) end++;
        if (end === row) end = row + 1;
        const rows = await readSpan(dataAt(row), dataAt(end - 1) + 1);
        onRows(row, rows);
        row = end;
      }
    },
  };
  await ready;
  return source;
}

/** A workbook: one sheet at a time, held in memory once read. */
async function sheetSource(wb: Workbook): Promise<TableSource> {
  let index = 0;
  let columns: string[] = [];
  let rows: string[][] = [];
  let truncated = false;

  const load = async (i: number): Promise<void> => {
    const sheet = wb.sheets[i] as Sheet | undefined;
    if (!sheet) return;
    const data = await wb.read(sheet);
    index = i;
    truncated = data.truncated;
    const first = data.rows[0] ?? [];
    // A spreadsheet's first row is a header far more often than not, and unlike
    // a CSV there is nothing else to go on — so it is one unless it is empty.
    const header = first.length > 0 && first.some((c) => c.trim() !== "");
    columns = header
      ? first.map((c, n) => (c.trim() === "" ? `Column ${n + 1}` : c))
      : first.map((_, n) => `Column ${n + 1}`);
    rows = header ? data.rows.slice(1) : data.rows;
  };
  await load(0);

  return {
    get columns() { return columns; },
    get rows() { return rows.length; },
    get parts() { return wb.sheets.map((s) => s.name); },
    get part() { return index; },
    get note() { return truncated ? "truncated at 500 000 rows" : "Excel workbook"; },
    choose: load,
    async getMany(wanted) { return wanted.map((r) => rows[r] ?? []); },
    async scan(onRows, cancelled) {
      const STEP = 5000;
      for (let i = 0; i < rows.length; i += STEP) {
        if (cancelled()) return;
        onRows(i, rows.slice(i, i + STEP));
        // Yield between chunks so a 400 000-row sheet does not freeze the
        // window for the duration of its own sort.
        await Promise.resolve();
      }
    },
  };
}

/** Parquet: row groups, decoded on demand and cached one at a time by the reader. */
function parquetSource(file: ParquetFile): TableSource {
  return {
    columns: file.columns,
    rows: file.rows,
    parts: [],
    part: 0,
    note: file.createdBy
      ? `${file.groups.length} row group${file.groups.length === 1 ? "" : "s"} · ${file.createdBy.split(" ")[0] ?? ""}`
      : `${file.groups.length} row groups`,
    async choose() { /* one table per file */ },
    async getMany(wanted) {
      if (wanted.length === 0) return [];
      const order = wanted.map((r, i) => ({ r, i })).sort((a, b) => a.r - b.r);
      const out: string[][] = new Array(wanted.length);
      let k = 0;
      while (k < order.length) {
        let j = k;
        // A run is extended while the extra rows are cheaper than another
        // decode — the reader works a row group at a time, so a gap inside one
        // group costs nothing extra.
        while (j + 1 < order.length &&
          (order[j + 1] as { r: number }).r - (order[k] as { r: number }).r < 2000) j++;
        const first = (order[k] as { r: number }).r;
        const lastRow = (order[j] as { r: number }).r;
        const rows = await file.read(first, lastRow - first + 1);
        for (let t = k; t <= j; t++) {
          const item = order[t] as { r: number; i: number };
          out[item.i] = rows[item.r - first] ?? [];
        }
        k = j + 1;
      }
      return out;
    },
    async scan(onRows, cancelled) {
      let at = 0;
      for (const g of file.groups) {
        if (cancelled()) return;
        const rows = await file.read(at, g.rows);
        onRows(at, rows);
        at += g.rows;
      }
    },
  };
}
