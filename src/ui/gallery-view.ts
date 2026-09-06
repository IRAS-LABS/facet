/**
 * The gallery (item 34).
 *
 * The details list answered the complaint that a grid of tiles is a wall of dark
 * rectangles you cannot scan. That is true of a folder of source code and it is
 * *not* true of a folder of photographs, where the picture is the only part of
 * the file anybody cares about and the name is noise you glance at afterwards.
 * So the gallery is the list's opposite on purpose: thumbnails as large as the
 * window allows, the name in small type underneath, and nothing else.
 *
 * What it is not is the canvas. The canvas puts files at fixed positions in an
 * endless plane and lets you fly around it; that is a different pleasure and a
 * different set of gestures. This scrolls, in one direction, like every photo
 * roll anybody has used — which is exactly why it belongs beside the canvas
 * rather than instead of it.
 *
 * Two things carry it:
 *
 *  1. **Virtualised by row.** Tiles are a fixed size, so the number across is
 *     arithmetic from the width and the visible rows are arithmetic from the
 *     scroll offset. A 40 000-file folder mounts about three rows of tiles. The
 *     same trick as the list, one dimension further.
 *  2. **A mounted tile asks for its preview and an unmounted one does not.**
 *     Unlike the list, *every* kind is asked — a gallery where only photographs
 *     have faces is the grid of glyphs the list was invented to replace. The
 *     bound is the viewport, not the folder size.
 *
 * Tile size is the same `cardSize` the canvas uses, because "how big are the
 * pictures" is one thought and having it mean two different numbers depending on
 * which view you were last in is how a setting stops being trusted. Ctrl+wheel
 * and +/- change it from here and the shell writes it down.
 */

import {
  DEFAULT_CARD,
  parse as parseFields,
  subtitle,
  type FieldDef,
} from "@core/explorer/fields";
import type { FileEntry, Preview, ViewConfig } from "@core/explorer/types";
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

/** Space between tiles, and from the edge of the scroller. */
const GAP = 16;

/*
 * The height of a group heading band, in px.
 *
 * A number rather than a measurement for the same reason the list's headings are
 * exactly one row tall: `#place` writes every tile's `top` in pixels, so a band
 * that turned out taller than this says would sit on top of the first row of its
 * own group. The CSS pins `.gv-group` to it.
 */
const BAND = 30;
/** Picture area height as a fraction of tile width. */
const RATIO = 0.74;
/** Label strip for one line of name; each extra line adds NAME_LH. */
const LABEL_BASE = 22;
const NAME_LH = 15;
/** Rows built above and below the viewport so scrolling never shows a gap. */
const OVERSCAN = 2;

/** Tile size bounds, matching the card-size setting's own range. */
const MIN_TILE = 96;
const MAX_TILE = 420;

const GLYPHS: Record<string, string> = {
  folder: "▤", image: "▦", video: "▶", audio: "◍", document: "▤",
  tabular: "▩", model3d: "◈", archive: "▣", code: "‹›", binary: "⬡",
};

export interface GalleryCallbacks {
  onOpen(entry: FileEntry): void;
  onSelect(entries: FileEntry[]): void;
  /** Asked once per entry, when its tile is mounted. Every kind, see header. */
  onWantPreview?(entry: FileEntry): void;
  /** Right-click. The selection is already correct when this fires. */
  onMenu?(entry: FileEntry | null, x: number, y: number): void;
  /**
   * The user asked for bigger or smaller tiles. The shell owns the setting —
   * writing it here would make the gallery a second writer of a preference the
   * canvas also reads, and the two would drift.
   */
  onResize?(px: number): void;
  /** The folder being listed. Asked at drag and drop time; see `ListCallbacks`. */
  folder?(): string;
  /** A drop landed. The shell owns the filesystem; the view only reports. */
  onDrop?(paths: readonly string[], to: string, effect: DropEffect): void;
}

export class GalleryView {
  readonly #cb: GalleryCallbacks;

  readonly #root: HTMLElement;
  readonly #scroll: HTMLElement;
  readonly #spacer: HTMLElement;
  readonly #empty: HTMLElement;

  #entries: FileEntry[] = [];
  #cfg: ViewConfig;
  #selected = new Set<string>();
  #cursor = -1;
  #anchor = -1;
  #asked = new Set<string>();
  #tiles = new Map<number, HTMLElement>();
  /** The selection as it stood when a marquee began; see `foldSweep`. */
  #sweepBase: ReadonlySet<string> = new Set();
  /** The tile currently lit as a drop target, if any. */
  #dropPath: string | null = null;
  #teardown: Array<() => void> = [];
  /*
   * Where every tile goes, in pixels, worked out once per layout.
   *
   * Ungrouped, a tile's position is pure arithmetic on its index and these
   * arrays are a formality. Grouped, it is not: a group ends wherever it ends,
   * so the row it ends on is usually short, the next group starts on a fresh
   * row under its own heading, and index no longer tells you the column. Rather
   * than have two position formulas that must agree, there is one table, and
   * `#draw` binary-searches it -- `#top` is non-decreasing by construction.
   */
  #left: number[] = [];
  #top: number[] = [];
  /** Heading bands, in the same pixel space. Small: one per group. */
  #bands: Array<{ top: number; label: string; count: number }> = [];
  /** slot in `#bands` -> mounted node, windowed like the tiles. */
  #bandNodes = new Map<number, HTMLElement>();
  #first = -1;
  #last = -1;
  /*
   * What the current layout was built for. Sentinels rather than the real
   * defaults, so the first config to arrive always counts as a change.
   */
  #sizeWas = -1;
  #linesWas = -1;
  #fieldsWas: string | null = null;
  #groupWas: ViewConfig["group"] = "none";
  /** Tiles across, recomputed on every draw — the window can be resized. */
  #perRow = 1;
  /**
   * The width a tile is actually drawn at, which is *not* the card-size
   * setting. The setting is a target: a phone reports a 384 px viewport, and
   * `floor` on a 190 px target gave exactly one column with 178 px of dead
   * space beside it -- half the screen, on the device where screen is
   * scarcest. So the column count rounds to the nearest fit and the tiles then
   * stretch to consume the row, which is what a photo grid is expected to do
   * and what every gallery on the platform does.
   */
  #drawn = 190;
  #fieldsMemo: { text: string; fields: FieldDef[] } | null = null;

  constructor(host: HTMLElement, cfg: ViewConfig, cb: GalleryCallbacks) {
    this.#cfg = cfg;
    this.#cb = cb;

    this.#root = document.createElement("div");
    this.#root.className = "gv";

    this.#scroll = document.createElement("div");
    this.#scroll.className = "gv-scroll";
    this.#scroll.tabIndex = 0;

    this.#spacer = document.createElement("div");
    this.#spacer.className = "gv-spacer";
    this.#scroll.appendChild(this.#spacer);

    this.#empty = document.createElement("p");
    this.#empty.className = "gv-empty";
    this.#empty.textContent = "Nothing here.";
    this.#empty.hidden = true;
    this.#scroll.appendChild(this.#empty);

    this.#root.appendChild(this.#scroll);
    host.appendChild(this.#root);

    this.#scroll.addEventListener("scroll", () => this.#draw(), { passive: true });
    this.#scroll.addEventListener("click", (e) => this.#onClick(e));
    this.#scroll.addEventListener("dblclick", (e) => this.#onOpen(e));
    this.#scroll.addEventListener("contextmenu", (e) => this.#onMenu(e));
    this.#scroll.addEventListener("keydown", (e) => this.#onKey(e));
    // Not passive: a Ctrl+wheel that is allowed through zooms the whole WebView,
    // which on WebView2 leaves the app at 110% with no obvious way back.
    this.#scroll.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
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
        startsOn: (t) => t === null || t.closest(".gv-tile") === null,
        hit: (box) => this.#hit(box),
        onStart: () => {
          this.#sweepBase = new Set(this.#selected);
        },
        onSweep: (indices, mode) => this.#sweep(indices, mode),
        onEnd: () => this.#syncSelection(true),
      }),
    );
    new ResizeObserver(() => this.#relayout()).observe(this.#scroll);

    this.#applySize();
  }

  // ── Shell-facing API — the same shape as the list and the canvas ───────────

  setConfig(cfg: ViewConfig): void {
    this.#cfg = cfg;
    /*
     * Against remembered values, not against the config object held a moment
     * ago.
     *
     * The shell keeps one ViewConfig and mutates it in place, so `cfg` is the
     * very object this field already pointed at and `before.cardSize !==
     * cfg.cardSize` compares a number with itself -- always false, so the tiles
     * never resized and the grouping would never have appeared. The list hit
     * exactly this with its columns; the fix there was to compare the resolved
     * result, and the fix here is to keep the scalars.
     */
    const changed =
      cfg.cardSize !== this.#sizeWas ||
      cfg.nameLines !== this.#linesWas ||
      cfg.cardFields !== this.#fieldsWas ||
      cfg.group !== this.#groupWas;
    this.#sizeWas = cfg.cardSize;
    this.#linesWas = cfg.nameLines;
    this.#fieldsWas = cfg.cardFields;
    this.#groupWas = cfg.group;
    // Tile geometry changed, so every mounted tile is the wrong size and the
    // number across is wrong too. Cheap: only the visible rows exist.
    if (changed) {
      this.#applySize();
      this.#relayout();
    }
  }

  setEntries(entries: FileEntry[]): void {
    this.#entries = entries;
    this.#selected.clear();
    this.#asked.clear();
    this.#cursor = -1;
    this.#anchor = -1;
    this.#dropAll();
    this.#scroll.scrollTop = 0;
    this.#empty.hidden = entries.length > 0;
    this.#relayout();
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

  refresh(path: string): void {
    for (const [i, node] of this.#tiles) {
      if (this.#entries[i]?.path !== path) continue;
      node.replaceWith(this.#buildTile(i));
      return;
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

  // ── Geometry ──────────────────────────────────────────────────────────────

  #tile(): number {
    return Math.max(MIN_TILE, Math.min(MAX_TILE, Math.round(this.#cfg.cardSize)));
  }

  #nameLines(): number {
    return Math.max(1, Math.min(6, this.#cfg.nameLines ?? 2));
  }

  /** Full tile height: picture area, then the label strip. */
  #cell(): number {
    return Math.round(this.#drawn * RATIO) + LABEL_BASE + this.#nameLines() * NAME_LH;
  }

  /**
   * Fit the grid to the width available, then publish the result.
   *
   * `round` rather than `floor` is the whole difference between two columns
   * and one on a phone: 368 px of usable width over a 206 px step is 1.79,
   * which floors to a single tile and a wasted half-screen. Rounding takes the
   * nearer of the two fits and the stretch below absorbs the error, so a tile
   * lands within about a fifth of the size that was asked for either way.
   */
  #applySize(): void {
    const w = this.#scroll.clientWidth;
    if (w > 0) {
      const target = this.#tile();
      this.#perRow = Math.max(1, Math.round((w - GAP) / (target + GAP)));
      this.#drawn = Math.max(
        MIN_TILE,
        Math.floor((w - GAP * (this.#perRow + 1)) / this.#perRow),
      );
    } else {
      this.#drawn = this.#tile();
    }
    this.#root.style.setProperty("--tile", `${this.#drawn}px`);
    this.#root.style.setProperty("--tile-pic", `${Math.round(this.#drawn * RATIO)}px`);
    this.#root.style.setProperty("--name-lines", String(this.#nameLines()));
  }

  /** Recompute the grid and rebuild the visible rows from scratch. */
  #relayout(): void {
    const w = this.#scroll.clientWidth;
    if (w === 0) return;
    // Owns both the column count and the drawn tile width -- see `#applySize`.
    this.#applySize();
    this.#place();
    this.#dropAll();
    this.#draw();
  }

  /**
   * Lay every tile out, and every heading with them.
   *
   * The entries arrive in group order already -- the shell reorders them, see
   * `groupedOrder` -- so this is a single forward pass that starts a new row
   * whenever the row is full and a new row *plus a heading* whenever the bucket
   * changes. `now` is taken once so a folder laid out across midnight cannot
   * split a date group the shell did not split.
   */
  #place(): void {
    const n = this.#entries.length;
    const step = this.#cell() + GAP;
    this.#groupWas = this.#cfg.group;
    this.#left = new Array<number>(n);
    this.#top = new Array<number>(n);
    this.#bands = [];

    const marks = groupBoundaries(this.#entries, this.#cfg.group);
    let next = 0;
    let y = GAP;
    let col = 0;

    for (let i = 0; i < n; i++) {
      const mark = marks[next];
      if (mark !== undefined && mark.index === i) {
        // Close the row in progress before the heading, but only if there is
        // one -- at i === 0 there is nothing above to close and an extra step
        // here would open the folder with a blank row.
        if (i > 0) y += step;
        this.#bands.push({ top: y, label: mark.label, count: mark.count });
        y += BAND;
        col = 0;
        next++;
      } else if (col === this.#perRow) {
        col = 0;
        y += step;
      }

      this.#left[i] = GAP + col * (this.#drawn + GAP);
      this.#top[i] = y;
      col++;
    }

    const height = n === 0 ? GAP : y + this.#cell() + GAP;
    this.#spacer.style.height = `${height}px`;
  }

  /** First entry whose tile reaches `y` or below. -1 when there is none. */
  #firstAt(y: number): number {
    const step = this.#cell();
    let lo = 0;
    let hi = this.#top.length - 1;
    let out = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.#top[mid]! + step >= y) {
        out = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return out;
  }

  /** Last entry whose tile starts at or above `y`. -1 when there is none. */
  #lastAt(y: number): number {
    let lo = 0;
    let hi = this.#top.length - 1;
    let out = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.#top[mid]! <= y) {
        out = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return out;
  }

  #dropAll(): void {
    for (const [, node] of this.#tiles) node.remove();
    for (const [, node] of this.#bandNodes) node.remove();
    this.#tiles.clear();
    this.#bandNodes.clear();
    this.#first = -1;
    this.#last = -1;
  }

  #draw(): void {
    const h = this.#scroll.clientHeight;
    if (h === 0 || this.#entries.length === 0) return;
    const step = this.#cell() + GAP;
    const top = this.#scroll.scrollTop;
    const yMin = top - OVERSCAN * step;
    const yMax = top + h + OVERSCAN * step;

    const first = Math.max(0, this.#firstAt(yMin));
    const found = this.#lastAt(yMax);
    const last = found < 0 ? -1 : found;
    if (first === this.#first && last === this.#last) return;
    this.#first = first;
    this.#last = last;

    for (const [i, node] of this.#tiles) {
      if (i < first || i > last) {
        node.remove();
        this.#tiles.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (!this.#tiles.has(i)) this.#spacer.appendChild(this.#buildTile(i));
    }

    // The bands are one per group, so a linear pass over them is cheaper than
    // the bookkeeping a search would need -- and it is the same pass whether
    // there are two groups or none.
    this.#bands.forEach((band, slot) => {
      const visible = band.top + BAND >= yMin && band.top <= yMax;
      const node = this.#bandNodes.get(slot);
      if (visible && node === undefined) {
        this.#spacer.appendChild(this.#buildBand(slot, band));
      } else if (!visible && node !== undefined) {
        node.remove();
        this.#bandNodes.delete(slot);
      }
    });
  }

  #buildBand(slot: number, band: { top: number; label: string; count: number }): HTMLElement {
    const node = document.createElement("div");
    node.className = "gv-group";
    node.style.top = `${band.top}px`;
    node.setAttribute("role", "presentation");

    const name = document.createElement("span");
    name.className = "gv-group-name";
    name.textContent = band.label;

    const count = document.createElement("span");
    count.className = "gv-group-count";
    count.textContent = String(band.count);

    node.append(name, count);
    this.#bandNodes.set(slot, node);
    return node;
  }

  #buildTile(index: number): HTMLElement {
    const e = this.#entries[index]!;

    const node = document.createElement("figure");
    node.className = "gv-tile";
    node.dataset["index"] = String(index);
    node.draggable = true;
    if (e.path === this.#dropPath) node.dataset["drop"] = "1";
    node.dataset["kind"] = e.kind;
    node.style.left = `${this.#left[index] ?? GAP}px`;
    node.style.top = `${this.#top[index] ?? GAP}px`;
    node.setAttribute("aria-selected", String(this.#selected.has(e.path)));
    if (index === this.#cursor) node.dataset["cursor"] = "1";
    node.title = e.path;

    node.append(this.#face(e), this.#label(e));
    this.#tiles.set(index, node);
    return node;
  }

  /**
   * The picture. Asked for once per entry — `#asked` rather than checking
   * `preview === undefined`, because a file that genuinely has nothing to show
   * comes back as `{type:"none"}` and would otherwise be asked again every time
   * it scrolled past.
   */
  #face(e: FileEntry): HTMLElement {
    const box = document.createElement("div");
    box.className = "gv-face";

    if (e.preview === undefined && !this.#asked.has(e.path)) {
      this.#asked.add(e.path);
      this.#cb.onWantPreview?.(e);
    }

    const url = thumbUrl(e.preview) ?? e.thumb;
    if (url !== undefined) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      // A thumbnail that will not load — a file deleted since the folder was
      // read, a path the WebView refuses — leaves the browser's broken-image
      // icon in the tile, which reads as a corrupt file rather than as a
      // missing picture. The glyph is what the tile would have had anyway.
      img.addEventListener("error", () => {
        img.replaceWith(glyphFor(e));
      }, { once: true });
      box.appendChild(img);
      return box;
    }

    const p = e.preview;
    if (p !== undefined && p.type === "text") {
      // Source code at tile size is unreadable and everybody knows it — but the
      // *shape* of a file (indented, wide, blank) is recognisable, so the lines
      // go in small and grey as texture rather than as something to read.
      const pre = document.createElement("pre");
      pre.className = "gv-text";
      pre.textContent = p.lines.slice(0, 12).join("\n");
      box.appendChild(pre);
      return box;
    }

    box.appendChild(glyphFor(e));
    return box;
  }

  #label(e: FileEntry): HTMLElement {
    const cap = document.createElement("figcaption");
    cap.className = "gv-cap";

    const name = document.createElement("span");
    name.className = "gv-name";
    name.textContent = e.name;
    cap.appendChild(name);

    const sub = subtitle(e, this.#fields());
    if (sub !== "") {
      const s = document.createElement("span");
      s.className = "gv-sub";
      s.textContent = sub;
      cap.appendChild(s);
    }
    return cap;
  }

  /** The card fields, resolved once per setting string rather than per tile. */
  #fields(): FieldDef[] {
    const text = this.#cfg.cardFields ?? DEFAULT_CARD;
    if (this.#fieldsMemo?.text !== text) {
      this.#fieldsMemo = { text, fields: parseFields(text, { requireName: false }) };
    }
    return this.#fieldsMemo.fields;
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  #indexFrom(ev: Event): number {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".gv-tile");
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

  #onOpen(ev: MouseEvent): void {
    const i = this.#indexFrom(ev);
    if (i >= 0) this.#cb.onOpen(this.#entries[i]!);
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  /** Same rule as the list: a tile outside the selection becomes it first. */
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
      ev.dataTransfer.setData("text/plain", paths.join("\n"));
    }
    dragGhost(ev, entry.name, paths.length);
  }

  /** A folder tile takes the drop; anything else falls through to the folder. */
  #folderAt(ev: DragEvent): string | null {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".gv-tile");
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
    for (const [i, node] of this.#tiles) {
      const entry = this.#entries[i];
      if (!here && entry !== undefined && entry.path === path) node.dataset["drop"] = "1";
      else delete node.dataset["drop"];
    }
  }

  // ── Marquee ───────────────────────────────────────────────────────────────

  /**
   * Which tiles a band touches.
   *
   * Both axes matter here, unlike the list: tiles are islands with gaps between
   * them, and a band drawn down the gutter between two columns should take
   * nothing. `#firstAt`/`#lastAt` narrow to the rows the band reaches — they
   * only work because `#top` is monotonic — and the x test does the rest.
   */
  #hit(box: Rect): number[] {
    const cell = this.#cell();
    const first = this.#firstAt(box.y0);
    const last = this.#lastAt(box.y1);
    if (first < 0 || last < first) return [];
    const out: number[] = [];
    for (let i = first; i <= last; i++) {
      const x = this.#left[i] ?? 0;
      const y = this.#top[i] ?? 0;
      if (x <= box.x1 && x + this.#drawn >= box.x0 && y <= box.y1 && y + cell >= box.y0) {
        out.push(i);
      }
    }
    return out;
  }

  #sweep(indices: readonly number[], mode: SweepMode): void {
    const swept = indices.map((i) => this.#entries[i]!.path);
    this.#selected = foldSweep(this.#sweepBase, swept, mode);
    this.#syncSelection(false);
  }

  /** Same rule as the list: never shrink a selection you right-clicked inside. */
  #onMenu(ev: MouseEvent): void {
    ev.preventDefault();
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

  #onWheel(ev: WheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    this.#zoom(ev.deltaY < 0 ? 1 : -1);
  }

  /**
   * Bigger or smaller, in steps rather than continuously.
   *
   * A drag-a-slider size control was the complaint about the overlay — small
   * changes are impossible and it jumps. A step is a step whatever the input
   * was, so the wheel and the +/- keys land on the same sizes.
   */
  #zoom(dir: 1 | -1): void {
    const step = 32;
    const next = Math.max(MIN_TILE, Math.min(MAX_TILE, this.#tile() + dir * step));
    if (next === this.#tile()) return;
    this.#cb.onResize?.(next);
  }

  #onKey(ev: KeyboardEvent): void {
    const n = this.#entries.length;
    if (n === 0) return;

    // Zoom before movement: +/- are not navigation and Ctrl+= must not fall
    // through to the browser's own zoom.
    if (ev.key === "+" || ev.key === "=" ) { ev.preventDefault(); this.#zoom(1); return; }
    if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); this.#zoom(-1); return; }

    const perPage = Math.max(1, Math.floor(this.#scroll.clientHeight / (this.#cell() + GAP)));
    const page = perPage * this.#perRow;
    let to = this.#cursor;

    switch (ev.key) {
      case "ArrowRight": to = Math.min(n - 1, this.#cursor + 1); break;
      case "ArrowLeft": to = Math.max(0, this.#cursor - 1); break;
      // Down and up move a whole row, which is the only thing they can mean in
      // a grid and the reason the list's key handler could not simply be reused.
      //
      // By geometry rather than by `index +/- perRow`, because grouping makes
      // the last row of every group a short one: adding `perRow` there lands
      // past the start of the next group and skips files that are plainly on
      // the screen below the cursor.
      case "ArrowDown": to = this.#rowStep(this.#cursor, 1); break;
      case "ArrowUp": to = this.#rowStep(this.#cursor, -1); break;
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

  /**
   * One visual row up or down, landing under the column you were in.
   *
   * Scans out from the cursor to the next row, then across it for the tile
   * whose left edge is nearest -- at most two rows' worth of entries either
   * way, so it stays cheap on a folder of any size.
   */
  #rowStep(from: number, dir: 1 | -1): number {
    const n = this.#entries.length;
    if (from < 0) return dir > 0 ? 0 : n - 1;
    const y = this.#top[from] ?? 0;
    const x = this.#left[from] ?? 0;

    let row = -1;
    let best = from;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = from + dir; i >= 0 && i < n; i += dir) {
      const ty = this.#top[i]!;
      if (ty === y) continue;
      if (row < 0) row = ty;
      else if (ty !== row) break;
      const d = Math.abs((this.#left[i] ?? 0) - x);
      if (d < gap) {
        gap = d;
        best = i;
      }
    }
    return best;
  }

  #scrollTo(i: number): void {
    const y = this.#top[i] ?? 0;
    const step = this.#cell();
    const top = this.#scroll.scrollTop;
    const h = this.#scroll.clientHeight;
    // A heading immediately above the tile comes into view with it, so arrowing
    // into a group still tells you which group you are in.
    const band = this.#bands.find((b) => b.top + BAND === y);
    const above = band ? band.top : y;
    if (above < top) this.#scroll.scrollTop = Math.max(0, above - GAP);
    else if (y + step + GAP > top + h) this.#scroll.scrollTop = y + step + GAP - h;
    this.#draw();
  }

  #syncSelection(tell: boolean): void {
    for (const [i, node] of this.#tiles) {
      const e = this.#entries[i];
      node.setAttribute("aria-selected", String(e !== undefined && this.#selected.has(e.path)));
      if (i === this.#cursor) node.dataset["cursor"] = "1";
      else delete node.dataset["cursor"];
    }
    if (tell) this.#cb.onSelect(this.#entries.filter((e) => this.#selected.has(e.path)));
  }
}

/** The stand-in for a file with no picture, and for one whose picture failed. */
function glyphFor(e: FileEntry): HTMLElement {
  const glyph = document.createElement("span");
  glyph.className = "gv-glyph";
  glyph.textContent = GLYPHS[e.kind] ?? "⬡";
  return glyph;
}

/** The thumbnail inside a preview, if that preview is a picture at all. */
function thumbUrl(p: Preview | undefined): string | undefined {
  if (p === undefined) return undefined;
  if (p.type === "image") return p.url;
  if (p.type === "tiles") return p.urls[0];
  return undefined;
}
