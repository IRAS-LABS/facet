/**
 * Reading along on the real page.
 *
 * The reader's own view rebuilds the document as text: dark background, one
 * paragraph per line, in reading order. That is the right thing for a phone at
 * arm's length and for anything with no page geometry, and it is the wrong
 * thing for a research paper. A paper *is* its layout — the figure the
 * paragraph is about, the equation it just referred to, the table, the column
 * the eye is following. Rebuilt as a column of text, the words are all there
 * and the paper is gone. So this is the other half: the page exactly as it
 * looks, with the spoken sentence lit up on it.
 *
 * It is much less work than it sounds, because the reader was built for it.
 * `ReadWord.box` and `ReadDoc.sizes` have been carried through every adapter
 * from the start for exactly this. What is left is to draw the page and put a
 * transparent, positioned copy of each word on top of it.
 *
 * Three things are worth knowing about how it is done:
 *
 * **The word boxes are positioned in per cent, not pixels.** A page drawn at
 * 1.5× and the same page drawn at 3× want the same overlay, so the overlay is
 * expressed in the page's own proportions and zoom becomes a single width
 * change on the wrapper. The alternative — recomputing several thousand
 * absolute positions on every zoom step and every window resize — is the
 * difference between a zoom that feels instant and one that stutters.
 *
 * **Pages are drawn only when they are near the screen, and released when they
 * are not.** A sixty-page paper at 2× is about 1.5 GB of canvas if you draw it
 * all, which on a phone is not a slow reader but a dead one. The sheet keeps
 * its exact aspect ratio whether or not it has been drawn, so nothing moves
 * under the reader when a page arrives.
 *
 * **The DOM contract is identical to the text view.** Same `.read-block` with
 * `data-block`, same `.read-word` with `data-word`, same class names for the
 * highlight. That is deliberate: the highlighter, the follow-scrolling and
 * tap-a-word-to-start-there in `read-view.ts` all work here without knowing
 * this file exists.
 */

import { loadPdfjs } from "@core/explorer/preview";
import { loadPicture } from "@core/canvas/picture";
import type { ReadBlock, ReadDoc } from "@core/voice/doc";
import { boxOf, type Box } from "@core/ocr/page";

/** How far outside the view a page is drawn before it is needed. */
const NEAR = "150% 0px";

/**
 * The most pages held as pixels at once.
 *
 * Six is two either side of the one being read plus room for a fast scroll.
 * At 2× on a letter page that is about 150 MB, which is affordable on a phone;
 * it is the number that stops this being a memory leak with a page-turn
 * animation.
 */
const DRAWN_CAP = 6;

/** What the page view needs from the reader to fetch bytes. */
export interface SheetHost {
  fileUrl(path: string): Promise<string>;
}

/** Can this document be shown as pages at all? */
export function hasPages(doc: ReadDoc | null): boolean {
  if (!doc || doc.sizes.length === 0) return false;
  if (!doc.sizes.some((s) => s.width > 0 && s.height > 0)) return false;
  // Geometry for the sheet is not enough: without word boxes the overlay would
  // be an empty sheet nobody can click on and nothing can highlight.
  return doc.blocks.some((b) => b.words.some((w) => w.box));
}

export class Sheets {
  private readonly sheets: HTMLElement[] = [];
  private readonly canvases = new Map<number, HTMLCanvasElement>();
  /** Pages with pixels in them, oldest first, so the cap has something to drop. */
  private readonly drawn: number[] = [];
  private watcher: IntersectionObserver | null = null;

  private pdfTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
  private pdfDoc: import("pdfjs-dist").PDFDocumentProxy | null = null;
  private url = "";
  private path = "";
  /** Kept so a zoom can redraw the pages it already has at the new size. */
  private doc: ReadDoc | null = null;
  /** Bumped on every open and close, so a draw for an old document is dropped. */
  private era = 0;

  constructor(private readonly host: SheetHost) {}

  /**
   * Build the page view for a document.
   *
   * Fills `blockEls` the same way the text view does, so the caller's
   * highlighter keeps working on whichever view is showing.
   */
  build(
    path: string,
    doc: ReadDoc,
    blockEls: HTMLElement[],
    scroller: HTMLElement | null = null,
  ): DocumentFragment {
    this.doc = doc;
    this.release();
    this.path = path;
    const era = ++this.era;
    const frag = document.createDocumentFragment();

    // Blocks grouped by the page they sit on. A block belongs to one page by
    // construction, so this is a bucket sort rather than a search.
    const byPage = new Map<number, number[]>();
    for (let i = 0; i < doc.blocks.length; i++) {
      const block = doc.blocks[i] as ReadBlock;
      const list = byPage.get(block.page);
      if (list) list.push(i);
      else byPage.set(block.page, [i]);
    }

    this.watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.page ?? -1);
          if (n < 0) continue;
          if (entry.isIntersecting) void this.draw(n, doc, era);
          else this.undraw(n);
        }
      },
      // The sheets scroll inside the reader's own pane, not the window, so
      // that pane is what `rootMargin` should be measured against -- with the
      // viewport as root the margin means something subtly different and a
      // page can be drawn a screenful too late on a short window.
      { root: scroller, rootMargin: NEAR },
    );

    for (let page = 0; page < Math.max(1, doc.pages); page++) {
      const size = doc.sizes[page];
      if (!size || size.width <= 0 || size.height <= 0) continue;

      const sheet = document.createElement("div");
      sheet.className = "read-sheet";
      sheet.dataset.page = String(page);
      // The aspect ratio is set before anything is drawn, so the scroll height
      // is right from the first frame and pages arriving later do not shove
      // the reader's place down the document.
      sheet.style.aspectRatio = `${size.width} / ${size.height}`;

      const label = document.createElement("div");
      label.className = "read-sheetnum";
      label.textContent = String(page + 1);
      sheet.append(label);

      const marks = document.createElement("div");
      marks.className = "read-marks";
      for (const i of byPage.get(page) ?? []) {
        const block = doc.blocks[i] as ReadBlock;
        const el = this.blockEl(block, i, size);
        if (!el) continue;
        blockEls[i] = el;
        marks.append(el);
      }
      sheet.append(marks);

      this.sheets[page] = sheet;
      this.watcher.observe(sheet);
      frag.append(sheet);
    }

    return frag;
  }

  /**
   * One block, as a transparent rectangle over the real words.
   *
   * Returns null when there is nothing to place it by. A block whose words all
   * lack boxes cannot be drawn on the page — text pulled out of an embedded
   * annotation, for instance — and inventing a position for it would put a
   * highlight somewhere the words are not, which is worse than not showing it.
   * The text view still has it, and the voice still reads it.
   */
  private blockEl(block: ReadBlock, index: number, size: { width: number; height: number }): HTMLElement | null {
    const boxes = block.words.map((w) => w.box).filter((b): b is Box => !!b);
    const outer = block.box ?? (boxes.length > 0 ? boxOf(boxes) : null);
    if (!outer) return null;

    const el = document.createElement("p");
    el.className = `read-block read-${block.kind}`;
    el.dataset.block = String(index);
    el.classList.toggle("read-off", block.skip);
    if (block.skip) el.title = block.why ?? "Skipped";
    place(el, outer, size.width, size.height);

    for (let w = 0; w < block.words.length; w++) {
      const word = block.words[w];
      if (!word?.box) continue;
      const span = document.createElement("span");
      span.className = "read-word";
      span.dataset.word = String(w);
      // The glyphs underneath are the real ones; this is a hit area, a
      // highlight and the text a long press selects, so its own type is for
      // screen readers and for the clipboard, not to be looked at. Two
      // overlapping *visible* copies of every word is exactly the blurry
      // double-vision people complain about in PDF viewers, which is why it
      // is transparent rather than small.
      //
      // The trailing space is what makes a copy read as prose. Each word is
      // its own element with nothing between them, so without it the
      // clipboard gets "Deepresiduallearning" -- correct in the DOM and
      // useless to the person who selected it.
      span.textContent = `${word.text} `;
      // Laid out at the size of the word it covers, in units of the sheet's
      // own width, so one width change is still the whole of a zoom. Anything
      // smaller and the platform's long press finds no text where the finger
      // went down: it hit-tests glyphs, not the boxes around them.
      span.style.fontSize = `${size.width > 0 ? (word.box.h / size.width) * 100 : 0}cqw`;
      place(span, word.box, outer.w, outer.h, outer);
      el.append(span);
    }

    return el;
  }

  /** Draw a page, if it is not already drawn. */
  private async draw(page: number, doc: ReadDoc, era: number): Promise<void> {
    if (this.era !== era) return;
    const sheet = this.sheets[page];
    if (!sheet || this.canvases.has(page)) return;

    const canvas = document.createElement("canvas");
    canvas.className = "read-canvas";
    // Claimed before the await so two observer callbacks in the same scroll
    // cannot both start drawing the same page.
    this.canvases.set(page, canvas);
    this.drawn.push(page);
    this.trim();

    try {
      if (!this.url) this.url = await this.host.fileUrl(this.path);
      if (this.era !== era) return;

      const size = doc.sizes[page] ?? { width: 0, height: 0 };
      if (this.path.toLowerCase().endsWith(".pdf")) await this.drawPdf(canvas, page, size);
      else await this.drawImage(canvas);

      if (this.era !== era || !this.canvases.has(page)) return;
      sheet.prepend(canvas);
    } catch {
      // A page that will not draw leaves the sheet blank with its overlay
      // still on it: the words can still be clicked and the voice still reads
      // them. An error box in the middle of a document would be worse.
      this.canvases.delete(page);
    }
  }

  private async drawPdf(
    canvas: HTMLCanvasElement,
    page: number,
    size: { width: number; height: number },
  ): Promise<void> {
    if (!this.pdfTask) {
      const pdfjs = await loadPdfjs();
      this.pdfTask = pdfjs.getDocument({ url: this.url });
      this.pdfDoc = await this.pdfTask.promise;
    }
    const doc = this.pdfDoc;
    if (!doc) throw new Error("the PDF would not open");

    const pdfPage = await doc.getPage(Math.min(page, doc.numPages - 1) + 1);
    // Scaled to the width the sheet is actually on screen at, times the
    // device's own pixel ratio, and capped: rendering a page at 4× to show it
    // at 400 CSS pixels wide costs sixteen times the memory for pixels nobody
    // can see, and on a phone that is the whole budget.
    const wide = this.sheets[page]?.clientWidth || 700;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.min(3, Math.max(1, (wide * ratio) / (size.width || wide)));

    const view = pdfPage.getViewport({ scale });
    canvas.width = Math.round(view.width);
    canvas.height = Math.round(view.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    // White first: a PDF page is transparent wherever nothing is drawn, and on
    // the reader's dark panel that would show as a black page with black text.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvas, canvasContext: ctx, viewport: view }).promise;
  }

  private async drawImage(canvas: HTMLCanvasElement): Promise<void> {
    const img = await loadPicture(this.url, "not a picture this build can open");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
  }

  /** Give a page's pixels back. The sheet and its overlay stay. */
  private undraw(page: number): void {
    const canvas = this.canvases.get(page);
    if (!canvas) return;
    this.canvases.delete(page);
    const at = this.drawn.indexOf(page);
    if (at >= 0) this.drawn.splice(at, 1);
    canvas.remove();
    // Removing the element is not enough on its own: the backing store lives
    // until the canvas is resized away, and a detached 40 MB canvas held by
    // nothing still costs 40 MB until the collector gets to it.
    canvas.width = 0;
    canvas.height = 0;
  }

  /**
   * Redraw the pages that have pixels, at whatever size they are now.
   *
   * A canvas rasterised for a 400-pixel-wide sheet and then shown at 1200 is
   * three times too coarse -- readable as a shape, useless as a paper. The
   * render reads `clientWidth` every time, so throwing the old pixels away and
   * asking again is the whole of it. Only the drawn pages: the rest are still
   * blank and the observer will draw them at the new size when they arrive.
   */
  rescale(): void {
    const doc = this.doc;
    if (!doc) return;
    const pages = [...this.canvases.keys()];
    for (const page of pages) this.undraw(page);
    for (const page of pages) void this.draw(page, doc, this.era);
  }

  private trim(): void {
    while (this.drawn.length > DRAWN_CAP) {
      const oldest = this.drawn[0];
      if (oldest === undefined) return;
      this.undraw(oldest);
    }
  }

  /** Drop everything: the observer, the pixels, and the PDF worker. */
  release(): void {
    this.era++;
    this.watcher?.disconnect();
    this.watcher = null;
    for (const page of [...this.canvases.keys()]) this.undraw(page);
    this.sheets.length = 0;
    this.drawn.length = 0;
    this.doc = null;
    this.url = "";
    const task = this.pdfTask;
    this.pdfTask = null;
    this.pdfDoc = null;
    void task?.destroy().catch(() => {
      // Destroying a task that already failed to load is not worth reporting.
    });
  }
}

/**
 * Position an element over its share of the page, in per cent.
 *
 * `within` is the box the element's offset parent covers, when it has one --
 * a word is placed inside its own block, not inside the page.
 */
function place(el: HTMLElement, box: Box, width: number, height: number, within?: Box): void {
  const left = within ? box.x - within.x : box.x;
  const top = within ? box.y - within.y : box.y;
  const pc = (v: number, of: number): string => `${of > 0 ? (v / of) * 100 : 0}%`;
  el.style.left = pc(left, width);
  el.style.top = pc(top, height);
  el.style.width = pc(box.w, width);
  el.style.height = pc(box.h, height);
}
