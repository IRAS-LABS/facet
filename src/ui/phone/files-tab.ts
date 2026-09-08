/**
 * Files — categories first, folders underneath.
 *
 * The ask was "a file, downloads, documents, audio, video, image", which is the
 * My Files layout: a short grid of the seven things people go looking for, and
 * the raw storage tree below it for when none of them is what you meant. The
 * order matters — a phone file manager that opens on `/storage/emulated/0` has
 * answered a question nobody asked, because "where are my downloads" is the
 * actual question about nine times in ten.
 *
 * Categories are scans by extension, not folders. A PDF that arrived over
 * WhatsApp is a document wherever it happens to sit on the card, and a category
 * that only looked in `/Documents` would miss almost everything.
 */

import type { FileEntry } from "@core/explorer/types";
import { bytes, el, fill, shortDate } from "./dom";
import { ThumbLoader } from "./thumbs";
import { btn, iconBtn } from "./photos-tab";
import { icon } from "./icons";
import type { PhoneShell, PhoneTab, TabId } from "./shell";

interface Category {
  id: string;
  name: string;
  icon: string;
  exts: readonly string[];
  /** Narrower than the media roots when the category has an obvious home. */
  roots?: readonly string[];
  /**
   * How much of the front page this one is worth.
   *
   * The seven categories are nowhere near equally likely. "Where are my
   * downloads" is most of why anyone opens a file manager at all, and
   * `Archives` is a long way behind `Images`. Seven identical rectangles spent
   * the same screen on both and made the page read as a settings list, so the
   * likely ones are boxes and the tail is a row of bubbles.
   */
  shape: "hero" | "box" | "bubble";
  /** Hue for this category's tint, 0-360. Everything coloured on the tile is
   *  mixed from it, so a new category is one number and not a block of rules. */
  hue: number;
  /** One line under the name. Boxes have the room for it; bubbles do not. */
  sub?: string;
}

const CATEGORIES: readonly Category[] = [
  {
    id: "downloads", name: "Downloads", icon: "download",
    exts: [], // everything
    roots: ["/sdcard/Download", "/sdcard/Downloads"],
    shape: "hero", hue: 265, sub: "Everything you saved",
  },
  {
    id: "documents", name: "Documents", icon: "file-text",
    exts: ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "epub", "ppt", "pptx",
           "xls", "xlsx", "ods", "csv", "tsv", "json"],
    shape: "box", hue: 205, sub: "PDFs, docs, sheets",
  },
  { id: "images", name: "Images", icon: "image",
    exts: ["jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "jxl", "bmp", "heic", "heif",
           "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "svg"],
    shape: "box", hue: 330, sub: "Photos & graphics" },
  { id: "video", name: "Video", icon: "play",
    exts: ["mp4", "mkv", "mov", "webm", "avi", "m4v", "3gp", "3g2", "mts", "m2ts", "wmv", "flv", "mpg", "mpeg", "ogv"],
    shape: "bubble", hue: 15 },
  { id: "audio", name: "Audio", icon: "music",
    exts: ["mp3", "wav", "flac", "aac", "ogg", "opus", "m4a", "wma", "aiff", "amr", "mid"],
    shape: "bubble", hue: 150 },
  { id: "installs", name: "Installs", icon: "package", exts: ["apk", "apks", "xapk", "obb"],
    shape: "bubble", hue: 45 },
  { id: "archives", name: "Archives", icon: "archive",
    exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso"],
    shape: "bubble", hue: 190 },
];

/** How a listing is ordered. Four columns, because those are the four
 *  questions people actually ask of a folder: what is it called, when did it
 *  arrive, how big is it, what sort of thing is it. */
type SortBy = "name" | "date" | "size" | "kind";

const SORTS: readonly { by: SortBy; label: string }[] = [
  { by: "name", label: "Name" },
  { by: "date", label: "Date" },
  { by: "size", label: "Size" },
  { by: "kind", label: "Type" },
];

type View =
  | { kind: "home" }
  | { kind: "category"; id: string }
  | { kind: "folder"; path: string };

/** File kind → icon name, for the list-row thumbnail fallback. */
const GLYPHS: Record<string, string> = {
  folder: "folder", image: "image", video: "play", audio: "music",
  document: "file-text", tabular: "table", model3d: "box", archive: "archive",
  code: "code", binary: "file",
};

export class FilesTab implements PhoneTab {
  readonly id: TabId = "files";
  readonly label = "Files";
  readonly icon = "folder";
  readonly el: HTMLElement;

  private body: HTMLElement;
  private loader: ThumbLoader;

  /** Where we are, and how we got here. The last entry is the current view. */
  private stack: View[] = [{ kind: "home" }];
  private roots: FileEntry[] = [];

  /**
   * Newest first, which is right for a phone: the alternative -- strict
   * alphabetical -- buries the screenshot taken a minute ago under two hundred
   * files named for their timestamps. It is a default and not a law now, which
   * is the point: every file manager lets you say how to sort, and one that
   * decides for you is unusable the first time you want the biggest file.
   */
  private sort: { by: SortBy; desc: boolean } = { by: "date", desc: true };

  constructor(private readonly shell: PhoneShell) {
    this.body = el("div.ph-screen");
    this.el = this.body;
    this.loader = new ThumbLoader(shell.thumbs, shell.scroller);
  }

  /** The stack is never empty — `home` is pushed at construction and `back()`
   *  refuses to pop the last entry — but the fallback keeps that invariant from
   *  being something the type system has to take on trust. */
  private get view(): View { return this.stack[this.stack.length - 1] ?? { kind: "home" }; }

  title(): string {
    const v = this.view;
    if (v.kind === "home") return "Files";
    if (v.kind === "category") return CATEGORIES.find((c) => c.id === v.id)?.name ?? "Files";
    // A storage volume is called what the Storage list on the front page calls
    // it. The last path segment is the right answer for every folder on the
    // device except the one everybody opens first: `/storage/emulated/0` is
    // the phone's own storage, and tapping "Home" put the word `0` in the
    // title bar -- a heading that names nothing, on the screen where you have
    // just navigated and most need to know where you are.
    const root = this.roots.find((r) => r.path === v.path);
    if (root) return root.name;
    return v.path.split("/").filter(Boolean).pop() ?? v.path;
  }

  actions(): HTMLElement[] {
    if (this.stack.length > 1) {
      return [iconBtn("←", "Back", () => { this.back(); })];
    }
    return [];
  }

  back(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    void this.draw();
    return true;
  }

  activate(): void {
    void this.draw();
  }

  private push(view: View): void {
    this.stack.push(view);
    this.shell.scroller.scrollTop = 0;
    void this.draw();
  }

  /**
   * The listing in the chosen order. Folders always lead, whichever column is
   * being sorted: a folder is a place and a file is a thing, and mixing them
   * by size puts an empty directory between two photographs.
   */
  private ordered(list: readonly FileEntry[]): FileEntry[] {
    const dir = this.sort.desc ? -1 : 1;
    const by = this.sort.by;
    return [...list].sort((a, b) => {
      if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
      let d = 0;
      if (by === "name") d = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      else if (by === "size") d = (a.size ?? 0) - (b.size ?? 0);
      else if (by === "kind") d = (a.ext || a.kind).localeCompare(b.ext || b.kind);
      else d = (a.modified ?? 0) - (b.modified ?? 0);
      // Ties fall back to the name, so a folder of files that all arrived in
      // the same second does not reshuffle itself every time it is drawn.
      if (d === 0) d = a.name.localeCompare(b.name, undefined, { numeric: true });
      return d * dir;
    });
  }

  /**
   * The sort row. Four pills rather than a menu: a menu hides the answer to
   * "how is this sorted right now", which is half of what the control is for.
   * Pressing the one already chosen turns it round.
   */
  private sortBar(): HTMLElement {
    const bar = el("div.ph-sort", { role: "group", "aria-label": "Sort by" });
    for (const s of SORTS) {
      const on = this.sort.by === s.by;
      const arrow = on ? (this.sort.desc ? " ↓" : " ↑") : "";
      const b = el<"button">("button.ph-sort-pill", {
        type: "button",
        text: s.label + arrow,
        "aria-pressed": on,
        title: on ? `Sorted by ${s.label.toLowerCase()} — tap to reverse` : `Sort by ${s.label.toLowerCase()}`,
      });
      if (on) b.classList.add("is-on");
      b.addEventListener("click", () => {
        if (this.sort.by === s.by) this.sort.desc = !this.sort.desc;
        // Names read best A-Z and everything else newest/biggest first, so a
        // fresh column starts the way that column is usually wanted.
        else this.sort = { by: s.by, desc: s.by !== "name" };
        void this.draw();
      });
      bar.append(b);
    }
    return bar;
  }

  private async draw(): Promise<void> {
    this.shell.refreshChrome(this.id);
    const v = this.view;
    if (v.kind === "home") return this.drawHome();
    if (v.kind === "category") return this.drawCategory(v.id);
    return this.drawFolder(v.path);
  }

  // ── Home: categories, then storage ──────────────────────────────────────

  private async drawHome(): Promise<void> {
    const cats = el("div.ph-cats");
    for (const cat of CATEGORIES) {
      // The hue rides on the element as a custom property rather than a class
      // per category, so the stylesheet has one set of tile rules instead of
      // seven near-identical colour blocks.
      const node = el<"button">("button.ph-cat", {
        type: "button",
        "aria-label": cat.name,
        "data-shape": cat.shape,
        style: `--cat-h: ${cat.hue}`,
      },
        el("span.ph-cat-icon", { "aria-hidden": true }, icon(cat.icon)),
        el("span.ph-cat-text", {},
          el("span.ph-cat-name", { text: cat.name }),
          cat.sub === undefined ? null : el("span.ph-cat-sub", { text: cat.sub }),
        ),
      );
      node.addEventListener("click", () => this.push({ kind: "category", id: cat.id }));
      cats.append(node);
    }

    fill(this.body, el("h2.ph-day", {}, el("span", { text: "Categories" })), cats);

    // Storage volumes underneath. `roots()` is one IPC call and the answer does
    // not change while the app runs, so it is fetched once and kept.
    if (this.roots.length === 0) {
      try {
        const places = await this.shell.fs.roots();
        this.roots = places.map((p) => ({
          path: p.path ?? "",
          name: p.name,
          kind: "folder" as const,
          ext: "",
        })).filter((r) => r.path !== "");
      } catch {
        this.roots = [];
      }
    }

    if (this.roots.length > 0 && this.view.kind === "home") {
      this.body.append(
        el("h2.ph-day", {}, el("span", { text: "Storage" })),
        this.rows(this.roots),
      );
    }
  }

  // ── A category ──────────────────────────────────────────────────────────

  private async drawCategory(id: string): Promise<void> {
    const cat = CATEGORIES.find((c) => c.id === id);
    if (!cat) return;

    fill(this.body, el("div.ph-scanbar", { "aria-label": `Finding ${cat.name}` }));

    // The store's index first: on the phone that is MediaStore -- every file
    // the system has indexed, in any folder, with any extension -- and it is
    // already in memory. The walk over the category's usual homes then adds
    // whatever the index has not caught up with. Merged by path.
    const roots = cat.roots ?? DEFAULT_ROOTS;
    const indexed = fromIndex(cat, this.shell.store.get().everything);
    let hits: FileEntry[] = indexed;
    try {
      const scan = await this.shell.fs.scanMedia(roots, cat.exts, {
        maxDepth: 6, limit: 4000, budgetMs: 6000,
      });
      hits = mergeHits(indexed, scan.hits.map(toEntry));
    } catch {
      hits = indexed;
    }

    // The view may have changed while the scan ran — a fast back press, a tab
    // switch. Painting into a screen the user has left is a classic way to make
    // a back button look broken.
    if (this.view.kind !== "category" || this.view.id !== id) return;

    if (hits.length === 0) {
      fill(this.body, el("div.ph-note", {},
        el("span.ph-note-icon", { "aria-hidden": true }, icon(cat.icon)),
        el("p.ph-note-title", { text: `No ${cat.name.toLowerCase()} found` }),
        el("p.ph-note-body", { text: "Nothing matched in the folders Facet can read." }),
        btn("Browse storage instead", () => { this.stack = [{ kind: "home" }]; void this.draw(); }),
      ));
      return;
    }

    const shown = this.ordered(hits);
    fill(this.body,
      el("p.ph-count", { text: `${hits.length.toLocaleString()} items` }),
      this.sortBar(),
      this.rows(shown),
    );
  }

  // ── A folder ────────────────────────────────────────────────────────────

  private async drawFolder(path: string): Promise<void> {
    fill(this.body, el("div.ph-scanbar", { "aria-label": "Reading folder" }));

    let entries: FileEntry[] = [];
    try {
      entries = (await this.shell.fs.list(path)).entries;
    } catch {
      fill(this.body, el("div.ph-note", {},
        el("p.ph-note-title", { text: "Can't open this folder" }),
        el("p.ph-note-body", { text: "Android may not grant access to it, or it may have been removed." }),
      ));
      return;
    }

    if (this.view.kind !== "folder" || this.view.path !== path) return;

    const shown = this.ordered(entries);

    fill(this.body,
      el("p.ph-count", { text: path }),
      entries.length > 0 ? this.sortBar() : null,
      entries.length > 0
        ? this.rows(shown)
        : el("div.ph-note", {}, el("p.ph-note-title", { text: "Empty folder" })),
    );
  }

  // ── Rows ────────────────────────────────────────────────────────────────

  private rows(entries: readonly FileEntry[]): HTMLElement {
    const list = el("div.ph-rows");
    for (const entry of entries) list.append(this.row(entry, entries));
    return list;
  }

  private row(entry: FileEntry, siblings: readonly FileEntry[]): HTMLElement {
    // Every row but a folder now has a real picture waiting for it -- a page,
    // a cover, an icon, a card -- so every row but a folder asks for one. The
    // glyph stays underneath as what the row shows until it arrives, which on
    // a cached tile is no time at all and on a cold PDF is a second.
    const thumb = el("div.ph-row-thumb");
    if (entry.kind === "folder") {
      thumb.append(icon("folder"));
    } else {
      thumb.append(el<"img">("img", { alt: "", decoding: "async" }));
      thumb.append(el("span.ph-row-glyph", { "aria-hidden": true },
        icon(GLYPHS[entry.kind] ?? "file")));
      // A document is a page and a page must not be cropped to a square: the
      // letterhead and the date, which is everything identifying about it,
      // live at the edges.
      if (entry.kind !== "image" && entry.kind !== "video") thumb.classList.add("fit");
      this.loader.observe(thumb, entry);
    }

    const sub = entry.kind === "folder"
      ? "Folder"
      : [bytes(entry.size), shortDate(entry.modified)].filter(Boolean).join(" · ");

    const node = el<"button">("button.ph-row", {
      type: "button",
      "aria-label": entry.name,
    },
      thumb,
      el("span.ph-row-text", {},
        el("span.ph-row-name", { text: entry.name }),
        el("span.ph-row-sub", { text: sub }),
      ),
      el("span.ph-row-chev", { text: entry.kind === "folder" ? "›" : "", "aria-hidden": true }),
    );

    node.addEventListener("click", () => {
      if (entry.kind === "folder") this.push({ kind: "folder", path: entry.path });
      else this.shell.open(entry, siblings.filter((s) => s.kind !== "folder"));
    });
    return node;
  }
}

/** Where a category scan looks when it has no home of its own. */
const DEFAULT_ROOTS: readonly string[] = [
  "/sdcard/Download",
  "/sdcard/Documents",
  "/sdcard/DCIM",
  "/sdcard/Pictures",
  "/sdcard/Movies",
  "/sdcard/Music",
  "/sdcard/Android/media",
];

/**
 * The files of the store's index that belong to a category.
 *
 * Kind first, extension second: the index derives kind from the MIME type the
 * system decided on, so a picture with an odd extension is still an image
 * here, and Downloads is "anything under the download folders" regardless.
 */
function fromIndex(cat: Category, everything: readonly FileEntry[]): FileEntry[] {
  const roots = (cat.roots ?? []).map((r) => `${r}/`);
  return everything.filter((it) => {
    if (cat.id === "downloads") return roots.some((r) => it.path.startsWith(r));
    // Media categories go by what the indexer decided, not the extension: a
    // `.jpg` the index calls MEDIA_TYPE_NONE is a plain file, not a picture.
    if (cat.id === "images") return it.kind === "image";
    if (cat.id === "video") return it.kind === "video";
    if (cat.id === "audio") return it.kind === "audio";
    if (cat.id === "documents") return it.kind === "document" || it.kind === "tabular" || cat.exts.includes(it.ext);
    if (cat.id === "archives") return it.kind === "archive" || cat.exts.includes(it.ext);
    return cat.exts.includes(it.ext);
  });
}

/** Union by path, index rows winning, newest first. */
function mergeHits(indexed: readonly FileEntry[], walked: readonly FileEntry[]): FileEntry[] {
  if (indexed.length === 0) return [...walked];
  const seen = new Set(indexed.map((it) => it.path));
  const out = [...indexed];
  for (const w of walked) if (!seen.has(w.path)) out.push(w);
  if (out.length === indexed.length) return out;
  return out.sort((a, b) => (b.modified ?? -Infinity) - (a.modified ?? -Infinity));
}

function toEntry(hit: { name: string; path: string; size: number; modified: number | null }): FileEntry {
  const dot = hit.name.lastIndexOf(".");
  const ext = dot > 0 ? hit.name.slice(dot + 1).toLowerCase() : "";
  return {
    path: hit.path,
    name: hit.name,
    kind: kindOf(ext),
    ext,
    size: hit.size,
    ...(hit.modified === null ? {} : { modified: hit.modified }),
  };
}

function kindOf(ext: string): FileEntry["kind"] {
  for (const cat of CATEGORIES) {
    if (cat.id === "downloads") continue;
    if (cat.exts.includes(ext)) {
      if (cat.id === "images") return "image";
      if (cat.id === "video") return "video";
      if (cat.id === "audio") return "audio";
      if (cat.id === "archives") return "archive";
      if (cat.id === "installs") return "binary";
      return "document";
    }
  }
  return "binary";
}
