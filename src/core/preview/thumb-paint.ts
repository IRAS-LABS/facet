/**
 * The paint box the thumbnail renderers share.
 *
 * Split out of `doc-thumb` when the list of formats that get a real picture
 * grew past three: every renderer needs paper, a canvas, a PNG at the end, and
 * most of them need "fit this image into the tile" or "set these lines on a
 * page". Keeping one copy of each means a change to how a preview looks is one
 * edit rather than nine, and it lets `file-thumbs` exist without importing the
 * module that imports it.
 */

/**
 * The few file operations these modules need.
 *
 * A structural type rather than an import of `TauriFs`, so they stay testable
 * without the IPC layer and cannot accidentally reach for anything heavier.
 */
export interface RangedReads {
  readHead(path: string, max?: number): Promise<number[]>;
  readRange(path: string, offset: number, len: number): Promise<number[]>;
  readTail(path: string, len: number): Promise<[number[], number]>;
  fileUrl(path: string): Promise<string>;
}

/*
 * Paper and ink for the rendered pages.
 *
 * Fixed rather than themed, and that is a decision rather than an oversight: a
 * thumbnail is encoded once and cached to disk for the life of the file, so it
 * cannot follow a theme switch that happens afterwards. Given a choice between
 * a picture that is wrong half the time and one that is a white page always, a
 * white page always is the honest one -- and it is also what the document
 * actually looks like, which is the entire point of a preview.
 */
export const PAPER = "#ffffff";
export const INK = "#1b1b1f";
export const FAINT = "#9aa0a6";
export const PLATE = "#f4f4f6";

/** The proportions of a sheet of paper. Every drawn page uses it. */
export const PAGE_RATIO = 0.77;

/** A canvas at `w`x`h` with a 2D context, or null if the context is refused. */
export function surface(
  w: number,
  h: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d");
  return ctx ? [c, ctx] : null;
}

/** PNG rather than JPEG: these are flat pages and line art, where JPEG's
 *  ringing around hard edges is exactly the artefact you would notice. */
export function encode(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}

/**
 * The first `max` bytes of a URL, without downloading the rest.
 *
 * A cover image lives in the first few hundred kilobytes of an MP3 and the
 * whole file is eight megabytes; a tag parser that reads the file to find them
 * costs forty times what it needs to. Reading the body as a stream and
 * cancelling is the version of that which needs nothing from the server: no
 * Range support, no content-length, no second request.
 *
 * `readHead` on the IPC side would also work and is deliberately not used --
 * it hands bytes over as a JSON array of numbers, which is roughly twenty
 * bytes of wire per byte of file and is only affordable at the eight kilobytes
 * the text renderer asks for.
 */
export async function head(url: string, max: number): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(value);
      got += value.byteLength;
    }
  } finally {
    // Cancels the transfer rather than letting the rest of a 4 GB file arrive
    // in the background after we have what we came for.
    void reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(got, max));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    const take = Math.min(p.byteLength, out.length - at);
    out.set(p.subarray(0, take), at);
    at += take;
  }
  return out;
}

/** A standalone ArrayBuffer for a view that may be a window onto a bigger one. */
export function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Draw a decoded picture at up to `px` on its longest side.
 *
 * Fit, not fill, and the canvas is the size of the fitted picture rather than a
 * square with bars: a book cover cropped to a square loses its title, and a
 * letterboxed one wastes half the tile. The grid lays out whatever shape it is
 * handed, which is the same thing photographs get.
 */
export async function fitOnPaper(bmp: ImageBitmap, px: number): Promise<Blob | null> {
  if (bmp.width <= 0 || bmp.height <= 0) return null;
  const scale = Math.min(px / bmp.width, px / bmp.height, 1);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const made = surface(w, h);
  if (!made) return null;
  const [c, ctx] = made;
  // Paper behind it: a PNG cover with a transparent border would otherwise
  // show whatever the tile is sitting on through its own margins.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return await encode(c);
}

/** Decode `bytes` as a picture and draw it at `px`, or null if it is not one. */
export async function fitImage(bytes: Uint8Array, px: number): Promise<Blob | null> {
  if (bytes.byteLength === 0) return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    return null;
  }
  try {
    return await fitOnPaper(bmp, px);
  } finally {
    bmp.close();
  }
}

/**
 * Lines of text set on a page.
 *
 * Not a preview of the *content* so much as a fingerprint: a shopping list, a
 * log and a licence look nothing alike at 100 px even when no word is legible.
 * The first line gets the ink and the rest get the grey, because at this size
 * the first line is the only one anybody actually reads.
 */
export function textPage(px: number, lines: readonly string[]): HTMLCanvasElement | null {
  const w = Math.round(px * PAGE_RATIO);
  const made = surface(w, px);
  if (!made) return null;
  const [c, ctx] = made;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, c.width, c.height);

  const pad = Math.round(px * 0.08);
  const size = Math.max(4, Math.round(px * 0.055));
  const step = Math.round(size * 1.45);
  ctx.font = `${size}px ui-monospace, monospace`;
  ctx.textBaseline = "top";

  const room = Math.floor((px - pad * 2) / step);
  const wide = w - pad * 2;

  for (let i = 0; i < room; i++) {
    const raw = lines[i];
    if (raw === undefined) break;
    // Tabs are drawn as spaces because a canvas does not expand them -- an
    // indented file would otherwise render every line starting at the margin.
    let line = raw.replace(/\t/g, "  ").replace(/[\u0000-\u001f]/g, "");
    // Trim to width by measurement rather than by character count: at this
    // size a proportional guess is wrong by enough to overflow the page.
    while (line.length > 0 && ctx.measureText(line).width > wide) {
      line = line.slice(0, -1);
    }
    // A blank line still costs its row; that is what makes a paragraph look
    // like a paragraph rather than a solid block.
    if (line === "") continue;
    ctx.fillStyle = i === 0 ? INK : FAINT;
    ctx.fillText(line, pad, pad + i * step);
  }
  return c;
}

/** A rounded rectangle path, since `roundRect` is not everywhere yet. */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
