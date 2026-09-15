/**
 * A PDF out of scanned pages.
 *
 * Two ways in, and they are genuinely different documents. `imagesToPdf` puts
 * the pictures on the pages and stops; it is fast, it works with no model
 * downloaded, and the result is not searchable. The OCR route in `ocr/pdf.ts`
 * puts invisible text under the same pictures and you can hit ctrl+F in it.
 *
 * This file is only the first. It lives next to the scanner rather than in
 * `ocr/` because it has nothing to do with reading text -- a scan of a
 * photograph, a drawing or a page in a language nobody has a model for still
 * wants to be one PDF.
 */

/** One page's worth of encoded image. */
export interface PdfImage {
  /** JPEG or PNG bytes. Anything else pdf-lib will refuse. */
  readonly bytes: Uint8Array;
  readonly kind: "jpeg" | "png";
  readonly width: number;
  readonly height: number;
  /**
   * The page size in points, when the caller already knows it.
   *
   * A scan does not know how big it is -- hence `DPI` below -- but a page
   * rendered out of an existing PDF knows exactly, and must keep it. A signed
   * agreement that comes back three-quarters of its old size is a different
   * document to anyone who prints it, and the signature no longer sits where
   * it was placed against a ruler. Set this and the pixels are laid out at
   * whatever resolution makes them fill it; leave it off and `DPI` decides.
   */
  readonly pt?: { readonly w: number; readonly h: number };
}

/**
 * Points per inch. PDF's unit is 1/72 inch, and a scan has no inherent size --
 * it is a grid of pixels that came from a photograph of something roughly A4.
 * Laying it out at 200 dpi puts a normal page at close to A4 and keeps the
 * page a sane size in a viewer, which is all "correct" can mean here.
 */
const DPI = 200;

/**
 * One PDF, one page per image, each page exactly the shape of its image.
 *
 * Not a fixed A4 with the scan letterboxed inside it. A scan that has been
 * cropped to the page *is* the page; boxing it inside a nominal A4 adds white
 * margins that were not in the document and makes every page the same shape
 * even when one of them was a receipt.
 */
export async function imagesToPdf(
  images: readonly PdfImage[],
  meta: { readonly title?: string } = {},
): Promise<Uint8Array> {
  if (images.length === 0) throw new Error("nothing to save");

  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setProducer("Facet");
  doc.setCreator("Facet");
  if (meta.title !== undefined && meta.title !== "") doc.setTitle(meta.title);

  for (const img of images) {
    const embedded =
      img.kind === "jpeg"
        ? await doc.embedJpg(img.bytes)
        : await doc.embedPng(img.bytes);

    const w = img.pt ? img.pt.w : (img.width / DPI) * 72;
    const h = img.pt ? img.pt.h : (img.height / DPI) * 72;
    const page = doc.addPage([w, h]);
    page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
  }

  return doc.save();
}
