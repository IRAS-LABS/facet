/**
 * Getting text out of whatever is in front of you (items 1-6).
 *
 * Every route ends at the same `ReadDoc`, and that is the point of the file.
 * A PDF with a text layer, a scan of the same PDF, a photograph of a page, a
 * saved web page and a plain text file arrive here by completely different
 * paths and leave as the same thing, so the player, the highlight, the
 * reading-order overlay and the cleanup rules are each written once.
 *
 * The one decision that is not obvious is what happens to a PDF. Its text
 * layer is tried first, always -- it is instant, exact, and knows where every
 * character sits. OCR is the fallback for the pages that have no text layer,
 * because a scan is a picture and there is nothing else to be done with it.
 * A document can be half of each, which is common in practice: a scanned form
 * bound into a typed report. So the decision is taken per page, not per file.
 */

import { Tesseract, type Recogniser } from "@core/ocr/engine";
import { loadPdfjs } from "@core/explorer/preview";
import { blankPage, type OcrPage } from "@core/ocr/page";
import { fromBlocks, fromPages, fromText, type ReadDoc } from "./doc";
import { htmlBlocks, htmlTitle } from "./html-text";
import { isScanned, pdfPages } from "./pdf-text";

/** Everything the reader will open. */
export const READ_EXTS = [
  "pdf",
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
  "xhtml",
  "csv",
  "json",
  "log",
  "rtf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
  "tif",
  "tiff",
] as const;

const IMAGE = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"]);
const MARKUP = new Set(["html", "htm", "xhtml"]);

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function canRead(path: string): boolean {
  return (READ_EXTS as readonly string[]).includes(extensionOf(path));
}

export interface Told {
  /** Something short and true for the status line. */
  what: string;
  /** 0-1, or -1 when there is no way to know. */
  done: number;
}

export interface BuildOptions {
  /** Told what is happening, so a 60-page scan is not a blank screen. */
  onProgress?(p: Told): void;
  signal?: AbortSignal;
  /**
   * Allowed to run OCR on pages that have no text layer.
   *
   * Off unless the reader has asked the user, because OCR of a long scan is
   * minutes of the machine's full attention and should never begin because
   * somebody opened a file.
   */
  ocr?: boolean;
  /** Language codes for OCR, joined with "+". */
  language?: string;
  /** Overrides the real engine. Only the harness passes one. */
  engine?: Recogniser;
}

/** How OCR is scaled when rendering a PDF page to read it. See `ocr-view`. */
const OCR_SCALE = 2;

/**
 * Build a readable document from a file.
 *
 * `bytes` is the file's contents; the caller fetches them, because it is the
 * caller that knows whether the path is a real file, a URL or something a test
 * made up.
 */
export async function build(
  path: string,
  bytes: ArrayBuffer,
  opts: BuildOptions = {},
): Promise<ReadDoc> {
  const ext = extensionOf(path);

  if (ext === "pdf") return fromPdf(path, bytes, opts);
  if (IMAGE.has(ext)) return fromImage(path, bytes, opts);
  if (MARKUP.has(ext)) return fromHtml(path, decode(bytes));
  return fromText(strip(decode(bytes), ext), path);
}

/** Read a selection or any text somebody already has in hand (items 5, 6). */
export function fromPlain(text: string, source: string): ReadDoc {
  return fromText(text, source);
}

// ── PDF ──────────────────────────────────────────────────────────────────────

async function fromPdf(path: string, bytes: ArrayBuffer, opts: BuildOptions): Promise<ReadDoc> {
  opts.onProgress?.({ what: "Reading the PDF", done: -1 });

  const pages = await pdfPages(
    new Uint8Array(bytes),
    (n, total) => opts.onProgress?.({ what: `Reading page ${n} of ${total}`, done: n / total }),
    opts.signal,
  );

  const scanned = pages.map(isScanned);
  const needing = scanned.filter(Boolean).length;

  if (needing > 0 && opts.ocr) {
    await ocrInto(bytes, pages, scanned, opts);
  }

  const doc = fromPages(pages, path);
  // Left on the document so the reader can offer OCR rather than silently
  // reading eight of sixty pages and stopping.
  doc.scanned = scanned.map((yes, i) => (yes ? i : -1)).filter((i) => i >= 0);
  return doc;
}

/**
 * Recognise the pages that had no text layer, in place.
 *
 * Rendering happens here rather than in `pdf-text` because it needs a canvas,
 * and `pdf-text` is deliberately free of the DOM so it can be checked without
 * one.
 */
async function ocrInto(
  bytes: ArrayBuffer,
  pages: OcrPage[],
  scanned: boolean[],
  opts: BuildOptions,
): Promise<void> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const pdf = await task.promise;
  const engine = opts.engine ?? new Tesseract();
  const wanted = scanned.map((yes, i) => (yes ? i : -1)).filter((i) => i >= 0);

  const canvas = document.createElement("canvas");
  try {
    for (let n = 0; n < wanted.length; n++) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = wanted[n] as number;
      const page = await pdf.getPage(index + 1);
      try {
        const view = page.getViewport({ scale: OCR_SCALE });
        canvas.width = Math.round(view.width);
        canvas.height = Math.round(view.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        // PDF pages are transparent where nothing is drawn, and the engine
        // reads nothing at all off transparent black.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport: view }).promise;

        const result = await engine.read(canvas, {
          language: opts.language ?? "eng",
          onProgress: (p) =>
            opts.onProgress?.({
              what: `Recognising page ${index + 1} — ${p.what}`,
              done: (n + Math.max(0, p.done)) / wanted.length,
            }),
        });
        pages[index] = result.page;
      } finally {
        page.cleanup();
      }
    }
  } finally {
    if (!opts.engine) await engine.close();
    void task.destroy();
  }
}

// ── Pictures (item 1) ────────────────────────────────────────────────────────

async function fromImage(path: string, bytes: ArrayBuffer, opts: BuildOptions): Promise<ReadDoc> {
  if (!opts.ocr) {
    // Nothing has been recognised yet, so there is nothing to read. An empty
    // document with the page size filled in is what lets the reader draw the
    // picture and offer the button, rather than showing an error.
    const doc = fromPages([blankPage(0, 0)], path);
    doc.scanned = [0];
    return doc;
  }

  opts.onProgress?.({ what: "Recognising the picture", done: -1 });

  const canvas = await draw(bytes);
  const engine = opts.engine ?? new Tesseract();
  try {
    const result = await engine.read(canvas, {
      language: opts.language ?? "eng",
      onProgress: (p) => opts.onProgress?.({ what: p.what, done: p.done }),
    });
    return fromPages([result.page], path);
  } finally {
    if (!opts.engine) await engine.close();
  }
}

/** Decode image bytes onto a canvas the engine can read back. */
async function draw(bytes: ArrayBuffer): Promise<HTMLCanvasElement> {
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

// ── Markup and plain text ────────────────────────────────────────────────────

function fromHtml(path: string, source: string): ReadDoc {
  const doc = fromBlocks(htmlBlocks(source), path);
  const title = htmlTitle(source);
  if (title) doc.title = title;
  return doc;
}

/**
 * Decode bytes as text.
 *
 * UTF-8 with a BOM stripped covers everything this app writes and nearly
 * everything it is handed. A file in a legacy Windows codepage will come
 * through with a few wrong characters rather than failing, which is the right
 * trade for a reader: it will mispronounce a word, not refuse the document.
 */
function decode(bytes: ArrayBuffer): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Take the obvious punctuation-noise out of formats that are text but not prose.
 *
 * Markdown read literally says "hash hash Introduction" and "star star
 * important star star", which is the single most common complaint about
 * readers that treat every text file the same. Nothing here tries to be a
 * Markdown parser -- it removes the marks and keeps the words.
 */
function strip(text: string, ext: string): string {
  if (ext === "md" || ext === "markdown") {
    return text
      .replace(/^```[\s\S]*?^```/gm, "\n")            // fenced code, not prose
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")             // headings
      .replace(/^\s{0,3}>\s?/gm, "")                  // quotes
      .replace(/^\s{0,3}([*+-]|\d+[.)])\s+/gm, "")    // list markers
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")       // images keep their alt
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")        // links keep their words
      .replace(/(\*\*|__|\*|_|`)/g, "")               // emphasis marks
      .replace(/^\s*([-*_]\s*){3,}$/gm, "");          // rules
  }

  if (ext === "rtf") {
    // Not an RTF parser, and it does not pretend to be one: control words out,
    // braces out, escaped characters back. It turns an RTF into something
    // readable, which is all the reader needs.
    return text
      .replace(/\\'([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\par[d]?\b/g, "\n")
      .replace(/\\[a-z]+-?\d*\s?/gi, "")
      .replace(/[{}]/g, "");
  }

  return text;
}
