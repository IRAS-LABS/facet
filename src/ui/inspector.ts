/**
 * The hex and binary inspector.
 *
 * Tucked away on purpose — Ctrl+Shift+H, or type "hex" in the palette. It is
 * not on the surface because nine people out of ten never want it, and the
 * tenth knows exactly what they are looking for.
 *
 * Three things make it an inspector rather than a dump:
 *
 * It never loads the file. Rows are read in 64 KB windows as you scroll, so a
 * 40 GB disk image opens as fast as a 4 KB one and neither costs more than a
 * few hundred kilobytes of memory. Bytes that have not arrived yet render as
 * dashes rather than as zeroes, because a dump that invents zeroes is a lie
 * told in the one tool people open when they have stopped trusting everything
 * else.
 *
 * It knows what the bytes are for. `@core/inspect/structure` walks the file's
 * real container format, and the result colours the dump and fills the tree on
 * the left. Clicking a region jumps to it.
 *
 * It reads numbers out loud. Every integer width in both byte orders at the
 * cursor, at once — because the entire reason you are staring at hex is that
 * you do not yet know which one it is.
 */

import { structure, type Region, type Structure } from "@core/inspect/structure";
import { formatSize, type FileEntry } from "@core/explorer/types";
import { attachTextZoom } from "@ui/zoom";

export interface InspectHost {
  /** A window of the file. Must clamp at EOF rather than throwing. */
  readRange(path: string, offset: number, len: number): Promise<number[]>;
  readHead(path: string, max: number): Promise<number[]>;
  /** Bytes, and the absolute offset they start at — the tail of a short file
   *  is the whole of it, and guessing that offset from the size is how an
   *  inspector ends up pointing at the wrong byte. */
  readTail(path: string, len: number): Promise<[number[], number]>;
}

/** Bytes per row. Sixteen, because every hex dump ever written uses sixteen. */
const COLS = 16;
/** Read granularity. Big enough that scrolling does not thrash the IPC hop. */
const CHUNK = 64 * 1024;
/** Windows kept before the oldest is dropped — 4 MB of file, at most. */
const CACHE = 64;
/** How much of the front the structure walker gets. */
const STRUCT_HEAD = 4 * 1024 * 1024;
/** And of the back, for the formats that keep their index there. */
const STRUCT_TAIL = 128 * 1024;

const KIND_CLASS: Record<string, string> = {
  header: "k-header", meta: "k-meta", data: "k-data",
  index: "k-index", trailer: "k-trailer", unknown: "k-unknown",
};

export class Inspector {
  private readonly root = document.createElement("div");
  private readonly title = document.createElement("div");
  private readonly tree = document.createElement("div");
  private readonly scroll = document.createElement("div");
  private readonly spacer = document.createElement("div");
  private readonly rowLayer = document.createElement("div");
  private readonly values = document.createElement("div");
  private readonly find = document.createElement("input");
  private readonly goto = document.createElement("input");
  private readonly note = document.createElement("div");
  private readonly keyBox = document.createElement("div");

  private entry: FileEntry | null = null;
  private size = 0;
  private cursor = 0;
  private rowH = 18;

  private readonly chunks = new Map<number, Uint8Array>();
  private readonly inflight = new Set<number>();
  /** Bumped on every open and close so a late read cannot paint stale bytes. */
  private token = 0;

  private struct: Structure = { format: "", regions: [], truncated: false };
  /** Top-level regions sorted by start, for the per-byte lookup. */
  private sorted: Region[] = [];
  /** Resolved once per paint rather than once per byte on screen. */
  private cursorRegion: Region | null = null;
  private searching = false;

  constructor(private readonly host: InspectHost) {
    this.root.className = "hx";
    this.root.hidden = true;

    const bar = document.createElement("div");
    bar.className = "hx-bar";
    this.title.className = "hx-title";

    this.goto.className = "hx-input";
    this.goto.placeholder = "offset — 1024 or 0x400";
    this.goto.spellcheck = false;
    this.goto.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.stopPropagation();
      const at = parseOffset(this.goto.value);
      if (at !== null) this.jump(Math.min(at, Math.max(0, this.size - 1)));
    });

    this.find.className = "hx-input";
    this.find.placeholder = 'find — "PNG" or FF D8 FF';
    this.find.spellcheck = false;
    this.find.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.stopPropagation();
      void this.search(e.shiftKey);
    });

    const close = document.createElement("button");
    close.className = "hx-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());

    bar.append(this.title, this.goto, this.find, close);

    this.tree.className = "hx-tree";

    this.scroll.className = "hx-scroll";
    this.spacer.className = "hx-spacer";
    this.rowLayer.className = "hx-rows";
    this.spacer.append(this.rowLayer);
    this.scroll.append(this.spacer);
    this.scroll.addEventListener("scroll", () => this.paint());

    // Pinch to change the type size. A hex dump on a phone is 16 columns of
    // monospace against a screen 6.7 inches wide, and it was the one document
    // in the app you could open, could not read, and could do nothing about.
    // The font rather than a transform because this view is virtualised: it
    // builds the rows you can see and lies about the rest with a spacer, all
    // from `rowH`, which `measureRow` measures. Grow the type and the measure
    // tells the truth again; scale the layer and it does not.
    attachTextZoom(this.scroll, this.root, {
      remeasure: () => {
        this.measureRow();
        this.spacer.style.height = `${this.spacerHeight()}px`;
        this.paint();
      },
    });

    this.values.className = "hx-values";
    this.note.className = "hx-note";
    this.keyBox.className = "hx-legend";

    const side = document.createElement("div");
    side.className = "hx-side";
    // The legend sits below the note rather than inside it: a search result and
    // a colour key are both wanted at once, and one must not erase the other.
    side.append(this.values, this.note, this.keyBox);

    const main = document.createElement("div");
    main.className = "hx-main";
    main.append(this.tree, this.scroll, side);

    this.root.append(bar, main);
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
    this.chunks.clear();
    this.inflight.clear();
    this.entry = null;
  }

  toggle(entry: FileEntry | undefined): void {
    if (this.isOpen) this.close();
    else if (entry) void this.open(entry);
  }

  async open(entry: FileEntry): Promise<void> {
    if (entry.kind === "folder") return;
    const mine = ++this.token;
    this.entry = entry;
    this.size = entry.size ?? 0;
    this.cursor = 0;
    this.chunks.clear();
    this.inflight.clear();
    this.struct = { format: "", regions: [], truncated: false };
    this.sorted = [];
    this.root.hidden = false;
    this.title.textContent = `${entry.name} — ${formatSize(this.size)} · reading…`;
    this.tree.replaceChildren();
    this.values.replaceChildren();
    this.note.textContent = "";
    this.keyBox.replaceChildren();

    this.measureRow();

    this.spacer.style.height = `${this.spacerHeight()}px`;
    this.scroll.scrollTop = 0;
    this.paint();
    this.scroll.focus();

    await this.walk(mine);
  }

  // ── Structure ─────────────────────────────────────────────────────────────

  private async walk(mine: number): Promise<void> {
    const entry = this.entry;
    if (!entry) return;
    try {
      const head = new Uint8Array(await this.host.readHead(entry.path, Math.min(STRUCT_HEAD, this.size)));
      if (this.token !== mine) return;

      // The tail is only worth an extra hop for the formats that put their
      // index at the end — zip and PDF are read from the back, and asking for
      // 128 KB of every file to find out otherwise is a hop for nothing.
      let tail: { bytes: Uint8Array; offset: number } | undefined;
      const wantsTail = this.size > head.length &&
        (head[0] === 0x50 || String.fromCharCode(...head.slice(0, 5)) === "%PDF-");
      if (wantsTail) {
        const [raw, at] = await this.host.readTail(entry.path, Math.min(STRUCT_TAIL, this.size));
        if (this.token !== mine) return;
        tail = { bytes: new Uint8Array(raw), offset: at };
      }

      this.struct = structure(head, this.size, tail);
      this.sorted = [...this.struct.regions].sort((a, b) => a.start - b.start);

      // A head read is also the cheapest cache fill there is: the first rows
      // are the ones already on screen.
      for (let i = 0; i * CHUNK < head.length; i++) {
        this.chunks.set(i, head.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, head.length)));
      }
    } catch (e) {
      if (this.token !== mine) return;
      this.note.textContent = String(e);
    }
    if (this.token !== mine) return;
    this.title.textContent =
      `${entry.name} — ${formatSize(this.size)}` +
      (this.struct.format ? ` · ${this.struct.format.toUpperCase()}` : " · unrecognised container");
    this.buildTree();
    this.paint();
  }

  private buildTree(): void {
    this.tree.replaceChildren();
    if (this.struct.regions.length === 0) {
      const p = document.createElement("p");
      p.className = "hx-empty";
      // Not a failure. Most files on a disk are in formats nothing has ever
      // written a parser for, and the dump is still the point.
      p.textContent = this.struct.format
        ? "Nothing further to break down."
        : "No structure FACET recognises. The bytes are still all here.";
      this.tree.append(p);
      return;
    }

    const add = (regions: Region[], depth: number, into: HTMLElement): void => {
      for (const r of regions) {
        const row = document.createElement("button");
        row.className = `hx-node ${KIND_CLASS[r.kind] ?? "k-unknown"}`;
        row.style.paddingLeft = `${8 + depth * 12}px`;

        const name = document.createElement("span");
        name.className = "hx-node-name";
        name.textContent = r.name;
        const at = document.createElement("span");
        at.className = "hx-node-at";
        at.textContent = `0x${r.start.toString(16)}`;
        row.append(name, at);

        if (r.note) {
          const note = document.createElement("span");
          note.className = "hx-node-note";
          note.textContent = r.note;
          row.append(note);
        }
        row.addEventListener("click", () => this.jump(r.start));
        into.append(row);
        if (r.children) add(r.children, depth + 1, into);
      }
    };
    add(this.struct.regions, 0, this.tree);
    this.legend();

    if (this.struct.truncated) {
      const p = document.createElement("p");
      p.className = "hx-empty";
      p.textContent = `Walked the first ${formatSize(STRUCT_HEAD)}; the rest of the file was not parsed.`;
      this.tree.append(p);
    }
  }

  /**
   * What the colours in the dump mean.
   *
   * Only the kinds this file actually contains — a key listing six things when
   * four of them are not on screen is a puzzle rather than a legend. Built into
   * the note pane under the readout, which is otherwise empty most of the time.
   */
  private legend(): void {
    const seen = new Map<string, string>();
    const walk = (rs: Region[]): void => {
      for (const r of rs) {
        seen.set(r.kind, KIND_CLASS[r.kind] ?? "k-unknown");
        walk(r.children ?? []);
      }
    };
    walk(this.struct.regions);
    if (seen.size === 0) return;

    const box = document.createDocumentFragment();
    const WORDS: Record<string, string> = {
      header: "structure the format needs to decode at all",
      meta: "metadata — what the file says about itself",
      data: "the content itself",
      index: "an index: where other things live",
      trailer: "the end, and anything riding past it",
      unknown: "unclaimed",
    };
    for (const [kind, cls] of seen) {
      const row = document.createElement("div");
      row.className = `hx-key ${cls}`;
      const dot = document.createElement("i");
      const label = document.createElement("span");
      label.textContent = `${kind} — ${WORDS[kind] ?? ""}`;
      row.append(dot, label);
      box.append(row);
    }
    this.keyBox.replaceChildren(box);
  }

  // ── Bytes ─────────────────────────────────────────────────────────────────

  /** A loaded byte, or -1. Never blocks, never invents. */
  private at(off: number): number {
    const chunk = this.chunks.get(Math.floor(off / CHUNK));
    if (!chunk) return -1;
    const v = chunk[off % CHUNK];
    return v === undefined ? -1 : v;
  }

  private need(from: number, to: number): void {
    const first = Math.floor(from / CHUNK);
    const last = Math.floor(Math.max(from, to - 1) / CHUNK);
    for (let i = first; i <= last; i++) {
      if (this.chunks.has(i) || this.inflight.has(i)) continue;
      this.fetch(i);
    }
  }

  private fetch(index: number): void {
    const entry = this.entry;
    if (!entry) return;
    const mine = this.token;
    this.inflight.add(index);
    const offset = index * CHUNK;
    void this.host
      .readRange(entry.path, offset, Math.min(CHUNK, this.size - offset))
      .then((bytes) => {
        if (this.token !== mine) return;
        this.chunks.set(index, new Uint8Array(bytes));
        // Oldest-first eviction. A hex inspector is scrolled, not queried at
        // random, so insertion order is a good enough guess at what is cold.
        while (this.chunks.size > CACHE) {
          const oldest = this.chunks.keys().next().value;
          if (oldest === undefined) break;
          this.chunks.delete(oldest);
        }
        this.paint();
      })
      .catch((e: unknown) => {
        if (this.token === mine) this.note.textContent = String(e);
      })
      .finally(() => this.inflight.delete(index));
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  /**
   * How tall the scroll spacer is allowed to get.
   *
   * A browser silently clamps an element somewhere north of 33 million pixels,
   * and one pixel of clamping means the bottom of the file becomes unreachable
   * — the scrollbar hits the end while the dump is still in the middle. At 18
   * pixels a row that ceiling arrives at about a 30 MB file, which is nothing.
   * So past this point the bar stops being one-pixel-per-row and becomes a
   * proportion of the file, which is what a scrollbar on a 40 GB disk image was
   * always going to be.
   */
  private spacerHeight(): number {
    return Math.min(Math.ceil(this.size / COLS) * this.rowH, 20_000_000);
  }

  /** Rows that fit, floored at one so the arithmetic below cannot divide by nothing. */
  private pageRows(): number {
    return Math.max(1, Math.floor(this.scroll.clientHeight / this.rowH));
  }

  /**
   * The first row to draw for the current scroll position.
   *
   * Expressed as a fraction rather than as `scrollTop / rowH` so that it stays
   * correct on both sides of the clamp above. For any file small enough not to
   * be clamped the two are the same number.
   */
  private firstRow(): number {
    const total = Math.ceil(this.size / COLS);
    const span = Math.max(0, this.spacerHeight() - this.scroll.clientHeight);
    if (span <= 0) return 0;
    const frac = Math.min(1, Math.max(0, this.scroll.scrollTop / span));
    return Math.round(frac * Math.max(0, total - this.pageRows()));
  }

  /**
   * Ask the stylesheet how tall a row is.
   *
   * Row height comes from the stylesheet, not from a constant here, so a theme
   * that changes the monospace size -- or a pinch, which changes it by the
   * `--zoom` multiplier -- does not desynchronise the virtual scroll from what
   * is actually on screen. Everything else in this view is derived from the
   * number this measures, which is why the zoom can be a font size and does
   * not have to be a transform.
   */
  private measureRow(): void {
    this.rowLayer.style.transform = "translateY(0)";
    const probe = document.createElement("div");
    probe.className = "hx-row";
    probe.textContent = "0";
    this.rowLayer.append(probe);
    this.rowH = probe.getBoundingClientRect().height || 18;
    probe.remove();
  }

  private paint(): void {
    if (!this.isOpen || !this.entry) return;
    const total = Math.ceil(this.size / COLS);
    const first = this.firstRow();
    const pad = Math.min(2, first);
    const from = first - pad;
    const last = Math.min(total, first + this.pageRows() + 2);
    this.cursorRegion = this.regionAt(this.cursor);

    this.need(from * COLS, last * COLS);
    // Rows are pinned to the viewport, not to the spacer, because on a clamped
    // spacer a row's pixel position and its offset in the file are no longer
    // the same thing.
    this.rowLayer.style.transform = `translateY(${this.scroll.scrollTop - pad * this.rowH}px)`;

    const rows: HTMLElement[] = [];
    for (let r = from; r < last; r++) rows.push(this.row(r * COLS));
    this.rowLayer.replaceChildren(...rows);
    this.paintValues();
  }

  private row(base: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "hx-row";

    const off = document.createElement("span");
    off.className = "hx-off";
    off.textContent = base.toString(16).padStart(8, "0");

    const hex = document.createElement("span");
    hex.className = "hx-hex";
    const asc = document.createElement("span");
    asc.className = "hx-asc";

    for (let i = 0; i < COLS; i++) {
      const at = base + i;
      if (at >= this.size) break;
      const v = this.at(at);
      const region = this.regionAt(at);
      const cls = KIND_CLASS[region?.kind ?? "unknown"] ?? "k-unknown";
      // Every byte of the region the cursor is in, lit at once. Without it the
      // tree and the dump are two lists that happen to be next to each other;
      // with it you can see where a segment starts and stops.
      const here = region && region === this.cursorRegion ? " is-inregion" : "";
      const sel = at === this.cursor ? " is-cursor" : here;

      const h = document.createElement("i");
      h.className = `${cls}${sel}`;
      h.textContent = v < 0 ? "--" : v.toString(16).padStart(2, "0");
      // The gutter between the eighth and ninth byte is the one visual aid a
      // dump genuinely needs; it is how you count to eleven without counting.
      if (i === 8) h.classList.add("hx-gap");
      h.addEventListener("mousedown", () => this.setCursor(at));
      hex.append(h);

      const a = document.createElement("i");
      a.className = `${cls}${sel}`;
      a.textContent = v < 0 ? " " : v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "·";
      a.addEventListener("mousedown", () => this.setCursor(at));
      asc.append(a);
    }
    row.append(off, hex, asc);
    return row;
  }

  /** The deepest named region covering an offset. */
  private regionAt(off: number): Region | null {
    let lo = 0;
    let hi = this.sorted.length - 1;
    let found: Region | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.sorted[mid] as Region;
      if (off < r.start) hi = mid - 1;
      else if (off >= r.end) lo = mid + 1;
      else { found = r; break; }
    }
    if (!found) return null;
    let node = found;
    for (;;) {
      const kid = node.children?.find((c) => off >= c.start && off < c.end);
      if (!kid) return node;
      node = kid;
    }
  }

  private setCursor(off: number): void {
    this.cursor = Math.max(0, Math.min(off, Math.max(0, this.size - 1)));
    this.paint();
  }

  /** Move the cursor and bring it on screen, centring only when it is not. */
  private jump(off: number): void {
    this.cursor = Math.max(0, Math.min(off, Math.max(0, this.size - 1)));
    const row = Math.floor(this.cursor / COLS);
    const first = this.firstRow();
    const rows = this.pageRows();
    if (row < first + 1 || row > first + rows - 2) {
      const total = Math.ceil(this.size / COLS);
      const want = Math.max(0, row - Math.floor(rows / 2));
      const span = Math.max(0, this.spacerHeight() - this.scroll.clientHeight);
      const reach = Math.max(1, total - rows);
      this.scroll.scrollTop = Math.min(span, (want / reach) * span);
    }
    this.paint();
  }

  // ── The readout ───────────────────────────────────────────────────────────

  private paintValues(): void {
    const b: number[] = [];
    for (let i = 0; i < 8; i++) b.push(this.at(this.cursor + i));
    const have = (n: number): boolean => b.slice(0, n).every((v) => v >= 0 && this.cursor + n <= this.size);

    const dv = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) dv.setUint8(i, Math.max(0, b[i] ?? 0));

    const rows: Array<[string, string]> = [
      ["Offset", `${this.cursor}  ·  0x${this.cursor.toString(16)}`],
    ];
    const region = this.regionAt(this.cursor);
    if (region) {
      rows.push(["In", `${region.name}  ·  +${this.cursor - region.start}`]);
    }
    if (have(1)) {
      rows.push(["u8 / i8", `${dv.getUint8(0)} / ${dv.getInt8(0)}`]);
      rows.push(["binary", dv.getUint8(0).toString(2).padStart(8, "0")]);
    }
    if (have(2)) {
      rows.push(["u16 LE / BE", `${dv.getUint16(0, true)} / ${dv.getUint16(0)}`]);
      rows.push(["i16 LE / BE", `${dv.getInt16(0, true)} / ${dv.getInt16(0)}`]);
    }
    if (have(4)) {
      rows.push(["u32 LE / BE", `${dv.getUint32(0, true)} / ${dv.getUint32(0)}`]);
      rows.push(["i32 LE / BE", `${dv.getInt32(0, true)} / ${dv.getInt32(0)}`]);
      rows.push(["f32 LE / BE", `${num(dv.getFloat32(0, true))} / ${num(dv.getFloat32(0))}`]);
      // A plausible Unix time is worth calling out: a 32-bit field that lands
      // inside the last few decades is almost never a coincidence, and it is
      // the single most common thing anyone is hunting for in a binary.
      const t = unixTime(dv.getUint32(0, true)) ?? unixTime(dv.getUint32(0));
      if (t) rows.push(["as a date", t]);
    }
    if (have(8)) {
      rows.push(["u64 LE", dv.getBigUint64(0, true).toString()]);
      rows.push(["f64 LE", num(dv.getFloat64(0, true))]);
    }

    const dl = document.createElement("dl");
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }
    this.values.replaceChildren(dl);
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Find the next occurrence, streaming rather than loading.
   *
   * The window overlaps by the pattern length so a match that straddles a
   * window boundary is still found — the bug every from-scratch search has
   * the first time, and the one that makes it quietly useless rather than
   * obviously broken.
   */
  private async search(backwards: boolean): Promise<void> {
    const entry = this.entry;
    const pat = parsePattern(this.find.value);
    if (!entry || !pat || pat.length === 0 || this.searching) return;
    const mine = this.token;
    this.searching = true;
    this.note.textContent = "Searching…";

    const WINDOW = 1 << 20;
    try {
      if (!backwards) {
        for (let at = this.cursor + 1; at < this.size; at += WINDOW) {
          const len = Math.min(WINDOW + pat.length - 1, this.size - at);
          const buf = new Uint8Array(await this.host.readRange(entry.path, at, len));
          if (this.token !== mine) return;
          const hit = indexOf(buf, pat, 0);
          if (hit >= 0) { this.found(at + hit, pat.length); return; }
        }
      } else {
        for (let end = this.cursor; end > 0; end -= WINDOW) {
          const from = Math.max(0, end - WINDOW);
          const buf = new Uint8Array(await this.host.readRange(entry.path, from, end - from + pat.length - 1));
          if (this.token !== mine) return;
          const hit = lastIndexOf(buf, pat, Math.min(buf.length, end - from) - 1);
          if (hit >= 0) { this.found(from + hit, pat.length); return; }
        }
      }
      this.note.textContent = backwards ? "No earlier match." : "No further match.";
    } catch (e) {
      this.note.textContent = String(e);
    } finally {
      this.searching = false;
    }
  }

  private found(at: number, len: number): void {
    this.note.textContent = `Match at 0x${at.toString(16)} (${len} bytes). Enter for the next, Shift+Enter back.`;
    this.jump(at);
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  /** Returns true when it consumed the key. */
  key(e: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    const target = e.target as HTMLElement | null;
    if (target === this.find || target === this.goto) {
      if (e.key === "Escape") { target.blur(); return true; }
      return false;
    }
    const rows = Math.max(1, Math.floor(this.scroll.clientHeight / this.rowH) - 1);
    switch (e.key) {
      case "Escape": this.close(); return true;
      case "ArrowRight": this.jump(this.cursor + 1); return true;
      case "ArrowLeft": this.jump(this.cursor - 1); return true;
      case "ArrowDown": this.jump(this.cursor + COLS); return true;
      case "ArrowUp": this.jump(this.cursor - COLS); return true;
      case "PageDown": this.jump(this.cursor + rows * COLS); return true;
      case "PageUp": this.jump(this.cursor - rows * COLS); return true;
      case "Home": this.jump(0); return true;
      case "End": this.jump(this.size - 1); return true;
      case "/": this.find.focus(); this.find.select(); return true;
      case "g": case "G": this.goto.focus(); this.goto.select(); return true;
      case "n": case "N": void this.search(e.shiftKey); return true;
      default: return false;
    }
  }
}

// ── Parsing the two inputs ──────────────────────────────────────────────────

/** `0x400`, `1024`, or `+16`/`-16` relative to nothing — plain numbers only. */
function parseOffset(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = /^0x/i.test(t) ? Number.parseInt(t.slice(2), 16) : Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * A quoted string is text; anything else is hex.
 *
 * Guessing between the two by whether the input happens to parse as hex would
 * make `"face"` — a real word, and four valid hex digits — mean something
 * different from what was typed. The quotes decide.
 */
function parsePattern(s: string): Uint8Array | null {
  const t = s.trim();
  if (!t) return null;
  const quoted = /^"(.*)"$/.exec(t) ?? /^'(.*)'$/.exec(t);
  if (quoted) {
    return new TextEncoder().encode(quoted[1] ?? "");
  }
  // `FF D8 FF`, `ffd8ff`, `0xFF,0xD8` — all the ways people paste bytes.
  const clean = t.replace(/0[xX]/g, "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length < 2) return null;
  const even = clean.length % 2 === 0 ? clean : clean.slice(0, -1);
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(even.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const n = needle.length;
  outer: for (let i = from; i + n <= hay.length; i++) {
    for (let k = 0; k < n; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const n = needle.length;
  outer: for (let i = Math.min(from, hay.length - n); i >= 0; i--) {
    for (let k = 0; k < n; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/** Short, readable floats — 17 significant digits is not a readout. */
function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  return a >= 1e-4 && a < 1e9 ? String(Number(v.toPrecision(7))) : v.toExponential(4);
}

/** A 32-bit value read as seconds since 1970, if that lands somewhere sane. */
function unixTime(v: number): string | null {
  if (v < 631152000 || v > 2524608000) return null; // 1990 … 2050
  return new Date(v * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
