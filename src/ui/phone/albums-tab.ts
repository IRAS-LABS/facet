/**
 * Albums — every folder that holds a picture, named the way a person would.
 *
 * "All my folders, you know, from like if it's from Snapchat if it's from this
 * if it's from that" is a request for exactly this and for nothing clever: no
 * curation, no auto-generated memories, no clustering. A folder that has
 * pictures in it is an album, its cover is its newest picture, and it is called
 * what the app that made it is called rather than
 * `Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images`.
 *
 * The list sorts by recency rather than alphabetically, because the album you
 * want is nearly always one you have just added to, and an A-to-Z list puts
 * Camera below Bluetooth forever.
 */

import type { Album, GalleryItem } from "@core/phone/gallery";
import { el, fill, tileCaption } from "./dom";
import { favPaths } from "./favorites";
import { ThumbLoader } from "./thumbs";
import { btn, iconBtn } from "./photos-tab";
import { icon } from "./icons";
import type { PhoneShell, PhoneTab, TabId } from "./shell";
import type { StoreSnapshot } from "./store";

/**
 * The Favorites pseudo-album's id. Not a real folder path, which is what makes
 * it collision-proof: album ids are folder paths, and no path contains ":".
 */
const FAVS_ID = "fct:favs";

export class AlbumsTab implements PhoneTab {
  readonly id: TabId = "albums";
  readonly label = "Albums";
  readonly icon = "albums";
  readonly el: HTMLElement;

  private list: HTMLElement;
  private detail: HTMLElement;
  private loader: ThumbLoader;

  private albums: readonly Album[] = [];
  /** Null on the album list, a folder path when drilled into one. */
  private open: string | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly shell: PhoneShell) {
    this.list = el("div.ph-albums");
    this.detail = el("div.ph-album-detail", { hidden: true });
    this.el = el("div.ph-screen", {}, this.list, this.detail);
    this.loader = new ThumbLoader(shell.thumbs, shell.scroller);
  }

  title(): string {
    if (this.open === null) return "Albums";
    return this.albums.find((a) => a.id === this.open)?.name ?? "Album";
  }

  actions(): HTMLElement[] {
    if (this.open !== null) {
      return [iconBtn("←", "Back to albums", () => this.close())];
    }
    // No rescan button — the store's mtime watcher refreshes on its own.
    return [];
  }

  back(): boolean {
    if (this.open !== null) {
      this.close();
      return true;
    }
    return false;
  }

  activate(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.shell.store.subscribe((snap) => this.render(snap));
    void this.shell.store.ensure();
  }

  private render(snap: StoreSnapshot): void {
    // Favorites go first when there are any, as a pseudo-album over the same
    // grid. Stars live in localStorage, so the join against the live scan here
    // is also what keeps deleted files from haunting the album as blank cells.
    const favs = this.favItems(snap);
    const first = favs[0];
    this.albums = first
      ? [
          {
            id: FAVS_ID,
            name: "★ Favorites",
            path: "",
            count: favs.length,
            cover: first,
            newest: first.modified ?? 0,
          },
          ...snap.albums,
        ]
      : snap.albums;

    if (snap.state === "scanning" && snap.albums.length === 0) {
      fill(this.list, el("div.ph-scanbar", { "aria-label": "Scanning storage" }));
      return;
    }

    if (snap.albums.length === 0) {
      fill(this.list,
        el("div.ph-note", {},
          el("span.ph-note-icon", { "aria-hidden": true }, icon("albums")),
          el("p.ph-note-title", { text: "No albums yet" }),
          el("p.ph-note-body", { text: "Albums appear for every folder on the device that contains a picture or a video." }),
          btn("Scan again", () => void this.shell.store.refresh()),
        ));
      return;
    }

    fill(this.list, ...this.albums.map((a) => this.tile(a)));

    // A rescan while drilled in must not strand the detail view on a folder
    // that has gone away — a card unmounted, a folder deleted from elsewhere.
    if (this.open !== null && !this.albums.some((a) => a.id === this.open)) {
      this.close();
    } else if (this.open !== null) {
      this.showAlbum(this.open);
    }
  }

  private favItems(snap: StoreSnapshot): readonly GalleryItem[] {
    const favs = favPaths();
    if (favs.size === 0) return [];
    return snap.items.filter((it) => favs.has(it.path));
  }

  private tile(album: Album): HTMLElement {
    const cover = el("div.ph-album-cover");

    if (album.cover) {
      const img = el<"img">("img", { alt: "", decoding: "async" });
      cover.append(img);
      this.loader.observe(cover, album.cover);
    } else {
      cover.append(el("span.ph-album-empty", { "aria-hidden": true }, icon("image")));
    }

    // Two decorative sheets behind the cover. Only the "stack" album style
    // draws them (fanned a few degrees each way, like prints in a pile); the
    // other styles hide them in CSS. Built unconditionally so switching style
    // in settings is a class change on the root, not a re-render of forty tiles.
    const pile = el("div.ph-album-pile", {},
      el("span.ph-album-sheet", { "aria-hidden": true }),
      el("span.ph-album-sheet", { "aria-hidden": true }),
      cover,
    );

    const node = el<"button">("button.ph-album", {
      type: "button",
      "aria-label": `${album.name}, ${album.count} items`,
    },
      pile,
      el("span.ph-album-name", { text: album.name }),
      el("span.ph-album-count", { text: `${album.count.toLocaleString()}` }),
    );

    node.addEventListener("click", () => this.showAlbum(album.id));
    return node;
  }

  /**
   * Drill in.
   *
   * A second grid rather than a new screen with its own scroller, so the shell's
   * single `main` keeps owning the scroll and the thumbnail observer keeps
   * working against one root. The album list stays in the DOM, hidden, because
   * rebuilding forty covers on every back press is a visible stutter for no
   * gain.
   */
  private showAlbum(id: string): void {
    const album = this.albums.find((a) => a.id === id);
    if (!album) return;

    this.open = id;
    this.list.hidden = true;
    this.detail.hidden = false;

    const items =
      id === FAVS_ID
        ? this.favItems(this.shell.store.get())
        : this.shell.store.get().items.filter((it) => it.folder === id);

    const grid = el("div.ph-grid");
    for (const item of items) {
      const img = el<"img">("img", { alt: "", decoding: "async" });
      const cell = el<"button">("button.ph-cell", {
        type: "button",
        "aria-label": item.name,
      }, img,
        el("span.ph-cell-fallback", { text: item.ext.toUpperCase() || "FILE" }),
      );
      const cap = tileCaption(item.kind, item.name);
      if (cap) cell.append(cap);
      if (item.kind === "video") {
        cell.append(el("span.ph-cell-play", { "aria-hidden": true }, icon("play")));
      }
      cell.addEventListener("click", () => this.shell.open(item, items));
      this.loader.observe(cell, item);
      grid.append(cell);
    }

    fill(this.detail,
      el("p.ph-album-path", { text: album.path }),
      grid,
    );
    this.shell.scroller.scrollTop = 0;
    this.shell.refreshChrome(this.id);
  }

  private close(): void {
    this.open = null;
    this.detail.hidden = true;
    this.list.hidden = false;
    fill(this.detail);
    this.shell.refreshChrome(this.id);
  }
}
