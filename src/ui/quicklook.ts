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
}

/** Extensions the webview will actually paint. Anything else gets facts only. */
const WEB_IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "ico"]);
const WEB_VIDEO = new Set(["mp4", "webm", "m4v", "mov", "ogv"]);
const WEB_AUDIO = new Set(["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac"]);

/** Enough to show the shape of a file without pulling a gigabyte over IPC. */
const HEAD_BYTES = 16384;
const TEXT_CHARS = 4000;
const HEX_BYTES = 512;

/** How many pages of a PDF a quick look rasterizes. A peek, not a reader —
 *  past this it says how much more there is instead of grinding through a
 *  four-hundred-page manual nobody asked to see all of. */
const PDF_PAGE_CAP = 20;

export class QuickLook {
  private readonly root: HTMLElement;
  private readonly card = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly facts = document.createElement("dl");
  private readonly heading = document.createElement("button");
  private readonly actionBar = document.createElement("div");
  private readonly infoBtn = document.createElement("button");

  /** Whether the facts are showing. Folded to start with on a phone. */
  private factsOn: boolean;

  /** Guards against a slow read painting into a card that moved on. */
  private token = 0;

  /** What is on screen. Kept only so the session record can name it. */
  private entry: FileEntry | null = null;

  /** The open pdf.js document, so closing the card frees its worker memory. */
  private pdfTask: { destroy(): Promise<void> } | null = null;

  constructor(private readonly host: QuickLookHost) {
    this.root = document.createElement("div");
    this.root.className = "ql";
    this.root.hidden = true;

    this.card.className = "ql-card";
    // A button, not a heading: the name is the obvious thing to tap to ask
    // "what is this file", and it was inert. It still reads as the title.
    this.heading.className = "ql-title";
    this.heading.type = "button";
    this.heading.title = "Show file details";
    this.heading.addEventListener("click", () => this.setFacts(!this.factsOn));
    this.body.className = "ql-body";
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
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ql-close";
    close.textContent = "✕";
    close.title = "Close  (Esc)";
    close.addEventListener("click", () => this.close());
    head.append(this.heading, this.infoBtn, close);
    this.card.append(head, this.body, this.actionBar, this.facts);
    this.root.append(this.card);

    // Nothing is on screen yet; `show()` sets the real value per file.
    this.factsOn = true;
    this.setFacts(true);
    document.body.appendChild(this.root);

    // Clicking the dimmed ground closes; clicking the card must not.
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
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
    this.body.replaceChildren();
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
    this.heading.textContent = entry.name;
    this.body.replaceChildren(note("Reading…"));
    this.renderFacts(entry);
    this.renderActions(entry);
    // Every file starts folded on a phone, including the second one opened in
    // the same session -- leaving it open because the last file's details were
    // read would be the same permanent block of text, one tap later.
    this.setFacts(this.host.factsFolded?.() !== true);

    try {
      const node = await this.preview(entry);
      if (mine !== this.token) return;
      this.body.replaceChildren(node);
    } catch (e) {
      if (mine !== this.token) return;
      this.body.replaceChildren(note(`Could not read this file — ${String(e)}`));
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

  // ── PDF ───────────────────────────────────────────────────────────────────

  /**
   * Renders the first page synchronously with the card, then keeps appending
   * pages behind it — so a peek at a big PDF shows something at once instead
   * of after twenty rasterizations. The token guards every step: a card that
   * moved on to another file stops the tail of pages mid-loop.
   */
  private async previewPdf(entry: FileEntry): Promise<HTMLElement> {
    const mine = this.token;
    const [pdfjs, url] = await Promise.all([loadPdfjs(), this.host.fileUrl(entry.path)]);
    const task = pdfjs.getDocument({ url });
    this.pdfTask = task;
    const doc = await task.promise;
    if (mine !== this.token) return note("");
    this.addFact("Pages", String(doc.numPages));

    const wrap = document.createElement("div");
    wrap.className = "ql-pdf";
    // The body is already on screen holding "Reading…", so its box is real.
    const width = Math.max(320, this.body.clientWidth - 12);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const shown = Math.min(doc.numPages, PDF_PAGE_CAP);

    await this.renderPdfPage(doc, 1, wrap, width, dpr);
    void (async () => {
      for (let i = 2; i <= shown; i++) {
        if (mine !== this.token) return;
        await this.renderPdfPage(doc, i, wrap, width, dpr);
      }
      if (mine === this.token && doc.numPages > shown) {
        wrap.append(note(`Showing the first ${shown} of ${doc.numPages} pages.`));
      }
    })();
    return wrap;
  }

  private async renderPdfPage(
    doc: { getPage(n: number): Promise<import("pdfjs-dist").PDFPageProxy> },
    index: number,
    wrap: HTMLElement,
    width: number,
    dpr: number,
  ): Promise<void> {
    const page = await doc.getPage(index);
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
    wrap.append(canvas);
  }

  private dropPdf(): void {
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
      const g = document.createElement("span");
      g.className = "ql-action-icon";
      g.textContent = a.glyph;
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
