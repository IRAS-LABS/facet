/**
 * Thumbnails for the files that are not pictures.
 *
 * A photo roll that shows every photograph and every video, and then draws a
 * grey rectangle with "PDF" written on it for the document sitting between
 * them, is a grid with holes in it. The holes are worse than they sound: the
 * eye finds a file in a grid by recognising it, and a chip that says "PDF" is
 * identical to every other chip that says "PDF", so a folder of statements
 * becomes a wall of indistinguishable placeholders that can only be read by
 * their filenames -- which is to say, not a grid at all.
 *
 * This module is the routing table, and it draws the three formats it was
 * originally written for:
 *
 *   PDF   -- page one, rendered. The cover of a document is what a document
 *            looks like, and pdfjs is already a dependency of this app.
 *   TXT   -- the first lines, set on a page. Not a preview of the *content* so
 *            much as a fingerprint: a shopping list, a log and a licence look
 *            nothing alike at 100 px even when no word is legible.
 *   APK   -- the app's own launcher icon, pulled out of the archive.
 *
 * Everything else -- Office, OpenDocument, EPUB, zip, SVG, fonts, audio art,
 * 3D models, and a drawn card for the formats with nothing to read -- is in
 * `file-thumbs`, and the paint box both share is in `thumb-paint`.
 *
 * One rule holds across all of them: `docThumbKind` returns null only for a
 * file the *picture* pipeline owns. It never returns null for "no idea", and
 * `docThumb` never resolves null for a file it accepted, because null reaches
 * the grid as the grey chip and the grey chip is what this module exists to
 * delete.
 *
 * Nothing here is on the hot path for a photograph.
 */

import { readDirectory, readEntry, type ZipEntry } from "@core/table/zipread";
import {
  AUDIO_EXT,
  FONT_EXT,
  MODEL_EXT,
  OFFICE_EXT,
  OPENDOC_EXT,
  ZIP_EXT,
  cardThumb,
  fileThumb,
  type FileThumbKind,
} from "./file-thumbs";
import {
  PAPER,
  PLATE,
  encode,
  surface,
  textPage,
  type RangedReads,
} from "./thumb-paint";

/** Re-exported: the shape lives in `thumb-paint`, which the renderers all
 *  share, and this module was its original home. */
export type { RangedReads };

/** What `docThumb` can draw. Every extension maps to one of these. */
export type DocThumbKind = "pdf" | "apk" | "text" | FileThumbKind;

/**
 * Extensions that get a text page.
 *
 * Source code was excluded when this list was three formats long, on the
 * grounds that the roll is a gallery and a repository checkout would flood it.
 * That reasoning does not survive the file browser: a folder of scripts with a
 * grey chip on every tile is exactly the wall of identical squares this module
 * exists to remove, and a Python file and a shell script are as different at
 * 100 px as a shopping list and a licence. Code is in.
 */
const TEXT_EXT = new Set([
  "txt", "text", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonl",
  "xml", "ini", "cfg", "conf", "yml", "yaml", "toml", "properties", "env",
  "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "py", "rs", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cs",
  "rb", "php", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "lua",
  "swift", "dart", "scala", "groovy", "gradle", "pl", "pm", "r", "jl", "vim",
  "srt", "vtt", "ics", "vcf", "tex", "bib", "diff", "patch", "gitignore",
  "editorconfig", "lock", "cmake", "makefile", "dockerfile", "asc", "pem",
]);

/**
 * Extensions the picture pipeline owns.
 *
 * This module must decline them: a JPEG routed here would be drawn as a card,
 * and worse, it would be queued in the document lane instead of the still one.
 * SVG is deliberately absent -- the still pipeline cannot rasterise a vector,
 * so it is ours.
 */
const PICTURE_EXT = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "avifs",
  "bmp", "ico", "heic", "heics", "heif",
  "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef",
  "srw", "jxl",
  "mp4", "mkv", "mov", "webm", "avi", "m4v", "3gp", "3g2", "mts", "m2ts",
  "wmv", "flv", "f4v", "mpg", "mpeg", "m2v", "ogv", "vob", "divx", "insv",
]);

/**
 * Which route `ext` takes, or null if the picture pipeline owns it.
 *
 * Note what this no longer does: return null for an extension nobody has
 * heard of. An unknown format gets `"card"` -- a drawn page with its
 * extension on it -- because null reaches the grid as the grey chip, and the
 * grey chip is the thing being removed.
 */
export function docThumbKind(ext: string): DocThumbKind | null {
  const e = ext.toLowerCase();
  if (PICTURE_EXT.has(e)) return null;
  if (e === "pdf") return "pdf";
  if (e === "apk" || e === "apks" || e === "xapk") return "apk";
  if (e === "svg") return "svg";
  if (OFFICE_EXT.has(e)) return "office";
  if (OPENDOC_EXT.has(e)) return "opendoc";
  if (e === "epub") return "epub";
  if (ZIP_EXT.has(e)) return "archive";
  if (FONT_EXT.has(e)) return "font";
  if (AUDIO_EXT.has(e)) return "audio";
  if (MODEL_EXT.has(e)) return "model";
  if (TEXT_EXT.has(e)) return "text";
  return "card";
}

// ── PDF ───────────────────────────────────────────────────────────────────

/**
 * Page one, scaled to fit a `px` box.
 *
 * By URL rather than by bytes, with `disableAutoFetch`, which is how the
 * desktop preview already loads a PDF: pdfjs then pulls the cross-reference
 * table and the one page it is asked for, instead of the whole document. For a
 * 200-page statement that is the difference between a few kilobytes and the
 * entire file crossing the IPC boundary for a 100 px tile.
 */
async function pdfThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const { loadPdfjs } = await import("@core/explorer/preview");
  const pdfjs = await loadPdfjs();
  const url = await fs.fileUrl(path);
  const task = pdfjs.getDocument({ url, disableAutoFetch: true });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    // Fit, not fill. A portrait page cropped to a square tile loses its head
    // and its foot, which on a document is where all the identifying marks
    // are -- the letterhead, the title, the date.
    const scale = Math.min(px / base.width, px / base.height);
    const vp = page.getViewport({ scale: Math.max(0.05, scale) });
    const made = surface(vp.width, vp.height);
    if (!made) return null;
    const [c, ctx] = made;
    // Paper first. A PDF page is transparent where it is blank, and left
    // transparent the text would sit on whatever the tile is behind it.
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
    return await encode(c);
  } finally {
    // Frees the worker's copy of the document. Without this a scroll through a
    // folder of PDFs leaks one parsed document per tile.
    void task.destroy().catch(() => {});
  }
}

// ── text ──────────────────────────────────────────────────────────────────

/**
 * The first lines of a text file, set on a page.
 *
 * Only the head is read -- 8 KB is far more than the dozen lines that fit --
 * so this costs the same for a 4 GB log as for a note.
 */
async function textThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const bytes = Uint8Array.from(await fs.readHead(path, 8192));
  // `fatal: false` so a file that is not UTF-8 (a Windows-1252 log, a truncated
  // multi-byte character at the 8 KB cut) renders with replacement characters
  // instead of throwing away a preview that would have been perfectly readable.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const page = textPage(px, text.split(/\r?\n/));
  return page ? await encode(page) : null;
}

// ── APK ──────────────────────────────────────────────────────────────────

/*
 * An APK is a zip file, and its launcher icon is a PNG inside it.
 *
 * The zip half is already solved: `core/table/zipread` reads one member out of
 * an archive without unpacking it, which is exactly the operation a 100 MB APK
 * holding a 4 KB icon needs. It was written for .xlsx and it does not care --
 * an .apk, a .jar and a workbook are the same container. Reusing it also means
 * the two subtleties that bite a hand-rolled reader (the local header's name
 * and extra lengths differ from the central directory's copy, and the trailing
 * comment can push the end record 64 KB from the last byte) are already
 * handled, and handled in one place.
 *
 * What is *not* attempted is reading `AndroidManifest.xml` to find out which
 * icon the app actually declares. That file is Android's binary XML, which
 * needs a resource-table parser and a chunk decoder to answer a question the
 * heuristic below answers correctly for essentially every real APK. The cost
 * of being wrong is a generic badge on one tile, which is where we started.
 */

/** Icon-ish members, best guess first. */
function iconCandidates(entries: readonly ZipEntry[]): ZipEntry[] {
  // 256 bytes only rules out the spacers: a 1x1 transparent PNG is about 70
  // bytes and a nine-patch divider not much more. It is deliberately not set
  // where it would exclude a small icon -- a flat two-colour launcher icon at
  // 48 px compresses to under half a kilobyte, and an early draft of this
  // filter threw exactly that away. Size is a weak proxy for "is this an
  // icon"; the real test is the shape check in `plate`, which measures the
  // decoded image instead of guessing from the byte count.
  const pics = entries.filter(
    (e) => /^res\/.+\.(png|webp)$/i.test(e.name) && e.uncompressedSize > 256,
  );
  const score = (e: ZipEntry): number => {
    const n = e.name.toLowerCase();
    let s = 0;
    // Named outright. Nothing else comes close as a signal.
    if (n.includes("ic_launcher") || n.includes("ic_app") || n.includes("app_icon")) s += 1000;
    else if (n.includes("launcher") || n.includes("appicon")) s += 700;
    // `res/mipmap-*` exists for one reason in the platform's own convention,
    // and that reason is the launcher icon.
    if (n.startsWith("res/mipmap")) s += 300;
    // The round variant is a real launcher icon but the wrong one for a square
    // tile, so it ranks below its square sibling and above everything else.
    if (n.includes("round")) s -= 120;
    // Foreground layer of an adaptive icon: correct art, but it is the half
    // that expects a background behind it, so prefer a flat icon if there is
    // one. Still far better than a badge.
    if (n.includes("foreground")) s -= 60;
    if (n.includes("background")) s -= 400;
    // Bigger means a higher density bucket, which is the resolution we want.
    // Log, so a few kilobytes cannot outrank being named `ic_launcher`.
    s += Math.log2(e.uncompressedSize) * 4;
    return s;
  };
  return pics.sort((a, b) => score(b) - score(a)).slice(0, 4);
}

/**
 * Draw `icon` centred on a plate at `px`.
 *
 * The plate is there because launcher icons are transparent outside their
 * shape, and a dark glyph on a dark tile is an empty tile. Inset a little, so
 * it reads as an app icon on a card rather than as a cropped photograph.
 */
async function plate(bytes: Uint8Array, px: number): Promise<Blob | null> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    return null;
  }
  try {
    // Square-ish, and not tiny. The last line of defence against picking up a
    // banner or a nine-patch out of an APK whose resource names were mangled
    // by the shrinker, where the name carries no signal at all.
    const ratio = bmp.width / bmp.height;
    if (ratio < 0.7 || ratio > 1.4 || Math.min(bmp.width, bmp.height) < 32) return null;

    const made = surface(px, px);
    if (!made) return null;
    const [c, ctx] = made;
    ctx.fillStyle = PLATE;
    ctx.fillRect(0, 0, px, px);
    const box = Math.round(px * 0.76);
    const scale = Math.min(box / bmp.width, box / bmp.height);
    const w = bmp.width * scale;
    const h = bmp.height * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, (px - w) / 2, (px - h) / 2, w, h);
    return await encode(c);
  } finally {
    bmp.close();
  }
}

/** The app's own icon, or null to fall back to a badge. */
async function apkThumb(fs: RangedReads, path: string, px: number): Promise<Blob | null> {
  const entries = await readDirectory(fs, path);
  for (const e of iconCandidates(entries)) {
    // A single unreadable member is not a verdict on the file -- an adaptive
    // icon's foreground can be a vector while its sibling PNG reads fine -- so
    // each candidate gets its own try and the loop continues past a failure.
    try {
      const out = await plate(await readEntry(fs, path, e), px);
      if (out) return out;
    } catch {
      continue;
    }
  }
  return null;
}

// ── entry point ───────────────────────────────────────────────────────────

/**
 * A thumbnail for a non-picture file, or null if there is nothing to draw.
 *
 * Null is a normal answer and the caller should treat it as final: it means
 * this file has no preview worth showing, and the chip is the right result.
 */
export async function docThumb(
  fs: RangedReads,
  path: string,
  ext: string,
  px: number,
): Promise<Blob | null> {
  const kind = docThumbKind(ext);
  if (kind === null) return null;
  const e = ext.toLowerCase();
  try {
    switch (kind) {
      case "pdf":
        return (await pdfThumb(fs, path, px)) ?? (await cardThumb(e, px));
      case "apk":
        return (await apkThumb(fs, path, px)) ?? (await cardThumb(e, px));
      case "text":
        return (await textThumb(fs, path, px)) ?? (await cardThumb(e, px));
      default:
        return await fileThumb(kind, fs, path, e, px);
    }
  } catch {
    // A PDF whose xref sends pdfjs chasing its tail, a text file that vanished
    // between the scan and the render: the tile still gets a page rather than
    // a hole.
    return await cardThumb(e, px);
  }
}
