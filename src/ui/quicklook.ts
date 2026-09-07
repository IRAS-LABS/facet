/**
 * Universal quick-look.
 *
 * Space on anything selected shows what it *is* without committing to opening
 * it. That is the difference between a file manager you browse and one you
 * hunt in: you can walk a folder of two hundred unknown files and never leave
 * the grid.
 *
 * The rule this obeys everywhere: never claim to preview something it cannot
 * actually read. A format with no preview shows its facts and says plainly that
 * there is no preview yet, rather than a broken-image glyph or an empty box
 * that reads as a bug.
 */

import { formatSize, type FileEntry } from "@core/explorer/types";
import { loadPdfjs } from "@core/explorer/preview";
import { attachZoom, type Zoom } from "@ui/zoom";
import { icon } from "@ui/phone/icons";

/** One button on the bar under the preview. */
export interface QuickAction {
  glyph: string;
  label: string;
  run(): void;
}

export interface QuickLookHost {
  fileUrl(path: string): Promise<string>;
  /** First `max` bytes of a file, for text sniffing and the hex dump. */
  readHead(path: string, max: number): Promise<number[]>;
  /**
   * What can be done with this file, as buttons under the preview.
   *
   * Absent on the desktop, where every one of them is a keystroke or a
   * right-click away and a second row of buttons would be noise. On a phone
   * this bar is the only way to reach any of it.
   */
  actions?(entry: FileEntry): readonly QuickAction[];
  /**
   * Start with the facts folded behind the "i".
   *
   * True on a phone. Opening a document to be shown its own absolute path is
   * not what anyone opened it for, and on a 384px screen the block took a
   * quarter of the height away from the thing being read.
   *
   * A function, and asked afresh for each file: a boolean here was read while
   * the module was still loading, which is earlier than the answer exists.
   */
  factsFolded?(): boolean;
  /**
   * Give the open file a new name, and answer with the path it ended up at.
   *
   * Optional, because the browser build has no filesystem to rename on. The
   * card does the asking, the trimming and the keeping of the extension; this
   * only has to move the file and tell the folder underneath to catch up.
   */
  rename?(entry: FileEntry, name: string): Promise<string>;
  /**
   * The file before or after this one in the folder as it is currently sorted
   * and filtered, or null at either end.
   *
   * What makes the card a reader rather than a peek: a folder of receipts is
   * walked by swiping, the same as a folder of photos, instead of closing and
   * reopening the card twenty times.
   */
  neighbour?(entry: FileEntry, step: 1 | -1): FileEntry | null;
  /**
   * One frame of a picture or clip, decoded natively, as JPEG bytes.
   *
   * The card's own decoders are the WebView's, and the WebView has no codec
   * for HEIC, DNG, TIFF, JXL, or for half the video containers a phone can
   * end up holding. Without this the card fell through to the hex dump, and
   * showed a wall of bytes for a file whose thumbnail it was displaying in
   * the grid one tap earlier. Optional: the browser build has no ffmpeg.
   */
  frameAt?(path: string, at: number, width: number): Promise<Uint8Array>;
}

/** Extensions the webview will actually paint. Anything else gets facts only. */
/**
 * The most extra resolution a zoomed PDF page is redrawn at.
 *
 * A page is about 800 CSS px wide here, so 4x is a 3200 px canvas at a dpr of
 * 1 and 6400 at 2 -- past that the canvas costs more memory than the zoom
 * returns in legibility, and the browser starts refusing the allocation
 * outright on a phone.
 */
const PDF_MAX_SHARP = 4;

/** Just enough of pdfjs's document to draw from. */
type PdfDoc = { getPage(n: number): Promise<import("pdfjs-dist").PDFPageProxy> };

/** Long edge asked of the native decoder for a card-sized preview. */
const NATIVE_FRAME_PX = 1600;

const WEB_IMAGE = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "avifs",
  "bmp", "svg", "ico",
]);
/* No "ogv": Chromium on Android demuxes Ogg and then has no Theora
   decoder, so the element loads, reports a duration, and paints a field of
   solid green. A frame from the native decoder is a better answer. */
const WEB_VIDEO = new Set(["mp4", "webm", "m4v", "mov"]);
const WEB_AUDIO = new Set(["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac"]);

/** Pages the webview can lay out for real, rather than only quote at you. */
const WEB_PAGE = new Set(["html", "htm", "xhtml"]);

/** Enough to show the shape of a file without pulling a gigabyte over IPC. */
const HEAD_BYTES = 16384;

/**
 * A rendered page is read whole -- half a document lays out as a broken one --
 * but not without a ceiling. Four megabytes of markup is already an outlier;
 * past that the source view is the honest answer.
 */
const PAGE_BYTES = 4 * 1024 * 1024;

/**
 * Prepended to the markup, ahead of whatever the document declares. A page may
 * lay itself out; it may not reach anything. `img-src data:` keeps embedded
 * pictures -- the common case for a self-contained report -- while a remote one
 * simply does not load.
 */
const OFFLINE_CSP =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: blob:; " +
  "font-src data:; " +
  "base-uri 'none'; " +
  "form-action 'none'" +
  '">';

const TEXT_CHARS = 4000;
const HEX_BYTES = 512;

/**
 * How far ahead of the scroll a PDF page is drawn, as a share of the card's
 * own height. Two screens: far enough that a fast scroll never catches the
 * renderer, near enough that a four-hundred-page manual costs a handful of
 * canvases rather than four hundred.
 */
const PDF_LOOKAHEAD = "200% 0px";

/** How far a thumb has to travel sideways before it counts as a page turn. */
const SWIPE_MIN = 60;

export class QuickLook {
  private readonly root: HTMLElement;
  private readonly card = document.createElement("div");
  private readonly body = document.createElement("div");
  /**
   * What the preview actually hangs off. A layer of its own, between the
   * scroller and the content, because the zoom is a transform and a transform
   * on the scroller itself would scale the scrollbars with the page.
   */
  private readonly zoomLayer = document.createElement("div");
  private readonly zoom: Zoom;
  private readonly facts = document.createElement("dl");
  private readonly heading = document.createElement("button");
  /**
   * The thing that actually scrolls the name.
   *
   * `overflow-x: auto` on the `<button>` itself did nothing: a button is not
   * a scroll container in Chromium, so the long name was simply clipped, with
   * no ellipsis and nothing to drag -- exactly the head this was meant to
   * fix. The button keeps its tap; the div around it does the scrolling.
   */
  private readonly titleWrap = document.createElement("div");
  private readonly actionBar = document.createElement("div");
  private readonly infoBtn = document.createElement("button");
  private readonly srcBtn = document.createElement("button");
  // The glyph lives in its own span so that flipping it does not wipe the word
  // the phone shell appends beside it -- `textContent =` on the button took the
  // label with it, and the toggle came back wordless.
  private readonly srcGlyph = document.createElement("span");
  /** Sticky across files: someone reading markup is reading all of it. */
  private asSource = false;

  /** The button that takes the card full-bleed, and the one that brings it
   *  back. Two controls rather than one, because in full screen the header
   *  it lives in is gone -- see `setFull`. */
  private readonly fullBtn = document.createElement("button");
  private readonly fullGlyph = document.createElement("span");
  private readonly exitBtn = document.createElement("button");
  /** Whether the card is filling the screen. Reset when the card closes. */
  private full = false;

  /** A single finger on the preview, until it lifts or a second one lands. */
  private swipe: { id: number; x: number; y: number; live: boolean } | null = null;

  /** Rename, done in the header where the name already is. */
  private readonly editBtn = document.createElement("button");
  private readonly renameRow = document.createElement("form");
  private readonly renameField = document.createElement("input");
  private readonly renameNote = document.createElement("p");
  /** The extension the field is not allowed to touch. */
  private renameExt = "";

  /** Whether the facts are showing. Folded to start with on a phone. */
  private factsOn: boolean;

  /** Guards against a slow read painting into a card that moved on. */
  private token = 0;

  /** What is on screen. Kept only so the session record can name it. */
  private entry: FileEntry | null = null;

  /** The open pdf.js document, so closing the card frees its worker memory. */
  private pdfTask: { destroy(): Promise<void> } | null = null;
  /** Watches which PDF pages are near the viewport, so only those get drawn. */
  private pdfWatch: IntersectionObserver | null = null;
  /** Kept so a zoom can ask for the same pages again, drawn finer. */
  private pdfDoc: PdfDoc | null = null;
  private pdfWidth = 0;
  private pdfDpr = 1;
  /** The extra resolution the visible pages are currently drawn at. */
  private pdfSharp = 1;

  constructor(private readonly host: QuickLookHost) {
    this.root = document.createElement("div");
    this.root.className = "ql";
    this.root.hidden = true;

    this.card.className = "ql-card";
    // A button, not a heading: the name is the obvious thing to tap to ask
    // "what is this file", and it was inert. It still reads as the title.
    this.titleWrap.className = "ql-titlewrap";
    this.heading.className = "ql-title";
    this.heading.type = "button";
    this.heading.title = "Show file details";
    // Off limits to the phone shell's button-labeller. The file name is the
    // label, and `show()` rewrites the contents of this button on every file,
    // which would throw away a word the labeller had appended. It only ever
    // labels buttons showing three characters or fewer, so this matters for
    // exactly one file -- one called `a.b` -- and that is still a file.
    this.heading.dataset["fctLabelled"] = "";
    this.heading.addEventListener("click", () => this.setFacts(!this.factsOn));
    this.body.className = "ql-body";
    this.zoomLayer.className = "ql-zoom";
    this.body.append(this.zoomLayer);
    // Pinch, double-tap and ctrl-wheel. Every gallery on the phone has this;
    // a file manager that renders a PDF and then refuses to enlarge it is
    // showing you the document through a letterbox.
    this.zoom = attachZoom(this.body, this.zoomLayer, {
      // Tapping the preview toggles full screen -- but only a tap that was
      // not the opening half of a double-tap zoom, which is why the card no
      // longer takes this off `click`.
      onTap: (t) => {
        if (!(t instanceof Element)) return;
        if (t.closest("button, a, input, select, textarea, video, audio")) return;
        this.setFull(!this.full);
      },
      // Redraw anything rasterised at the zoom it is now being shown at. A
      // photograph does not need this -- the compositor upscales from the
      // full decode -- but a PDF page is a canvas, and a canvas stretched to
      // 4x is a canvas four times too coarse. This is the "zoom in without
      // lowering quality" of 2026-09-07.
      onSettle: (k) => this.resharpen(k),
    });
    this.facts.className = "ql-facts";
    this.actionBar.className = "ql-actions";
    this.actionBar.hidden = true;

    const head = document.createElement("div");
    head.className = "ql-head";
    this.infoBtn.type = "button";
    this.infoBtn.className = "ql-icon";
    this.infoBtn.textContent = "ⓘ";
    this.infoBtn.title = "File details";
    this.infoBtn.setAttribute("aria-label", "File details");
    this.infoBtn.addEventListener("click", () => this.setFacts(!this.factsOn));
    // Only ever visible on a page. Everything else has exactly one way to be
    // looked at, and a toggle that does nothing is worse than no toggle.
    this.srcBtn.type = "button";
    this.srcBtn.className = "ql-icon";
    this.srcBtn.hidden = true;
    this.srcBtn.append(this.srcGlyph);
    this.srcBtn.addEventListener("click", () => {
      this.asSource = !this.asSource;
      if (this.entry) void this.show(this.entry);
    });

    // Rename, in the header rather than behind a menu, because the name is
    // already here and pointing at the thing being changed is the whole
    // affordance. Hidden without a filesystem to rename on.
    this.editBtn.type = "button";
    this.editBtn.className = "ql-icon";
    this.editBtn.textContent = "✎";
    this.editBtn.title = "Rename";
    this.editBtn.setAttribute("aria-label", "Rename");
    this.editBtn.addEventListener("click", () => this.setRenaming(true));

    // Full screen. Wanted most by the two previews that are documents in their
    // own right -- a rendered page and a PDF -- but offered on everything,
    // because "let me see this bigger" is not a question about file types.
    this.fullBtn.type = "button";
    this.fullBtn.className = "ql-icon";
    this.fullGlyph.className = "ql-full-glyph";
    this.fullBtn.append(this.fullGlyph);
    this.fullBtn.addEventListener("click", () => this.setFull(!this.full));

    // The way back out. A rendered page is an iframe and a PDF is a canvas
    // stack; neither passes a tap up to us, so full screen needs a control of
    // its own floating over the content rather than a second tap on it.
    this.exitBtn.type = "button";
    this.exitBtn.className = "ql-exit";
    this.exitBtn.textContent = "✕";
    this.exitBtn.title = "Exit full screen  (Esc)";
    this.exitBtn.setAttribute("aria-label", "Exit");
    this.exitBtn.hidden = true;
    this.exitBtn.addEventListener("click", () => this.setFull(false));


    const close = document.createElement("button");
    close.type = "button";
    close.className = "ql-close";
    close.textContent = "✕";
    close.title = "Close  (Esc)";
    close.addEventListener("click", () => this.close());
    this.titleWrap.append(this.heading);
    head.append(this.titleWrap, this.srcBtn, this.editBtn, this.fullBtn, this.infoBtn, close);
    // Glyphs only, up here. The phone shell stacks the button's name under its
    // glyph, which is the right call on a toolbar with room and the wrong one
    // on this row: five words turned a header into three rows and took a fifth
    // of the screen away from the file. Marking them as already-labelled is how
    // that pass is told to leave a button alone; each keeps its `title` and its
    // `aria-label`, so nothing is lost to a screen reader or a long press.
    for (const b of [this.srcBtn, this.editBtn, this.fullBtn, this.infoBtn, close]) {
      b.dataset["fctLabelled"] = "";
    }

    // The rename field stands in the head's own row, in place of the name.
    // A form, so the phone keyboard shows "go" and Enter submits without a
    // key handler -- and so Escape lands on the field, which the card's own
    // Escape listener then reads as "cancel the rename", not "close".
    this.renameRow.className = "ql-rename";
    this.renameRow.hidden = true;
    this.renameField.type = "text";
    this.renameField.className = "ql-rename-field";
    this.renameField.spellcheck = false;
    this.renameField.autocapitalize = "off";
    this.renameField.autocomplete = "off";
    this.renameField.setAttribute("aria-label", "New name");
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "ql-rename-go";
    ok.textContent = "Save";
    const no = document.createElement("button");
    no.type = "button";
    no.className = "ql-rename-no";
    no.textContent = "Cancel";
    no.addEventListener("click", () => this.setRenaming(false));
    this.renameNote.className = "ql-rename-note";
    this.renameNote.hidden = true;
    this.renameRow.append(this.renameField, ok, no);
    this.renameRow.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.commitRename();
    });

    this.card.append(head, this.renameRow, this.renameNote, this.body, this.actionBar, this.facts, this.exitBtn);
    this.root.append(this.card);

    // Nothing is on screen yet; `show()` sets the real value per file.
    this.factsOn = true;
    this.setFacts(true);
    // Gives the button its glyph and its accessible name before the phone
    // shell walks the panel looking for buttons to put words on.
    this.setFull(false);
    document.body.appendChild(this.root);

    // Clicking the dimmed ground closes; clicking the card must not.
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    // Left and right walk the folder, the same keys the grid underneath uses.
    // Only when the name is not being edited -- an arrow key in a text field
    // is a cursor, not a page turn.
    this.root.addEventListener("keydown", (e) => {
      if (!this.renameRow.hidden) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (!this.step(e.key === "ArrowRight" ? 1 : -1)) return;
      e.preventDefault();
      e.stopPropagation();
    });

    // And a swipe does the same with a thumb. Taken on the scroller rather
    // than the card so it cannot fire while the header is being pressed, and
    // only at 1x: once the content is zoomed a sideways drag is a pan, and
    // turning the page out from under someone reading a column of a table is
    // the worst possible reading of it.
    this.body.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      // A second finger means a pinch. The first one's travel is then part of
      // the zoom and must not also turn the page.
      if (this.swipe) {
        this.swipe.live = false;
        return;
      }
      this.swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, live: true };
    }, { passive: true });
    const endSwipe = (e: PointerEvent): void => {
      const s = this.swipe;
      if (!s) return;
      // Only the finger that started it clears the record; the second one
      // lifting off a pinch leaves the first still down.
      if (s.id !== e.pointerId) return;
      this.swipe = null;
      if (!s.live || e.type !== "pointerup") return;
      if (this.zoom.scale !== 1) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      // Clearly sideways, and clearly a travel rather than a tap: a diagonal
      // drag is someone scrolling, and the card must not take it.
      if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 2) return;
      this.step(dx < 0 ? 1 : -1);
    };
    this.body.addEventListener("pointerup", endSwipe, { passive: true });
    this.body.addEventListener("pointercancel", endSwipe, { passive: true });

    // The phone's back gesture arrives as an Escape dispatched at this panel
    // (see `closeTopPanel`). Taking it here, ahead of the document handler
    // that closes the card, is what makes back mean "leave full screen" while
    // full screen is on -- and `preventDefault` is how the shell is told the
    // press was consumed, so it does not fall through and exit the app.
    this.root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!this.renameRow.hidden) this.setRenaming(false);
      else if (this.full) this.setFull(false);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** What this surface is showing, for the session record. Null when closed. */
  get openPath(): string | null {
    return this.isOpen ? (this.entry?.path ?? null) : null;
  }

  /**
   * What Escape and the back gesture do. Full screen is a state inside the
   * card, so it unwinds first: one press to get the chrome back, the next to
   * put the file away.
   */
  escape(): void {
    if (this.full) this.setFull(false);
    else this.close();
  }

  /**
   * Move to the next or previous file in the folder. Answers whether it went
   * anywhere, so the key handler only swallows the press when it did and the
   * arrow still reaches the grid at either end of the folder.
   */
  private step(dir: 1 | -1): boolean {
    if (!this.entry || this.host.neighbour === undefined) return false;
    const next = this.host.neighbour(this.entry, dir);
    if (!next) return false;
    void this.show(next);
    return true;
  }

  close(): void {
    this.setRenaming(false);
    this.setFull(false);
    this.root.hidden = true;
    this.zoomLayer.replaceChildren();
    this.zoom.reset();
    this.entry = null;
    this.token++;
    this.dropPdf();
  }

  /** Space toggles, so a second press on the same file dismisses it. */
  toggle(entry: FileEntry | null): void {
    if (this.isOpen || !entry) {
      this.close();
      return;
    }
    void this.show(entry);
  }

  async show(entry: FileEntry): Promise<void> {
    const mine = ++this.token;
    this.dropPdf();
    this.entry = entry;
    this.root.hidden = false;
    // In a span, not straight on the button: the two-line clamp that keeps a
    // long name from pushing the head's buttons onto a row of their own has to
    // live on a block, and a flex item is not one. See `.ql-title > span`.
    const title = document.createElement("span");
    title.textContent = entry.name;
    this.heading.replaceChildren(title);
    const isPage = WEB_PAGE.has(entry.ext);
    this.srcBtn.hidden = !isPage;
    // A folder's preview is one sentence. Nothing to enlarge, and full screen
    // would be a blank wall with a full stop in the middle of it.
    this.setRenaming(false);
    this.editBtn.hidden = this.host.rename === undefined || entry.kind === "folder";
    const canFill = entry.kind !== "folder";
    this.fullBtn.hidden = !canFill;
    if (!canFill && this.full) this.setFull(false);
    else this.setFull(this.full);
    if (isPage) {
      const toSource = !this.asSource;
      this.srcGlyph.textContent = toSource ? "</>" : "□";
      // One word, because the phone shell stacks it under the glyph and clips
      // anything past twelve characters -- "Show the source" arrived on the
      // device as "Show the so…".
      const label = toSource ? "Source" : "Page";
      this.srcBtn.title = toSource ? "Show the source" : "Show the rendered page";
      this.srcBtn.setAttribute("aria-label", label);
      const tag = this.srcBtn.querySelector(".fct-blabel");
      if (tag) tag.textContent = label;
    }
    this.zoomLayer.replaceChildren(note("Reading…"));
    // A new file starts at 1x and at the top. Inheriting the last file's zoom
    // opens the next one somewhere in its middle at three times life size.
    this.zoom.reset();
    this.renderFacts(entry);
    this.renderActions(entry);
    // Every file starts folded on a phone, including the second one opened in
    // the same session -- leaving it open because the last file's details were
    // read would be the same permanent block of text, one tap later.
    this.setFacts(this.host.factsFolded?.() !== true);

    try {
      const node = await this.preview(entry);
      if (mine !== this.token) return;
      this.zoomLayer.replaceChildren(node);
    } catch (e) {
      if (mine !== this.token) return;
      this.zoomLayer.replaceChildren(note(`Could not read this file — ${String(e)}`));
    }
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  private async preview(entry: FileEntry): Promise<HTMLElement> {
    if (entry.kind === "folder") return note("Folder — press enter to go in.");

    if (entry.kind === "image" && WEB_IMAGE.has(entry.ext)) {
      const img = document.createElement("img");
      img.className = "ql-media";
      img.src = await this.host.fileUrl(entry.path);
      img.alt = entry.name;
      img.addEventListener("load", () => {
        this.addFact("Dimensions", `${img.naturalWidth} × ${img.naturalHeight}`);
      });
      return img;
    }

    if (entry.kind === "video" && WEB_VIDEO.has(entry.ext)) {
      const v = document.createElement("video");
      v.className = "ql-media";
      v.src = await this.host.fileUrl(entry.path);
      v.controls = true;
      // Muted so a peek at a clip never blasts a room; the player is one
      // keypress away when you actually want to watch it.
      v.muted = true;
      v.preload = "metadata";
      v.addEventListener("loadedmetadata", () => {
        this.addFact("Dimensions", `${v.videoWidth} × ${v.videoHeight}`);
        this.addFact("Duration", hms(v.duration));
      });
      return v;
    }

    if (entry.kind === "audio" && WEB_AUDIO.has(entry.ext)) {
      const a = document.createElement("audio");
      a.className = "ql-audio";
      a.src = await this.host.fileUrl(entry.path);
      a.controls = true;
      a.preload = "metadata";
      a.addEventListener("loadedmetadata", () => this.addFact("Duration", hms(a.duration)));
      return a;
    }

    // A PDF gets real pages. pdf.js is already in the bundle for the OCR
    // reader, and the loader is shared, so this costs nothing until the first
    // PDF is actually peeked at.
    if (entry.ext === "pdf") return this.previewPdf(entry);

    if (WEB_PAGE.has(entry.ext) && !this.asSource) return this.previewPage(entry);

    /*
     * A picture or a clip the WebView cannot open itself.
     *
     * Everything below this point reads the file as bytes, and for a 40 MP
     * raw or an AVI that is a screen of hex where a photograph should be --
     * the same file the grid behind the card is showing a thumbnail of. The
     * native decoder that made that thumbnail is one call away, so the card
     * shows the frame and says, in one line, that the frame is all it can
     * show.
     */
    if (entry.kind === "image" || entry.kind === "video") {
      const shot = await this.nativeFrame(entry);
      if (shot) return shot;
    }

    // Everything else: read the head once and decide from the bytes rather than
    // from the extension. A .log, a .conf and an extensionless dotfile are all
    // text, and none of them are in any list.
    const head = new Uint8Array(await this.host.readHead(entry.path, HEAD_BYTES));
    if (head.length === 0) return note("Empty file.");

    if (looksTextual(head)) {
      const pre = document.createElement("pre");
      pre.className = "ql-text";
      const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
      pre.textContent = text.slice(0, TEXT_CHARS) + (text.length > TEXT_CHARS ? "\n…" : "");
      return pre;
    }

    const pre = document.createElement("pre");
    pre.className = "ql-hex";
    pre.textContent = hexDump(head.subarray(0, HEX_BYTES));
    return pre;
  }

  /**
   * The still the platform can make of a file the card cannot open.
   *
   * Returns null rather than throwing when there is no native decoder, or it
   * declines, so the caller falls through to its byte dump exactly as before.
   */
  private async nativeFrame(entry: FileEntry): Promise<HTMLElement | null> {
    const frameAt = this.host.frameAt;
    if (!frameAt) return null;
    let bytes: Uint8Array;
    try {
      bytes = await frameAt.call(this.host, entry.path, 0, NATIVE_FRAME_PX);
    } catch {
      return null;
    }
    if (!bytes || bytes.byteLength === 0) return null;
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
    const img = document.createElement("img");
    img.className = "ql-media";
    img.src = url;
    img.alt = entry.name;
    // One frame is all there is, so the URL has no second reader; letting it
    // go once the picture is up keeps a folder of raws from accumulating a
    // blob per file peeked at.
    img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
    const line = document.createElement("p");
    line.className = "ql-note";
    line.textContent = entry.kind === "video"
      ? `.${entry.ext} plays in the editor — this is one frame of it.`
      : `.${entry.ext} is decoded by the phone, not the browser — this is a preview, not the full file.`;
    const wrap = document.createElement("div");
    wrap.className = "ql-native";
    wrap.append(img, line);
    return wrap;
  }

  /**
   * A page, laid out.
   *
   * Sandboxed to nothing at all: no scripts, no same-origin, no forms, no
   * top-level navigation. On top of that the document is served a policy that
   * permits no fetch of any kind except inline styles and `data:` images.
   *
   * That belt-and-braces is not paranoia for its own sake. This app's whole
   * claim is that nothing it opens phones anywhere, and an HTML file is the one
   * format that arrives with the *intent* to fetch. Rendering one with the
   * network reachable would hand a stranger's document a tracking pixel, an
   * `<img src=https://...>` pointed at a log, and a way to confirm the file was
   * opened, on a device the person believed was offline. So the render is real
   * layout with real CSS and no reachable outside.
   *
   * `srcdoc` rather than a file URL for the same reason: it gives the frame an
   * opaque origin, so even a same-origin escape has nothing to read.
   */
  private async previewPage(entry: FileEntry): Promise<HTMLElement> {
    const size = entry.size ?? PAGE_BYTES;
    if (size > PAGE_BYTES) {
      return note(`This page is ${formatSize(size)} — too large to lay out here. ` +
        "Its source is one tap away, on the </> button.");
    }
    const bytes = new Uint8Array(await this.host.readHead(entry.path, size));
    if (bytes.length === 0) return note("Empty file.");
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    const frame = document.createElement("iframe");
    frame.className = "ql-html";
    // Empty, not omitted: an absent `sandbox` is no sandbox, and every token
    // left out of a present one is a capability withheld.
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = `${entry.name} — rendered, offline`;
    frame.srcdoc = OFFLINE_CSP + html;
    return frame;
  }

  // ── PDF ───────────────────────────────────────────────────────────────────

  /**
   * Every page of the document, drawn as it is scrolled to.
   *
   * It used to stop at twenty and say so, which is a peek and not a reader:
   * a fifty-page contract opened here simply had its second half missing. Now
   * every page gets a slot at the right proportions immediately -- so the
   * scrollbar tells the truth about the document's length from the first
   * frame -- and the pixels arrive as that slot comes near the screen.
   */
  private async previewPdf(entry: FileEntry): Promise<HTMLElement> {
    const mine = this.token;
    const [pdfjs, url] = await Promise.all([loadPdfjs(), this.host.fileUrl(entry.path)]);
    const task = pdfjs.getDocument({ url });
    this.pdfTask = task;
    const doc = await task.promise;
    this.pdfDoc = doc;
    this.pdfSharp = 1;
    if (mine !== this.token) return note("");
    this.addFact("Pages", String(doc.numPages));

    const wrap = document.createElement("div");
    wrap.className = "ql-pdf";
    // The body is already on screen holding "Reading…", so its box is real.
    const width = Math.max(320, this.body.clientWidth - 12);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.pdfWidth = width;
    this.pdfDpr = dpr;

    // Page one decides the shape of every empty slot. Guessing A4 instead
    // would make a document of slides open with the scrollbar lying about
    // where the end is, and correct itself in jumps as you scrolled.
    const first = await doc.getPage(1);
    if (mine !== this.token) return wrap;
    const shape = first.getViewport({ scale: 1 });
    const tall = Math.round(width * (shape.height / shape.width));

    const watch = new IntersectionObserver(
      (rows) => {
        for (const row of rows) {
          if (!row.isIntersecting) continue;
          const slot = row.target;
          if (!(slot instanceof HTMLElement) || slot.dataset["drawn"] !== undefined) continue;
          slot.dataset["drawn"] = "";
          watch.unobserve(slot);
          // At whatever sharpness the zoom is currently asking for, so a page
          // scrolled to while zoomed in arrives sharp rather than arriving
          // coarse and being redrawn.
          slot.dataset["sharp"] = String(this.pdfSharp);
          void this.drawPdfPage(doc, Number(slot.dataset["page"]), slot, width, dpr * this.pdfSharp, mine);
        }
      },
      { root: this.body, rootMargin: PDF_LOOKAHEAD },
    );
    this.pdfWatch = watch;

    for (let i = 1; i <= doc.numPages; i++) {
      const slot = document.createElement("div");
      slot.className = "ql-slot";
      slot.style.height = `${tall}px`;
      slot.dataset["page"] = String(i);
      wrap.append(slot);
      watch.observe(slot);
    }
    return wrap;
  }

  /**
   * Draw the visible pages again for a zoom that has settled.
   *
   * Only the visible ones, and only when the zoom actually asks for more than
   * is already there: re-rendering a fifty-page document because someone
   * pinched is how a reader becomes a heater. Coming back down is left alone
   * until the zoom returns to 1x, where the fine canvases are dropped and the
   * ordinary ones drawn -- a downscale looks correct, so there is nothing to
   * fix in a hurry, and redrawing on the way out of a zoom is wasted work.
   */
  private resharpen(k: number): void {
    const doc = this.pdfDoc;
    if (!doc) return;
    const want = Math.min(Math.max(1, k), PDF_MAX_SHARP);
    if (Math.abs(want - this.pdfSharp) < 0.05) return;
    this.pdfSharp = want;
    const box = this.body.getBoundingClientRect();
    const mine = this.token;
    for (const slot of this.zoomLayer.querySelectorAll<HTMLElement>(".ql-slot")) {
      if (slot.dataset["drawn"] === undefined) continue;
      if (Number(slot.dataset["sharp"] ?? "1") === want) continue;
      const r = slot.getBoundingClientRect();
      // A page entirely off screen keeps whatever it has; it will be redrawn
      // if the zoom is still up when it scrolls back into view.
      if (r.bottom < box.top - r.height || r.top > box.bottom + r.height) continue;
      slot.dataset["sharp"] = String(want);
      void this.drawPdfPage(doc, Number(slot.dataset["page"]), slot, this.pdfWidth, this.pdfDpr * want, mine);
    }
  }

  private async drawPdfPage(
    doc: PdfDoc,
    index: number,
    slot: HTMLElement,
    width: number,
    dpr: number,
    mine: number,
  ): Promise<void> {
    if (mine !== this.token) return;
    const page = await doc.getPage(index);
    if (mine !== this.token) return;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.className = "ql-page";
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // White under the ink: a PDF with no background is transparent, and the
    // card's dark canvas would swallow black text whole.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    if (mine !== this.token) return;
    // The placeholder height goes now, not before: keeping it until the pixels
    // exist is what stops the page under the finger from jumping.
    slot.style.height = "";
    slot.replaceChildren(canvas);
  }

  private dropPdf(): void {
    this.pdfWatch?.disconnect();
    this.pdfWatch = null;
    this.pdfDoc = null;
    this.pdfSharp = 1;
    const t = this.pdfTask;
    this.pdfTask = null;
    if (t) void t.destroy().catch(() => undefined);
  }

  // ── Facts ─────────────────────────────────────────────────────────────────

  private renderFacts(entry: FileEntry): void {
    this.facts.replaceChildren();
    this.addFact("Kind", entry.kind + (entry.ext ? `  ·  .${entry.ext}` : ""));
    if (entry.size !== undefined) {
      this.addFact("Size", `${formatSize(entry.size)}  (${entry.size.toLocaleString()} bytes)`);
    }
    if (entry.modified !== undefined) {
      this.addFact("Modified", new Date(entry.modified).toLocaleString());
    }
    this.addFact("Path", entry.path);
  }

  /**
   * Show or hide the facts.
   *
   * They are still built either way: `addFact` is called from the image and
   * video load handlers as their dimensions arrive, and a block that only
   * populated while it was open would be empty the first time it was asked
   * for.
   */
  /**
   * Fill the screen with the file, or give the chrome back.
   *
   * Everything the card puts around the preview -- the name, the details, the
   * action bar -- is help for choosing what to look at, and it is in the way
   * once the choosing is done. Full screen drops all of it and hands the whole
   * viewport to the one thing being read.
   */
  private setFull(on: boolean): void {
    this.full = on;
    this.root.classList.toggle("ql-full", on);
    this.exitBtn.hidden = !on;
    this.fullGlyph.textContent = on ? "⤡" : "⤢";
    // Both fit the twelve characters the phone shell allows a stacked label
    // before it truncates one; "Exit full screen" did not.
    const label = on ? "Exit" : "Full screen";
    this.fullBtn.title = on ? "Exit full screen  (Esc)" : "Full screen";
    this.fullBtn.setAttribute("aria-label", label);
    this.fullBtn.setAttribute("aria-pressed", String(on));
    const tag = this.fullBtn.querySelector(".fct-blabel");
    if (tag) tag.textContent = label;
  }

  /**
   * Swap the name for a field to type a new one into, or put it back.
   *
   * The extension never enters the field. Renaming `holiday.jpg` to `holiday`
   * is a way to lose a photo out of the gallery, and nobody who retypes a name
   * means to do that -- so the suffix is held aside and re-attached on the way
   * out, and the note under the field says so.
   */
  private setRenaming(on: boolean): void {
    const entry = this.entry;
    if (on && !entry) return;
    this.renameRow.hidden = !on;
    this.titleWrap.hidden = on;
    this.editBtn.hidden = on || this.host.rename === undefined;
    this.renameNote.hidden = !on;
    if (!on) {
      this.renameNote.textContent = "";
      this.renameNote.classList.remove("is-bad");
      return;
    }
    const name = entry?.name ?? "";
    const dot = name.lastIndexOf(".");
    this.renameExt = dot > 0 ? name.slice(dot) : "";
    this.renameField.value = dot > 0 ? name.slice(0, dot) : name;
    this.renameNote.classList.remove("is-bad");
    this.renameNote.textContent = this.renameExt === ""
      ? "No extension to keep."
      : `Keeps the ${this.renameExt} ending.`;
    this.renameField.focus();
    this.renameField.select();
  }

  private async commitRename(): Promise<void> {
    const entry = this.entry;
    const doRename = this.host.rename;
    if (!entry || !doRename) return;

    const bad = (why: string): void => {
      this.renameNote.textContent = why;
      this.renameNote.classList.add("is-bad");
    };

    const stem = entry.name.slice(0, entry.name.length - this.renameExt.length);
    const typed = this.renameField.value.trim();
    if (typed === "" || typed === stem) { this.setRenaming(false); return; }
    // The characters that are not a name on any volume this runs on. Stripping
    // them quietly beats a rename that comes back as an errno.
    const clean = typed.replace(/[\/:*?"<>|]/g, "").trim();
    if (clean === "") { bad("That name has nothing usable in it."); return; }

    const name = clean + this.renameExt;
    try {
      const path = await doRename(entry, name);
      // The card is still showing the same bytes; only its address changed.
      this.entry = { ...entry, path, name };
      const title = document.createElement("span");
      title.textContent = name;
      this.heading.replaceChildren(title);
      this.renderFacts(this.entry);
      this.setRenaming(false);
    } catch (err) {
      bad(/exists/i.test(String(err))
        ? "There is already a file with that name here."
        : `Couldn't rename — ${String(err)}`);
    }
  }

  private setFacts(on: boolean): void {
    this.factsOn = on;
    this.facts.hidden = !on;
    this.infoBtn.setAttribute("aria-pressed", String(on));
  }

  private renderActions(entry: FileEntry): void {
    const acts = this.host.actions?.(entry) ?? [];
    this.actionBar.replaceChildren();
    this.actionBar.hidden = acts.length === 0;
    for (const a of acts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ql-action";
      // Through the icon set, not straight onto the span. Written out, the
      // bar mixed full-colour emoji (the delete can, the pen), a text glyph
      // (the OCR "abc") and one character no font on the device had at all,
      // which drew Redact as an empty white square. `icon` returns a
      // stroke-drawn SVG for anything it knows and the original text for
      // anything it does not, so this can only be an improvement.
      const g = icon(a.glyph);
      g.classList.add("ql-action-icon");
      const l = document.createElement("span");
      l.className = "ql-action-label";
      l.textContent = a.label;
      b.append(g, l);
      b.addEventListener("click", () => a.run());
      this.actionBar.append(b);
    }
  }

  private addFact(label: string, value: string): void {
    // Re-stating a fact (dimensions arriving after the image decodes) updates
    // in place instead of appending a second row.
    const existing = this.facts.querySelector<HTMLElement>(`[data-k="${cssEscape(label)}"]`);
    if (existing) {
      existing.textContent = value;
      return;
    }
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.dataset["k"] = label;
    dd.textContent = value;
    this.facts.append(dt, dd);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "ql-note";
  p.textContent = text;
  return p;
}

/**
 * A NUL byte or a heavy run of control characters is the giveaway for binary.
 * Sampling the head is enough — a file that is text at all is text at the top,
 * and the alternative (a full charset detector) is a library for a question
 * this cheap heuristic answers correctly for everything a person actually
 * double-clicks.
 */
function looksTextual(bytes: Uint8Array): boolean {
  let control = 0;
  const n = Math.min(bytes.length, 2048);
  for (let i = 0; i < n; i++) {
    const b = bytes[i] as number;
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / n < 0.05;
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.subarray(off, off + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

function hms(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60) > 0 ? `${Math.floor(m / 60)}:` : ""}${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Attribute selectors choke on spaces and quotes; labels are ours but short. */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "");
}
