/**
 * Turning a finished PDF into one nobody can take anything off.
 *
 * Everything `stamp.ts` does -- a signature, a watermark, a drawn cover -- it
 * does by adding operators to a page's content stream. That is the right way
 * to build the document: form fields, links and bookmarks survive it, the file
 * stays small, and the text stays searchable. It is also, for exactly the same
 * reason, removable. A page's content stream is a list, anyone with a PDF
 * editor can delete the end of a list, and what is underneath is untouched and
 * waiting. A watermark you can take off is a watermark in the decorative sense
 * only.
 *
 * So this is the other end of that trade, offered as a choice rather than
 * imposed: every page is rendered to a picture and a new document is built out
 * of the pictures. There are no operators left to delete because there is
 * nothing on the page but one image, and the signature is now made of the same
 * pixels as the words it sits beside. Removing it means painting it out by
 * hand, on every page, and what you are left with no longer matches the copy
 * that was signed.
 *
 * What it costs is real, and the caller has to say so out loud in the UI: the
 * document stops being searchable, text can no longer be selected or copied,
 * screen readers get nothing at all, and the file grows -- a page of text is a
 * few kilobytes as text and a few hundred as a picture. That is a bad trade
 * for a report and the right one for a signed agreement, which is why the
 * choice belongs to the person saving the file and not to this module.
 *
 * `scan/pdf.ts` builds the document from the images; this file only makes
 * them. Two hundred lines of pdf-lib page arithmetic do not want a second
 * copy.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";

import { loadPdfjs } from "@core/explorer/preview";
import { imagesToPdf, type PdfImage } from "@core/scan/pdf";

/**
 * How many pixels across a rendered page gets, and the ceiling on that.
 *
 * 2x the page's own points is about 144 dpi on a letter page -- the factor the
 * preview already uses: legible on screen, fine on paper, and not so heavy
 * that a forty-page contract exhausts a phone. The cap is what stops a
 * poster-sized page, and a PDF page may legally be 200 inches across, from
 * asking for a canvas no browser will hand out.
 */
const SCALE = 2;
const MAX_PX = 4000;

/** See `encode`. */
const JPEG_QUALITY = 0.92;

export interface FlattenProgress {
  /** 1-based, for "page 3 of 12". */
  readonly page: number;
  readonly pages: number;
}

/**
 * Rebuild `bytes` as a document whose every page is a single flat picture.
 *
 * Rendering goes through pdf.js rather than re-embedding the original page
 * objects, because re-embedding would keep them -- and not keeping them is the
 * entire point. What comes out the far side has never met the source
 * document's text, so there is nothing left to extract with `pdftotext` and
 * nothing left to peel off in an editor.
 *
 * Throws if any page fails. A half-flattened document is the worst possible
 * result: it looks locked and is not, on pages nobody checked.
 */
export async function flattenPdf(
  bytes: Uint8Array,
  onPage?: (p: FlattenProgress) => void,
): Promise<Uint8Array> {
  const pdfjs = await loadPdfjs();
  // A copy, because pdf.js takes ownership of the buffer it is handed and the
  // caller may well still want its own bytes afterwards -- sign-view does.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const task = pdfjs.getDocument({ data: copy });
  const doc = await task.promise;
  try {
    const pages: PdfImage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      onPage?.({ page: i, pages: doc.numPages });
      pages.push(await renderPage(doc, i));
    }
    return await imagesToPdf(pages);
  } finally {
    // The loading task owns the worker, not the document proxy. Not tearing it
    // down leaves a worker per flatten alive for the life of the app, which on
    // the phone is a few flattens away from being killed for memory.
    await task.destroy();
  }
}

/** One page, painted onto white at `SCALE`, encoded, and kept at its own size. */
async function renderPage(doc: PDFDocumentProxy, index: number): Promise<PdfImage> {
  const page = await doc.getPage(index);
  const unit = page.getViewport({ scale: 1 });
  const scale = Math.min(SCALE, MAX_PX / Math.max(unit.width, unit.height, 1));
  const view = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(view.width));
  canvas.height = Math.max(1, Math.round(view.height));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("the page could not be drawn");
  // A PDF page paints nothing where it is blank, so with no ground laid first
  // an ordinary document flattens to black text on transparency -- which a
  // viewer shows over its own dark chrome as black on black, and which JPEG,
  // having no transparency at all, turns into a solid black page.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: view }).promise;
  // `unit` is post-rotation, so a landscape page stays landscape.
  return { ...(await encode(canvas)), pt: { w: unit.width, h: unit.height } };
}

/**
 * PNG or JPEG, chosen by what the page turned out to be.
 *
 * A page of text is a handful of colours over white, and PNG stores that
 * losslessly in less space than JPEG needs to store it badly -- JPEG rings
 * around black on white, which on a signed document reads as a smudged
 * signature. A page carrying a photograph or a scan is the opposite case: PNG
 * of continuous tone is enormous. Counting distinct colours on a coarse grid
 * separates the two in a few milliseconds, and is right far more often than
 * picking one and using it for everything.
 */
async function encode(canvas: HTMLCanvasElement): Promise<Omit<PdfImage, "pt">> {
  const flat = looksFlat(canvas);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, flat ? "image/png" : "image/jpeg", flat ? undefined : JPEG_QUALITY);
  });
  if (blob === null) throw new Error("the page could not be saved");
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    kind: flat ? "png" : "jpeg",
    width: canvas.width,
    height: canvas.height,
  };
}

/** Whether the page reads as line art: few distinct colours, sampled coarsely. */
function looksFlat(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) return true;
  const step = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 128));
  const seen = new Set<number>();
  try {
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        // Quantised to five bits a channel: a photograph still runs to
        // thousands of buckets, while antialiased black text on white stays in
        // the tens.
        seen.add(((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3));
        if (seen.size > 512) return false;
      }
    }
  } catch {
    // A tainted canvas cannot be read back. PNG is the safe answer to not
    // knowing: bigger, never uglier.
    return true;
  }
  return true;
}
