/**
 * Trash — the way back.
 *
 * Deleting in the viewer or the roll moves the file into a `.facet-trash`
 * folder beside it (a same-volume rename, instant even for a 4 GB clip). This
 * sheet is the other half of that promise: see what is in there, put it back,
 * or let it go for good. Without this screen the trash folders were real but
 * invisible, which is worse than no trash at all — the files looked deleted
 * and were secretly still spending storage.
 *
 * A full-screen fixed overlay at z-index 40, on the body. That address is
 * load-bearing: the shell's back-button handler closes "whatever fixed body
 * child at z≥40 is on top" by dispatching Escape at it, so being one of those
 * is what makes the hardware back button close this sheet with no wiring here
 * beyond an Escape listener.
 *
 * The confirm for emptying is a second tap on the same button, in the DOM.
 * Never `confirm()`: a native modal blocks the Android WebView's event loop
 * and can be suppressed outright in release builds.
 */

import type { GalleryItem } from "@core/phone/gallery";
import { el, fill } from "./dom";
import { icon } from "./icons";
import { ThumbLoader } from "./thumbs";
import { iconBtn } from "./photos-tab";
import type { PhoneShell } from "./shell";

export class TrashSheet {
  readonly el: HTMLElement;

  private titleEl: HTMLElement;
  private grid: HTMLElement;
  private foot: HTMLElement;
  private loader: ThumbLoader;

  private selection = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  /** Set while the destructive button is waiting for its second tap. */
  private armed = 0;
  private busy = false;

  constructor(private readonly shell: PhoneShell) {
    this.titleEl = el("h1.ph-title", { text: "Trash" });
    this.grid = el("div.ph-trash-grid");
    this.foot = el("div.ph-trash-foot");

    const head = el("header.ph-head", {},
      iconBtn("←", "Close trash", () => this.close()),
      this.titleEl,
    );
    const body = el("div.ph-trash-body", {}, this.grid);
    this.el = el("div.ph-trash", { hidden: true }, head, body, this.foot);
    this.loader = new ThumbLoader(shell.thumbs, body);

    this.el.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this.close();
    });
    document.body.append(this.el);
  }

  open(): void {
    this.selection.clear();
    this.el.hidden = false;
    // Focusable, so the shell's synthetic Escape has somewhere to land even
    // when nothing inside has been tapped yet.
    this.el.tabIndex = -1;
    this.el.focus();
    this.unsubscribe?.();
    this.unsubscribe = this.shell.store.subscribe(() => this.render());
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.el.hidden = true;
    this.disarm();
  }

  dispose(): void {
    this.close();
    this.el.remove();
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private render(): void {
    const items = this.shell.store.get().trash;
    // Items can vanish under a live selection (a rescan, a restore finishing);
    // the selection must never refer to a file that is no longer listed.
    const alive = new Set(items.map((it) => it.path));
    for (const p of this.selection) if (!alive.has(p)) this.selection.delete(p);

    this.titleEl.textContent =
      this.selection.size > 0 ? `${this.selection.size} selected` : `Trash (${items.length})`;

    if (items.length === 0) {
      fill(this.grid, el("div.ph-note", {},
        el("span.ph-note-icon", { "aria-hidden": true }, icon("trash")),
        el("p.ph-note-title", { text: "Trash is empty" }),
        el("p.ph-note-body", {
          text: "Files you delete stay here, in a .facet-trash folder next to where they lived, until you empty the trash.",
        }),
      ));
      fill(this.foot);
      return;
    }

    fill(this.grid, ...items.map((it) => this.cell(it)));
    this.renderFoot(items);
  }

  private cell(item: GalleryItem): HTMLElement {
    const img = el<"img">("img", { alt: "", decoding: "async", loading: "lazy" });
    const cell = el<"button">("button.ph-cell", {
      type: "button",
      "aria-label": item.name,
      "aria-selected": this.selection.has(item.path) ? "true" : "false",
    }, img);
    cell.append(el("span.ph-cell-fallback", {},
      el("span", { text: item.ext.toUpperCase() || "FILE" }),
    ));
    cell.append(el("span.ph-cell-name", { text: item.name }));
    cell.append(el("span.ph-cell-check", { text: "✓", "aria-hidden": true }));

    cell.addEventListener("click", () => {
      if (this.selection.has(item.path)) {
        this.selection.delete(item.path);
        cell.setAttribute("aria-selected", "false");
      } else {
        this.selection.add(item.path);
        cell.setAttribute("aria-selected", "true");
      }
      this.disarm();
      this.titleEl.textContent =
        this.selection.size > 0
          ? `${this.selection.size} selected`
          : `Trash (${this.shell.store.get().trash.length})`;
      this.renderFoot(this.shell.store.get().trash);
    });

    if (item.kind === "image" || item.kind === "video") this.loader.observe(cell, item);
    return cell;
  }

  private renderFoot(items: readonly GalleryItem[]): void {
    const picked = this.selection.size;
    const scope = picked > 0 ? `${picked}` : "all";
    const restore = el<"button">("button.ph-note-btn", {
      type: "button",
      text: picked > 0 ? `Restore ${scope}` : "Restore all",
    });
    restore.addEventListener("click", () => void this.restore(this.chosen(items)));

    const destroy = el<"button">("button.ph-note-btn.ph-danger", {
      type: "button",
      text: picked > 0 ? `Delete ${scope} forever` : "Empty trash",
    });
    destroy.addEventListener("click", () => {
      if (this.armed) {
        this.disarm();
        void this.empty(this.chosen(items));
      } else {
        // Two taps to destroy, with the question asked in the button itself.
        destroy.textContent = picked > 0 ? `Really delete ${scope}? Tap again` : "Really empty? Tap again";
        this.armed = window.setTimeout(() => this.renderFoot(this.shell.store.get().trash), 4000);
      }
    });

    fill(this.foot, restore, destroy);
  }

  private disarm(): void {
    window.clearTimeout(this.armed);
    this.armed = 0;
  }

  private chosen(items: readonly GalleryItem[]): GalleryItem[] {
    if (this.selection.size === 0) return [...items];
    return items.filter((it) => this.selection.has(it.path));
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /**
   * Move files back to the folder their `.facet-trash` sits in. `move_file`
   * refuses to clobber and picks a free name on collision, so restoring a
   * photo whose name was since reused loses neither file.
   */
  private async restore(items: readonly GalleryItem[]): Promise<void> {
    if (this.busy || items.length === 0) return;
    this.busy = true;
    const done: string[] = [];
    const restored: GalleryItem[] = [];
    try {
      for (const it of items) {
        const home = it.folder.replace(/\/\.facet-trash$/, "");
        try {
          const res = await this.shell.fs.moveFile(it.path, `${home}/${it.name}`, false);
          done.push(it.path);
          restored.push({
            ...it,
            path: res.path,
            name: res.path.slice(res.path.lastIndexOf("/") + 1),
            folder: home,
            folderName: home.slice(home.lastIndexOf("/") + 1) || home,
          });
        } catch {
          // A single unrestorable file (folder vanished, storage revoked) must
          // not abort the rest of the batch.
        }
      }
    } finally {
      this.busy = false;
    }
    if (done.length > 0) this.shell.store.noteRestored(done, restored);
    this.selection.clear();
  }

  /** Gone for good — on Windows, to the OS Recycle Bin; on Android, gone. */
  private async empty(items: readonly GalleryItem[]): Promise<void> {
    if (this.busy || items.length === 0) return;
    this.busy = true;
    const paths = items.map((it) => it.path);
    try {
      await this.shell.fs.emptyTrash(paths);
      this.shell.store.noteEmptied(paths);
      this.selection.clear();
    } catch {
      // Rust refused (path check) or the OS did. The list stays as it is,
      // which is itself the honest report: nothing was deleted.
    } finally {
      this.busy = false;
    }
  }
}
