/**
 * The details list, with a preview pane beside it.
 *
 * The canvas is the fun way to look at a folder and this is the way you actually
 * work in one. The complaint that produced it is worth writing down, because it
 * is the whole design brief: a grid of big square tiles gives every file the
 * same weight, and most files have nothing to show at tile size. Source code
 * rendered as a shrunken screenshot of itself is unreadable, a folder with no
 * pictures inside is an empty black box, and thirty-four of those in a window is
 * a wall of dark rectangles you cannot scan.
 *
 * So: one row per file, full names, real columns, and **one** preview — big
 * enough to read — of whatever is selected. Thirty-four tiny previews nobody can
 * read become one that anybody can.
 *
 * Two things are load-bearing rather than decorative:
 *
 *  1. **Rows are virtualised.** Row height is fixed, so the visible slice is
 *     arithmetic, and only that slice exists in the DOM. A 40 000-file folder
 *     mounts about forty rows. Same reasoning as the canvas, much simpler maths.
 *  2. **The pane is the only thing that asks for an expensive preview.** Rows
 *     ask only for kinds where a 22 px thumbnail genuinely distinguishes one
 *     file from another — pictures and video. Everything else gets a glyph in
 *     the row and its real preview in the pane when you select it. That is what
 *     keeps arrow-keying down a folder of RAWs from queueing a thousand decodes.
 */

import {
  facts,
  parse as parseFields,
  template,
  type FieldDef,
} from "@core/explorer/fields";
import {
  type FileEntry,
  type Preview,
  type SortKey,
  type ViewConfig,
} from "@core/explorer/types";
import { groupBoundaries } from "@core/explorer/grouping";
import {
  acceptDrops,
  beginDrag,
  dragGhost,
  endDrag,
  osDrag,
  type DropEffect,
} from "./dnd";
import { enableMarquee, foldSweep, type Rect, type SweepMode } from "./marquee";

/** Row height in px. Fixed — the virtualiser is arithmetic, not measurement. */
const ROW = 30;

/** Rows built above and below the viewport so scrolling never shows a gap. */
const OVERSCAN = 6;

/*
 * Group headings are rows too - exactly `ROW` tall, sitting in the same
 * absolutely-positioned column as everything else.
 *
 * That is the whole trick, and it is why grouping cost this file about forty
 * lines instead of a rewrite. A heading of any other height would make the
 * position of row *n* depend on how many headings are above it *and* how tall
 * each one is, which is a measured layout, which is the one thing the
 * virtualiser here exists to avoid. Equal heights keep it arithmetic: a slot is
 * a slot, and the only new fact is which slots hold headings.
 */


/** Pane width bounds. Below the floor the preview stops being worth the space. */
const PANE_MIN = 220;
const PANE_MAX = 720;

const LS_PANE = "facet.list.pane";

export interface ListCallbacks {
  onOpen(entry: FileEntry): void;
  onSelect(entries: FileEntry[]): void;
  /** Row-level ask: cheap kinds only. See the header note. */
  onWantPreview?(entry: FileEntry): void;
  /** Pane-level ask: always made for the selected file, whatever it is. */
  onWantFullPreview?(entry: FileEntry): void;
  /** A column header was clicked. The shell owns sorting and re-lists. */
  onSort?(key: SortKey): void;
  /**
   * Right-click (item 39). `entry` is null on empty space below the rows.
   *
   * The view has already fixed the selection before this fires — see
   * `#onMenu` — so the shell can build the menu from `selection` and does not
   * need to know that a right-click on an unselected row is also a click.
   */
  onMenu?(entry: FileEntry | null, x: number, y: number): void;
  /**
   * The folder being listed.
   *
   * A callback rather than a field because the view outlives any one folder:
   * it is asked at the moment a drag starts or a drop lands, so it cannot go
   * stale between navigations the way a value handed in at construction would.
   */
  folder?(): string;
  /** A drop landed. The shell owns the filesystem; the view only reports. */
  onDrop?(paths: readonly string[], to: string, effect: DropEffect): void;
}

const GLYPHS: Record<string, string> = {
  folder: "▤", image: "▦", video: "▶", audio: "◍", document: "▤",
  tabular: "▩", model3d: "◈", archive: "▣", code: "‹›", binary: "⬡",
};

/** Kinds whose row thumbnail is worth a decode. */
const THUMBABLE = new Set(["image", "video"]);

export class ListView {
  readonly #cb: ListCallbacks;

  readonly #root: HTMLElement;
  readonly #head: HTMLElement;
  readonly #scroll: HTMLElement;
  readonly #spacer: HTMLElement;
  readonly #pane: HTMLElement;

  #entries: FileEntry[] = [];
  #cfg: ViewConfig;
  /** The chosen columns, resolved once per config rather than once per row. */
  #fields: FieldDef[] = [];
  #selected = new Set<string>();
  /** The row the keyboard is on, and the anchor for shift-range selection. */
  #cursor = -1;
  #anchor = -1;
  /**
   * Whether the gesture behind the pending click came from a finger.
   *
   * Touch has no double click. The desktop contract — click selects, double
   * click opens — leaves a phone user able to see a folder and unable to enter
   * it, which is exactly what shipped: on the device the list would highlight
   * a row and go nowhere, twice. So on a coarse pointer a tap selects *and*
   * opens, which is what every file manager on the platform does, and
   * long-press is how you select a row without opening it.
   */
  #tapOpens = false;
  /**
   * Set by a long-press so the click Chromium may synthesise after it does not
   * also open. Cleared on every `pointerdown`, so it can never leak into the
   * next gesture and eat a legitimate tap.
   */
  #menuJustFired = false;
  #asked = new Set<string>();
  /** index → mounted row. Rows outside the window are removed, not pooled: a
   *  row is four spans, and the pool bookkeeping cost more than it saved. */
  #rows = new Map<number, HTMLElement>();
  /** slot -> mounted heading, kept beside `#rows` and windowed the same way. */
  #headNodes = new Map<number, HTMLElement>();
  /** Heading text by slot. Empty when nothing is grouped. */
  #heads = new Map<number, string>();
  /** How many entries each heading covers, by slot. */
  #headCounts = new Map<number, number>();
  /** entry index -> slot. The identity map when nothing is grouped. */
  #slotOf: number[] = [];
  /** How tall the spacer is, in slots: entries plus headings. */
  #slots = 0;
  #first = -1;
  #last = -1;
  /** The grouping the current layout was built for, so `setConfig` can tell. */
  #groupWas: ViewConfig["group"] = "none";
  /** What the pane is currently showing, so a refresh can tell if it cares. */
  #panePath: string | null = null;
  /** The selection as it stood when a marquee began; see `foldSweep`. */
  #sweepBase: ReadonlySet<string> = new Set();
  /**
   * True while a band is being dragged.
   *
   * The pane is skipped while it is set. Sweeping over four hundred files
   * would otherwise ask the preview service for four hundred files nobody has
   * looked at yet, one per frame, and the band would stutter for it.
   */
  #sweeping = false;
  /** The row currently lit as a drop target, if any. */
  #dropPath: string | null = null;
  #teardown: Array<() => void> = [];

  constructor(host: HTMLElement, cfg: ViewConfig, cb: ListCallbacks) {
    this.#cfg = cfg;
    this.#cb = cb;

    this.#root = document.createElement("div");
    this.#root.className = "lv";

    const left = document.createElement("div");
    left.className = "lv-left";

    this.#head = document.createElement("div");
    this.#head.className = "lv-head";
    this.#applyColumns();

    this.#scroll = document.createElement("div");
    this.#scroll.className = "lv-scroll";
    this.#scroll.tabIndex = 0;

    this.#spacer = document.createElement("div");
    this.#spacer.className = "lv-spacer";
    this.#scroll.appendChild(this.#spacer);

    left.append(this.#head, this.#scroll);

    const grip = document.createElement("div");
    grip.className = "lv-grip";
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "vertical");

    this.#pane = document.createElement("aside");
    this.#pane.className = "lv-pane";

    this.#root.append(left, grip, this.#pane);
    host.appendChild(this.#root);

    this.#root.style.setProperty("--pane-w", `${this.#storedPaneWidth()}px`);
    this.#dragToResize(grip);

    this.#scroll.addEventListener("scroll", () => this.#draw(), { passive: true });
    // Which input started the gesture decides what the click that follows
    // means. Read it here rather than off the click itself, because a click
    // synthesised from a tap reports `detail` and coordinates but not what
    // produced it.
    this.#scroll.addEventListener(
      "pointerdown",
      (e) => {
        this.#tapOpens = e.pointerType !== "mouse";
        this.#menuJustFired = false;
      },
      { passive: true },
    );
    this.#scroll.addEventListener("click", (e) => {
      this.#onClick(e);
      if (this.#tapOpens && !this.#menuJustFired) this.#onOpen(e);
    });
    this.#scroll.addEventListener("dblclick", (e) => this.#onOpen(e));
    this.#scroll.addEventListener("contextmenu", (e) => this.#onMenu(e));
    this.#scroll.addEventListener("keydown", (e) => this.#onKey(e));
    this.#scroll.addEventListener("dragstart", (e) => this.#onDragStart(e));
    this.#scroll.addEventListener("dragend", () => endDrag());
    this.#teardown.push(
      acceptDrops(this.#scroll, {
        folderAt: (e) => this.#folderAt(e),
        mark: (path) => this.#markDrop(path),
        run: (paths, to, effect) => this.#cb.onDrop?.(paths, to, effect),
      }),
      enableMarquee({
        scroll: this.#scroll,
        layer: this.#spacer,
        // Anywhere that is not a row. A press on a row is the beginning of a
        // click or of a file drag, and both of those are already spoken for.
        startsOn: (t) => t === null || t.closest(".lv-row") === null,
        hit: (box) => this.#hit(box),
        onStart: () => {
          this.#sweeping = true;
          this.#sweepBase = new Set(this.#selected);
        },
        onSweep: (indices, mode) => this.#sweep(indices, mode),
        onEnd: () => {
          this.#sweeping = false;
          // One pane render and one shell notification for the whole gesture.
          this.#syncSelection(true);
        },
      }),
    );
    new ResizeObserver(() => this.#draw()).observe(this.#scroll);

    this.#renderPane(null);
  }

  // ── Shell-facing API — deliberately the same shape as CanvasView ──────────

  setConfig(cfg: ViewConfig): void {
    const regroup = cfg.group !== this.#groupWas;
    this.#cfg = cfg;
    // Grouping moves every row, so the whole window goes and comes back. The
    // shell re-sends the entries straight afterwards in the normal case; doing
    // it here too costs one arithmetic pass and means a config change arriving
    // on its own cannot leave the headings behind.
    if (regroup) {
      this.#dropAllRows();
      this.#layout();
      this.#draw();
    }
    // A sort arrow only redraws the header. A different set of columns means
    // every mounted row has the wrong number of cells in it, so they go and
    // come back — which is cheap, because only the visible slice exists.
    //
    // What decides that is the resolved field list, not `cfg.columns`: the shell
    // keeps one ViewConfig and mutates it, so the object arriving here is the
    // same object already stored, and any before/after comparison of its
    // properties compares a value with itself. That shipped for about ten
    // minutes — the header changed and the rows underneath did not.
    if (this.#applyColumns()) {
      this.#dropAllRows();
      this.#draw();
    }
  }

  setEntries(entries: FileEntry[]): void {
    this.#entries = entries;
    this.#selected.clear();
    this.#asked.clear();
    this.#cursor = -1;
    this.#anchor = -1;
    this.#dropAllRows();
    this.#layout();
    this.#scroll.scrollTop = 0;
    this.#draw();
    this.#renderPane(null);
  }

  selectPaths(paths: readonly string[]): void {
    const here = new Set(this.#entries.map((e) => e.path));
    this.#selected = new Set(paths.filter((p) => here.has(p)));
    const first = this.#entries.findIndex((e) => this.#selected.has(e.path));
    this.#cursor = first;
    this.#anchor = first;
    this.#syncSelection(false);
    if (first >= 0) this.#scrollTo(first);
  }

  /** A preview arrived. Repaint the row if it is mounted, and the pane if it is
   *  showing this file — either can be true without the other. */
  refresh(path: string): void {
    for (const [i, node] of this.#rows) {
      if (this.#entries[i]?.path !== path) continue;
      node.replaceWith(this.#buildRow(i));
      break;
    }
    if (this.#panePath === path) {
      const entry = this.#entries.find((e) => e.path === path);
      if (entry) this.#renderPane(entry);
    }
  }

  focus(): void {
    this.#scroll.focus();
  }

  destroy(): void {
    for (const off of this.#teardown) off();
    this.#teardown = [];
    this.#root.remove();
  }

  // ── Header ────────────────────────────────────────────────────────────────

  /**
   * Resolve the chosen columns and rebuild the header.
   *
   * The grid track list is written to the root as `--lv-cols`, which both the
   * header and every row read — one declaration keeps a header cell over the
   * column it names, which is the entire reason the rows are a grid and not a
   * flex row with widths on each span.
   *
   * Returns whether the columns actually changed, so the caller knows whether
   * the mounted rows are now wrong. See the note in `setConfig`.
   */
  #applyColumns(): boolean {
    const next = parseFields(this.#cfg.columns, { requireName: true });
    const same =
      next.length === this.#fields.length && next.every((f, i) => f === this.#fields[i]);
    this.#fields = next;
    this.#root.style.setProperty("--lv-cols", template(this.#fields));

    this.#head.replaceChildren();
    for (const f of this.#fields) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lv-th";
      b.dataset["field"] = f.id;
      if (f.align === "right") b.dataset["align"] = "right";
      // The arrow is on the column being sorted, and only there — two arrows
      // means neither of them tells you anything.
      const active = f.sort !== null && this.#cfg.sort === f.sort;
      b.textContent = active ? `${f.label} ${this.#cfg.ascending ? "▲" : "▼"}` : f.label;
      if (active) b.setAttribute("aria-sort", this.#cfg.ascending ? "ascending" : "descending");
      // Fields nothing sorts on still get a header — it labels the column —
      // but it does not pretend to be a button that does something.
      if (f.sort !== null) {
        const key: SortKey = f.sort;
        b.addEventListener("click", () => this.#cb.onSort?.(key));
      } else {
        b.disabled = true;
      }
      this.#head.appendChild(b);
    }
    return !same;
  }

  // ── Rows ──────────────────────────────────────────────────────────────────

  #dropAllRows(): void {
    for (const [, node] of this.#rows) node.remove();
    for (const [, node] of this.#headNodes) node.remove();
    this.#rows.clear();
    this.#headNodes.clear();
    this.#first = -1;
    this.#last = -1;
  }

  /**
   * Work out where the headings go.
   *
   * The entries arrive already in group order - the shell reorders them, see
   * `groupedOrder` - so this is one pass looking for the point where the bucket
   * changes, not a second partition. `now` is taken once for the whole pass so a
   * folder listed across midnight cannot label two adjacent files "Today" and
   * "Yesterday" and split a group the shell did not split.
   */
  #layout(): void {
    const n = this.#entries.length;
    this.#heads.clear();
    this.#headCounts.clear();
    this.#slotOf = new Array<number>(n);
    this.#groupWas = this.#cfg.group;

    const marks = groupBoundaries(this.#entries, this.#cfg.group);
    let next = 0;
    let slot = 0;
    for (let i = 0; i < n; i++) {
      const mark = marks[next];
      if (mark !== undefined && mark.index === i) {
        this.#heads.set(slot, mark.label);
        this.#headCounts.set(slot, mark.count);
        next++;
        slot++;
      }
      this.#slotOf[i] = slot;
      slot++;
    }
    this.#slots = slot;
    this.#spacer.style.height = String(this.#slots * ROW) + "px";
  }

  /**
   * Mount the visible window.
   *
   * `first` and `last` are *slots*, not entry indices. With nothing grouped the
   * two are the same number and this is the arithmetic it always was; with
   * headings in the way, which entry lives in a slot becomes a lookup - which is
   * what `#entryIn` is for.
   */
  #draw(): void {
    const h = this.#scroll.clientHeight;
    if (h === 0) return;
    const top = this.#scroll.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const last = Math.min(this.#slots - 1, Math.ceil((top + h) / ROW) + OVERSCAN);
    if (first === this.#first && last === this.#last) return;
    this.#first = first;
    this.#last = last;

    for (const [slot, node] of this.#headNodes) {
      if (slot < first || slot > last) {
        node.remove();
        this.#headNodes.delete(slot);
      }
    }
    for (const [i, node] of this.#rows) {
      const slot = this.#slotOf[i] ?? -1;
      if (slot < first || slot > last) {
        node.remove();
        this.#rows.delete(i);
      }
    }
    for (let slot = first; slot <= last; slot++) {
      const head = this.#heads.get(slot);
      if (head !== undefined) {
        if (!this.#headNodes.has(slot)) {
          this.#spacer.appendChild(this.#buildHead(slot, head));
        }
        continue;
      }
      const i = this.#entryIn(slot);
      if (i >= 0 && !this.#rows.has(i)) this.#spacer.appendChild(this.#buildRow(i));
    }
  }

  /**
   * Which entry sits in a slot, or -1 if the slot holds a heading.
   *
   * A binary search rather than a second array: `#slotOf` is monotonic by
   * construction, the window is a few dozen slots wide, and a reverse table
   * would be one more thing to keep in step.
   */
  #entryIn(slot: number): number {
    let lo = 0;
    let hi = this.#slotOf.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = this.#slotOf[mid]!;
      if (at === slot) return mid;
      if (at < slot) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  #buildHead(slot: number, label: string): HTMLElement {
    const node = document.createElement("div");
    node.className = "lv-group";
    node.style.top = String(slot * ROW) + "px";
    node.setAttribute("role", "presentation");

    const name = document.createElement("span");
    name.className = "lv-group-name";
    name.textContent = label;

    // The count is the reason a heading earns its row: "Pictures" tells you
    // what is below it, "Pictures 214" tells you whether to scroll past it.
    const count = document.createElement("span");
    count.className = "lv-group-count";
    count.textContent = String(this.#headCounts.get(slot) ?? 0);

    node.append(name, count);
    this.#headNodes.set(slot, node);
    return node;
  }



  #buildRow(index: number): HTMLElement {
    const e = this.#entries[index]!;
    const node = document.createElement("div");
    node.className = "lv-row";
    node.dataset["index"] = String(index);
    node.draggable = true;
    if (e.path === this.#dropPath) node.dataset["drop"] = "1";
    node.style.top = String((this.#slotOf[index] ?? index) * ROW) + "px";
    // The zebra stripe has to come from the index, not from `:nth-child` —
    // rows are absolutely positioned and mount in scroll order, so DOM order
    // is meaningless here.
    if (index % 2 === 1) node.dataset["odd"] = "1";
    node.setAttribute("aria-selected", String(this.#selected.has(e.path)));
    if (index === this.#cursor) node.dataset["cursor"] = "1";
    // The full path on the row, not only in the pane: the pane shows one file
    // and the tooltip works on the one you are pointing at.
    node.title = e.path;

    node.append(this.#rowIcon(e), ...this.#fields.map((f) => cell(f, f.value(e))));
    this.#rows.set(index, node);
    return node;
  }

  /**
   * A 22 px square: the real thumbnail where one exists, the kind glyph
   * otherwise. Only pictures and video are ever asked for — see the header.
   */
  #rowIcon(e: FileEntry): HTMLElement {
    const box = document.createElement("span");
    box.className = "lv-icon";
    box.dataset["kind"] = e.kind;

    const url = thumbUrl(e.preview) ?? e.thumb;
    if (url !== undefined) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      box.appendChild(img);
      return box;
    }

    box.textContent = GLYPHS[e.kind] ?? "⬡";
    if (THUMBABLE.has(e.kind) && !this.#asked.has(e.path)) {
      this.#asked.add(e.path);
      this.#cb.onWantPreview?.(e);
    }
    return box;
  }

  // ── The pane ──────────────────────────────────────────────────────────────

  /**
   * One file, shown properly. Nothing selected is its own state with its own
   * message rather than an empty box — an empty box is how a broken pane looks.
   */
  #renderPane(entry: FileEntry | null): void {
    this.#pane.replaceChildren();
    this.#panePath = entry?.path ?? null;

    if (!entry) {
      const empty = document.createElement("div");
      empty.className = "lv-empty";
      const n = this.#entries.length;
      empty.textContent =
        n === 0 ? "Nothing here" : "Select a file to preview it";
      this.#pane.appendChild(empty);
      return;
    }

    const face = document.createElement("div");
    face.className = "lv-face";
    face.append(this.#paneFace(entry));

    const name = document.createElement("div");
    name.className = "lv-pane-name";
    name.textContent = entry.name;

    const dl = document.createElement("dl");
    dl.className = "lv-facts";
    for (const [k, v] of facts(entry)) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }

    // The path is selectable and wraps. The original complaint included not
    // being able to read a long path anywhere, and a truncated path in a
    // details pane is the same failure one level down.
    const path = document.createElement("div");
    path.className = "lv-path";
    path.textContent = entry.path;

    this.#pane.append(face, name, dl, path);
  }

  #paneFace(entry: FileEntry): HTMLElement {
    const p = entry.preview;
    if (p === undefined) {
      this.#cb.onWantFullPreview?.(entry);
      const wait = document.createElement("div");
      wait.className = "lv-face-glyph";
      wait.textContent = GLYPHS[entry.kind] ?? "⬡";
      return wait;
    }

    switch (p.type) {
      case "image": {
        const img = document.createElement("img");
        img.className = "lv-face-img";
        img.src = p.url;
        img.alt = "";
        img.decoding = "async";
        return img;
      }
      case "text": {
        // The pane is where a text preview finally has room to be read, so it
        // gets the lines at a normal size instead of the card's shrunken block.
        const pre = document.createElement("pre");
        pre.className = "lv-face-text";
        pre.textContent = p.lines.join("\n");
        return pre;
      }
      case "tiles": {
        const wrap = document.createElement("div");
        wrap.className = "lv-face-tiles";
        for (const u of p.urls) {
          const img = document.createElement("img");
          img.src = u;
          img.alt = "";
          img.decoding = "async";
          wrap.appendChild(img);
        }
        if (p.more > 0) {
          const more = document.createElement("span");
          more.className = "lv-face-more";
          more.textContent = `+${p.more}`;
          wrap.appendChild(more);
        }
        return wrap;
      }
      case "none":
      default: {
        const box = document.createElement("div");
        box.className = "lv-face-glyph";
        box.textContent = GLYPHS[entry.kind] ?? "⬡";
        const why = document.createElement("span");
        why.className = "lv-face-why";
        why.textContent = p.reason;
        box.appendChild(why);
        return box;
      }
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  #indexFrom(ev: Event): number {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".lv-row");
    const raw = el?.dataset["index"];
    return raw === undefined ? -1 : Number(raw);
  }

  #onClick(ev: MouseEvent): void {
    const i = this.#indexFrom(ev);
    if (i < 0) {
      if (this.#selected.size === 0) return;
      this.#selected.clear();
      this.#syncSelection(true);
      return;
    }
    if (ev.shiftKey && this.#anchor >= 0) this.#selectRange(this.#anchor, i);
    else if (ev.ctrlKey || ev.metaKey) {
      const p = this.#entries[i]!.path;
      if (this.#selected.has(p)) this.#selected.delete(p);
      else this.#selected.add(p);
      this.#anchor = i;
    } else {
      this.#selected = new Set([this.#entries[i]!.path]);
      this.#anchor = i;
    }
    this.#cursor = i;
    this.#syncSelection(true);
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  /**
   * A row was picked up.
   *
   * Dragging a row that is not part of the selection selects it first, and
   * dragging one that *is* takes the whole selection with it. Same rule as
   * right-click, and for the same reason: grabbing one of eight highlighted
   * files and moving only that one is a data-loss-shaped surprise.
   */
  #onDragStart(ev: DragEvent): void {
    const i = this.#indexFrom(ev);
    if (i < 0) {
      ev.preventDefault();
      return;
    }
    const entry = this.#entries[i]!;
    if (!this.#selected.has(entry.path)) {
      this.#selected = new Set([entry.path]);
      this.#anchor = i;
      this.#cursor = i;
      this.#syncSelection(true);
    }
    const paths = this.#entries.filter((e) => this.#selected.has(e.path)).map((e) => e.path);
    const from = this.#cb.folder?.() ?? "";
    beginDrag(paths, from);

    /*
     * Item 9. If the shell has an OS drag to offer, the gesture goes there
     * instead — a drop that lands in Chrome, in Explorer or in a chat window
     * needs a real file from the operating system, which a web page cannot
     * produce. The two kinds of drag cannot run at once, so the HTML5 one is
     * cancelled before it starts, and with it the ghost card and the text
     * payload: the OS draws its own preview and carries the files themselves.
     *
     * Dropping back inside FACET still works. The native drag arrives at our
     * own window as ordinary drag events, and `acceptDrops` resolves the
     * source paths from `dragging()` rather than from `dataTransfer` — which
     * is exactly why they were never put in `dataTransfer` to begin with.
     */
    const os = osDrag();
    if (os !== null) {
      ev.preventDefault();
      os(paths);
      return;
    }

    if (ev.dataTransfer !== null) {
      ev.dataTransfer.effectAllowed = "copyMove";
      // Something has to go in the store or some engines refuse to start the
      // drag at all. The paths are the honest thing to put there, and they are
      // what a text field receiving the drop would want anyway.
      ev.dataTransfer.setData("text/plain", paths.join("\n"));
    }
    dragGhost(ev, entry.name, paths.length);
  }

  /**
   * Which folder a point drops into.
   *
   * A folder row takes the drop. Anything else — a file row, the space below
   * the rows, a group heading — falls through to the folder being listed,
   * which is what makes "drop it in here" work without aiming at anything.
   */
  #folderAt(ev: DragEvent): string | null {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".lv-row");
    if (el !== null && el !== undefined) {
      const entry = this.#entries[Number(el.dataset["index"])];
      if (entry !== undefined && entry.kind === "folder") return entry.path;
    }
    return this.#cb.folder?.() ?? null;
  }

  #markDrop(path: string | null): void {
    this.#dropPath = path;
    const here = path !== null && path === (this.#cb.folder?.() ?? null);
    if (here) this.#scroll.dataset["drop"] = "1";
    else delete this.#scroll.dataset["drop"];
    for (const [i, node] of this.#rows) {
      const entry = this.#entries[i];
      if (!here && entry !== undefined && entry.path === path) node.dataset["drop"] = "1";
      else delete node.dataset["drop"];
    }
  }

  // ── Marquee ───────────────────────────────────────────────────────────────

  /**
   * Which rows a band touches.
   *
   * Rows run the full width, so only the vertical span matters — a band that
   * reaches a row's stripe of y has touched it wherever it is horizontally.
   * The slots are monotonic, so the scan can stop as soon as it passes the
   * bottom of the box rather than walking the rest of a large folder.
   */
  #hit(box: Rect): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.#entries.length; i++) {
      const top = (this.#slotOf[i] ?? i) * ROW;
      if (top > box.y1) break;
      if (top + ROW >= box.y0) out.push(i);
    }
    return out;
  }

  #sweep(indices: readonly number[], mode: SweepMode): void {
    const swept = indices.map((i) => this.#entries[i]!.path);
    this.#selected = foldSweep(this.#sweepBase, swept, mode);
    // Rows repaint every frame; the shell hears once, at the end.
    this.#syncSelection(false);
  }

  #onOpen(ev: MouseEvent): void {
    const i = this.#indexFrom(ev);
    if (i >= 0) this.#cb.onOpen(this.#entries[i]!);
  }

  /**
   * Right-click (item 39).
   *
   * Selection first, menu second, and only when the row is not already part of
   * the selection: right-clicking one of eight highlighted files has to keep
   * all eight, or "convert these" quietly becomes "convert this one". Every
   * file manager behaves this way and getting it wrong is destructive.
   *
   * The default menu is always suppressed, including when the shell has no
   * handler — WebView2's own menu offers Reload and view-source on a file
   * explorer, which is not a thing anyone wants.
   */
  #onMenu(ev: MouseEvent): void {
    ev.preventDefault();
    this.#menuJustFired = true;
    const i = this.#indexFrom(ev);
    if (i >= 0) {
      const path = this.#entries[i]!.path;
      if (!this.#selected.has(path)) {
        this.#selected = new Set([path]);
        this.#anchor = i;
        this.#cursor = i;
        this.#syncSelection(true);
      }
    } else if (this.#selected.size > 0) {
      this.#selected.clear();
      this.#syncSelection(true);
    }
    this.#cb.onMenu?.(i >= 0 ? this.#entries[i]! : null, ev.clientX, ev.clientY);
  }

  #onKey(ev: KeyboardEvent): void {
    const n = this.#entries.length;
    if (n === 0) return;
    const page = Math.max(1, Math.floor(this.#scroll.clientHeight / ROW) - 1);
    let to = this.#cursor;

    switch (ev.key) {
      case "ArrowDown": to = Math.min(n - 1, this.#cursor + 1); break;
      case "ArrowUp": to = Math.max(0, this.#cursor - 1); break;
      case "PageDown": to = Math.min(n - 1, this.#cursor + page); break;
      case "PageUp": to = Math.max(0, this.#cursor - page); break;
      case "Home": to = 0; break;
      case "End": to = n - 1; break;
      case "Enter":
        if (this.#cursor >= 0) {
          ev.preventDefault();
          this.#cb.onOpen(this.#entries[this.#cursor]!);
        }
        return;
      case "a":
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          this.#selected = new Set(this.#entries.map((e) => e.path));
          this.#syncSelection(true);
        }
        return;
      default:
        return;
    }

    ev.preventDefault();
    if (to < 0) to = 0;
    if (ev.shiftKey && this.#anchor >= 0) this.#selectRange(this.#anchor, to);
    else {
      this.#selected = new Set([this.#entries[to]!.path]);
      this.#anchor = to;
    }
    this.#cursor = to;
    this.#scrollTo(to);
    this.#syncSelection(true);
  }

  #selectRange(a: number, b: number): void {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.#selected = new Set(this.#entries.slice(lo, hi + 1).map((e) => e.path));
  }

  #scrollTo(i: number): void {
    const top = this.#scroll.scrollTop;
    const h = this.#scroll.clientHeight;
    // Slots, not indices - and if a heading sits immediately above the row, it
    // comes into view with it. Arrowing onto the first file of a group and
    // being unable to see which group it is would be a heading that only exists
    // for the mouse.
    const slot = this.#slotOf[i] ?? i;
    const above = this.#heads.has(slot - 1) ? slot - 1 : slot;
    if (above * ROW < top) this.#scroll.scrollTop = above * ROW;
    else if ((slot + 1) * ROW > top + h) this.#scroll.scrollTop = (slot + 1) * ROW - h;
    this.#draw();
  }

  /**
   * Push selection state out to the rows, the pane and the shell.
   *
   * `tell` exists because `selectPaths` is the shell restoring a selection it
   * already knows about — calling back into it would be a loop.
   */
  #syncSelection(tell: boolean): void {
    for (const [i, node] of this.#rows) {
      const e = this.#entries[i];
      node.setAttribute("aria-selected", String(e !== undefined && this.#selected.has(e.path)));
      if (i === this.#cursor) node.dataset["cursor"] = "1";
      else delete node.dataset["cursor"];
    }

    const chosen = this.#entries.filter((e) => this.#selected.has(e.path));
    // The pane shows one file. With several selected the last one the cursor
    // touched is the one you are looking at, which is also the one a range
    // selection ends on.
    const shown =
      this.#cursor >= 0 && this.#selected.has(this.#entries[this.#cursor]?.path ?? "")
        ? this.#entries[this.#cursor]!
        : (chosen[0] ?? null);
    if (!this.#sweeping && (shown?.path ?? null) !== this.#panePath) this.#renderPane(shown);

    if (tell) this.#cb.onSelect(chosen);
  }

  // ── Pane width ────────────────────────────────────────────────────────────

  #storedPaneWidth(): number {
    const raw = Number(localStorage.getItem(LS_PANE));
    if (!Number.isFinite(raw) || raw <= 0) return 340;
    return Math.max(PANE_MIN, Math.min(PANE_MAX, raw));
  }

  #dragToResize(grip: HTMLElement): void {
    let dragging = false;
    grip.addEventListener("pointerdown", (e) => {
      dragging = true;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const right = this.#root.getBoundingClientRect().right;
      const w = Math.max(PANE_MIN, Math.min(PANE_MAX, right - e.clientX));
      this.#root.style.setProperty("--pane-w", `${Math.round(w)}px`);
    });
    const stop = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      try { grip.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      const w = this.#root.style.getPropertyValue("--pane-w");
      try { localStorage.setItem(LS_PANE, String(parseInt(w, 10))); } catch { /* private mode */ }
      this.#draw();
    };
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  }
}

// ── Row content ─────────────────────────────────────────────────────────────

/**
 * One cell.
 *
 * The field id goes on the element rather than into a class name, so a field
 * added to the table needs no stylesheet change: the shared `.lv-c` rules cover
 * ellipsis and alignment, and `[data-field="name"]` is the only one that wants
 * anything of its own.
 */
function cell(f: FieldDef, text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "lv-c";
  s.dataset["field"] = f.id;
  if (f.align === "right") s.dataset["align"] = "right";
  s.textContent = text;
  return s;
}

/** The thumbnail inside a preview, if that preview is a picture at all. */
function thumbUrl(p: Preview | undefined): string | undefined {
  if (p === undefined) return undefined;
  if (p.type === "image") return p.url;
  if (p.type === "tiles") return p.urls[0];
  return undefined;
}

