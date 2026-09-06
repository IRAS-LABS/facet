/**
 * Previews for everything.
 *
 * A grid of glyphs and truncated names is not a file explorer, it is a list
 * with extra steps — you cannot find the right screenshot, the right take, or
 * the right config file without seeing inside it. So every card asks this
 * service what its file looks like, and the answer is a `Preview` the card can
 * paint directly.
 *
 * Three rules hold the whole thing together:
 *
 *  1. **Nothing here blocks a paint.** Cards render immediately with a glyph;
 *     previews arrive later and swap in. A folder of 40 000 files asks only for
 *     the cards actually on screen at the readable zoom tier.
 *  2. **Bounded work per file.** Reads are capped, decodes are capped, and at
 *     most `lanes()` run at once. Scrolling fast through a folder must not queue
 *     ten thousand decodes behind the cards you are actually looking at.
 *  3. **A failure is an answer.** Anything we cannot preview resolves to
 *     `{type:"none", reason}` and is cached like any other result, so a RAW file
 *     is asked about once, not once per scroll. The reason is shown to the user
 *     rather than hidden, because "HEIC needs a decoder" is information and a
 *     broken-image icon is not.
 *
 * What is missing and why is listed in NEEDS_DECODER at the bottom: PDF, RAW,
 * HEIC and Office files all need a real decoder, and none of them can be faked
 * convincingly from bytes we already have.
 */

import type { DirListing, FileEntry, Preview } from "./types";
// Importing the registry declares the settings read below; `settings.get` on an
// undeclared id is a warning and an undefined, so the import is load-bearing.
import { PREF } from "@core/settings/registry";
import { settings } from "@core/settings/store";

/*
 * The tunables below are the *defaults*, and they live in the registry now —
 * these constants are what the registry declares. Where a value is read at the
 * point of use it is read from the store instead, so changing "Previews at
 * once" in the settings panel takes effect on the next file rather than on the
 * next launch.
 */

/** Longest edge of a generated raster preview, in px. */
const FRAME_PX = 320;

/** Bytes read for a text-ish head preview. */
const TEXT_HEAD = 4096;

/** Lines shown on a text card face. Configurable — "Lines on a text preview". */
const textLines = (): number => settings.get<number>(PREF.previewTextLines);

/** Bytes read looking for embedded cover art before giving up. */
const TAG_HEAD = 96 * 1024;
const TAG_HEAD_MAX = 1536 * 1024;

/** Preview results kept in memory. Beyond this the oldest are dropped. */
const cacheMax = (): number => settings.get<number>(PREF.previewCache);

/** How many previews may be in flight at once. */
const lanes = (): number => settings.get<number>(PREF.previewLanes);

/** Bytes of a RAW file read looking for its IFD chain. */
const RAW_HEAD = 256 * 1024;

/**
 * Bounds on an embedded preview worth pulling through the bridge. The floor is
 * low on purpose: it exists to reject an offset that turned out to point at
 * nothing, not to prefer the big preview over the small one — the caller
 * already sorts by size and the JPEG magic number is checked either way.
 */
const RAW_PREVIEW_MIN = 256;
const RAW_PREVIEW_MAX = 24 * 1024 * 1024;

/**
 * Tail read when looking for a zip's end-of-central-directory record. It sits
 * at the very end unless the archive carries a comment, and the comment field
 * is 16 bits, so 64 KB + the record itself always finds it.
 */
const ZIP_TAIL = 64 * 1024 + 128;
const ZIP_CD_MAX = 4 * 1024 * 1024;
const ZIP_ENTRIES_MAX = 4000;
const ZIP_MEMBER_MAX = 24 * 1024 * 1024;

/** Largest HEIC worth pulling into memory whole. Phone shots are ~2-4 MB. */
const HEIC_MAX = 48 * 1024 * 1024;

/** Images a webview can decode. Anything else needs a module we have not built. */
const WEB_IMAGE = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "avifs",
  "bmp", "svg", "ico",
]);
const WEB_VIDEO = new Set(["mp4", "webm", "m4v", "mov", "ogv"]);

/**
 * Extensions worth previewing as their own text. Deliberately generous — if a
 * file is textual, its first lines are almost always the best possible preview
 * of it, better than any icon could be.
 */
const TEXTUAL = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonl", "ndjson",
  "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "rb", "go", "java", "kt",
  "kts", "c", "h", "cpp", "hpp", "cc", "cs", "swift", "php", "sh", "bash", "zsh",
  "ps1", "psm1", "bat", "cmd", "sql", "css", "scss", "less", "html", "htm", "vue",
  "svelte", "lua", "r", "m", "pl", "diff", "patch", "gitignore", "dockerfile",
  "makefile", "gradle", "srt", "vtt", "ass", "cube", "obj", "mtl", "ply", "gcode",
]);

/**
 * RAW files are containers: every one of them carries a full-size JPEG preview
 * so the camera's own screen can show the shot instantly. Extracting that beats
 * demosaicing the sensor data — it is the picture the photographer saw.
 */
const RAW_TIFF = new Set(["cr2", "nef", "arw", "dng", "orf", "rw2", "srw", "pef", "3fr"]);

/** Zip containers. Office and friends are zips with a known layout inside. */
const ZIP_LIKE = new Set([
  "zip", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "apk", "jar", "ipa", "vsix",
]);

/**
 * Where each Office-family format keeps its text, so a document with no saved
 * thumbnail can still preview as its own first words rather than as an icon.
 */
const OFFICE_TEXT: Record<string, string> = {
  docx: "word/document.xml",
  pptx: "ppt/slides/slide1.xml",
  xlsx: "xl/sharedStrings.xml",
  odt: "content.xml",
  ods: "content.xml",
  odp: "content.xml",
};

/** Media folders inside Office packages, used as a thumbnail of last resort. */
const OFFICE_MEDIA = ["word/media/", "ppt/media/", "xl/media/", "Pictures/"];

/**
 * Pictures per folder card, files decoded to fill it, subfolders searched, and
 * the smaller decode budget one level down — a folder card is worth some work,
 * not unbounded work.
 */
const FOLDER_TILES = 4;
const FOLDER_PROBE = 4;
const FOLDER_SUBS = 6;
const FOLDER_SUB_PROBE = 2;

/** Names listed on a folder card that has no picture to show instead. */
const FOLDER_LIST = 8;

/**
 * Files `build` can turn into an actual picture, used to decide what is worth
 * decoding for a folder card. Office documents are left out on purpose: they
 * usually preview as their own text, and parsing a zip directory per file to
 * find that out is not worth it just to draw a folder.
 */
function picturable(e: FileEntry): boolean {
  return (
    WEB_VIDEO.has(e.ext) ||
    e.kind === "audio" ||
    e.ext === "pdf" ||
    e.ext === "heic" ||
    e.ext === "heif" ||
    e.ext === "raf" ||
    RAW_TIFF.has(e.ext)
  );
}

export interface PreviewHost {
  fileUrl(path: string): Promise<string>;
  readHead(path: string, max: number): Promise<number[]>;
  /** Bytes from an arbitrary offset. Absent in the browser preview. */
  readRange?(path: string, offset: number, len: number): Promise<number[]>;
  /** Tail bytes plus total file size, together so they cannot disagree. */
  readTail?(path: string, len: number): Promise<[number[], number]>;
  list(path: string): Promise<DirListing>;
}

/** One member of a zip, as described by the central directory. */
interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  offset: number;
}

export class PreviewService {
  private readonly cache = new Map<string, Preview>();
  private readonly inflight = new Map<string, Promise<Preview>>();
  private active = 0;
  private readonly queue: Array<() => void> = [];
  /** Bumped by `reset()`; work started before the current epoch is discarded. */
  private epoch = 0;

  constructor(private readonly host: PreviewHost) {}

  /** Synchronous peek — what a card should paint right now, if we know. */
  peek(entry: FileEntry): Preview | undefined {
    return this.cache.get(entry.path);
  }

  /**
   * Ask for a preview. Repeat asks for the same path share one piece of work,
   * which matters because scrolling mounts and unmounts the same card many
   * times a second.
   */
  async want(entry: FileEntry): Promise<Preview> {
    // Both switches answer here rather than deeper in, so that turning previews
    // off costs nothing at all — no read, no decode, no queue slot — which is
    // the entire reason someone on a slow network drive would turn them off.
    if (!settings.get<boolean>(PREF.previews)) {
      return { type: "none", reason: "previews are turned off in settings" };
    }
    if (entry.kind === "folder" && !settings.get<boolean>(PREF.folderPreviews)) {
      return { type: "none", reason: "folder previews are turned off in settings" };
    }

    const hit = this.cache.get(entry.path);
    if (hit) return hit;
    const busy = this.inflight.get(entry.path);
    if (busy) return busy;

    const era = this.epoch;
    const job = this.gate(() => this.build(entry))
      .catch((e: unknown): Preview => ({ type: "none", reason: short(e) }))
      .then((p) => {
        this.inflight.delete(entry.path);
        if (era === this.epoch) this.remember(entry.path, p);
        return p;
      });
    this.inflight.set(entry.path, job);
    return job;
  }

  /**
   * Drop everything for a folder change. Previews of files you have navigated
   * away from are dead weight, and the generated frames hold real memory.
   */
  reset(): void {
    this.epoch++;
    this.cache.clear();
    this.inflight.clear();
    this.queue.length = 0;
  }

  private remember(path: string, p: Preview): void {
    // A loop rather than one eviction: the budget can be lowered while the
    // cache is already fuller than the new limit, and dropping one per insert
    // would take a thousand more previews to honour a setting the user changed
    // to get memory back now.
    while (this.cache.size >= cacheMax()) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(path, p);
  }

  /** Concurrency gate. Without it a fast scroll starts hundreds of decodes. */
  private gate<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active++;
        fn().then(resolve, reject).finally(() => {
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < lanes()) start();
      else this.queue.push(start);
    });
  }

  // ── Per-kind builders ─────────────────────────────────────────────────────

  private async build(entry: FileEntry): Promise<Preview> {
    if (entry.kind === "folder") return this.folder(entry);

    const ext = entry.ext;

    if (WEB_IMAGE.has(ext)) {
      const url = await this.host.fileUrl(entry.path);
      // Big photographs get downscaled once instead of being decoded at full
      // resolution into a 190 px card. A folder of 24-megapixel raws-as-JPEGs
      // is ~100 MB of decoded bitmap per screenful otherwise; SVG is exempt
      // because it is already resolution-free.
      //
      // The test is the image's *pixels*, not its file size, and `downscale`
      // makes it: a well-compressed 400 KB photo can still be 6000 px wide, and
      // a byte-size gate waves it through. Nothing is wasted asking — the card
      // has to decode the image either way, and an already-small one comes back
      // null and keeps its original URL.
      if (ext !== "svg") {
        const small = await this.downscale(url);
        if (small) return small;
      }
      return { type: "image", url };
    }
    if (WEB_VIDEO.has(ext)) {
      return this.videoFrame(await this.host.fileUrl(entry.path));
    }
    if (entry.kind === "audio") {
      return this.audioArt(entry);
    }
    if (ext === "pdf") return this.pdfPage(entry);
    if (ext === "heic" || ext === "heif") return this.heicImage(entry);
    if (RAW_TIFF.has(ext)) return this.rawPreview(entry, ext);
    if (ext === "raf") return this.fujiPreview(entry);
    if (ZIP_LIKE.has(ext)) return this.zipPreview(entry, ext);
    if (TEXTUAL.has(ext) || (ext === "" && entry.kind !== "binary")) {
      return this.textHead(entry);
    }

    const needs = NEEDS_DECODER[ext];
    if (needs) return { type: "none", reason: needs };

    // Unknown extension: it still might be text. One cheap read decides.
    return this.textHead(entry);
  }

  /**
   * A folder previews as what is inside it. Album art, a shoot, a screenshots
   * dump — the covers *are* the folder's identity, and a folder glyph tells you
   * nothing you did not already know from the name.
   */
  private async folder(entry: FileEntry): Promise<Preview> {
    const listing = await this.host.list(entry.path);
    const found = await this.folderTiles(listing.entries, {
      probe: FOLDER_PROBE,
      descend: true,
    });
    if (found.urls.length > 0) {
      return { type: "tiles", urls: found.urls, more: found.more };
    }

    // No pictures anywhere inside — so show the contents as a list. A folder of
    // source, or of shortcuts, or of spreadsheets has no image to give, and a
    // grey glyph reading "5 items" says nothing you did not know from the name.
    // Its table of contents does: you can tell a build folder from a config
    // folder at a glance, without opening either.
    const n = listing.entries.length;
    if (n > 0) {
      const sorted = [...listing.entries].sort((a, b) => {
        // Folders first, because they are the structure and the files are the
        // detail — same order the folder itself opens in.
        if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines = sorted
        .slice(0, FOLDER_LIST)
        .map((e) => (e.kind === "folder" ? `${e.name}/` : e.name));
      if (n > lines.length) lines.push(`+${n - lines.length} more`);
      return { type: "text", lines };
    }

    const reason = n === 0 ? "empty" : n === 1 ? "1 item" : `${n} items`;
    return { type: "none", reason };
  }

  /**
   * Pictures for a folder card, cheapest source first: images the webview can
   * simply point at, then files that have to be decoded to become a picture,
   * then one level down.
   *
   * The old rule was "direct children that are web images", and on a real home
   * directory that left almost every folder blank — Pictures keeps its photos in
   * Camera Roll, Music is album folders, a phone dumps HEIC, a camera dumps RAW,
   * and none of those are a jpg sitting at the top level. Eighteen identical
   * grey glyphs is exactly the grid-of-nothing the previews exist to replace.
   *
   * The recursive call gets a smaller decode budget rather than none: Videos
   * holds nothing but Captures and Screen Recordings, and a Videos folder that
   * shows nothing because the clips are one level down is the exact complaint
   * this is here to answer.
   */
  private async folderTiles(
    entries: FileEntry[],
    opts: { probe: number; descend: boolean },
  ): Promise<{ urls: string[]; more: number }> {
    const plain = entries.filter((e) => e.kind !== "folder" && WEB_IMAGE.has(e.ext));
    const decodable =
      opts.probe > 0
        ? entries.filter((e) => e.kind !== "folder" && !WEB_IMAGE.has(e.ext) && picturable(e))
        : [];

    const urls = await Promise.all(
      plain.slice(0, FOLDER_TILES).map((e) => this.host.fileUrl(e.path)),
    );

    // Each of these costs a decode, so only a few are ever tried — enough to
    // fill the card, not enough to make opening a folder expensive.
    for (const e of decodable.slice(0, opts.probe)) {
      if (urls.length >= FOLDER_TILES) break;
      const p = await this.build(e).catch(() => null);
      if (p && p.type === "image") urls.push(p.url);
    }

    if (urls.length > 0) {
      return { urls, more: Math.max(0, plain.length + decodable.length - urls.length) };
    }

    if (!opts.descend) return { urls, more: 0 };

    // Nothing at this level, so look inside. This is where Camera Roll, an
    // album per artist and a shoot per date actually live.
    const subs = entries.filter((e) => e.kind === "folder").slice(0, FOLDER_SUBS);
    for (const s of subs) {
      const listing = await this.host.list(s.path).catch(() => null);
      if (!listing) continue;
      const inner = await this.folderTiles(listing.entries, {
        probe: FOLDER_SUB_PROBE,
        descend: false,
      });
      urls.push(...inner.urls);
      if (urls.length >= FOLDER_TILES) break;
    }
    return { urls: urls.slice(0, FOLDER_TILES), more: 0 };
  }

  /**
   * Shrink a large photo to card size. Returns null on any failure so the
   * caller can simply fall back to the original URL — a downscale that did not
   * work is a performance loss, not a reason to show nothing.
   */
  private downscale(url: string): Promise<Preview | null> {
    return new Promise<Preview | null>((resolve) => {
      // The whole body is guarded, not just the draw. `new Image()` throws
      // outright where there is no DOM, and a synchronous throw inside a
      // Promise executor rejects the promise rather than returning null —
      // which would turn "could not shrink this" into "this file has no
      // preview" for every image in the folder.
      try {
        const img = new Image();
        img.decoding = "async";
        const timer = setTimeout(() => resolve(null), 12_000);
        img.onerror = () => { clearTimeout(timer); resolve(null); };
        img.onload = () => {
          clearTimeout(timer);
          try {
            // Already card-sized: re-encoding would cost a JPEG pass and flatten
            // any transparency to black for nothing. Null means "keep yours".
            if (img.naturalWidth <= FRAME_PX && img.naturalHeight <= FRAME_PX) {
              return resolve(null);
            }
            const s = Math.min(1, FRAME_PX / Math.max(img.naturalWidth, img.naturalHeight));
            const c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(img.naturalWidth * s));
            c.height = Math.max(1, Math.round(img.naturalHeight * s));
            const ctx = c.getContext("2d");
            if (!ctx) return resolve(null);
            ctx.drawImage(img, 0, 0, c.width, c.height);
            resolve({ type: "image", url: c.toDataURL("image/jpeg", 0.78) });
          } catch {
            // Tainted canvas, out of memory — the original still works.
            resolve(null);
          }
        };
        img.src = url;
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * A frame out of the video, because a film strip icon is the same icon for
   * every clip you have ever shot. Seeks a little way in first: frame zero of a
   * real recording is very often black or a fade-up.
   */
  private videoFrame(url: string): Promise<Preview> {
    return new Promise<Preview>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      // Needed on Safari/WebKit-family webviews, which otherwise refuse to
      // decode a frame for an element that was never in the document.
      v.playsInline = true;
      v.crossOrigin = "anonymous";

      let settled = false;
      const done = (p: Preview): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeAttribute("src");
        v.load();
        resolve(p);
      };

      // A file on a slow or disconnected drive must not hold a lane forever.
      const timer = setTimeout(() => done({ type: "none", reason: "timed out" }), 12_000);

      v.addEventListener("error", () => done({ type: "none", reason: "cannot decode" }));
      v.addEventListener("loadeddata", () => {
        const d = v.duration;
        v.currentTime = Number.isFinite(d) && d > 0 ? Math.min(d * 0.1, 2) : 0;
      });
      v.addEventListener("seeked", () => {
        try {
          const w = v.videoWidth;
          const h = v.videoHeight;
          if (w === 0 || h === 0) return done({ type: "none", reason: "no picture" });
          const s = Math.min(1, FRAME_PX / Math.max(w, h));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(w * s));
          c.height = Math.max(1, Math.round(h * s));
          const ctx = c.getContext("2d");
          if (!ctx) return done({ type: "none", reason: "no canvas" });
          ctx.drawImage(v, 0, 0, c.width, c.height);
          done({ type: "image", url: c.toDataURL("image/jpeg", 0.72) });
        } catch (e) {
          done({ type: "none", reason: short(e) });
        }
      });

      v.src = url;
    });
  }

  /**
   * Embedded cover art, read straight out of the tag. Two formats cover almost
   * every music library: ID3v2 (mp3, and often .aiff/.wav) and FLAC's own
   * PICTURE block. Anything else falls back to the kind glyph.
   */
  private async audioArt(entry: FileEntry): Promise<Preview> {
    const head = new Uint8Array(await this.host.readHead(entry.path, TAG_HEAD));

    // ID3v2 declares its own total size, so we know whether the art we are
    // looking for even fits in what we read — and can ask for exactly enough.
    if (head.length > 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const total = 10 + syncsafe(head, 6);
      const full =
        total <= head.length
          ? head
          : total <= TAG_HEAD_MAX
            ? new Uint8Array(await this.host.readHead(entry.path, total))
            : head;
      const art = id3Picture(full);
      if (art) return { type: "image", url: art };
    }

    if (head.length > 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
      const art = flacPicture(head);
      if (art) return { type: "image", url: art };
    }

    return { type: "none", reason: "no cover art" };
  }

  /** The first lines of the file, which for anything textual is the real thing. */
  private async textHead(entry: FileEntry): Promise<Preview> {
    const bytes = new Uint8Array(await this.host.readHead(entry.path, TEXT_HEAD));
    if (bytes.length === 0) return { type: "none", reason: "empty file" };

    // UTF-16 is plain text that is half NUL bytes, so the binary test throws it
    // out — and on Windows that is a lot of real text: PowerShell transcripts,
    // anything written with `>` from a 5.1 console, plenty of exported logs.
    // They previewed as "binary", which is both wrong and useless.
    const enc = bomEncoding(bytes);
    if (!enc && !looksTextual(bytes)) return { type: "none", reason: "binary" };

    const text = new TextDecoder(enc ?? "utf-8", { fatal: false }).decode(bytes);
    const lines = text
      .split(/\r?\n/, textLines() + 1)
      .slice(0, textLines())
      // Tabs collapse to a single glyph inside a card, which destroys the shape
      // of indented code — most of what a code preview is worth. Control
      // characters are dropped outright rather than drawn as replacement boxes.
      .map((l) => l.replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ""));
    // Trailing blank lines waste the card face, which is the scarcest space here.
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length === 0) return { type: "none", reason: "blank" };
    return { type: "text", lines };
  }

  // ── Decoders loaded on demand ─────────────────────────────────────────────

  /**
   * Page one, rendered. A PDF is the one format where the first page really is
   * the file — a cover, a letterhead, a scanned receipt — and every other
   * preview strategy for it is a guess.
   */
  private async pdfPage(entry: FileEntry): Promise<Preview> {
    const pdfjs = await loadPdfjs();
    const url = await this.host.fileUrl(entry.path);
    // disableAutoFetch keeps a 400-page document from streaming in its entirety
    // when all we ever look at is the first page.
    const task = pdfjs.getDocument({ url, disableAutoFetch: true });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      const unit = page.getViewport({ scale: 1 });
      const scale = Math.min(2, FRAME_PX / Math.max(unit.width, unit.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.ceil(vp.width));
      c.height = Math.max(1, Math.ceil(vp.height));
      const ctx = c.getContext("2d");
      if (!ctx) return { type: "none", reason: "no canvas" };
      // A PDF page paints nothing where it is blank, so without a white ground
      // a normal document renders as black text on a transparent card.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
      return { type: "image", url: c.toDataURL("image/jpeg", 0.8) };
    } finally {
      // The loading task owns the worker and the outstanding requests, so it is
      // the thing that has to be torn down — the document proxy has no destroy.
      void task.destroy();
    }
  }

  /**
   * HEIC, which is what the phone actually shoots. Decoded through libheif;
   * one at a time, because a 12-megapixel frame is ~48 MB of RGBA and four
   * lanes of that at once is a memory spike big enough to notice.
   */
  private async heicImage(entry: FileEntry): Promise<Preview> {
    if ((entry.size ?? 0) > HEIC_MAX) return { type: "none", reason: "HEIC too large to preview" };
    const bytes = new Uint8Array(await this.host.readHead(entry.path, HEIC_MAX));
    if (bytes.length === 0) return { type: "none", reason: "empty file" };

    return (heicLock = heicLock.then(async () => {
      const libheif = await loadHeif();
      const images = new libheif.HeifDecoder().decode(bytes);
      const image = images[0];
      if (!image) return { type: "none", reason: "no image inside" } as Preview;
      try {
        const w = image.get_width();
        const h = image.get_height();
        if (w <= 0 || h <= 0) return { type: "none", reason: "no picture" } as Preview;

        const full = document.createElement("canvas");
        full.width = w;
        full.height = h;
        const fctx = full.getContext("2d");
        if (!fctx) return { type: "none", reason: "no canvas" } as Preview;
        const data = fctx.createImageData(w, h);
        const filled = await new Promise<boolean>((resolve) => {
          image.display(data, (out) => resolve(out !== null));
        });
        if (!filled) return { type: "none", reason: "cannot decode" } as Preview;
        fctx.putImageData(data, 0, 0);

        const s = Math.min(1, FRAME_PX / Math.max(w, h));
        const small = document.createElement("canvas");
        small.width = Math.max(1, Math.round(w * s));
        small.height = Math.max(1, Math.round(h * s));
        const sctx = small.getContext("2d");
        if (!sctx) return { type: "none", reason: "no canvas" } as Preview;
        sctx.drawImage(full, 0, 0, small.width, small.height);
        // Drop the full-size bitmap now rather than at the next GC.
        full.width = 0;
        full.height = 0;
        return { type: "image", url: small.toDataURL("image/jpeg", 0.8) } as Preview;
      } finally {
        image.free?.();
      }
    }));
  }

  // ── Containers ────────────────────────────────────────────────────────────

  private range(path: string, offset: number, len: number): Promise<number[]> {
    if (!this.host.readRange) return Promise.reject(new Error("needs the desktop app"));
    return this.host.readRange(path, offset, len);
  }

  /**
   * The JPEG a RAW file already contains. Every camera writes one so its own
   * screen can show the shot without demosaicing, and it is the photographer's
   * picture — the same framing, the same crop, usually full resolution.
   *
   * RAW formats are TIFF underneath, so this is an IFD walk: collect every
   * (offset, length) pair that describes a JPEG, then take the biggest.
   */
  private async rawPreview(entry: FileEntry, ext: string): Promise<Preview> {
    const head = new Uint8Array(await this.host.readHead(entry.path, RAW_HEAD));
    if (head.length < 16) return { type: "none", reason: "truncated" };

    const le = head[0] === 0x49 && head[1] === 0x49;
    const be = head[0] === 0x4d && head[1] === 0x4d;
    if (!le && !be) return { type: "none", reason: `${ext.toUpperCase()} header not recognised` };

    const picks = tiffJpegs(head, le);
    if (picks.length === 0) return { type: "none", reason: "no embedded preview" };

    // Biggest first: a RAW usually holds both a 160 px thumbnail and a full-size
    // preview, and the thumbnail is not worth showing on a card this size.
    picks.sort((a, b) => b.len - a.len);
    for (const p of picks.slice(0, 3)) {
      if (p.len < RAW_PREVIEW_MIN || p.len > RAW_PREVIEW_MAX) continue;
      const bytes = new Uint8Array(await this.range(entry.path, p.off, p.len));
      const out = await this.fromJpeg(bytes);
      if (out) return out;
    }
    return { type: "none", reason: "embedded preview unreadable" };
  }

  /**
   * Fuji's RAF is not TIFF. It puts the offset and length of its embedded JPEG
   * at fixed positions in a 148-byte header, big-endian, which makes it the
   * easiest preview in the whole file.
   */
  private async fujiPreview(entry: FileEntry): Promise<Preview> {
    const head = new Uint8Array(await this.host.readHead(entry.path, 256));
    if (head.length < 92 || latin1(head.subarray(0, 8)) !== "FUJIFILM") {
      return { type: "none", reason: "RAF header not recognised" };
    }
    const off = be32(head, 84);
    const len = be32(head, 88);
    if (len < RAW_PREVIEW_MIN || len > RAW_PREVIEW_MAX) return { type: "none", reason: "no embedded preview" };
    const out = await this.fromJpeg(new Uint8Array(await this.range(entry.path, off, len)));
    return out ?? { type: "none", reason: "embedded preview unreadable" };
  }

  /**
   * Turn extracted JPEG bytes into a card-sized preview. Extracted previews are
   * often full-resolution, so this hands the big one to `downscale` and keeps
   * only the small result — otherwise a folder of 40 RAWs holds 120 MB of
   * base64 in the cache.
   */
  private async fromJpeg(bytes: Uint8Array): Promise<Preview | null> {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const url = dataUrl("image/jpeg", bytes);
    if (!url) return null;
    return (await this.downscale(url)) ?? { type: "image", url };
  }

  /**
   * Zip containers. Office documents, ebooks and APKs are all zips with a known
   * layout, so the preview is whatever the format put inside: a saved
   * thumbnail, else an embedded image, else the document's own text. A plain
   * archive previews as its contents, which is the thing you actually want to
   * know before extracting it.
   */
  private async zipPreview(entry: FileEntry, ext: string): Promise<Preview> {
    const dir = await this.zipDir(entry.path);
    if (dir.length === 0) return { type: "none", reason: "empty or not a zip" };

    const find = (pred: (n: string) => boolean): ZipEntry | undefined =>
      dir.find((e) => e.size > 0 && pred(e.name.toLowerCase()));

    // 1. A thumbnail the authoring app already rendered for us.
    const thumb =
      find((n) => n.startsWith("docprops/thumbnail.") && /\.(jpe?g|png)$/.test(n)) ??
      find((n) => n === "thumbnails/thumbnail.png");
    if (thumb) {
      const img = await this.zipImage(entry.path, thumb);
      if (img) return img;
    }

    // 2. EPUB covers are conventionally named, and they are the whole point.
    if (ext === "epub") {
      const cover = find((n) => /cover[^/]*\.(jpe?g|png)$/.test(n)) ?? find(isImageName);
      if (cover) {
        const img = await this.zipImage(entry.path, cover);
        if (img) return img;
      }
    }

    // 3. The document's own words.
    //
    // This sits above the embedded-image rule, which is not the obvious order.
    // Tried the other way against real files first, and "largest image in the
    // package" reliably picks decoration: a letterhead logo on a contract, a
    // headshot on a deck, a supplier logo on an invoice. Every document from one
    // company then previews as the same logo — the one thing that cannot tell
    // them apart. The opening words are nearly always the title, which is what
    // you are scanning for. Formats that genuinely *are* their picture (epub)
    // are handled above, and an authored thumbnail still outranks everything.
    const textPart = OFFICE_TEXT[ext];
    if (textPart) {
      const member = dir.find((e) => e.name === textPart);
      if (member) {
        const raw = await this.zipRead(entry.path, member);
        if (raw) {
          const lines = xmlToLines(new TextDecoder("utf-8", { fatal: false }).decode(raw));
          if (lines.length > 0) return { type: "text", lines };
        }
      }
    }

    // 4. No words to be had — a picture from inside beats a generic icon.
    const media = dir
      .filter((e) => OFFICE_MEDIA.some((d) => e.name.startsWith(d)) && isImageName(e.name.toLowerCase()))
      .sort((a, b) => b.size - a.size)[0];
    if (media) {
      const img = await this.zipImage(entry.path, media);
      if (img) return img;
    }

    if (textPart) return { type: "none", reason: "no text or images inside" };

    // 5. A plain archive: show what is in it.
    const names = dir
      .filter((e) => !e.name.endsWith("/"))
      .slice(0, textLines() - 1)
      .map((e) => `${e.name}  ${kb(e.size)}`);
    const rest = dir.filter((e) => !e.name.endsWith("/")).length - names.length;
    if (rest > 0) names.push(`… +${rest} more`);
    return names.length > 0 ? { type: "text", lines: names } : { type: "none", reason: "empty archive" };
  }

  private async zipImage(path: string, e: ZipEntry): Promise<Preview | null> {
    const bytes = await this.zipRead(path, e);
    if (!bytes) return null;
    const mime = e.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    if (mime === "image/jpeg") return this.fromJpeg(bytes);
    const url = dataUrl(mime, bytes);
    if (!url) return null;
    return (await this.downscale(url)) ?? { type: "image", url };
  }

  /**
   * A zip's file table lives at the *end* of the file — that is the whole
   * reason `read_tail` exists. Read the tail, find the end-of-central-directory
   * record, then seek to the directory it points at.
   */
  private async zipDir(path: string): Promise<ZipEntry[]> {
    if (!this.host.readTail) throw new Error("needs the desktop app");
    const [tailArr, size] = await this.host.readTail(path, ZIP_TAIL);
    const tail = new Uint8Array(tailArr);
    const base = size - tail.length;

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];

    let cdSize = le32(tail, eocd + 12);
    let cdOff = le32(tail, eocd + 16);

    // ZIP64: the 32-bit fields saturate and the real values live in a separate
    // record found through a locator that sits just before the EOCD.
    if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
      let loc = -1;
      for (let i = eocd - 20; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x06 && tail[i + 3] === 0x07) {
          loc = i;
          break;
        }
      }
      if (loc < 0) return [];
      const z64 = new Uint8Array(await this.range(path, le64(tail, loc + 8), 56));
      if (z64.length < 56) return [];
      cdSize = le64(z64, 40);
      cdOff = le64(z64, 48);
    }

    const cd =
      cdOff >= base && cdOff + cdSize <= size
        ? tail.subarray(cdOff - base, cdOff - base + cdSize)
        : new Uint8Array(await this.range(path, cdOff, Math.min(cdSize, ZIP_CD_MAX)));

    const out: ZipEntry[] = [];
    let at = 0;
    while (at + 46 <= cd.length && out.length < ZIP_ENTRIES_MAX) {
      if (le32(cd, at) !== 0x02014b50) break;
      const nameLen = le16(cd, at + 28);
      const extraLen = le16(cd, at + 30);
      const commentLen = le16(cd, at + 32);
      out.push({
        name: utf8(cd.subarray(at + 46, at + 46 + nameLen)),
        method: le16(cd, at + 10),
        compSize: le32(cd, at + 20),
        size: le32(cd, at + 24),
        offset: le32(cd, at + 42),
      });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /** One member's bytes, inflating if it was deflated. */
  private async zipRead(path: string, e: ZipEntry): Promise<Uint8Array | null> {
    if (e.compSize > ZIP_MEMBER_MAX || e.size > ZIP_MEMBER_MAX) return null;
    // The central directory's local-header offset points at a header whose name
    // and extra fields may be *different lengths* from the central copy, so the
    // data offset has to be read from the local header itself.
    const lh = new Uint8Array(await this.range(path, e.offset, 30));
    if (lh.length < 30 || le32(lh, 0) !== 0x04034b50) return null;
    const at = e.offset + 30 + le16(lh, 26) + le16(lh, 28);
    const raw = new Uint8Array(await this.range(path, at, e.compSize));
    if (raw.length === 0) return null;
    if (e.method === 0) return raw;
    if (e.method !== 8) return null;
    return inflateRaw(raw);
  }
}

// ── Byte-level helpers ───────────────────────────────────────────────────────

/**
 * Textual until proven otherwise. A NUL byte settles it immediately; past that
 * a high proportion of control characters means we are looking at a container,
 * not prose. UTF-16 text trips the NUL test, which is why `bomEncoding` gets
 * asked first — this function only sees files with no byte-order mark.
 */
function looksTextual(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 2048);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) odd++;
  }
  return odd / n < 0.05;
}

/**
 * The encoding a file declares in its first bytes, or null if it declares none.
 * Only the marks worth trusting: a UTF-16 BOM is unambiguous, and it is the one
 * case where a file that fails every "is this text" heuristic is in fact text.
 * UTF-8's BOM is included because stripping it costs nothing and leaves a stray
 * glyph at the top of the card otherwise.
 */
function bomEncoding(b: Uint8Array): string | null {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return "utf-16le";
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return "utf-16be";
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return "utf-8";
  return null;
}

/** ID3's 28-bit size: seven bits per byte, top bit always clear. */
function syncsafe(b: Uint8Array, at: number): number {
  return (
    ((b[at]! & 0x7f) << 21) |
    ((b[at + 1]! & 0x7f) << 14) |
    ((b[at + 2]! & 0x7f) << 7) |
    (b[at + 3]! & 0x7f)
  );
}

function be32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

/**
 * Walk ID3v2 frames for an APIC (attached picture) and return it as a data URL.
 *
 * v2.2 used three-character frame ids and 3-byte sizes; v2.3/v2.4 use four and
 * four. Both still turn up in real libraries — anything ripped before about
 * 2005 is v2.2 — so both are handled rather than assuming the modern one.
 */
function id3Picture(b: Uint8Array): string | null {
  if (b.length < 10) return null;
  const version = b[3]!;
  const flags = b[5]!;
  const size = 10 + syncsafe(b, 6);
  let at = 10;
  // An extended header sits between the header and the first frame.
  if (version >= 3 && (flags & 0x40) !== 0 && b.length > 14) {
    at += version === 4 ? syncsafe(b, 10) : be32(b, 10) + 4;
  }

  const idLen = version === 2 ? 3 : 4;
  const wanted = version === 2 ? "PIC" : "APIC";
  const end = Math.min(size, b.length);

  while (at + idLen + (version === 2 ? 3 : 6) <= end) {
    const id = String.fromCharCode(...b.subarray(at, at + idLen));
    if (id.trim() === "" || id.charCodeAt(0) === 0) return null;

    let len: number;
    let headLen: number;
    if (version === 2) {
      len = (b[at + 3]! << 16) | (b[at + 4]! << 8) | b[at + 5]!;
      headLen = 6;
    } else {
      // v2.4 sizes are syncsafe; v2.3's are plain. Reading a v2.3 size as
      // syncsafe silently truncates any frame over 128 KB — which is to say,
      // every cover image — so this distinction is the whole ballgame.
      len = version === 4 ? syncsafe(b, at + 4) : be32(b, at + 4);
      headLen = 10;
    }
    if (len <= 0) return null;

    const body = at + headLen;
    if (id === wanted) {
      return version === 2
        ? pictureFromV2(b.subarray(body, Math.min(body + len, b.length)))
        : pictureFromV3(b.subarray(body, Math.min(body + len, b.length)));
    }
    at = body + len;
  }
  return null;
}

/** v2.2 PIC: encoding byte, 3-char image format, picture type, description. */
function pictureFromV2(f: Uint8Array): string | null {
  if (f.length < 6) return null;
  const enc = f[0]!;
  const fmt = String.fromCharCode(f[1]!, f[2]!, f[3]!).toUpperCase();
  const mime = fmt === "PNG" ? "image/png" : "image/jpeg";
  const descEnd = endOfString(f, 5, enc);
  if (descEnd < 0) return null;
  return dataUrl(mime, f.subarray(descEnd));
}

/** v2.3/v2.4 APIC: encoding byte, MIME string, picture type, description. */
function pictureFromV3(f: Uint8Array): string | null {
  if (f.length < 4) return null;
  const enc = f[0]!;
  let at = 1;
  const mimeStart = at;
  while (at < f.length && f[at] !== 0) at++;
  const mime = latin1(f.subarray(mimeStart, at)) || "image/jpeg";
  at++; // MIME is always latin-1 terminated, whatever the text encoding is
  at++; // picture type
  const descEnd = endOfString(f, at, enc);
  if (descEnd < 0 || descEnd >= f.length) return null;
  return dataUrl(mime.startsWith("image/") ? mime : `image/${mime}`, f.subarray(descEnd));
}

/**
 * Index just past a terminated string. UTF-16 encodings (1 and 2) terminate
 * with a *pair* of NULs on an even offset, which is the detail that turns a
 * cover image into garbage if you get it wrong.
 */
function endOfString(f: Uint8Array, from: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = from; i + 1 < f.length; i += 2) {
      if (f[i] === 0 && f[i + 1] === 0) return i + 2;
    }
    return -1;
  }
  for (let i = from; i < f.length; i++) if (f[i] === 0) return i + 1;
  return -1;
}

/** FLAC METADATA_BLOCK_PICTURE, block type 6. */
function flacPicture(b: Uint8Array): string | null {
  let at = 4;
  while (at + 4 <= b.length) {
    const header = b[at]!;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!;
    const body = at + 4;
    if (type === 6 && body + len <= b.length) {
      let p = body + 4; // picture type
      const mimeLen = be32(b, p);
      p += 4;
      const mime = latin1(b.subarray(p, p + mimeLen)) || "image/jpeg";
      p += mimeLen;
      const descLen = be32(b, p);
      p += 4 + descLen;
      p += 16; // width, height, depth, indexed colours
      const dataLen = be32(b, p);
      p += 4;
      if (p + dataLen <= b.length) return dataUrl(mime, b.subarray(p, p + dataLen));
      return null;
    }
    if (last) return null;
    at = body + len;
  }
  return null;
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

/**
 * Base64 in chunks. `String.fromCharCode(...bytes)` on a 500 KB cover blows the
 * argument limit and throws a RangeError, which is an unpleasant way to find
 * out your music folder has big artwork in it.
 */
function dataUrl(mime: string, bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return `data:${mime};base64,${btoa(s)}`;
}

// ── Lazily-loaded decoders ───────────────────────────────────────────────────
//
// Both are imported dynamically and memoised. Neither is worth its download
// until you actually open a folder containing one of these formats, and between
// them they are larger than the rest of the app put together.

let pdfjsOnce: Promise<typeof import("pdfjs-dist")> | null = null;

/**
 * Exported because the OCR panel (item 32) renders PDF pages too, and a second
 * copy of pdf.js would mean a second 1.5 MB download and a second worker for
 * the same library. Memoised here, so both callers share one instance.
 */
export function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  pdfjsOnce ??= (async () => {
    const [mod, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.mjs?url"),
    ]);
    // Without a worker, pdf.js renders on the main thread and every page turn
    // freezes the canvas.
    mod.GlobalWorkerOptions.workerSrc = worker.default;
    return mod;
  })();
  return pdfjsOnce;
}

let heifOnce: Promise<typeof import("libheif-js/wasm-bundle").default> | null = null;

function loadHeif(): Promise<typeof import("libheif-js/wasm-bundle").default> {
  heifOnce ??= import("libheif-js/wasm-bundle").then((m) => m.default);
  return heifOnce;
}

/** Serialises HEIC decodes; see `heicImage` for why. */
let heicLock: Promise<Preview> = Promise.resolve({ type: "none", reason: "" });

function utf8(b: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(b);
}

function le16(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

/** Unsigned — `<<24` in JS produces a *signed* 32-bit result, hence the `>>> 0`. */
function le32(b: Uint8Array, i: number): number {
  return (((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0);
}

/** 64-bit little-endian as a double. Exact below 2^53, which covers any file. */
function le64(b: Uint8Array, i: number): number {
  return le32(b, i) + le32(b, i + 4) * 0x1_0000_0000;
}

function le16be(b: Uint8Array, i: number, le: boolean): number {
  return le ? le16(b, i) : ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
}

function le32be(b: Uint8Array, i: number, le: boolean): number {
  return le ? le32(b, i) : be32(b, i);
}

function isImageName(n: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp)$/.test(n);
}

function kb(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Every JPEG a TIFF-based RAW file points at, as (offset, length) pairs.
 *
 * Walks the IFD chain and any SubIFDs, collecting three ways a preview gets
 * recorded: the JPEGInterchangeFormat pair used by most makers, a strip that is
 * itself JPEG-compressed (Canon's CR2 puts its full-size preview here), and
 * Panasonic's JpgFromRaw tag. Offsets that point outside the buffer we read are
 * still valid — they are absolute file offsets, and the caller seeks to them.
 */
function tiffJpegs(b: Uint8Array, le: boolean): Array<{ off: number; len: number }> {
  const out: Array<{ off: number; len: number }> = [];
  const seen = new Set<number>();
  const queue: number[] = [le32be(b, 4, le)];
  let guard = 0;

  while (queue.length > 0 && guard++ < 24) {
    const at = queue.shift()!;
    // An IFD beyond what we read cannot be walked without another round trip;
    // skipping it costs at most one candidate preview.
    if (at <= 0 || at + 2 > b.length || seen.has(at)) continue;
    seen.add(at);

    const count = le16be(b, at, le);
    if (count > 512) continue;
    let jpegOff = 0;
    let jpegLen = 0;
    let stripOff = 0;
    let stripLen = 0;
    let compression = 0;

    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = le16be(b, e, le);
      const type = le16be(b, e + 2, le);
      const n = le32be(b, e + 4, le);
      // Values of four bytes or fewer are stored inline in the entry itself.
      const short4 = type === 3 && n === 1;
      const val = short4 ? le16be(b, e + 8, le) : le32be(b, e + 8, le);

      switch (tag) {
        case 0x0103: compression = val; break;
        case 0x0111: stripOff = val; break;
        case 0x0117: stripLen = val; break;
        case 0x0201: jpegOff = val; break;
        case 0x0202: jpegLen = val; break;
        case 0x002e: // Panasonic JpgFromRaw: the data is here, not pointed at
          if (n > 1024) out.push({ off: le32be(b, e + 8, le), len: n });
          break;
        case 0x014a: { // SubIFDs — one offset, or an array of them
          if (n === 1) queue.push(val);
          else {
            for (let k = 0; k < Math.min(n, 8); k++) {
              const p = val + k * 4;
              if (p + 4 <= b.length) queue.push(le32be(b, p, le));
            }
          }
          break;
        }
        default: break;
      }
    }

    if (jpegOff > 0 && jpegLen > 0) out.push({ off: jpegOff, len: jpegLen });
    // Compression 6 and 7 both mean "this strip is a JPEG", which is how Canon
    // stores the big preview that makes CR2 worth opening at all.
    if ((compression === 6 || compression === 7) && stripOff > 0 && stripLen > 0) {
      out.push({ off: stripOff, len: stripLen });
    }

    const next = at + 2 + count * 12;
    if (next + 4 <= b.length) {
      const chain = le32be(b, next, le);
      if (chain > 0) queue.push(chain);
    }
  }
  return out;
}

/**
 * Inflate a raw DEFLATE stream using the platform's own decompressor. No
 * dependency: `DecompressionStream` is built into the webview. Returns null if
 * the stream is corrupt, which for a preview simply means "show something else".
 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Readable lines out of an Office XML part. Paragraph ends become newlines
 * before tags are stripped — without that the whole document collapses into one
 * unbroken run of words, which is unreadable at card size.
 */
function xmlToLines(xml: string): string[] {
  const text = xml
    // `</si>` is the odd one out: a spreadsheet's shared-string table has no
    // paragraphs, so without it every cell runs into the next and the first
    // "line" comes out as the entire header row jammed together.
    .replace(/<\/(w:p|a:p|text:p|w:br|text:line-break|si)\s*\/?>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
  return lines.slice(0, textLines());
}

function short(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * Formats whose previews need a decoder we have not shipped yet. Named
 * explicitly so the card can say *why* there is no picture — a user who sees
 * "needs a RAW decoder" knows the app understood the file, which a generic
 * grey icon does not tell them.
 */
const NEEDS_DECODER: Record<string, string> = {
  cr3: "CR3 needs a decoder",
  psd: "PSD needs a decoder", ai: "AI needs a decoder",
  // The pre-2007 Office formats are OLE compound files, not zips — a different
  // container entirely, and not worth a parser for how rarely they turn up.
  doc: "old Word format", xls: "old Excel format", ppt: "old PowerPoint format",
  rar: "RAR needs a decoder", "7z": "7-Zip needs a decoder",
  tar: "tar preview not built yet", gz: "gzip preview not built yet",
  glb: "3D preview not built yet", gltf: "3D preview not built yet",
  stl: "3D preview not built yet", fbx: "3D preview not built yet",
  blend: "3D preview not built yet",
  exe: "program", dll: "library", sys: "system file",
};
