/**
 * Putting a mark on a page — signatures and watermarks, one code path.
 *
 * A signature and a watermark look like different features and are the same
 * operation: take some art, put it at a place on a page at a size, an angle and
 * an opacity, and do it identically on screen and in the exported file. The
 * only real differences are that a watermark usually repeats and usually sits
 * behind the content, and both of those are parameters rather than a separate
 * implementation.
 *
 * Three render targets, and they must agree:
 *
 * - **Canvas**, for the live preview while the user drags the stamp around.
 * - **SVG**, for exporting a signed image or a watermark sheet.
 * - **PDF**, via pdf-lib, for the actual signed document.
 *
 * **How they are kept in agreement.** Every target gets its geometry from one
 * function, {@link stampMatrix}, which produces a single 2×3 matrix mapping art
 * coordinates into *y-down page space* — origin at the page's top-left, one
 * unit per PDF point. The canvas multiplies that matrix into its context; the
 * PDF exporter bakes it into the path data and hands pdf-lib a path already in
 * page space. Neither renderer does any placement arithmetic of its own, so
 * "it looked right in the preview and moved in the export" — the classic
 * failure of signing tools — cannot happen here.
 *
 * **Why y-down page space and not PDF's own y-up.** Path data is y-down
 * everywhere: SVG files, our own ink outlines, `Path2D`, and pdf-lib's
 * `drawSvgPath`, which anchors y-down path data at a y-up point. Choosing y-down
 * as the shared space means the flip happens exactly once, in the single
 * `drawSvgPath` call at the end, rather than being threaded through the
 * rotation and fitting maths where a sign error is invisible until someone
 * rotates a watermark.
 *
 * The public API still speaks PDF points with a **bottom-left origin**, because
 * that is what the file format uses and what any placement UI should store.
 */

import { buildAll } from "./ink";
import type { SigArt, Signature } from "./store";
import { boundsOfPaths, mul, transformPath, type Mat } from "./svg";

/** Where a stamp goes. Points, bottom-left origin, `w`/`h` before rotation. */
export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, anticlockwise, about the centre of the box. */
  rotate: number;
  /** 0..1. */
  opacity: number;
}

export function placement(p: Partial<Placement> = {}): Placement {
  return { x: 0, y: 0, w: 160, h: 54, rotate: 0, opacity: 1, ...p };
}

/**
 * Which pages a watermark covers.
 *
 * `range` is one-based and inclusive because that is how a person says
 * "pages 2 to 5". Translating at this boundary is one subtraction against a
 * class of off-by-one bugs that only surface on the last page of a long
 * document.
 */
export type PageSelection =
  | { kind: "all" }
  | { kind: "range"; from: number; to: number }
  | { kind: "list"; pages: readonly number[] };

export function selects(sel: PageSelection, oneBased: number): boolean {
  switch (sel.kind) {
    case "all":
      return true;
    case "range":
      return oneBased >= Math.min(sel.from, sel.to) && oneBased <= Math.max(sel.from, sel.to);
    case "list":
      return sel.pages.includes(oneBased);
  }
}

/** Repeat the mark across the page instead of placing it once. */
export interface Tiling {
  /** Gap between tiles in points, before the lattice is rotated. */
  gapX: number;
  gapY: number;
  /** Lattice rotation in degrees — 45 is the classic diagonal wash. */
  angle: number;
}

export interface Watermark {
  art: SigArt;
  colour: string;
  place: Placement;
  pages: PageSelection;
  /** Absent means a single stamp at `place`. */
  tile?: Tiling;
}

/* ────────────────────────────────────────────────────────────────── art ── */

export interface ArtPaths {
  /** `M`/`L`/`C`/`Z` paths, y-down, in their own coordinate box. */
  paths: string[];
  /** `[x, y, w, h]` the paths live in. */
  box: [number, number, number, number];
}

/**
 * Reduce any art to paths and a box.
 *
 * Returns `null` for raster art, which has no paths and takes the image route
 * in each renderer. Splitting on that here — rather than separately inside
 * three renderers — is what keeps the three in step.
 */
export function artPaths(art: SigArt): ArtPaths | null {
  switch (art.source) {
    case "drawn": {
      const paths = buildAll(art.strokes, art.ink)
        .map((p) => p.d)
        .filter((d) => d.length > 0);
      if (paths.length === 0) return null;
      return { paths, box: boundsOfPaths(paths) };
    }
    case "svg":
      return { paths: [...art.paths], box: [...art.viewBox] };
    case "image":
      return null;
  }
}

/**
 * Fit a box into a placement, preserving aspect and centring.
 *
 * Stretching a signature to fill a field is the single most obvious way to make
 * it look forged, so a non-uniform fit is not offered: the placement box is a
 * bound, not a target.
 *
 * `x`/`y` are y-down page-space coordinates of the fitted art's top-left.
 */
export function fitInto(
  box: readonly [number, number, number, number],
  place: Placement,
  pageH: number,
): { scale: number; x: number; y: number; w: number; h: number } {
  const bw = Math.max(box[2], 1e-6);
  const bh = Math.max(box[3], 1e-6);
  const scale = Math.min(place.w / bw, place.h / bh);
  const w = bw * scale;
  const h = bh * scale;
  // The placement's top edge in y-down space.
  const top = pageH - place.y - place.h;
  return { scale, x: place.x + (place.w - w) / 2, y: top + (place.h - h) / 2, w, h };
}

/**
 * The one matrix every renderer uses.
 *
 * Art coordinates → y-down page space. Composed as
 * `rotate about the fitted centre · translate · scale`, with the rotation
 * negated because a positive (anticlockwise) rotation in PDF's y-up space is a
 * clockwise rotation once y points down.
 */
export function stampMatrix(
  box: readonly [number, number, number, number],
  place: Placement,
  pageH: number,
): Mat {
  const fit = fitInto(box, place, pageH);
  // Place the art: scale it, then move its box origin to the fitted top-left.
  const put: Mat = [fit.scale, 0, 0, fit.scale, fit.x - box[0] * fit.scale, fit.y - box[1] * fit.scale];
  if (!place.rotate) return put;

  const a = (-place.rotate * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = fit.x + fit.w / 2;
  const cy = fit.y + fit.h / 2;
  const rot: Mat = [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
  return mul(rot, put);
}

/* ─────────────────────────────────────────────────────────────── canvas ── */

/**
 * Draw a stamp on a canvas whose context is already in CSS pixels.
 *
 * `viewScale` is CSS pixels per PDF point at the current zoom. The context is
 * left exactly as it was found.
 */
export function drawStampOnCanvas(
  ctx: CanvasRenderingContext2D,
  art: ArtPaths,
  colour: string,
  place: Placement,
  pageH: number,
  viewScale = 1,
): void {
  const m = stampMatrix(art.box, place, pageH);
  ctx.save();
  ctx.globalAlpha = clamp01(place.opacity);
  ctx.fillStyle = colour;
  ctx.scale(viewScale, viewScale);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  for (const d of art.paths) ctx.fill(new Path2D(d));
  ctx.restore();
}

/** The same, for raster art. Kept beside its vector twin so they stay aligned. */
export function drawImageStampOnCanvas(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  natural: { w: number; h: number },
  place: Placement,
  pageH: number,
  viewScale = 1,
): void {
  const m = stampMatrix([0, 0, natural.w, natural.h], place, pageH);
  ctx.save();
  ctx.globalAlpha = clamp01(place.opacity);
  ctx.scale(viewScale, viewScale);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0, natural.w, natural.h);
  ctx.restore();
}

/* ────────────────────────────────────────────────────────────────── svg ── */

/** A standalone SVG document for the art at a given width. */
export function artToSvg(art: ArtPaths, colour: string, width: number): string {
  const [bx, by, bw, bh] = art.box;
  const height = (bh / Math.max(bw, 1e-6)) * width;
  const body = art.paths.map((d) => `<path d="${d}"/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" ` +
    `viewBox="${round(bx)} ${round(by)} ${round(bw)} ${round(bh)}">` +
    `<g fill="${colour}" fill-rule="nonzero">${body}</g></svg>`
  );
}

/* ────────────────────────────────────────────────────────────── tiling ── */

/**
 * Positions for a tiled watermark covering a page, in bottom-left points.
 *
 * The lattice is generated over the page's bounding *circle* rather than its
 * rectangle, so a 45° tiling still reaches the corners. Covering only the
 * rectangle leaves two bare triangles that appear the moment the user rotates
 * the mark, which reads as the feature being half-finished.
 */
export function tilePositions(
  pageW: number,
  pageH: number,
  place: Placement,
  tile: Tiling,
): Array<{ x: number; y: number }> {
  const stepX = Math.max(8, place.w + tile.gapX);
  const stepY = Math.max(8, place.h + tile.gapY);
  const a = (tile.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  const cx = pageW / 2;
  const cy = pageH / 2;
  const reach = Math.hypot(pageW, pageH) / 2 + Math.max(stepX, stepY);
  const nx = Math.ceil(reach / stepX);
  const ny = Math.ceil(reach / stepY);

  const out: Array<{ x: number; y: number }> = [];
  for (let iy = -ny; iy <= ny; iy++) {
    for (let ix = -nx; ix <= nx; ix++) {
      const ux = ix * stepX;
      const uy = iy * stepY;
      const x = cx + ux * cos - uy * sin - place.w / 2;
      const y = cy + ux * sin + uy * cos - place.h / 2;
      // Cull tiles that cannot touch the page. Without this, a large page
      // carries a few hundred no-op draw calls per page into the output file.
      if (x + place.w < 0 || x > pageW) continue;
      if (y + place.h < 0 || y > pageH) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────── pdf ── */

/** `#rrggbb` → the 0..1 triple pdf-lib wants. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  let s = m[1] ?? "000000";
  if (s.length === 3) s = `${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
}

/** Decode a `data:` URL to bytes. */
export function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (comma < 0) return new Uint8Array();
  const body = url.slice(comma + 1);
  if (!/;base64/i.test(url.slice(0, comma))) return new TextEncoder().encode(decodeURIComponent(body));
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A filled rectangle that covers something. Never rotated: a tilted cover
 *  invites the reader to wonder what shape the thing underneath was. */
export interface Redaction {
  page: number;
  place: Placement;
  colour: string;
}

/**
 * A page replaced wholesale by a picture of itself.
 *
 * The only way a cover actually removes what is under it. The caller renders
 * the page with its rectangles already burnt in and hands the result here; the
 * page is rebuilt from that picture, so the words are not merely hidden, they
 * are no longer in the file.
 */
export interface PageRaster {
  page: number;
  /** A `data:image/png;base64,…` of the whole page at its full extent. */
  data: string;
}

/** The visible window of a page, in points from its bottom-left. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
  pages: PageSelection;
}

/** Everything `stampPdf` can do beyond placing art. All of it optional. */
export interface PdfExtras {
  redactions?: readonly Redaction[];
  flatten?: readonly PageRaster[];
  crop?: CropBox;
}

export interface StampRequest {
  art: SigArt;
  colour: string;
  place: Placement;
  /** Zero-based page index. */
  page: number;
}

/** Convenience: place a saved signature on a page. */
export function stampFor(sig: Signature, page: number, place: Placement): StampRequest {
  return { art: sig.art, colour: sig.colour, place, page };
}

/**
 * Apply signatures and watermarks to a PDF and return the new bytes.
 *
 * The document is modified in place rather than rebuilt page by page, so form
 * fields, links and bookmarks survive. A signed contract that has lost its form
 * fields is a worse document than the one that went in, however good the
 * signature looks.
 *
 * pdf-lib is imported lazily, matching `core/ocr/pdf.ts`: a session that never
 * signs anything never pays for it.
 */
export async function stampPdf(
  bytes: Uint8Array,
  stamps: readonly StampRequest[],
  watermarks: readonly Watermark[] = [],
  extras: PdfExtras = {},
): Promise<Uint8Array> {
  const { PDFDocument, degrees, rgb } = await import("pdf-lib");
  let doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let pages = doc.getPages();

  // Flattening first, and by rebuilding rather than by drawing over the top:
  // an image laid on a page hides the text from a reader and from nobody else.
  // A page rebuilt from a picture has no text left to find.
  const rasters = extras.flatten ?? [];
  if (rasters.length > 0) {
    const byPage = new Map(rasters.map((r) => [r.page, r.data]));
    const rebuilt = await PDFDocument.create();
    for (let i = 0; i < pages.length; i++) {
      const src = pages[i];
      if (!src) continue;
      const raster = byPage.get(i);
      if (raster === undefined) {
        const [copied] = await rebuilt.copyPages(doc, [i]);
        if (copied) rebuilt.addPage(copied);
        continue;
      }
      const { width, height } = src.getSize();
      const page = rebuilt.addPage([width, height]);
      try {
        const img = await rebuilt.embedPng(dataUrlBytes(raster));
        page.drawImage(img, { x: 0, y: 0, width, height });
      } catch {
        // A page that would not rasterise is left blank rather than left
        // readable: the user asked for the words to be gone.
      }
    }
    doc = rebuilt;
    pages = rebuilt.getPages();
  }

  // Embedded images are cached by data URL: a watermark tiled 60 times across
  // 40 pages must embed its image once, not 2400 times.
  type Embedded = Awaited<ReturnType<typeof doc.embedPng>>;
  const images = new Map<string, Embedded | null>();
  const embed = async (data: string): Promise<Embedded | null> => {
    const hit = images.get(data);
    if (hit !== undefined) return hit;
    let img: Embedded | null = null;
    try {
      const raw = dataUrlBytes(data);
      img = /^data:image\/jpe?g/i.test(data) ? await doc.embedJpg(raw) : await doc.embedPng(raw);
    } catch {
      // A malformed or unsupported image must not abort a whole signing run.
      img = null;
    }
    images.set(data, img);
    return img;
  };

  const paint = async (pageIndex: number, art: SigArt, colour: string, place: Placement): Promise<void> => {
    const page = pages[pageIndex];
    if (!page) return;
    const { height: pageH } = page.getSize();
    const opacity = clamp01(place.opacity);

    if (art.source === "image") {
      const img = await embed(art.data);
      if (!img) return;
      const m = stampMatrix([0, 0, art.w, art.h], place, pageH);
      // pdf-lib draws an image from a bottom-left anchor and rotates about that
      // anchor, so the anchor is the image's *bottom-left corner after
      // rotation* — which is the matrix applied to the art's bottom-left, i.e.
      // (0, art.h) in y-down art space.
      const anchor = { x: m[0] * 0 + m[2] * art.h + m[4], y: pageH - (m[1] * 0 + m[3] * art.h + m[5]) };
      const scale = Math.hypot(m[0], m[1]);
      page.drawImage(img, {
        x: anchor.x,
        y: anchor.y,
        width: art.w * scale,
        height: art.h * scale,
        opacity,
        ...(place.rotate ? { rotate: degrees(place.rotate) } : {}),
      });
      return;
    }

    const vec = artPaths(art);
    if (!vec) return;
    const m = stampMatrix(vec.box, place, pageH);
    const c = hexToRgb(colour);
    for (const d of vec.paths) {
      // The matrix is baked into the path, leaving pdf-lib with nothing to do
      // but flip y once. `x: 0, y: pageH, scale: 1` is that flip and nothing
      // else — no rotation, no scaling, no second opinion about placement.
      page.drawSvgPath(transformPath(d, m, 3), {
        x: 0,
        y: pageH,
        scale: 1,
        color: rgb(c.r, c.g, c.b),
        opacity,
        borderWidth: 0,
      });
    }
  };

  for (const w of watermarks) {
    if (!w.tile) {
      for (let i = 0; i < pages.length; i++) {
        if (selects(w.pages, i + 1)) await paint(i, w.art, w.colour, w.place);
      }
      continue;
    }

    // A tiled watermark draws the same art dozens of times per page. Emitting
    // the path data at every position is correct and ruinous: a signature
    // outline is roughly 1.5 kB, and 25 tiles across 40 pages is 1500 copies of
    // it — a measured 195 kB added to a 1 kB document in the first version of
    // this code. Drawing it once into a form XObject and referencing that per
    // tile makes the marks cost a few bytes each.
    const holder = await PDFDocument.create();
    const cell = holder.addPage([Math.max(1, w.place.w), Math.max(1, w.place.h)]);
    const unit: Placement = { x: 0, y: 0, w: w.place.w, h: w.place.h, rotate: 0, opacity: 1 };

    if (w.art.source === "image") {
      const raw = dataUrlBytes(w.art.data);
      const img = /^data:image\/jpe?g/i.test(w.art.data) ? await holder.embedJpg(raw) : await holder.embedPng(raw);
      const fit = fitInto([0, 0, w.art.w, w.art.h], unit, unit.h);
      cell.drawImage(img, { x: fit.x, y: unit.h - fit.y - fit.h, width: fit.w, height: fit.h });
    } else {
      const vec = artPaths(w.art);
      if (!vec) continue;
      const m = stampMatrix(vec.box, unit, unit.h);
      const c = hexToRgb(w.colour);
      for (const d of vec.paths) {
        cell.drawSvgPath(transformPath(d, m, 3), {
          x: 0,
          y: unit.h,
          scale: 1,
          color: rgb(c.r, c.g, c.b),
          borderWidth: 0,
        });
      }
    }

    const stamp = await doc.embedPage(cell);
    const opacity = clamp01(w.place.opacity);
    const a = (w.place.rotate * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);

    for (let i = 0; i < pages.length; i++) {
      if (!selects(w.pages, i + 1)) continue;
      const page = pages[i];
      if (!page) continue;
      const { width, height } = page.getSize();
      for (const spot of tilePositions(width, height, w.place, w.tile)) {
        // `drawPage` rotates about its own anchor, but the placement rotates
        // about the tile's centre. Solving `anchor + R·(w/2, h/2) = centre` for
        // the anchor is what keeps a rotated tile in its lattice cell instead
        // of swinging out of it.
        const hx = w.place.w / 2;
        const hy = w.place.h / 2;
        page.drawPage(stamp, {
          x: spot.x + hx - (hx * cos - hy * sin),
          y: spot.y + hy - (hx * sin + hy * cos),
          width: w.place.w,
          height: w.place.h,
          opacity,
          ...(w.place.rotate ? { rotate: degrees(w.place.rotate) } : {}),
        });
      }
    }
  }

  // Covers over the watermark, signatures over the covers: you may sign next
  // to something you blacked out, and you may not black out your own signature
  // by accident of ordering.
  for (const box of extras.redactions ?? []) {
    const page = pages[box.page];
    if (!page) continue;
    const c = hexToRgb(box.colour);
    page.drawRectangle({
      x: box.place.x,
      y: box.place.y,
      width: box.place.w,
      height: box.place.h,
      color: rgb(c.r, c.g, c.b),
      opacity: clamp01(box.place.opacity),
      borderWidth: 0,
    });
  }

  // Signatures last, so a watermark can never land on top of a signature.
  for (const s of stamps) await paint(s.page, s.art, s.colour, s.place);

  // The crop is a window, not a cut: the page keeps its coordinates, so every
  // placement above still lands where the preview showed it. Applied last for
  // the same reason -- nothing that follows has to know about it.
  const crop = extras.crop;
  if (crop) {
    for (let i = 0; i < pages.length; i++) {
      if (!selects(crop.pages, i + 1)) continue;
      const page = pages[i];
      if (!page) continue;
      const { width, height } = page.getSize();
      const x = Math.max(0, Math.min(crop.x, width));
      const y = Math.max(0, Math.min(crop.y, height));
      page.setCropBox(x, y, Math.min(crop.w, width - x), Math.min(crop.h, height - y));
    }
  }

  return doc.save();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}
