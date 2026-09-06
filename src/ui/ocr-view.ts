/**
 * Reading a document (item 32).
 *
 * Opens over any image or PDF with **R**. Tesseract runs on this machine; the
 * only thing that touches the network is the language pack, once, the first
 * time a language is chosen. A scan of a bank statement is not uploaded
 * anywhere, which is the entire reason this is a panel in a file explorer
 * rather than one of the dozen websites that will do it for you.
 *
 * The work is elsewhere. `@core/ocr/page` holds every judgement — reading
 * order, paragraphs, hyphens, search, what counts as a bad scan — and
 * `@core/ocr/engine` runs the worker. This file is the surface, and four
 * things about it are deliberate.
 *
 * **The words stay on the picture.** Recognised text is drawn as boxes over
 * the page, not just poured into a pane. That is what makes the result
 * checkable: a user can see at a glance that the total in the corner was read
 * as `1,240.00` and the boxes sit where the numbers are. A text pane alone
 * gives you no way to tell a good result from a confident wrong one.
 *
 * **Doubt is visible.** Words the engine was unsure of are drawn differently
 * and can be listed on their own. OCR's failure mode is silent — plausible
 * words in the right places that say something the page does not — so the one
 * thing this panel must never do is present a guess as a reading.
 *
 * **Columns are followed, not scanned across.** Two columns read top to bottom
 * interleave into nonsense that is word-perfect and unusable. `readingOrder`
 * does the work; this panel just never second-guesses it.
 *
 * **Nothing is written until asked.** The text lives in the panel. Save writes
 * a new file beside the original, which is never touched.
 */

import { loadPdfjs } from "@core/explorer/preview";
import {
  LANGUAGES,
  Tesseract,
  nameOfLanguage,
  type Progress,
  type Recogniser,
} from "@core/ocr/engine";
import {
  blankPage,
  docText,
  meanConfidence,
  pageText,
  problems,
  searchPage,
  textOfWords,
  wordAt,
  wordsInRect,
  wordsOf,
  type Box,
  type OcrPage,
  type OcrWord,
} from "@core/ocr/page";
import { mergePdfs } from "@core/ocr/pdf";

export interface OcrHost {
  fileUrl(path: string): Promise<string>;
  writeFile(path: string, bytes: Uint8Array, overwrite?: boolean): Promise<string>;
  refresh(): void;
  /** Overrides the real engine. Only the harness passes one. */
  engine?: Recogniser;
}

/** What the panel will open. PDFs are rendered a page at a time. */
export const OCR_EXTS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
  "tif",
  "tiff",
];

/**
 * Below this the word is drawn as doubtful.
 *
 * Tesseract's per-word confidence is not a probability and should not be read
 * as one, but it separates "read cleanly" from "guessed" well enough to be
 * worth showing. 75 is where, on the scans this was built against, the marked
 * words started actually being the wrong ones.
 */
const DOUBT = 75;

/** How wide the picture is drawn, as a percentage of the space available. */
const ZOOMS = [100, 150, 200, 300, 400];

interface Read {
  page: OcrPage;
  pdf?: Uint8Array;
}

export class OcrView {
  private readonly root = document.createElement("div");
  private readonly titleEl = document.createElement("div");
  private readonly note = document.createElement("div");
  private readonly flags = document.createElement("div");
  private readonly setup = document.createElement("div");
  private readonly barWrap = document.createElement("div");
  private readonly bar = document.createElement("div");
  private readonly barNote = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly stage = document.createElement("div");
  private readonly shot = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly boxes = document.createElement("div");
  private readonly marquee = document.createElement("div");
  private readonly textPane = document.createElement("div");
  private readonly exportBar = document.createElement("div");

  private readonly langSel = document.createElement("select");
  private readonly lang2Sel = document.createElement("select");
  private readonly pdfBox = document.createElement("input");
  private readonly allBox = document.createElement("input");
  private readonly doubtBox = document.createElement("input");
  private readonly readBtn = document.createElement("button");
  private readonly stopBtn = document.createElement("button");
  private readonly findIn = document.createElement("input");
  private readonly nameIn = document.createElement("input");
  private readonly pageNote = document.createElement("span");
  private readonly zoomNote = document.createElement("span");
  private readonly savePdfBtn = document.createElement("button");

  private path = "";
  private isPdf = false;
  private pageCount = 1;
  private at = 0;
  private zoom = 0;
  /** Only the pages that have actually been read. */
  private readonly done = new Map<number, Read>();
  private engine: Recogniser | null = null;
  private running = false;
  private cancelled = false;
  private query = "";
  private picked: OcrWord[] = [];
  /** Set while the pointer is down on the picture, in page pixels. */
  private dragFrom: { x: number; y: number } | null = null;
  private pdfTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
  private pdfDoc: import("pdfjs-dist").PDFDocumentProxy | null = null;

  constructor(private readonly host: OcrHost) {
    this.root.className = "ocr";
    this.root.hidden = true;

    const head = document.createElement("header");
    head.className = "ocr-bar";
    this.titleEl.className = "ocr-title";
    this.note.className = "ocr-note";
    head.append(this.titleEl, this.note, this.btn("✕", "Close  (Esc)", () => this.close()));

    this.flags.className = "ocr-flags";

    this.buildSetup();
    this.buildProgress();
    this.buildBody();
    this.buildExport();

    this.root.append(head, this.flags, this.setup, this.barWrap, this.body, this.exportBar);
    document.body.appendChild(this.root);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
  }

  // ── Building ──────────────────────────────────────────────────────────────

  private buildSetup(): void {
    this.setup.className = "ocr-setup";

    for (const l of LANGUAGES) {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = l.name;
      this.langSel.append(o);
    }
    this.langSel.value = "eng";

    // A second language rather than a multi-select: two is where the gain
    // stops. Each one added slows recognition and gives the engine another
    // alphabet to mistake a letter for, and a document in three scripts is
    // rare enough to be worth reading twice.
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "—";
    this.lang2Sel.append(none);
    for (const l of LANGUAGES) {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = l.name;
      this.lang2Sel.append(o);
    }

    this.pdfBox.type = "checkbox";
    this.pdfBox.title =
      "Writes a copy of the picture with the text laid invisibly on top, so the " +
      "PDF can be searched and copied from while still looking like the scan.";

    this.allBox.type = "checkbox";
    this.allBox.checked = true;

    this.doubtBox.type = "checkbox";
    this.doubtBox.checked = true;
    this.doubtBox.addEventListener("change", () => this.paintBoxes());

    this.readBtn.className = "ocr-go";
    this.readBtn.textContent = "Read";
    this.readBtn.addEventListener("click", () => void this.begin());

    this.setup.append(
      this.field("Language", this.langSel),
      this.field("and", this.lang2Sel),
      this.check("Searchable PDF", this.pdfBox),
      this.check("Mark doubtful words", this.doubtBox),
      this.readBtn,
    );
  }

  private buildProgress(): void {
    this.barWrap.className = "ocr-progress";
    this.barWrap.hidden = true;
    this.bar.className = "ocr-fill";
    const track = document.createElement("div");
    track.className = "ocr-track";
    track.append(this.bar);
    this.barNote.className = "ocr-barnote";
    this.stopBtn.className = "ocr-stop";
    this.stopBtn.textContent = "Stop";
    this.stopBtn.title = "Keeps the pages already read.";
    this.stopBtn.addEventListener("click", () => void this.halt());
    this.barWrap.append(track, this.barNote, this.stopBtn);
  }

  private buildBody(): void {
    this.body.className = "ocr-body";

    this.stage.className = "ocr-stage";
    this.shot.className = "ocr-shot";
    this.canvas.className = "ocr-canvas";
    this.boxes.className = "ocr-boxes";
    this.marquee.className = "ocr-marquee";
    this.marquee.hidden = true;
    this.boxes.append(this.marquee);
    this.shot.append(this.canvas, this.boxes);
    this.stage.append(this.shot);

    this.boxes.addEventListener("pointerdown", (e) => this.down(e));
    this.boxes.addEventListener("pointermove", (e) => this.move(e));
    this.boxes.addEventListener("pointerup", (e) => this.up(e));

    this.textPane.className = "ocr-text";
    this.textPane.tabIndex = 0;

    this.body.append(this.stage, this.textPane);
  }

  private buildExport(): void {
    this.exportBar.className = "ocr-export";

    const prev = this.btn("‹", "Previous page  (←)", () => void this.goto(this.at - 1));
    const next = this.btn("›", "Next page  (→)", () => void this.goto(this.at + 1));
    prev.className = "ocr-step";
    next.className = "ocr-step";
    this.pageNote.className = "ocr-pageno";

    const out = this.btn("−", "Smaller  (−)", () => this.setZoom(this.zoom - 1));
    const inn = this.btn("+", "Bigger  (+)", () => this.setZoom(this.zoom + 1));
    out.className = "ocr-step";
    inn.className = "ocr-step";
    this.zoomNote.className = "ocr-pageno";

    this.findIn.type = "search";
    this.findIn.placeholder = "Find on the page";
    this.findIn.className = "ocr-find";
    this.findIn.addEventListener("input", () => {
      this.query = this.findIn.value;
      this.paintBoxes();
      this.paintText();
      this.sayFound();
    });

    this.nameIn.type = "text";
    this.nameIn.className = "ocr-name";

    this.savePdfBtn.type = "button";
    this.savePdfBtn.textContent = "Save PDF";
    this.savePdfBtn.title = "Write the searchable PDF beside the original";
    this.savePdfBtn.disabled = true;
    this.savePdfBtn.addEventListener("click", () => void this.savePdf());

    const copy = this.btn("Copy", "Copy the text — or just the selected words", () =>
      void this.copy(),
    );
    const save = this.btn("Save text", "Write it beside the original", () => void this.save());
    save.classList.add("ocr-go");

    this.exportBar.append(
      prev,
      this.pageNote,
      next,
      out,
      this.zoomNote,
      inn,
      this.findIn,
      this.check("All pages", this.allBox),
      this.nameIn,
      copy,
      this.savePdfBtn,
      save,
    );
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "ocr-field";
    const text = document.createElement("span");
    text.textContent = label;
    wrap.append(text, control);
    return wrap;
  }

  private check(label: string, box: HTMLInputElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "ocr-check";
    const text = document.createElement("span");
    text.textContent = label;
    wrap.append(box, text);
    return wrap;
  }

  private btn(text: string, tip: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = tip;
    b.addEventListener("click", run);
    return b;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get openPath(): string | null {
    return this.root.hidden ? null : this.path;
  }

  /** What has been read so far, for anything that wants to ask. */
  get pages(): ReadonlyMap<number, OcrPage> {
    return new Map([...this.done].map(([i, r]) => [i, r.page]));
  }

  async open(path: string): Promise<void> {
    await this.shutPdf();
    this.path = path;
    this.root.hidden = false;
    this.done.clear();
    this.picked = [];
    this.query = "";
    this.findIn.value = "";
    this.at = 0;
    this.zoom = 0;
    this.pageCount = 1;
    this.isPdf = /\.pdf$/i.test(path);
    this.textPane.replaceChildren();
    this.boxes.replaceChildren(this.marquee);
    this.flags.replaceChildren();
    this.barWrap.hidden = true;
    this.readBtn.disabled = false;
    this.savePdfBtn.disabled = true;

    const name = path.split(/[\\/]/).pop() ?? path;
    this.titleEl.textContent = name;
    this.nameIn.value = `${name.replace(/\.[^.]+$/, "")}.txt`;

    this.say("Opening…");
    try {
      await this.load();
    } catch (e) {
      this.say(`Cannot open this file — ${e instanceof Error ? e.message : String(e)}`, true);
      this.readBtn.disabled = true;
      return;
    }
    this.allBox.disabled = !this.isPdf || this.pageCount < 2;
    this.setZoom(0);
    this.tellPage();
    this.say(
      this.isPdf && this.pageCount > 1
        ? `${this.pageCount} pages · press Read`
        : "Press Read",
    );
    this.textPane.focus();
  }

  close(): void {
    void this.halt();
    void this.engine?.close();
    void this.shutPdf();
    this.engine = null;
    this.root.hidden = true;
  }

  // ── The picture ───────────────────────────────────────────────────────────

  /**
   * Draw the current page onto the canvas at a size worth reading.
   *
   * PDFs are rendered rather than decoded: a scanned PDF is a picture in a
   * wrapper, and a born-digital one has selectable text already — but reading
   * *both* through the same path means one code path and a result that is
   * right either way, including the common awkward case of a digital document
   * with a scanned page stapled into the middle of it.
   */
  private async load(): Promise<void> {
    const url = await this.host.fileUrl(this.path);
    if (this.isPdf) await this.loadPdfPage(url, this.at);
    else await this.loadImage(url);
  }

  private async loadImage(url: string): Promise<void> {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.decoding = "async";
      el.addEventListener("load", () => resolve(el));
      el.addEventListener("error", () => reject(new Error("not a picture this build can open")));
      el.src = url;
    });
    this.canvas.width = img.naturalWidth;
    this.canvas.height = img.naturalHeight;
    this.canvas.getContext("2d")?.drawImage(img, 0, 0);
    this.pageCount = 1;
  }

  private async loadPdfPage(url: string, index: number): Promise<void> {
    // Opened once and held: a twelve-page document turned page by page would
    // otherwise re-parse the whole file twelve times, and on a large scan that
    // is the slowest thing in the panel by a distance.
    if (!this.pdfTask) {
      const pdfjs = await loadPdfjs();
      this.pdfTask = pdfjs.getDocument({ url });
      this.pdfDoc = await this.pdfTask.promise;
    }
    const doc = this.pdfDoc;
    if (!doc) throw new Error("the PDF would not open");
    this.pageCount = doc.numPages;
    const page = await doc.getPage(Math.min(index, doc.numPages - 1) + 1);

    // A PDF page has no pixels, only a size in points, so a scale has to be
    // chosen. 2× puts a letter page at about 200 dpi, which the engine's own
    // upscaling can lift the rest of the way; going straight to 4× here would
    // quadruple the memory for a page that is often already sharp.
    const view = page.getViewport({ scale: 2 });
    this.canvas.width = Math.round(view.width);
    this.canvas.height = Math.round(view.height);
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      // White first: PDF pages are transparent where nothing is drawn, and
      // Tesseract on a transparent-black background reads nothing at all.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      await page.render({ canvas: this.canvas, canvasContext: ctx, viewport: view }).promise;
    }
  }

  /** Let the worker go. Safe to call when nothing is open. */
  private async shutPdf(): Promise<void> {
    const task = this.pdfTask;
    this.pdfTask = null;
    this.pdfDoc = null;
    if (!task) return;
    try {
      await task.destroy();
    } catch {
      // Destroying a task that already failed to load is not worth reporting.
    }
  }

  private async goto(index: number): Promise<void> {
    const want = Math.max(0, Math.min(this.pageCount - 1, index));
    if (want === this.at || this.running) return;
    this.at = want;
    this.picked = [];
    try {
      await this.load();
    } catch (e) {
      this.say(`Cannot draw page ${want + 1} — ${String(e)}`, true);
      return;
    }
    this.tellPage();
    this.paint();
  }

  private setZoom(step: number): void {
    this.zoom = Math.max(0, Math.min(ZOOMS.length - 1, step));
    this.shot.style.width = `${ZOOMS[this.zoom] ?? 100}%`;
    this.zoomNote.textContent = `${ZOOMS[this.zoom] ?? 100}%`;
  }

  private tellPage(): void {
    this.pageNote.textContent = this.pageCount > 1 ? `${this.at + 1} / ${this.pageCount}` : "1";
  }

  // ── Running ───────────────────────────────────────────────────────────────

  private async begin(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    this.readBtn.disabled = true;
    this.stopBtn.disabled = false;
    this.barWrap.hidden = false;
    this.flags.replaceChildren();

    const engine = this.engine ?? this.host.engine ?? new Tesseract();
    this.engine = engine;

    const wantPdf = this.pdfBox.checked;
    const language = [this.langSel.value, this.lang2Sel.value].filter(Boolean).join("+");
    const targets = this.allBox.checked && !this.allBox.disabled
      ? Array.from({ length: this.pageCount }, (_, i) => i)
      : [this.at];

    try {
      for (let n = 0; n < targets.length; n++) {
        const index = targets[n] ?? 0;
        if (this.cancelled) break;
        if (index !== this.at) {
          this.at = index;
          this.tellPage();
          await this.load();
        }
        const result = await engine.read(this.canvas, {
          language,
          pdf: wantPdf,
          title: this.titleEl.textContent ?? "",
          onProgress: (p) => this.progress(p, n, targets.length),
        });
        if (this.cancelled) break;
        this.done.set(index, result.pdf ? { page: result.page, pdf: result.pdf } : { page: result.page });
        this.paint();
      }
      this.finish();
    } catch (e) {
      this.barWrap.hidden = true;
      this.say(
        this.cancelled
          ? `Stopped — ${this.done.size} page${this.done.size === 1 ? "" : "s"} kept.`
          : `Reading failed — ${e instanceof Error ? e.message : String(e)}`,
        !this.cancelled,
      );
    } finally {
      this.running = false;
      this.readBtn.disabled = false;
    }
  }

  private progress(p: Progress, n: number, total: number): void {
    const share = p.done < 0 ? 0.5 : p.done;
    const overall = (n + share) / total;
    this.bar.style.width = `${Math.round(overall * 100)}%`;
    this.bar.classList.toggle("ocr-unknown", p.done < 0);
    this.barNote.textContent = total > 1 ? `${p.what} — page ${n + 1} of ${total}` : p.what;
  }

  /**
   * Stopping kills the worker, so it also throws away the page in flight.
   *
   * There is no way to ask Tesseract for a partial page — the WASM call does
   * not return until it is done — so the honest thing is to keep the pages
   * that finished and say so, rather than to leave a half-read page looking
   * like a whole one.
   */
  private async halt(): Promise<void> {
    if (!this.running) return;
    this.cancelled = true;
    this.stopBtn.disabled = true;
    this.barWrap.hidden = true;
    await this.engine?.cancel();
  }

  private finish(): void {
    this.barWrap.hidden = true;
    const page = this.current;
    const words = wordsOf(page).length;
    const read = this.done.size;
    this.savePdfBtn.disabled = ![...this.done.values()].some((r) => r.pdf);
    this.say(
      words === 0
        ? "Nothing readable on this page."
        : `${words} words · ${Math.round(meanConfidence(page))}% sure · ` +
            `${read} page${read === 1 ? "" : "s"} read · ${nameOfLanguage(page.language)}`,
    );
    this.paint();
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  private get current(): OcrPage {
    return this.done.get(this.at)?.page ?? blankPage(this.canvas.width, this.canvas.height);
  }

  private paint(): void {
    this.paintBoxes();
    this.paintText();
    this.paintFlags();
  }

  /**
   * One absolutely-positioned element per word, in per-cent of the picture.
   *
   * Per-cent rather than pixels so that zooming is a single CSS width change
   * on the wrapper and every box follows exactly. Pixels would mean recomputing
   * several thousand positions on each zoom step and getting them subtly wrong
   * at fractional scales — which shows up as boxes drifting off their words the
   * further down the page you look.
   */
  private paintBoxes(): void {
    const page = this.current;
    const hits = new Set<OcrWord>();
    if (this.query.trim()) {
      for (const m of searchPage(page, this.query)) for (const w of m.words) hits.add(w);
    }
    const chosen = new Set(this.picked);

    const kids: HTMLElement[] = [this.marquee];
    if (page.width > 0 && page.height > 0) {
      for (const word of wordsOf(page)) {
        const el = document.createElement("div");
        el.className = "ocr-word";
        if (this.doubtBox.checked && word.confidence < DOUBT) el.classList.add("ocr-doubt");
        if (hits.has(word)) el.classList.add("ocr-hit");
        if (chosen.has(word)) el.classList.add("ocr-picked");
        el.style.left = `${(word.box.x / page.width) * 100}%`;
        el.style.top = `${(word.box.y / page.height) * 100}%`;
        el.style.width = `${(word.box.w / page.width) * 100}%`;
        el.style.height = `${(word.box.h / page.height) * 100}%`;
        el.title = `${word.text} — ${Math.round(word.confidence)}%`;
        kids.push(el);
      }
    }
    this.boxes.replaceChildren(...kids);
  }

  private paintText(): void {
    const page = this.current;
    const text = pageText(page);
    const q = this.query.trim().toLowerCase();

    const kids: HTMLElement[] = [];
    for (const para of text.split("\n\n")) {
      const p = document.createElement("p");
      p.className = "ocr-para";
      if (!q) {
        p.textContent = para;
      } else {
        // Split on the query rather than using innerHTML: the text came off a
        // scan and may contain anything, and building markup out of it would
        // be the one place in this feature where a document could run code.
        const lower = para.toLowerCase();
        let from = 0;
        for (;;) {
          const found = lower.indexOf(q, from);
          if (found < 0) break;
          if (found > from) p.append(para.slice(from, found));
          const mark = document.createElement("mark");
          mark.textContent = para.slice(found, found + q.length);
          p.append(mark);
          from = found + q.length;
        }
        p.append(para.slice(from));
      }
      kids.push(p);
    }
    this.textPane.replaceChildren(...kids);
  }

  /**
   * Why the result is disappointing, always visible.
   *
   * Not on hover and not folded away: these are the sentences that tell a user
   * their 96 dpi screenshot is the problem, and a warning nobody reads is the
   * same as no warning.
   */
  private paintFlags(): void {
    const found = this.done.size === 0 ? [] : problems(this.current);
    const kids = found.map((p) => {
      const el = document.createElement("div");
      el.className = `ocr-flag ocr-flag-${p.kind}`;
      el.textContent = p.note;
      return el;
    });
    this.flags.replaceChildren(...kids);
  }

  // ── Pointing at words ─────────────────────────────────────────────────────

  /** Client coordinates to page pixels. */
  private pointIn(e: PointerEvent): { x: number; y: number } {
    const page = this.current;
    const box = this.boxes.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - box.left) / box.width) * page.width,
      y: ((e.clientY - box.top) / box.height) * page.height,
    };
  }

  private down(e: PointerEvent): void {
    if (this.done.size === 0) return;
    this.dragFrom = this.pointIn(e);
    this.boxes.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    if (!this.dragFrom) return;
    const now = this.pointIn(e);
    const rect = between(this.dragFrom, now);
    const page = this.current;
    if (page.width === 0 || page.height === 0) return;
    this.marquee.hidden = false;
    this.marquee.style.left = `${(rect.x / page.width) * 100}%`;
    this.marquee.style.top = `${(rect.y / page.height) * 100}%`;
    this.marquee.style.width = `${(rect.w / page.width) * 100}%`;
    this.marquee.style.height = `${(rect.h / page.height) * 100}%`;
  }

  private up(e: PointerEvent): void {
    const from = this.dragFrom;
    this.dragFrom = null;
    this.marquee.hidden = true;
    if (!from) return;
    const now = this.pointIn(e);
    const page = this.current;
    const rect = between(from, now);

    // A drag under a few pixels is a click, not a marquee. Without this every
    // click selects an empty rectangle and clears the selection the user was
    // trying to make, because nobody presses a mouse button without moving.
    const tiny = rect.w < page.width * 0.004 && rect.h < page.height * 0.004;
    this.picked = tiny
      ? [wordAt(page, now.x, now.y)].filter((w): w is OcrWord => w !== null)
      : wordsInRect(page, rect);

    this.paintBoxes();
    this.sayPicked();
  }

  private sayPicked(): void {
    if (this.picked.length === 0) return;
    if (this.picked.length === 1) {
      const word = this.picked[0] as OcrWord;
      this.say(`“${word.text}” — ${Math.round(word.confidence)}% sure. Copy copies it alone.`);
      return;
    }
    this.say(`${this.picked.length} words selected. Copy copies just these.`);
  }

  private sayFound(): void {
    const q = this.query.trim();
    if (!q || this.done.size === 0) return;
    const hits = searchPage(this.current, q);
    this.say(
      hits.length === 0
        ? `“${q}” is not on this page.`
        : `${hits.length} match${hits.length === 1 ? "" : "es"} on this page.`,
    );
  }

  // ── Out ───────────────────────────────────────────────────────────────────

  /** The selection if there is one, otherwise everything read. */
  private text(): string {
    if (this.picked.length > 0) return textOfWords(this.picked);
    const indices = [...this.done.keys()].sort((a, b) => a - b);
    return docText({
      pages: indices.map((i) => (this.done.get(i) as Read).page),
      source: this.path,
    });
  }

  private async copy(): Promise<void> {
    const text = this.text();
    if (!text) {
      this.say("There is nothing to copy yet — press Read.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.say(this.picked.length > 0 ? "Selection copied." : "Copied.");
    } catch {
      this.say("The clipboard refused — save it instead.", true);
    }
  }

  private async save(): Promise<void> {
    const name = this.nameIn.value.trim();
    if (!name) {
      this.say("Give the file a name first.", true);
      return;
    }
    if (this.done.size === 0) {
      this.say("Nothing has been read yet.", true);
      return;
    }
    await this.write(name, new TextEncoder().encode(this.text()));
  }

  private async savePdf(): Promise<void> {
    const parts = [...this.done.keys()]
      .sort((a, b) => a - b)
      .map((i) => this.done.get(i)?.pdf)
      .filter((b): b is Uint8Array => b !== undefined && b.length > 0);
    if (parts.length === 0) {
      this.say("Tick “Searchable PDF” and read the page first.", true);
      return;
    }
    const base = (this.path.split(/[\\/]/).pop() ?? "page").replace(/\.[^.]+$/, "");
    try {
      const bytes = await mergePdfs(parts);
      await this.write(`${base} (searchable).pdf`, bytes);
    } catch (e) {
      this.say(`Could not build the PDF — ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private async write(name: string, bytes: Uint8Array): Promise<void> {
    const folder = this.path.replace(/[\\/][^\\/]+$/, "");
    try {
      // `false`: never over the original. The panel writes beside it, and if
      // the name is taken the host picks the next free one and says which.
      const written = await this.host.writeFile(`${folder}/${name}`, bytes, false);
      this.host.refresh();
      this.say(`Saved as ${written.split(/[\\/]/).pop()}`);
    } catch (e) {
      this.say(`Could not save — ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  // ── Odds and ends ─────────────────────────────────────────────────────────

  private say(message: string, bad = false): void {
    this.note.textContent = message;
    this.note.classList.toggle("ocr-bad", bad);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    const typing =
      e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (typing) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      this.findIn.focus();
      this.findIn.select();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void this.copy();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      void this.goto(this.at + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      void this.goto(this.at - 1);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      this.setZoom(this.zoom + 1);
    } else if (e.key === "-") {
      e.preventDefault();
      this.setZoom(this.zoom - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void this.begin();
    }
  }
}

/** The rectangle two points describe, whichever order they were given in. */
function between(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}
