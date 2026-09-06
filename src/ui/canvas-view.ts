/**
 * The 2D spatial file canvas.
 *
 * Files live at fixed positions in an infinite world; the Viewport moves the
 * camera. Two things make it work at directory sizes that would kill a naive
 * DOM grid:
 *
 *  1. Culling + node recycling — only cards whose world rect intersects the
 *     camera are mounted, and unmounted nodes go back into a pool rather than
 *     being destroyed. Panning across 50k files touches a few dozen nodes.
 *  2. Level of detail — the card's *screen* size decides how much of it is
 *     built. Far out, a card is a coloured tile with no text nodes at all.
 *     Close in, it earns a thumbnail, then a live preview.
 *
 * That second point is the feature, not an optimisation: zooming in is how you
 * preview. There is no separate preview mode to enter.
 */

import { Viewport } from "@core/canvas/viewport";
import {
  DEFAULT_CARD,
  parse as parseFields,
  subtitle,
  type FieldDef,
} from "@core/explorer/fields";
import {
  type FileEntry,
  type Preview,
  type ViewConfig,
} from "@core/explorer/types";

const GAP = 22;
const RATIO = 0.72; // card height = width * RATIO, before the label strip
/** Label strip height for a one-line name; each extra name line adds NAME_LH. */
const LABEL_BASE = 20;
const NAME_LH = 14;
/**
 * The smallest a card may be drawn when a folder is first framed, in screen px.
 * Matches the tier in `#lodFor` at which previews start.
 */
const ARRIVAL_MIN = 96;

import { acceptDrops, type DropEffect } from "./dnd";

export interface CanvasCallbacks {
  onOpen(entry: FileEntry): void;
  onSelect(entries: FileEntry[]): void;
  /** The folder on screen, for drops that land on bare canvas. */
  folder?(): string;
  /**
   * Files were dropped on a folder card, or on the canvas itself (item 6).
   *
   * Drops only. Cards are deliberately *not* draggable here, and that is the
   * one place this view diverges from the others: the left button already
   * means "pan the camera" everywhere on the canvas, cards included, and an
   * HTML5 drag started on a card would take the gesture away from the
   * viewport. Panning is what the canvas is; dragging files out of it is what
   * the list and the gallery are for.
   */
  onDrop?(paths: readonly string[], to: string, effect: DropEffect): void;
  /**
   * Asked for exactly once per entry, and only when a card is both mounted and
   * large enough on screen to show one. That is the whole preview policy: a
   * folder of 40 000 files costs 40 000 reads if you preload, and roughly forty
   * if you let the viewport decide. The shell fills in `entry.preview` and calls
   * `refresh()`.
   *
   * Every entry gets asked, not just pictures — a .ts file previews as its own
   * first lines and a folder as the covers inside it, and a grid where only
   * photos have faces is the grid of glyphs this replaced.
   */
  onWantPreview?(entry: FileEntry): void;
  /**
   * Right-click (item 39). `entry` is null on bare canvas. As in the list, the
   * selection is already correct by the time this fires.
   */
  onMenu?(entry: FileEntry | null, x: number, y: number): void;
}

interface Cell {
  entry: FileEntry;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class CanvasView {
  readonly viewport: Viewport;

  readonly #host: HTMLElement;
  readonly #world: HTMLElement;
  readonly #cb: CanvasCallbacks;

  #cells: Cell[] = [];
  #cols = 1;
  /** Set by a long-press so the tap it ends with does not also open. */
  #menuJustFired = false;
  #cfg: ViewConfig;
  /** Memo for `#cardFields`; the key is the setting string itself. */
  #subFor: string | null = null;
  #subFields: FieldDef[] = [];
  #bounds = { w: 0, h: 0 };

  /** index → mounted node. Everything else lives in #pool. */
  #mounted = new Map<number, HTMLElement>();
  #pool: HTMLElement[] = [];
  #selected = new Set<string>();
  #lod = -1;
  /** Paths already handed to onWantThumb, so recycling never re-requests. */
  #asked = new Set<string>();

  constructor(host: HTMLElement, cfg: ViewConfig, cb: CanvasCallbacks) {
    this.#host = host;
    this.#cfg = cfg;
    this.#cb = cb;

    this.#world = document.createElement("div");
    this.#world.className = "world";
    host.appendChild(this.#world);

    this.viewport = new Viewport(host, { minScale: 0.04, maxScale: 12 });
    this.viewport.onChange(() => this.#draw());

    // A click that ends a pan must not also select. Compare down/up positions.
    let downAt = { x: 0, y: 0 };
    // Touch has no double click — see the note on ListView#tapOpens. Without
    // this the canvas is a wall of cards you can select and never enter, which
    // is how it shipped.
    let downTouch = false;
    host.addEventListener("pointerdown", (e) => {
      downAt = { x: e.clientX, y: e.clientY };
      downTouch = e.pointerType !== "mouse";
      this.#menuJustFired = false;
    });
    host.addEventListener("pointerup", (e) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      this.#onTap(e);
      if (downTouch && !this.#menuJustFired) this.#onOpen(e);
    });
    host.addEventListener("dblclick", (e) => this.#onOpen(e));
    host.addEventListener("contextmenu", (e) => this.#onMenu(e));

    acceptDrops(host, {
      folderAt: (e) => this.#folderAt(e),
      mark: (path) => this.#markDrop(path),
      run: (paths, to, effect) => this.#cb.onDrop?.(paths, to, effect),
    });

    new ResizeObserver(() => this.#draw()).observe(host);
  }

  setConfig(cfg: ViewConfig): void {
    this.#cfg = cfg;
    this.#relayout();
  }

  /** Replace the contents and frame them. */
  setEntries(entries: FileEntry[]): void {
    this.#cells = entries.map((entry) => ({ entry, x: 0, y: 0, w: 0, h: 0 }));
    this.#selected.clear();
    this.#asked.clear();
    this.#relayout();
    // Framing the whole folder is only useful while the cards still say
    // something. `#lodFor` stops drawing names below 64 screen px and previews
    // below 96, so on a 384 px phone a folder of forty files framed whole came
    // out at about 0.19x -- a grid of blank squares with no text, no pictures
    // and no clue which one is which. Arriving lands at the preview tier at
    // worst and pans from the middle; zooming out to the overview is a gesture
    // away, and is now a choice rather than the only thing on offer.
    this.viewport.fit(0, 0, this.#bounds.w, this.#bounds.h, 40, ARRIVAL_MIN / this.#cfg.cardSize);
  }

  /**
   * Select by path, ignoring anything no longer here.
   *
   * By path rather than by entry because the caller restoring a selection is
   * reading it off disk from a previous run — the entries it names are strings,
   * and the ones that have since been moved or deleted simply do not come back.
   */
  selectPaths(paths: readonly string[]): void {
    const here = new Set(this.#cells.map((c) => c.entry.path));
    this.#selected = new Set(paths.filter((p) => here.has(p)));
    this.#syncSelection();
  }

  destroy(): void {
    this.viewport.destroy();
    this.#world.remove();
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  /**
   * How tall the label strip is. Grows with the name-line budget so a long
   * name has somewhere to go — the strip cannot stay 34 px tall and also show
   * three lines, and a name clipped mid-word is the thing being fixed here.
   */
  #labelH(): number {
    return LABEL_BASE + this.#nameLines() * NAME_LH;
  }

  #nameLines(): number {
    return Math.max(1, Math.min(6, this.#cfg.nameLines ?? 2));
  }

  /**
   * The fields that go under a card's name (item 36).
   *
   * Cached against the string it was parsed from rather than recomputed per
   * card: a screenful is a few hundred cards during a zoom, and this would
   * otherwise re-split the same line for every one of them. `setConfig` needs no
   * invalidation hook — the string it compares against is the cache key.
   */
  #cardFields(): FieldDef[] {
    const text = this.#cfg.cardFields;
    if (text !== this.#subFor) {
      this.#subFor = text;
      this.#subFields = parseFields(text, { fallback: DEFAULT_CARD });
    }
    return this.#subFields;
  }

  #relayout(): void {
    const w = this.#cfg.cardSize;
    const h = Math.round(w * RATIO) + this.#labelH();
    const n = this.#cells.length;

    // Aim for a block a little wider than tall — it reads better when framed
    // in a landscape window and keeps pan distances short.
    this.#cols = Math.max(1, Math.round(Math.sqrt(n * 1.7)));

    for (let i = 0; i < n; i++) {
      const cell = this.#cells[i]!;
      cell.w = w;
      cell.h = h;
      cell.x = (i % this.#cols) * (w + GAP);
      cell.y = Math.floor(i / this.#cols) * (h + GAP);
    }

    const rows = Math.ceil(n / this.#cols) || 1;
    this.#bounds = {
      w: this.#cols * (w + GAP) - GAP,
      h: rows * (h + GAP) - GAP,
    };

    for (const [, node] of this.#mounted) this.#recycle(node);
    this.#mounted.clear();
    this.#draw();
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  /**
   * The preview tier starts at 96 px, not 210.
   *
   * 210 was set when tier 3 meant "decoded photo thumbnail" and it made the
   * whole preview system invisible in normal use: at the default zoom a card is
   * ~130 px on screen, which landed in tier 2, so every file showed a kind glyph
   * and previews only appeared if you zoomed past ~105%. That is the grid-of-
   * glyphs the previews were built to fix. 96 px is roughly Explorer's "medium
   * icons", where a page of text, a photo or a PDF page is plainly readable as
   * *what it is* even when the words are not.
   */
  #lodFor(screenCardWidth: number): number {
    if (screenCardWidth < 26) return 0; // dot
    if (screenCardWidth < 64) return 1; // tile, no text
    if (screenCardWidth < 96) return 2; // icon + name
    return 3; // thumbnail / live preview
  }

  #draw(): void {
    const vp = this.viewport;
    const rect = this.#host.getBoundingClientRect();
    if (rect.width === 0) return;

    this.#world.style.transform =
      `translate3d(${vp.tx}px, ${vp.ty}px, 0) scale(${vp.scale})`;

    const lod = this.#lodFor(this.#cfg.cardSize * vp.scale);
    if (lod !== this.#lod) {
      this.#lod = lod;
      this.#world.dataset["lod"] = String(lod);
      // Cards carry their tier in their markup, so a tier change has to rebuild
      // the ones already on screen. Without this, zooming in on a card that was
      // mounted while far out left it as a bare glyph — it only grew a preview
      // if you happened to pan it off screen and back, which read as the
      // previews simply not working.
      for (const [, node] of this.#mounted) this.#recycle(node);
      this.#mounted.clear();
    }

    // Visible world rect, padded by one card so cards scroll in already built.
    const tl = vp.screenToWorld(0, 0);
    const br = vp.screenToWorld(rect.width, rect.height);
    const pad = this.#cfg.cardSize + GAP;
    const minX = tl.x - pad;
    const minY = tl.y - pad;
    const maxX = br.x + pad;
    const maxY = br.y + pad;

    // The grid is regular, so the visible set is a row/column range — no need
    // to test every cell.
    const cw = this.#cfg.cardSize + GAP;
    const ch = Math.round(this.#cfg.cardSize * RATIO) + this.#labelH() + GAP;
    const c0 = Math.max(0, Math.floor(minX / cw));
    const c1 = Math.min(this.#cols - 1, Math.floor(maxX / cw));
    const r0 = Math.max(0, Math.floor(minY / ch));
    const r1 = Math.floor(maxY / ch);

    const wanted = new Set<number>();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * this.#cols + c;
        if (i >= 0 && i < this.#cells.length) wanted.add(i);
      }
    }

    for (const [i, node] of this.#mounted) {
      if (!wanted.has(i)) {
        this.#recycle(node);
        this.#mounted.delete(i);
      }
    }
    for (const i of wanted) {
      if (!this.#mounted.has(i)) {
        const node = this.#build(i);
        this.#mounted.set(i, node);
        this.#world.appendChild(node);
      }
    }
  }

  #recycle(node: HTMLElement): void {
    node.remove();
    if (this.#pool.length < 400) this.#pool.push(node);
  }

  // ── Drops ─────────────────────────────────────────────────────────────────

  /** A folder card takes the drop; bare canvas falls through to the folder. */
  #folderAt(ev: DragEvent): string | null {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".card");
    if (el !== null && el !== undefined) {
      const cell = this.#cells[Number(el.dataset["index"])];
      if (cell !== undefined && cell.entry.kind === "folder") return cell.entry.path;
    }
    return this.#cb.folder?.() ?? null;
  }

  #markDrop(path: string | null): void {
    const here = path !== null && path === (this.#cb.folder?.() ?? null);
    if (here) this.#host.dataset["drop"] = "1";
    else delete this.#host.dataset["drop"];
    // Cards are culled and recycled, so only what is mounted can be painted —
    // which is exactly what is on screen, and the rest is not visible anyway.
    for (const node of this.#host.querySelectorAll<HTMLElement>(".card")) {
      const cell = this.#cells[Number(node.dataset["index"])];
      if (!here && cell !== undefined && cell.entry.path === path) {
        node.dataset["drop"] = "1";
      } else delete node.dataset["drop"];
    }
  }

  #build(index: number): HTMLElement {
    const cell = this.#cells[index]!;
    const e = cell.entry;
    const node = this.#pool.pop() ?? document.createElement("div");

    node.className = "card";
    node.dataset["index"] = String(index);
    node.dataset["kind"] = e.kind;
    node.style.cssText =
      `left:${cell.x}px;top:${cell.y}px;width:${cell.w}px;height:${cell.h}px`;
    node.setAttribute("aria-selected", String(this.#selected.has(e.path)));
    // The native tooltip carries the full path, not just the name. It is the
    // one affordance that works at every zoom tier, including the ones with no
    // text nodes at all, and it costs nothing to keep accurate.
    node.title = e.path;
    node.style.setProperty("--name-lines", String(this.#nameLines()));

    // LOD 0/1 need no text at all — building it would be the dominant cost
    // when thousands of cards are on screen.
    if (this.#lod <= 1) {
      node.innerHTML = `<div class="card-face"></div>`;
      return node;
    }

    // Only ask at the tier where a preview is actually legible. Below that the
    // card is under 96 px wide and a decoded JPEG buys nothing but I/O.
    let face = glyph(e);
    if (this.#lod >= 3) {
      if (e.preview !== undefined) {
        face = renderPreview(e, e.preview);
      } else if (e.thumb !== undefined) {
        face = `<img class="card-thumb" src="${escapeHtml(e.thumb)}" alt="" loading="lazy" decoding="async">`;
      } else if (!this.#asked.has(e.path)) {
        this.#asked.add(e.path);
        this.#cb.onWantPreview?.(e);
      }
    }

    node.innerHTML =
      `<div class="card-face">${face}</div>` +
      `<div class="card-meta">` +
      `<span class="card-name">${escapeHtml(e.name)}</span>` +
      `<span class="card-sub">${escapeHtml(subtitle(e, this.#cardFields()))}</span>` +
      `</div>`;
    return node;
  }

  /**
   * Rebuild the mounted card for one path — how a thumbnail arriving late gets
   * on screen without disturbing scroll position, selection, or layout.
   */
  refresh(path: string): void {
    for (const [i, node] of this.#mounted) {
      if (this.#cells[i]?.entry.path !== path) continue;
      this.#recycle(node);
      this.#mounted.delete(i);
      const fresh = this.#build(i);
      this.#mounted.set(i, fresh);
      this.#world.appendChild(fresh);
      return;
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────

  #cellFrom(ev: Event): Cell | undefined {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".card");
    const raw = el?.dataset["index"];
    return raw === undefined ? undefined : this.#cells[Number(raw)];
  }

  #onTap(ev: PointerEvent): void {
    const cell = this.#cellFrom(ev);
    if (!cell) {
      if (this.#selected.size === 0) return;
      this.#selected.clear();
      this.#syncSelection();
      return;
    }
    const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    if (!additive) this.#selected.clear();
    if (this.#selected.has(cell.entry.path)) this.#selected.delete(cell.entry.path);
    else this.#selected.add(cell.entry.path);
    this.#syncSelection();
  }

  #onOpen(ev: MouseEvent): void {
    const cell = this.#cellFrom(ev);
    if (cell) this.#cb.onOpen(cell.entry);
  }

  /**
   * Right-click (item 39). See the note on `ListView.#onMenu` — a right-click
   * inside an existing selection must not shrink it to one card.
   *
   * The viewport already cancels `contextmenu` on the canvas itself so that a
   * two-finger pan does not open Chrome's menu mid-gesture; this handler sits
   * on the host above it and is the one that now decides what happens instead.
   */
  #onMenu(ev: MouseEvent): void {
    ev.preventDefault();
    this.#menuJustFired = true;
    const cell = this.#cellFrom(ev);
    if (cell !== undefined) {
      if (!this.#selected.has(cell.entry.path)) {
        this.#selected.clear();
        this.#selected.add(cell.entry.path);
        this.#syncSelection();
      }
    } else if (this.#selected.size > 0) {
      this.#selected.clear();
      this.#syncSelection();
    }
    this.#cb.onMenu?.(cell?.entry ?? null, ev.clientX, ev.clientY);
  }

  #syncSelection(): void {
    for (const [i, node] of this.#mounted) {
      const path = this.#cells[i]?.entry.path;
      node.setAttribute(
        "aria-selected",
        String(path !== undefined && this.#selected.has(path)),
      );
    }
    this.#cb.onSelect(
      this.#cells.filter((c) => this.#selected.has(c.entry.path)).map((c) => c.entry),
    );
  }
}

// ── Card content ──────────────────────────────────────────────────────────

const GLYPHS: Record<string, string> = {
  folder: "▤", image: "▦", video: "▶", audio: "◍", document: "▤",
  tabular: "▩", model3d: "◈", archive: "▣", code: "‹›", binary: "⬡",
};

function glyph(e: FileEntry): string {
  return `<span class="card-glyph">${GLYPHS[e.kind] ?? "⬡"}</span>`;
}

/**
 * Paint a preview. Each variant is already in a form the DOM can show with no
 * further decoding — that is the point of the union — so this is layout only.
 *
 * The `none` case deliberately keeps the glyph *and* prints the reason. "HEIC
 * needs a decoder" tells the user the app read the file and understood it; a
 * bare grey icon tells them nothing and reads like a bug.
 */
function renderPreview(e: FileEntry, p: Preview): string {
  switch (p.type) {
    case "image":
      return `<img class="card-thumb" src="${escapeHtml(p.url)}" alt="" loading="lazy" decoding="async">`;
    case "text":
      return `<pre class="card-text">${p.lines.map(escapeHtml).join("\n")}</pre>`;
    case "tiles": {
      const tiles = p.urls
        .map((u) => `<img src="${escapeHtml(u)}" alt="" loading="lazy" decoding="async">`)
        .join("");
      const more = p.more > 0 ? `<span class="card-more">+${p.more}</span>` : "";
      return `<div class="card-tiles">${tiles}${more}</div>`;
    }
    case "none":
    default:
      return `${glyph(e)}<span class="card-why">${escapeHtml(p.reason)}</span>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}
