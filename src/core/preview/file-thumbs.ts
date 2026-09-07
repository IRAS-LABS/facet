/**
 * Real previews for the rest of the file system.
 *
 * `doc-thumb` started with three formats -- PDF, APK, text -- and the rule it
 * was written to enforce was that a grid with holes in it is not a grid. That
 * rule does not stop at three: a folder holding a slide deck, a spreadsheet, a
 * song, a font and a printable part had five holes in it, each one a grey
 * square with three letters on it, and three letters are the same three
 * letters on every file that shares an extension.
 *
 * So every format here gets the picture it actually has:
 *
 *   Office (docx/xlsx/pptx)  -- the thumbnail Word and PowerPoint embed, and
 *                               when there is none, the document's own first
 *                               words set on a page.
 *   OpenDocument             -- `Thumbnails/thumbnail.png`, which the format
 *                               mandates, so this one is always a real cover.
 *   EPUB                     -- the book's cover art.
 *   Zip and friends          -- what is inside, listed.
 *   SVG                      -- the drawing itself.
 *   Fonts                    -- a specimen set in the font.
 *   Audio                    -- the album art out of the tags.
 *   3D models                -- the model, rendered.
 *
 * And for everything left -- a `.bin`, a `.7z` we cannot open, a format nobody
 * has thought of -- a drawn card, tinted by what kind of thing it is. That is
 * the one case that is not a real preview, and it still is not the grey chip:
 * it is a page with the extension on it, and the tile underneath carries the
 * filename, which is how a file manager has always identified a file it cannot
 * open.
 *
 * Everything is bounded. The caller puts an eight-second deadline on all of
 * this, and every reader here takes a head of a file rather than the file.
 */

import { readDirectory, readEntry, type ZipEntry } from "@core/table/zipread";
import {
  FAINT,
  INK,
  PAGE_RATIO,
  PAPER,
  PLATE,
  bufferOf,
  encode,
  fitImage,
  head,
  roundRect,
  surface,
  textPage,
  type RangedReads,
} from "./thumb-paint";

// ── shared zip helpers ────────────────────────────────────────────────────

/** Members whose bytes are worth decoding as a picture, biggest first. */
function pictures(entries: readonly ZipEntry[]): ZipEntry[] {
  return entries
    .filter((e) => /\.(png|jpe?g|webp|gif)$/i.test(e.name) && e.uncompressedSize > 256)
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize);
}

/** The text of an XML part, with the tags dropped and the entities restored. */
export function xmlText(xml: string, tag: string): string[] {
  // Paragraph first, run second. Splitting on the paragraph close is what
  // keeps a slide's bullet list from arriving as one unbroken sentence.
  const paras = xml.split(/<\/(?:w:p|a:p|si|text:p|text:h)>/);
  const run = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  const out: string[] = [];
  for (const para of paras) {
    let line = "";
    for (const m of para.matchAll(run)) line += m[1] ?? "";
    line = unescapeXml(line).trim();
    if (line !== "") out.push(line);
    if (out.length > 40) break;
  }
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** `readEntry`, but a member that will not inflate is not a verdict on the file. */
async function member(
  fs: RangedReads,
  path: string,
  entry: ZipEntry | undefined,
): Promise<Uint8Array | null> {
  if (!entry) return null;
  try {
    return await readEntry(fs, path, entry);
  } catch {
    return null;
  }
}

// ── Office (OOXML) ────────────────────────────────────────────────────────

/**
 * A .docx, .xlsx or .pptx is a zip, and it is often carrying its own cover.
 *
 * Word and PowerPoint write `docProps/thumbnail.jpeg` whenever "save
 * thumbnail" is on, and a deck exported from anywhere else usually has one
 * too. When it does not, the first words of the document are the next best
 * thing: a slide's title, a letter's letterhead, a sheet's column headings.
 *
 * Rendering the actual page would need a layout engine for three different
 * formats; the first words need a regular expression, and at 100 px the two
 * are much closer than that difference suggests.
 */
async function officeThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const entries = await readDirectory(fs, path);

  const shot = entries.find((e) => /^docProps\/thumbnail\.(jpe?g|png)$/i.test(e.name));
  const bytes = await member(fs, path, shot);
  if (bytes) {
    const out = await fitImage(bytes, px);
    if (out) return out;
  }

  // Slide one, the document body, or the strings a workbook shares between
  // its cells -- whichever this container turns out to be.
  const part =
    entries.find((e) => /^ppt\/slides\/slide1\.xml$/i.test(e.name)) ??
    entries.find((e) => /^word\/document\.xml$/i.test(e.name)) ??
    entries.find((e) => /^xl\/sharedStrings\.xml$/i.test(e.name));
  const raw = await member(fs, path, part);
  if (!raw) return null;

  const xml = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  const tag = xml.includes("<a:t") ? "a:t" : xml.includes("<w:t") ? "w:t" : "t";
  const lines = xmlText(xml, tag);
  if (lines.length === 0) return null;
  const page = textPage(px, lines);
  return page ? await encode(page) : null;
}

// ── OpenDocument ──────────────────────────────────────────────────────────

/**
 * The one format that guarantees a preview.
 *
 * ODF requires `Thumbnails/thumbnail.png` in every package, so a .odt or .ods
 * from any producer has a real rendered cover sitting in it. Text is still the
 * fallback, for a file written by something that skipped the requirement.
 */
async function openDocThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const entries = await readDirectory(fs, path);
  const shot = entries.find((e) => /^Thumbnails\/thumbnail\.(png|jpe?g)$/i.test(e.name));
  const bytes = await member(fs, path, shot);
  if (bytes) {
    const out = await fitImage(bytes, px);
    if (out) return out;
  }

  const body = await member(fs, path, entries.find((e) => e.name === "content.xml"));
  if (!body) return null;
  const lines = xmlText(new TextDecoder("utf-8", { fatal: false }).decode(body), "text:span");
  const fallback = lines.length > 0 ? lines : ["(empty document)"];
  const page = textPage(px, fallback);
  return page ? await encode(page) : null;
}

// ── EPUB ──────────────────────────────────────────────────────────────────

/**
 * A book's cover.
 *
 * The correct route is `META-INF/container.xml` to the OPF to the manifest
 * item marked `cover-image`, and it is three round trips through an XML
 * parser to answer a question that "the biggest picture whose name says cover,
 * else simply the biggest picture" answers correctly for essentially every
 * book -- a cover is always the largest image in an EPUB, because everything
 * else in one is a chapter illustration or an icon.
 */
async function epubThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const pics = pictures(await readDirectory(fs, path));
  const named = pics.filter((e) => /cover/i.test(e.name));
  for (const e of [...named, ...pics].slice(0, 4)) {
    const bytes = await member(fs, path, e);
    if (!bytes) continue;
    const out = await fitImage(bytes, px);
    if (out) return out;
  }
  return null;
}

// ── archives ──────────────────────────────────────────────────────────────

/**
 * What is in the box.
 *
 * A zip's whole identity is its contents, and the central directory is at the
 * end of the file and costs a couple of kilobytes to read -- so the listing is
 * both the most useful preview an archive can have and the cheapest.
 *
 * Only the zip family. A .7z, .rar or .tar.gz has no directory that can be
 * read without decompressing, and those get the card instead.
 */
async function archiveThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const entries = await readDirectory(fs, path);
  if (entries.length === 0) return null;
  const files = entries.filter((e) => !e.name.endsWith("/"));
  const lines = [
    `${files.length} item${files.length === 1 ? "" : "s"}`,
    ...files.slice(0, 24).map((e) => e.name.replace(/^.*\//, "")),
  ];
  const page = textPage(px, lines);
  return page ? await encode(page) : null;
}

// ── SVG ───────────────────────────────────────────────────────────────────

/**
 * The drawing, drawn.
 *
 * An SVG is a picture the still pipeline declines, because the native
 * thumbnailer does not rasterise vectors and `createImageBitmap` refuses an
 * SVG blob. An `<img>` does not refuse: the WebView has a full SVG renderer
 * and this is the one line that reaches it.
 *
 * Loaded from the file URL rather than from bytes, so a document that
 * references its own assets can still find them.
 */
async function svgThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const url = await fs.fileUrl(path);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  // A vector with no width/height attribute has no intrinsic size, and an
  // image of zero by zero draws nothing at all. The viewBox square is the
  // conventional stand-in.
  const w = img.naturalWidth || px;
  const h = img.naturalHeight || px;
  const scale = Math.min(px / w, px / h);
  const made = surface(w * scale, h * scale);
  if (!made) return null;
  const [c, ctx] = made;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return await encode(c);
}

// ── fonts ─────────────────────────────────────────────────────────────────

let specimens = 0;

/**
 * A specimen, set in the font itself.
 *
 * The only honest preview a typeface can have: the name of the file tells you
 * nothing about the shapes, and the shapes are the entire content. `FontFace`
 * loads one without installing it anywhere the rest of the app can see, and
 * the family name is thrown away again immediately afterwards.
 */
async function fontThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const url = await fs.fileUrl(path);
  const family = `fct-specimen-${++specimens}`;
  const face = new FontFace(family, `url("${url}")`);
  try {
    await face.load();
  } catch {
    return null;
  }
  document.fonts.add(face);
  try {
    const made = surface(px * PAGE_RATIO, px);
    if (!made) return null;
    const [c, ctx] = made;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(px * 0.42)}px "${family}"`;
    ctx.fillText("Ag", c.width / 2, c.height * 0.42);
    ctx.fillStyle = FAINT;
    ctx.font = `${Math.round(px * 0.11)}px "${family}"`;
    ctx.fillText("ABC abc 123", c.width / 2, c.height * 0.78);
    return await encode(c);
  } finally {
    // The face is only needed for the two `fillText` calls above; left in the
    // document set, a scroll through a fonts folder would accumulate one live
    // typeface per tile.
    document.fonts.delete(face);
  }
}

// ── audio ─────────────────────────────────────────────────────────────────

/** How far into a song to look for its artwork. Tags live at the front. */
const TAG_BYTES = 3 * 1024 * 1024;

/** ASCII at `at`, for the four-character type codes these formats are built on. */
function tag4(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);
}

function be32(b: Uint8Array, at: number): number {
  return (
    ((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)
  ) >>> 0;
}

/**
 * The picture out of an ID3v2 APIC frame.
 *
 * Exported, with the two below it and `xmlText`, only so the byte-level
 * parsing can be exercised against fixtures without a canvas: everything in
 * this file that is not one of these needs a DOM to say anything at all.
 *
 * The size field is "synchsafe" -- seven bits per byte, so that no length can
 * ever contain the byte pattern that marks the start of an MP3 frame. Reading
 * it as a normal big-endian integer is the classic way to land in the middle
 * of the audio and find nothing.
 */
export function id3Picture(b: Uint8Array): Uint8Array | null {
  if (tag4(b, 0).slice(0, 3) !== "ID3") return null;
  const major = b[3] ?? 0;
  const size =
    ((b[6] ?? 0) << 21) | ((b[7] ?? 0) << 14) | ((b[8] ?? 0) << 7) | (b[9] ?? 0);
  let at = 10;
  const end = Math.min(10 + size, b.byteLength);
  while (at + 10 <= end) {
    const id = tag4(b, at);
    // v2.3 and v2.4 differ in how the frame length is written, and v2.4's is
    // synchsafe like the header's. Getting this wrong walks off the end.
    const raw = be32(b, at + 4);
    const len =
      major >= 4
        ? (((raw >>> 24) & 0x7f) << 21) | (((raw >>> 16) & 0x7f) << 14) |
          (((raw >>> 8) & 0x7f) << 7) | (raw & 0x7f)
        : raw;
    if (len <= 0 || at + 10 + len > end) break;
    if (id === "APIC") {
      const body = b.subarray(at + 10, at + 10 + len);
      // encoding byte, MIME (NUL-terminated), picture type byte, description
      // (NUL-terminated, or double-NUL when the encoding is UTF-16), then the
      // bytes we are after.
      const enc = body[0] ?? 0;
      let i = 1;
      while (i < body.length && body[i] !== 0) i++;
      i++; // MIME terminator
      i++; // picture type
      if (enc === 1 || enc === 2) {
        while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2;
        i += 2;
      } else {
        while (i < body.length && body[i] !== 0) i++;
        i++;
      }
      if (i < body.length) return body.subarray(i);
    }
    at += 10 + len;
  }
  return null;
}

/** The picture out of a FLAC METADATA_BLOCK_PICTURE. */
export function flacPicture(b: Uint8Array): Uint8Array | null {
  if (tag4(b, 0) !== "fLaC") return null;
  let at = 4;
  for (;;) {
    if (at + 4 > b.byteLength) return null;
    const header = b[at] ?? 0;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0);
    const body = at + 4;
    if (type === 6 && body + len <= b.byteLength) {
      // type(4) mime-length(4) mime desc-length(4) desc w(4) h(4) depth(4)
      // colours(4) data-length(4) data
      let i = body + 4;
      i += 4 + be32(b, i);
      i += 4 + be32(b, i);
      i += 16;
      const dataLen = be32(b, i);
      i += 4;
      if (dataLen > 0 && i + dataLen <= b.byteLength) return b.subarray(i, i + dataLen);
    }
    if (last) return null;
    at = body + len;
  }
}

/** The picture out of an MP4/M4A `covr` atom. */
export function mp4Picture(b: Uint8Array): Uint8Array | null {
  // Atoms nest, and only four of them are containers on the path to the art.
  const containers = new Set(["moov", "udta", "meta", "ilst", "covr"]);
  const walk = (from: number, to: number, depth: number): Uint8Array | null => {
    let at = from;
    while (at + 8 <= to && depth < 8) {
      let size = be32(b, at);
      const type = tag4(b, at + 4);
      let body = at + 8;
      // A 64-bit size is written as 1 in the 32-bit field, with the real one
      // following. Anything over 4 GB in a phone's music folder is unlikely,
      // but the field still has to be stepped over correctly.
      if (size === 1) {
        body += 8;
        size = be32(b, at + 12);
      }
      if (size < 8) return null;
      const end = Math.min(at + size, to);
      if (type === "data" && depth > 0) return b.subarray(body + 8, end);
      if (containers.has(type)) {
        // `meta` carries a version and flags before its children do.
        const inner = walk(type === "meta" ? body + 4 : body, end, depth + 1);
        if (inner) return inner;
      }
      at += size;
    }
    return null;
  };
  // Only descend into `moov`; `mdat` is the audio and is most of the file.
  let at = 0;
  while (at + 8 <= b.byteLength) {
    const size = be32(b, at);
    const type = tag4(b, at + 4);
    if (size < 8) break;
    if (type === "moov") return walk(at + 8, Math.min(at + size, b.byteLength), 0);
    at += size;
  }
  return null;
}

/** Album art, if the file is carrying any. */
async function audioThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const bytes = await head(await fs.fileUrl(path), TAG_BYTES);
  if (bytes.byteLength < 16) return null;
  const art = id3Picture(bytes) ?? flacPicture(bytes) ?? mp4Picture(bytes);
  if (!art || art.byteLength < 256) return null;
  return await fitImage(art, px);
}

// ── 3D models ─────────────────────────────────────────────────────────────

/** How much of a model to read. Past this a tile is not worth the memory. */
const MODEL_BYTES = 96 * 1024 * 1024;

/**
 * One WebGL context for every model thumbnail ever drawn.
 *
 * A context per tile is the obvious version and it is the wrong one: Android's
 * WebView caps how many a page may hold, and the ones past the cap do not
 * error -- the oldest is silently killed, so a scroll through a folder of
 * parts would blank the tiles behind it. One renderer, reused, cannot hit the
 * cap.
 */
let gl: import("three").WebGLRenderer | null = null;

async function renderer(px: number): Promise<import("three").WebGLRenderer | null> {
  const { WebGLRenderer } = await import("three");
  if (!gl) {
    try {
      // `preserveDrawingBuffer` because the pixels are read back with `toBlob`
      // after the render call returns, which is exactly the moment the buffer
      // is allowed to be discarded without it.
      gl = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    } catch {
      return null;
    }
  }
  gl.setSize(px, px, false);
  return gl;
}

/** The model, rendered from three-quarters on, or null if it will not load. */
async function modelThumb(
  fs: RangedReads,
  path: string,
  ext: string,
  px: number,
): Promise<Blob | null> {
  const url = await fs.fileUrl(path);
  const bytes = await head(url, MODEL_BYTES);
  if (bytes.byteLength === 0) return null;

  const three = await import("three");
  const { buildDrawable, disposeTree, frameFor } = await import("@core/model3d/scene");

  let object: import("three").Object3D | null = null;
  try {
    if (ext === "stl") {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      object = buildDrawable(new STLLoader().parse(bufferOf(bytes)), false);
    } else if (ext === "ply") {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      // Points are a real answer for a PLY: a scan is frequently vertices and
      // nothing else, and drawn as a mesh it is an empty tile.
      object = buildDrawable(new PLYLoader().parse(bufferOf(bytes)), true);
    } else if (ext === "obj") {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      object = new OBJLoader().parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    } else {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const loader = new GLTFLoader();
      object = await new Promise<import("three").Object3D | null>((resolve) => {
        // A .gltf whose buffers and textures are separate files alongside it
        // will fail here, and that is the right outcome: it resolves null and
        // the file gets a card, rather than the parse throwing out of a
        // promise nothing is holding.
        loader.parse(bufferOf(bytes), "", (g) => resolve(g.scene), () => resolve(null));
      });
    }
  } catch {
    return null;
  }
  if (!object) return null;

  const gfx = await renderer(px);
  if (!gfx) {
    disposeTree(object);
    return null;
  }

  // STL and PLY come out of CAD packages, slicers and scanners, which are Z-up
  // by overwhelming convention -- loaded without this a printed part lies on
  // its side. The tilt goes on a wrapper so the framing below measures the
  // model as it will actually be seen.
  const stage = new three.Group();
  if (ext === "stl" || ext === "ply") stage.rotation.x = -Math.PI / 2;
  stage.add(object);
  stage.updateMatrixWorld(true);

  const scene = new three.Scene();
  scene.background = new three.Color(PLATE);
  scene.add(new three.AmbientLight(0xffffff, 1.1));
  const key = new three.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 1.4, 1);
  scene.add(key);
  scene.add(stage);

  try {
    const framing = frameFor(stage, 45, 1);
    const camera = new three.PerspectiveCamera(45, 1, framing.near, framing.far);
    camera.position.copy(framing.position);
    camera.lookAt(framing.target);
    gfx.render(scene, camera);
    return await encode(gfx.domElement);
  } catch {
    return null;
  } finally {
    // The renderer is kept; everything it was pointed at is not.
    disposeTree(stage);
  }
}

// ── the card ──────────────────────────────────────────────────────────────

/**
 * The last resort, and still not a grey square.
 *
 * A .7z has no readable directory, a .bin has no structure at all, and there
 * will always be a format nobody has written a reader for. What those files
 * get is a page with their extension on it, tinted by the kind of thing they
 * are, over the ruled lines that make it read as a document rather than as a
 * failure -- and the tile underneath carries the filename, which is what a
 * file manager has always used to identify a file it cannot open.
 *
 * Tinted by group rather than by extension: the colour is there so that a
 * folder of mixed downloads sorts visually into archives, code and media at a
 * glance, which forty separate hues would defeat.
 */
export function cardThumb(ext: string, px: number): Promise<Blob | null> {
  const made = surface(px * PAGE_RATIO, px);
  if (!made) return Promise.resolve(null);
  const [c, ctx] = made;
  const w = c.width;
  const h = c.height;
  const hue = hueFor(ext);

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);

  // Ruled lines, fading out, so the card reads as a page of something.
  const pad = Math.round(px * 0.11);
  const rule = Math.max(1, Math.round(px * 0.012));
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `hsl(${hue} 12% 84% / ${(1 - i * 0.14).toFixed(2)})`;
    const y = pad + i * Math.round(px * 0.075);
    const long = i === 0 ? 0.62 : i % 3 === 2 ? 0.5 : 0.78;
    ctx.fillRect(pad, y, (w - pad * 2) * long, rule);
  }

  // The extension, on a band across the lower half -- where a document's label
  // goes, and far enough from the ruled lines to stay legible at 100 px.
  const bandH = Math.round(px * 0.2);
  const bandY = Math.round(h * 0.58);
  ctx.fillStyle = `hsl(${hue} 62% 46%)`;
  roundRect(ctx, 0, bandY, w * 0.82, bandH, Math.round(bandH * 0.24));
  ctx.fill();

  const label = (ext || "file").toUpperCase().slice(0, 5);
  ctx.fillStyle = PAPER;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let size = Math.round(bandH * 0.62);
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  // Five characters at the same size as two would run off the band.
  while (size > 6 && ctx.measureText(label).width > w * 0.7) {
    size -= 1;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
  }
  ctx.fillText(label, w * 0.41, bandY + bandH / 2);

  return encode(c);
}

/** Extension → a hue, by what kind of thing it is. */
function hueFor(ext: string): number {
  const groups: readonly [number, readonly string[]][] = [
    [265, ["exe", "msi", "dmg", "deb", "rpm", "appimage", "bin", "iso", "img"]],
    [190, ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz", "cab"]],
    [150, ["mp3", "wav", "flac", "aac", "ogg", "opus", "m4a", "wma", "aiff", "amr", "mid"]],
    [15, ["mp4", "mkv", "mov", "webm", "avi", "m4v", "3gp", "wmv", "flv"]],
    [205, ["doc", "docx", "odt", "rtf", "pages", "pdf", "epub", "mobi", "azw3"]],
    [95, ["xls", "xlsx", "ods", "csv", "tsv", "numbers"]],
    [35, ["ppt", "pptx", "odp", "key"]],
    [330, ["stl", "obj", "ply", "glb", "gltf", "3mf", "fbx", "dae", "step", "stp", "blend"]],
    [280, ["ttf", "otf", "woff", "woff2", "ttc"]],
  ];
  for (const [hue, exts] of groups) if (exts.includes(ext)) return hue;
  // Everything unclaimed shares one neutral slate, so an unknown format never
  // borrows the colour of a group it does not belong to.
  return 220;
}

// ── dispatch ──────────────────────────────────────────────────────────────

/** The kinds this module draws. `doc-thumb` owns PDF, APK and plain text. */
export type FileThumbKind =
  | "office"
  | "opendoc"
  | "epub"
  | "archive"
  | "svg"
  | "font"
  | "audio"
  | "model"
  | "card";

export const OFFICE_EXT = new Set([
  "docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "ppsx", "potx",
]);
export const OPENDOC_EXT = new Set(["odt", "ods", "odp", "odg", "ott", "ots", "otp"]);
/** Zip-family containers whose directory `zipread` can list. */
export const ZIP_EXT = new Set([
  "zip", "jar", "aar", "ipa", "whl", "crx", "vsix", "kmz", "cbz", "war", "nupkg", "sketch",
]);
export const FONT_EXT = new Set(["ttf", "otf", "woff", "woff2", "ttc"]);
export const AUDIO_EXT = new Set([
  "mp3", "flac", "m4a", "m4b", "aac", "mp4a", "wav", "ogg", "oga", "opus",
  "wma", "aiff", "aif", "amr", "3ga", "mid", "midi", "mka", "ape", "wv", "au",
]);
export const MODEL_EXT = new Set(["stl", "obj", "ply", "glb", "gltf"]);

/**
 * Draw one of this module's kinds.
 *
 * Every route falls back to the card rather than to null, which is the whole
 * point: `null` reaches the grid as the grey chip, and the chip is the thing
 * being removed. A file that cannot be read for its cover still gets a page
 * with its extension on it.
 */
export async function fileThumb(
  kind: FileThumbKind,
  fs: RangedReads,
  path: string,
  ext: string,
  px: number,
): Promise<Blob | null> {
  try {
    switch (kind) {
      case "office":
        return (await officeThumb(fs, path, px)) ?? (await cardThumb(ext, px));
      case "opendoc":
        return (await openDocThumb(fs, path, px)) ?? (await cardThumb(ext, px));
      case "epub":
        return (await epubThumb(fs, path, px)) ?? (await cardThumb(ext, px));
      case "archive":
        return (await archiveThumb(fs, path, px)) ?? (await cardThumb(ext, px));
      case "svg":
        return (await svgThumb(fs, path, px)) ?? (await cardThumb(ext, px));
      case "font":
        return (await fontThumb(fs, path, px)) ?? (await cardThumb(ext, px));
      case "audio":
        return (await audioThumb(fs, path, px)) ?? (await cardThumb(ext, px));
      case "model":
        return (await modelThumb(fs, path, ext, px)) ?? (await cardThumb(ext, px));
      case "card":
        return await cardThumb(ext, px);
    }
  } catch {
    // A corrupt archive, a font the loader rejects, a WebGL context that went
    // away: none of those are a reason to hand the grid a hole.
    return await cardThumb(ext, px);
  }
}
