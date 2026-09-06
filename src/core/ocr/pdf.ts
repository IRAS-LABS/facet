/**
 * One searchable PDF out of several (item 32).
 *
 * Tesseract writes a PDF per page — the C++ renderer is handed one image and
 * closed — so a twelve-page scan comes back as twelve one-page documents.
 * Saving them that way would be technically accurate and useless: the thing
 * the user asked for is *their document*, searchable, in one file.
 *
 * pdf-lib is imported lazily and only from here, so a session that never asks
 * for a PDF never downloads it.
 */

/**
 * Join single-page PDFs into one, in the order given.
 *
 * Copying pages rather than concatenating bytes: a PDF is an object graph with
 * a cross-reference table, and gluing two files together produces something
 * that opens in exactly the readers that are lenient about it. `copyPages`
 * renumbers the objects properly.
 *
 * A single part is returned untouched — there is no reason to rewrite a file
 * that is already the answer, and doing so would drop Tesseract's own metadata.
 */
export async function mergePdfs(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const real = parts.filter((p) => p.length > 0);
  if (real.length === 0) throw new Error("nothing to save");
  if (real.length === 1) return real[0] as Uint8Array;

  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  for (const part of real) {
    const doc = await PDFDocument.load(part);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return out.save();
}
