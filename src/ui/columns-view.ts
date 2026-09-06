/**
 * Miller columns (item 34).
 *
 * The list answers "what is in this folder", the gallery answers "what does
 * this folder look like", and neither of them answers "where am I". That is
 * what this is for: one column per folder, walking left to right, so the path
 * you took is on screen instead of in a breadcrumb you have to read. Picking a
 * folder does not *go* there — it opens it to the right, which is the whole
 * trick. You can look three folders deep and come back by moving your eyes.
 *
 * Three things are worth knowing before editing this file:
 *
 *  1. **The shell does the listing.** `onList(path)` hands back entries already
 *     sorted, filtered and hidden-stripped exactly as the current folder's were,
 *     because a column that sorted differently from the folder it came from
 *     would be a bug nobody could describe. The view never touches the
 *     filesystem and never reads a setting to decide what to show.
 *  2. **Every column is virtualised**, on the same arithmetic as the list: fixed
 *     row height, a spacer of the full height, and only the visible slice in the
 *     DOM. A column is *more* likely to be enormous than the main folder is —
 *     stepping into `node_modules` by accident should cost forty rows, not forty
 *     thousand.
 *  3. **A stale listing must never land in a live column.** Every load carries a
 *     token; by the time a slow network folder answers, the user has usually
 *     picked something else, and the check is what stops the answer to a
 *     question nobody is asking any more from overwriting the one they are.
 */

import { facts, kindLabel } from "@core/explorer/fields";
import type { FileEntry, Preview, ViewConfig } from "@core/explorer/types";
import {
  acceptDrops,
  beginDrag,
  dragGhost,
  endDrag,
  osDrag,
  type DropEffect,
} from "./dnd";

/** Row height in px. Fixed — the virtualiser is arithmetic, not measurement. */
const ROW = 24;

/** Rows built above and below each column's viewport so scrolling shows no gap. */
const OVERSCAN = 8;

/** Column width bounds, derived from the shared card size. */
const COL_MIN = 170;
const COL_MAX = 400;

/** How much of a peek pane is worth showing. Wider than a column, narrower than the list's. */
const PEEK_W = 300;

/** Card-size bounds for the zoom keys. Shared with the gallery on purpose. */
const SIZE_MIN = 96;
const SIZE_MAX = 420;

const GLYPHS: Record<string, string> = {
  folder: "▤", image: "▦", video: "▶", audio: "◍", document: "▤",
  tabular: "▩", model3d: "◈", archive: "▣", code: "‹›", binary: "⬡",
};

/** Kinds whose row icon is worth a decode at 16 px. */
const THUMBABLE = new Set(["image", "video"]);

export interface ColumnsCallbacks {
  onOpen(entry: FileEntry): void;
  onSelect(entries: FileEntry[]): void;
  /** Row-level ask: cheap kinds only. */
  onWantPreview?(entry: FileEntry): void;
  /** Peek-level ask: always made for the file that is showing. */
  onWantFullPreview?(entry: FileEntry): void;
  onMenu?(entry: FileEntry | null, x: number, y: number): void;
  /**
   * Files were dropped on a folder (item 6). Every column is a drop target of
   * its own, which is what this view is *for*: the folder you are dropping
   * into is three columns back and still on screen, so you never have to
   * navigate away from where the files are to reach where they are going.
   */
  onDrop?(paths: readonly string[], to: string, effect: DropEffect): void;
  /** New card size after a zoom key, for the shell to remember. */
  onResize?(px: number): void;
  /**
   * The folder the shell is showing, which is the first column's own path.
   * Asked rather than passed because `setEntries` is called from three places
   * and every one of them would have had to remember to say where it was.
   */
  cwd(): string;
  /**
   * Children of `path`, shaped the same way the current folder was.
   * Rejecting is normal — a folder can be unreadable — and shows as a note in
   * the column rather than an error anywhere else.
   */
  onList(path: string): Promise<FileEntry[]>;
}

interface Col {
  path: string;
  entries: FileEntry[];
  sel: Set<string>;
  /** Index of the row keys move from. -1 when nothing is picked yet. */
  cursor: number;
  /** Identifies the load this column is waiting for. 0 once it has landed. */
  token: number;
  el: HTMLElement;
  scroll: HTMLElement;
  spacer: HTMLElement;
  note: HTMLElement;
  mounted: Map<number, HTMLElement>;
}

export class ColumnsView {
  readonly #cb: ColumnsCallbacks;

  readonly #root: HTMLElement;
  readonly #scroll: HTMLElement;

  #cfg: ViewConfig;
  #cols: Col[] = [];
  #active = 0;
  #peek: HTMLElement | null = null;

  /** Paths already asked about, so a preview that came back "none" is not re-asked forever. */
  readonly #asked = new Set<string>();
  readonly #askedFull = new Set<string>();

  /** Monotonic, so a token is never reused. */
  #seq = 0;
  /** A column index waiting to be focused the moment its listing lands. */
  #pendingFocus: number | null = null;

  readonly #onKey = (ev: KeyboardEvent): void => this.#key(ev);

  constructor(host: HTMLElement, cfg: ViewConfig, cb: ColumnsCallbacks) {
    this.#cb = cb;
    this.#cfg = cfg;

    this.#root = document.createElement("div");
    this.#root.className = "cv";

    this.#scroll = document.createElement("div");
    this.#scroll.className = "cv-scroll";
    this.#root.appendChild(this.#scroll);

    this.#root.addEventListener("keydown", this.#onKey);
    host.appendChild(this.#root);
    this.#applyWidth();
  }

  // ── Shell-facing API ──────────────────────────────────────────────────────

  setConfig(cfg: ViewConfig): void {
    this.#cfg = cfg;
    this.#applyWidth();
  }

  /**
   * The shell moved, sorted or filtered. Either way the walk starts over: the
   * columns to the right describe folders reached from a listing that no longer
   * exists, and keeping them would leave a trail that does not lead anywhere.
   */
  setEntries(entries: FileEntry[]): void {
    for (const c of this.#cols) c.el.remove();
    this.#cols = [];
    this.#dropPeek();
    this.#asked.clear();
    this.#askedFull.clear();
    this.#pendingFocus = null;
    this.#active = 0;
    const root = this.#addColumn(this.#cb.cwd());
    this.#fill(root, entries);
  }

  /** The shell's idea of the selection, applied to the root column only. */
  selectPaths(paths: readonly string[]): void {
    const c = this.#cols[0];
    if (c === undefined) return;
    this.#truncate(0);
    c.sel = new Set(paths);
    c.cursor = c.entries.findIndex((e) => c.sel.has(e.path));
    this.#paint(c);
    this.#scrollCursorIntoView(c);
  }

  /** A preview landed for one file. Repaint wherever that file is showing. */
  refresh(path: string): void {
    for (const c of this.#cols) {
      const i = c.entries.findIndex((e) => e.path === path);
      if (i < 0) continue;
      const el = c.mounted.get(i);
      if (el !== undefined) {
        const fresh = this.#row(c, i);
        el.replaceWith(fresh);
        c.mounted.set(i, fresh);
      }
    }
    if (this.#peek?.dataset["path"] === path) this.#drawPeek();
  }

  focus(): void {
    (this.#cols[this.#active] ?? this.#cols[0])?.el.focus();
  }

  destroy(): void {
    this.#root.removeEventListener("keydown", this.#onKey);
    this.#root.remove();
  }

  // ── Geometry ──────────────────────────────────────────────────────────────

  /**
   * Columns take their width from the same card-size setting the gallery and
   * the canvas use, so one zoom key means one thing everywhere. Clamped: below
   * the floor a name is unreadable, above the ceiling you can only see two
   * folders at once and the whole point was seeing several.
   */
  #width(): number {
    return Math.max(COL_MIN, Math.min(COL_MAX, Math.round(this.#cfg.cardSize * 1.25)));
  }

  #applyWidth(): void {
    this.#root.style.setProperty("--cv-col", `${this.#width()}px`);
    this.#root.style.setProperty("--cv-peek", `${PEEK_W}px`);
  }

  // ── Columns ───────────────────────────────────────────────────────────────

  #addColumn(path: string): Col {
    const el = document.createElement("div");
    el.className = "cv-col";
    el.tabIndex = 0;

    const head = document.createElement("div");
    head.className = "cv-head";
    head.textContent = folderName(path);
    head.title = path;
    el.appendChild(head);

    const scroll = document.createElement("div");
    scroll.className = "cv-list";
    const spacer = document.createElement("div");
    spacer.className = "cv-spacer";
    scroll.appendChild(spacer);
    el.appendChild(scroll);

    const note = document.createElement("p");
    note.className = "cv-note";
    note.textContent = "Reading…";
    el.appendChild(note);

    const col: Col = {
      path,
      entries: [],
      sel: new Set(),
      cursor: -1,
      token: 0,
      el,
      scroll,
      spacer,
      note,
      mounted: new Map(),
    };

    scroll.addEventListener("scroll", () => this.#draw(col), { passive: true });
    el.addEventListener("mousedown", (ev) => this.#down(col, ev));
    el.addEventListener("dblclick", (ev) => this.#dbl(col, ev));
    el.addEventListener("contextmenu", (ev) => this.#menu(col, ev));
    el.addEventListener("dragstart", (ev) => this.#onDragStart(col, ev));
    el.addEventListener("dragend", () => endDrag());
    // No teardown kept: these listeners are on the column's own element, and
    // `#truncate` drops the element entirely rather than reusing it.
    acceptDrops(el, {
      folderAt: (ev) => this.#folderAt(col, ev),
      mark: (path) => this.#markDrop(col, path),
      run: (paths, to, effect) => this.#cb.onDrop?.(paths, to, effect),
    });
    el.addEventListener("focusin", () => {
      this.#active = this.#cols.indexOf(col);
    });

    this.#scroll.insertBefore(el, this.#peek);
    this.#cols.push(col);
    return col;
  }

  #fill(col: Col, entries: FileEntry[]): void {
    col.entries = entries;
    col.token = 0;
    col.note.textContent = entries.length === 0 ? "Empty folder" : "";
    col.note.hidden = entries.length > 0;
    col.spacer.style.height = `${entries.length * ROW}px`;
    for (const el of col.mounted.values()) el.remove();
    col.mounted.clear();
    this.#draw(col);
  }

  /** Drop every column to the right of `index`, and the peek with them. */
  #truncate(index: number): void {
    while (this.#cols.length > index + 1) {
      const c = this.#cols.pop();
      c?.el.remove();
    }
    this.#dropPeek();
    if (this.#active > index) this.#active = index;
  }

  /**
   * Open `entry` in the column to the right. The column appears immediately,
   * saying it is reading, because a folder on a slow disk that produced nothing
   * for two seconds reads as a click that did not register.
   */
  #openChild(parent: number, entry: FileEntry): void {
    this.#truncate(parent);
    const col = this.#addColumn(entry.path);
    const token = ++this.#seq;
    col.token = token;
    const index = this.#cols.length - 1;
    this.#scroll.scrollLeft = this.#scroll.scrollWidth;

    void this.#cb
      .onList(entry.path)
      .then((entries) => {
        if (col.token !== token || this.#cols[index] !== col) return;
        this.#fill(col, entries);
        if (this.#pendingFocus === index) {
          this.#pendingFocus = null;
          this.#step(col, 0);
          col.el.focus();
        }
      })
      .catch((e: unknown) => {
        if (col.token !== token || this.#cols[index] !== col) return;
        col.token = 0;
        col.note.hidden = false;
        col.note.textContent = String(e);
      });
  }

  // ── Rows ──────────────────────────────────────────────────────────────────

  #draw(col: Col): void {
    const h = col.scroll.clientHeight || 400;
    const top = col.scroll.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const last = Math.min(col.entries.length - 1, Math.ceil((top + h) / ROW) + OVERSCAN);

    for (const [i, el] of col.mounted) {
      if (i < first || i > last) {
        el.remove();
        col.mounted.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (col.mounted.has(i)) continue;
      const el = this.#row(col, i);
      col.spacer.appendChild(el);
      col.mounted.set(i, el);
    }
  }

  #row(col: Col, i: number): HTMLElement {
    const e = col.entries[i]!;
    const el = document.createElement("div");
    el.className = "cv-row";
    el.draggable = true;
    el.style.top = `${i * ROW}px`;
    el.dataset["path"] = e.path;
    el.dataset["kind"] = e.kind;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", col.sel.has(e.path) ? "true" : "false");
    if (col.cursor === i) el.dataset["cursor"] = "1";

    const icon = document.createElement("span");
    icon.className = "cv-icon";
    const url = thumbUrl(e.preview) ?? e.thumb;
    if (url !== undefined) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.decoding = "async";
      // See the gallery: a broken-image icon reads as a corrupt file, which is
      // a much stronger claim than "this thumbnail did not load".
      img.addEventListener("error", () => {
        img.remove();
        icon.textContent = GLYPHS[e.kind] ?? "⬡";
      }, { once: true });
      icon.appendChild(img);
    } else {
      icon.textContent = GLYPHS[e.kind] ?? "⬡";
      if (THUMBABLE.has(e.kind) && !this.#asked.has(e.path)) {
        this.#asked.add(e.path);
        this.#cb.onWantPreview?.(e);
      }
    }
    el.appendChild(icon);

    const nm = document.createElement("span");
    nm.className = "cv-nm";
    nm.textContent = e.name;
    nm.title = e.name;
    el.appendChild(nm);

    if (e.kind === "folder") {
      const chev = document.createElement("span");
      chev.className = "cv-chev";
      chev.textContent = "›";
      el.appendChild(chev);
    }
    return el;
  }

  #paint(col: Col): void {
    for (const [i, el] of col.mounted) {
      const e = col.entries[i];
      if (e === undefined) continue;
      el.setAttribute("aria-selected", col.sel.has(e.path) ? "true" : "false");
      if (col.cursor === i) el.dataset["cursor"] = "1";
      else delete el.dataset["cursor"];
    }
  }

  // ── Choosing ──────────────────────────────────────────────────────────────

  /**
   * Pick row `i` in `col`. Everything that makes this view what it is happens
   * here: picking narrows the walk to this column, and a single folder picked
   * opens to the right while a single file shows itself in a peek. A
   * multi-selection does neither, because "which of these five should the next
   * column show" has no answer.
   */
  #choose(col: Col, i: number, mode: "set" | "toggle" | "range"): void {
    const e = col.entries[i];
    if (e === undefined) return;
    const index = this.#cols.indexOf(col);
    this.#truncate(index);

    if (mode === "toggle") {
      if (col.sel.has(e.path)) col.sel.delete(e.path);
      else col.sel.add(e.path);
    } else if (mode === "range" && col.cursor >= 0) {
      const [a, b] = col.cursor < i ? [col.cursor, i] : [i, col.cursor];
      col.sel = new Set();
      for (let k = a; k <= b; k++) col.sel.add(col.entries[k]!.path);
    } else {
      col.sel = new Set([e.path]);
    }
    col.cursor = i;
    this.#paint(col);
    this.#tell(col);

    if (col.sel.size === 1 && col.sel.has(e.path)) {
      if (e.kind === "folder") this.#openChild(index, e);
      else this.#showPeek(e);
    }
  }

  /** Move the cursor by `d` rows, or to an absolute row when `abs` is given. */
  #step(col: Col, abs: number, d = 0): void {
    if (col.entries.length === 0) return;
    const from = col.cursor < 0 ? 0 : col.cursor;
    const to = Math.max(0, Math.min(col.entries.length - 1, d === 0 ? abs : from + d));
    this.#choose(col, to, "set");
    this.#scrollCursorIntoView(col);
  }

  #scrollCursorIntoView(col: Col): void {
    if (col.cursor < 0) return;
    const y = col.cursor * ROW;
    const h = col.scroll.clientHeight || 400;
    if (y < col.scroll.scrollTop) col.scroll.scrollTop = y;
    else if (y + ROW > col.scroll.scrollTop + h) col.scroll.scrollTop = y + ROW - h;
    this.#draw(col);
    this.#paint(col);
    col.el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  #tell(col: Col): void {
    this.#cb.onSelect(col.entries.filter((e) => col.sel.has(e.path)));
  }

  // ── The peek ──────────────────────────────────────────────────────────────

  #dropPeek(): void {
    this.#peek?.remove();
    this.#peek = null;
  }

  #showPeek(e: FileEntry): void {
    this.#dropPeek();
    const el = document.createElement("div");
    el.className = "cv-peek";
    el.dataset["path"] = e.path;
    this.#peek = el;
    this.#scroll.appendChild(el);
    this.#drawPeek();
    if (!this.#askedFull.has(e.path)) {
      this.#askedFull.add(e.path);
      this.#cb.onWantFullPreview?.(e);
    }
    this.#scroll.scrollLeft = this.#scroll.scrollWidth;
  }

  #drawPeek(): void {
    const el = this.#peek;
    if (el === null) return;
    const path = el.dataset["path"];
    let entry: FileEntry | undefined;
    for (const c of this.#cols) {
      const hit = c.entries.find((x) => x.path === path);
      if (hit !== undefined) entry = hit;
    }
    if (entry === undefined) return;
    el.textContent = "";

    const face = document.createElement("div");
    face.className = "cv-face";
    const url = thumbUrl(entry.preview);
    if (url !== undefined) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = entry.name;
      const kind = entry.kind;
      img.addEventListener("error", () => {
        const g = document.createElement("span");
        g.className = "cv-face-glyph";
        g.textContent = GLYPHS[kind] ?? "⬡";
        img.replaceWith(g);
      }, { once: true });
      face.appendChild(img);
    } else if (entry.preview?.type === "text") {
      const pre = document.createElement("pre");
      pre.className = "cv-text";
      pre.textContent = entry.preview.lines.slice(0, 40).join("\n");
      face.appendChild(pre);
    } else {
      const g = document.createElement("span");
      g.className = "cv-face-glyph";
      g.textContent = GLYPHS[entry.kind] ?? "⬡";
      face.appendChild(g);
      if (entry.preview?.type === "none") {
        const why = document.createElement("span");
        why.className = "cv-why";
        why.textContent = entry.preview.reason;
        face.appendChild(why);
      }
    }
    el.appendChild(face);

    const nm = document.createElement("p");
    nm.className = "cv-peek-name";
    nm.textContent = entry.name;
    nm.title = entry.path;
    el.appendChild(nm);

    const dl = document.createElement("dl");
    dl.className = "cv-facts";
    for (const [k, v] of facts(entry)) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }
    el.appendChild(dl);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "cv-open";
    open.textContent = `Open this ${kindLabel(entry).toLowerCase()}`;
    open.addEventListener("click", () => {
      this.#cb.onOpen(entry);
    });
    el.appendChild(open);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  #hit(col: Col, ev: MouseEvent): number {
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".cv-row");
    if (row === null || row === undefined) return -1;
    const path = row.dataset["path"];
    return col.entries.findIndex((e) => e.path === path);
  }

  #down(col: Col, ev: MouseEvent): void {
    if (ev.button !== 0) return;
    const i = this.#hit(col, ev);
    if (i < 0) {
      // Empty space below the rows clears this column, which also drops
      // everything the old selection had opened to the right of it.
      this.#truncate(this.#cols.indexOf(col));
      col.sel = new Set();
      this.#paint(col);
      this.#tell(col);
      return;
    }
    this.#choose(col, i, ev.ctrlKey || ev.metaKey ? "toggle" : ev.shiftKey ? "range" : "set");
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  /**
   * Same rule as the list and the gallery: a row outside this column's
   * selection becomes the selection first, and one inside it takes the whole
   * selection along. The source folder is the column's own path — not the
   * shell's `cwd()` — because in this view they are routinely different, and
   * that is the value that decides move-versus-copy.
   */
  #onDragStart(col: Col, ev: DragEvent): void {
    const i = this.#hit(col, ev);
    if (i < 0) {
      ev.preventDefault();
      return;
    }
    const entry = col.entries[i]!;
    if (!col.sel.has(entry.path)) this.#choose(col, i, "set");
    const paths = col.entries.filter((e) => col.sel.has(e.path)).map((e) => e.path);
    beginDrag(paths, col.path);

    // Item 9. See the long note in `ListView#onDragStart` for why the HTML5
    // drag is cancelled rather than run alongside.
    const os = osDrag();
    if (os !== null) {
      ev.preventDefault();
      os(paths);
      return;
    }

    if (ev.dataTransfer !== null) {
      ev.dataTransfer.effectAllowed = "copyMove";
      ev.dataTransfer.setData("text/plain", paths.join("\n"));
    }
    dragGhost(ev, entry.name, paths.length);
  }

  /** A folder row takes the drop; anything else falls to the column itself. */
  #folderAt(col: Col, ev: DragEvent): string | null {
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".cv-row");
    if (row !== null && row !== undefined && row.dataset["kind"] === "folder") {
      return row.dataset["path"] ?? null;
    }
    return col.path;
  }

  #markDrop(col: Col, path: string | null): void {
    const here = path !== null && path === col.path;
    if (here) col.scroll.dataset["drop"] = "1";
    else delete col.scroll.dataset["drop"];
    // The mounted rows, not the entries: the virtualiser owns which exist.
    for (const node of col.mounted.values()) {
      if (!here && path !== null && node.dataset["path"] === path) {
        node.dataset["drop"] = "1";
      } else delete node.dataset["drop"];
    }
  }

  #dbl(col: Col, ev: MouseEvent): void {
    const i = this.#hit(col, ev);
    const e = col.entries[i];
    if (e !== undefined) this.#cb.onOpen(e);
  }

  #menu(col: Col, ev: MouseEvent): void {
    if (this.#cb.onMenu === undefined) return;
    ev.preventDefault();
    const i = this.#hit(col, ev);
    const e = col.entries[i];
    // Right-clicking inside a selection acts on all of it; right-clicking
    // outside one makes what you clicked the selection first.
    if (e !== undefined && !col.sel.has(e.path)) this.#choose(col, i, "set");
    this.#cb.onMenu(e ?? null, ev.clientX, ev.clientY);
  }

  #key(ev: KeyboardEvent): void {
    const col = this.#cols[this.#active];
    if (col === undefined) return;
    const index = this.#active;

    switch (ev.key) {
      case "ArrowDown":
        this.#step(col, 0, 1);
        break;
      case "ArrowUp":
        this.#step(col, 0, -1);
        break;
      case "PageDown":
        this.#step(col, 0, Math.max(1, Math.floor((col.scroll.clientHeight || 400) / ROW) - 1));
        break;
      case "PageUp":
        this.#step(col, 0, -Math.max(1, Math.floor((col.scroll.clientHeight || 400) / ROW) - 1));
        break;
      case "Home":
        this.#step(col, 0);
        break;
      case "End":
        this.#step(col, col.entries.length - 1);
        break;
      case "ArrowRight": {
        const child = this.#cols[index + 1];
        if (child === undefined) break;
        if (child.token !== 0) {
          // Still reading. Remember that the keyboard is waiting for it, so the
          // walk carries on by itself instead of needing the key pressed twice.
          this.#pendingFocus = index + 1;
          break;
        }
        this.#active = index + 1;
        this.#step(child, 0);
        child.el.focus();
        break;
      }
      case "ArrowLeft": {
        const parent = this.#cols[index - 1];
        if (parent === undefined) break;
        this.#active = index - 1;
        parent.el.focus();
        break;
      }
      case "Enter": {
        const e = col.entries[col.cursor];
        if (e !== undefined) this.#cb.onOpen(e);
        break;
      }
      case "a":
        if (!(ev.ctrlKey || ev.metaKey)) return;
        this.#truncate(index);
        col.sel = new Set(col.entries.map((e) => e.path));
        this.#paint(col);
        this.#tell(col);
        break;
      // The same card size the gallery and the canvas zoom, in the same steps,
      // clamped to the same range — one setting, so one pair of keys.
      case "+":
      case "=":
        this.#cb.onResize?.(Math.min(SIZE_MAX, this.#cfg.cardSize + 24));
        break;
      case "-":
        this.#cb.onResize?.(Math.max(SIZE_MIN, this.#cfg.cardSize - 24));
        break;
      default:
        return;
    }
    ev.preventDefault();
  }
}

/** The thumbnail inside a preview, if that preview is a picture at all. */
function thumbUrl(p: Preview | undefined): string | undefined {
  if (p === undefined) return undefined;
  if (p.type === "image") return p.url;
  if (p.type === "tiles") return p.urls[0];
  return undefined;
}

/** The last segment of a path, for a column header. Roots keep their own name. */
function folderName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = i >= 0 ? trimmed.slice(i + 1) : trimmed;
  return name === "" ? path : name;
}
