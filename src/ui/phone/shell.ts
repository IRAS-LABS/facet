/**
 * The phone shell.
 *
 * This is the whole app on a phone: a header, a screen, and four labelled tabs
 * along the bottom. It replaces the desktop chrome outright rather than
 * restyling it, because the two are not one layout at two sizes — a folder tree,
 * a breadcrumb, a filter row and a mode switcher do not have a small version,
 * they have a *different* version, and the previous build's attempt to squeeze
 * them into 384 px is what produced a top bar that wrapped onto three rows and a
 * tree that had to be hidden outright to make room.
 *
 * Three rules the shell enforces on every screen under it:
 *
 *  1. **Nothing scrolls horizontally.** Android's back gesture owns a ~130 px
 *     strip down both edges and a WebView cannot opt out. A horizontal
 *     carousel therefore has an unreachable start and end, and reaching for
 *     them navigates back or closes the app — which is exactly what happened to
 *     the mode buttons in the first phone build. Grids and sheets only.
 *  2. **Every control on screen says what it is.** Icons carry labels. The
 *     desktop explained its glyphs with hover tooltips; a finger cannot hover,
 *     so on this build the word is part of the button.
 *  3. **48 px minimum target.** Not a guideline here — the tab bar, the header
 *     actions and the viewer's action bar all size from it.
 */

import type { PhoneFs } from "@core/explorer/tauri-fs";
import type { FileEntry } from "@core/explorer/types";
import {
  ANDROID_HOT_ROOTS,
  ANDROID_MEDIA_ROOTS,
  desktopMediaRoots,
  type GalleryItem,
} from "@core/phone/gallery";
import { perf } from "@core/phone/mark";
import { dropFav } from "./favorites";
import { el, fill } from "./dom";
import { icon } from "./icons";
import { MediaStore } from "./store";
import { Thumbs } from "./thumbs";
import { PhoneViewer } from "./viewer";
import { EVERYTHING_SPEC, PhotosTab, iconBtn } from "./photos-tab";
import { AlbumsTab } from "./albums-tab";
import { AudioDock } from "./audio-dock";
import { FilesTab } from "./files-tab";
import { SearchTab } from "./search-tab";
import { TrashSheet } from "./trash-sheet";
import { SettingsSheet } from "./settings-sheet";
import { bindPrefs, haptic, PhonePrefsStore } from "@core/phone/prefs";

export type TabId = "photos" | "all" | "albums" | "files" | "search";

/**
 * What a screen owes the shell.
 *
 * `activate` rather than a constructor argument for the data: tabs are built
 * once at mount and shown many times, and the work of loading has to be able to
 * happen on the second showing too — coming back to Photos after deleting
 * something in the viewer must not show the deleted thing.
 */
export interface PhoneTab {
  readonly id: TabId;
  /** Under the icon in the bar. Never omitted — see rule 2. */
  readonly label: string;
  readonly icon: string;
  /** In the header when this tab is showing. */
  title(): string;
  readonly el: HTMLElement;
  activate(): void;
  /** Header buttons for this tab, right-aligned. Each carries an `aria-label`. */
  actions?(): HTMLElement[];
  /**
   * A back press arrived. Return true if the tab consumed it — a folder went up
   * one level, a selection was cleared. False means the shell handles it.
   */
  back?(): boolean;
}

/** What the phone shell needs from the rest of the app. */
export interface PhoneHost {
  fs: PhoneFs;
  /** The user's home directory, for the desktop-testing root set. */
  home: string;
  /**
   * Hand a file to one of the full panels the desktop shell owns — the table
   * viewer, the 3D scene, the subtitle editor. The phone shell handles pictures
   * and video itself and delegates everything else rather than reimplementing
   * eighteen panels twice.
   */
  openPanel(entry: FileEntry, panel: string, siblings: readonly FileEntry[]): void;
  /**
   * Run one of the tools the phone editor does not implement itself — reading
   * the text out of a scan, transcribing a recording, trimming a clip, queuing
   * a batch. Every one of these already exists as a desktop panel; this is the
   * wire between a labelled tile on the phone and the panel that does the work.
   * Returns false when the tool has no home, so the caller can say so.
   */
  runTool(entry: FileEntry, tool: string): boolean;
  /** True when running under Tauri. Gates every tool that touches disk. */
  native: boolean;
}

export class PhoneShell {
  readonly el: HTMLElement;
  readonly store: MediaStore;
  readonly thumbs: Thumbs;
  readonly viewer: PhoneViewer;

  private trashSheet: TrashSheet | null = null;
  private settingsSheet: SettingsSheet | null = null;
  /** Every user-facing knob. Read at boot, projected onto `.ph` by `bindPrefs`. */
  readonly prefs = new PhonePrefsStore();
  private unbindPrefs: (() => void) | null = null;
  private dock: AudioDock | null = null;
  private onWake: (() => void) | null = null;

  private head: HTMLElement;
  private titleEl: HTMLElement;
  private actionsEl: HTMLElement;
  private body: HTMLElement;
  private tabsEl: HTMLElement;

  private tabs = new Map<TabId, PhoneTab>();
  private buttons = new Map<TabId, HTMLButtonElement>();
  private current: TabId = "photos";

  /** Where each tab was scrolled to, so switching away and back returns you
   *  to the same photograph rather than to the top of the roll. */
  private scrollMemo = new Map<TabId, number>();

  constructor(private readonly host: PhoneHost) {
    const onAndroid = host.native && isAndroid();
    const roots = onAndroid ? ANDROID_MEDIA_ROOTS : desktopMediaRoots(host.home);
    // On a desktop the roots are already few and shallow, so the first pass has
    // nothing to shortcut and simply uses them.
    const hot = onAndroid ? ANDROID_HOT_ROOTS : roots;

    this.store = new MediaStore(host.fs, roots, hot);
    this.thumbs = new Thumbs(host.fs);
    this.viewer = new PhoneViewer(host, this.store, this.thumbs);

    this.titleEl = el("h1.ph-title", { text: "Photos" });
    this.actionsEl = el("div.ph-acts");
    this.head = el("header.ph-head", {}, this.titleEl, this.actionsEl);
    this.body = el("main.ph-body");
    this.tabsEl = el("nav.ph-tabs", { role: "tablist" });

    this.el = el("div.ph", {}, this.head, this.body, this.tabsEl);

    this.register(new PhotosTab(this));
    // The same roll again, over everything the scan found — documents,
    // downloads, audio, installs — mixed in with the media at their own dates.
    this.register(new PhotosTab(this, EVERYTHING_SPEC));
    this.register(new AlbumsTab(this));
    this.register(new FilesTab(this));
    this.register(new SearchTab(this));

    this.renderTabs();
    this.wireBack();

    // Coming back to a gallery that does not know about the screenshot you
    // just took is the "why isn't it here" moment this exists to prevent. Both
    // events, because Android fires `visibilitychange` on app switch and the
    // desktop fires `focus` on window switch; the age gate in the store keeps
    // rapid flicking from costing a walk per flick. One rescan updates every
    // tab, since they all read the same store.
    this.onWake = () => {
      if (document.visibilityState === "visible") this.store.refreshIfStale(15_000);
    };
    document.addEventListener("visibilitychange", this.onWake);
    window.addEventListener("focus", this.onWake);

    // And while the app *is* in the foreground, notice new files by watching
    // directory mtimes — the screenshot taken with the gallery open appears on
    // its own, with no rescan button anywhere. See `MediaStore.startWatch`.
    this.store.startWatch();
  }

  /** Read-only accessors the tabs use, so they take one constructor argument. */
  get fs(): PhoneFs { return this.host.fs; }
  get home(): string { return this.host.home; }
  get native(): boolean { return this.host.native; }

  mount(parent: HTMLElement = document.body): void {
    // Before the element is in the tree, so the first paint already has the
    // right theme, glass and grid — no flash of the defaults.
    this.unbindPrefs = bindPrefs(this.prefs, this.el);
    parent.append(this.el);
    // The viewer goes on the body, not inside `.ph`. `.ph` carries a z-index so
    // it can sit above the desktop shell it replaces, which makes it a stacking
    // context — and a viewer nested inside one can never rise above a desktop
    // panel that is layered against the body.
    parent.append(this.viewer.el);
    this.show(this.prefs.get().defaultTab);
  }

  unmount(): void {
    this.store.stopWatch();
    this.thumbs.dispose();
    this.viewer.dispose();
    this.trashSheet?.dispose();
    this.settingsSheet?.dispose();
    this.dock?.dispose();
    this.unbindPrefs?.();
    if (this.onWake) {
      document.removeEventListener("visibilitychange", this.onWake);
      window.removeEventListener("focus", this.onWake);
    }
    this.el.remove();
  }

  /** Open a file. Pictures and video stay in the phone viewer; the rest are
   *  handed to the desktop panel that owns them. */
  open(entry: FileEntry, siblings: readonly FileEntry[] = []): void {
    if (entry.kind === "image" || entry.kind === "video") {
      // Swiping in the viewer walks the siblings, and on the All tab those
      // include the PDFs and archives sitting between the pictures. The viewer
      // renders media only, so swiping steps over them rather than landing on
      // a black screen with a spreadsheet's filename on it.
      this.viewer.open(
        entry,
        siblings.filter((s) => s.kind === "image" || s.kind === "video"),
      );
      return;
    }
    if (entry.kind === "audio") {
      // A bar over the list, not a full panel: you play a voice note while
      // continuing to scroll. Built lazily — most sessions never play audio.
      this.dock ??= new AudioDock(this);
      void this.dock.play(entry);
      return;
    }
    this.host.openPanel(entry, panelFor(entry), siblings);
  }

  /** The settings sheet, over whatever tab is showing. Built on first use. */
  openSettings(): void {
    this.settingsSheet ??= new SettingsSheet(this.prefs);
    this.settingsSheet.open();
  }

  /** The trash screen, over whatever tab is showing. Built on first use. */
  openTrash(): void {
    this.trashSheet ??= new TrashSheet(this);
    this.trashSheet.open();
  }

  /**
   * Move one file to its folder's `.facet-trash` — the single delete path,
   * shared by the viewer and the roll's multi-select so the two cannot drift.
   * `move_file` creates the folder and picks a free name on collision, and a
   * same-volume rename is instant whatever the file size. Returns false when
   * the move failed and the file is untouched.
   */
  async trashItem(entry: GalleryItem): Promise<boolean> {
    try {
      const res = await this.fs.moveFile(
        entry.path,
        `${entry.folder}/.facet-trash/${entry.name}`,
        false,
      );
      dropFav(entry.path);
      this.store.noteTrashed(entry.path, res.path);
      return true;
    } catch {
      return false;
    }
  }

  show(id: TabId): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    if (this.tabs.has(this.current)) {
      this.scrollMemo.set(this.current, this.body.scrollTop);
    }

    this.current = id;
    // The CSS keys per-tab column counts off this: `.ph[data-tab="photos"]`
    // and `.ph[data-tab="all"]` are otherwise the same tab class twice.
    this.el.dataset["tab"] = id;
    // Every tab stays in the DOM once it has shown; a switch flips `hidden`.
    // Detaching the outgoing tab and attaching the incoming one made the
    // browser rebuild layout, style and the image decode state for three
    // hundred tiles on every tap -- the second of blank grid testers saw.
    // `base.css` makes `[hidden]` display:none with !important, so nothing a
    // tab does to its own root can leak it back on screen.
    const switchAt = performance.now();
    for (const other of this.tabs.values()) {
      if (other !== tab && other.el.isConnected) other.el.hidden = true;
    }
    if (tab.el.parentElement !== this.body) this.body.append(tab.el);
    tab.el.hidden = false;
    this.titleEl.textContent = tab.title();
    fill(this.actionsEl, ...this.actionsFor(tab));

    for (const [tid, btn] of this.buttons) {
      btn.setAttribute("aria-selected", tid === id ? "true" : "false");
    }

    tab.activate();
    this.body.scrollTop = this.scrollMemo.get(id) ?? 0;
    requestAnimationFrame(() => {
      perf(`tab ${id} shown -> painted ${(performance.now() - switchAt).toFixed(1)}ms`);
    });
  }

  /** A tab whose title or actions changed while it is showing. */
  refreshChrome(id: TabId): void {
    if (id !== this.current) return;
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.titleEl.textContent = tab.title();
    fill(this.actionsEl, ...this.actionsFor(tab));
  }

  /**
   * The tab's own actions plus the gear. Always last, always present at the
   * root of a tab, so settings are one tap from anywhere — but not while a tab
   * is selecting, when four of its own actions already fill the row and a
   * fifth button would push the title off a 360px screen.
   */
  private actionsFor(tab: PhoneTab): HTMLElement[] {
    const own = tab.actions?.() ?? [];
    if (own.length >= 3) return own;
    return [...own, iconBtn("settings", "Settings", () => this.openSettings())];
  }

  /** The scrolling element, for the thumbnail observer's root. */
  get scroller(): HTMLElement { return this.body; }

  private register(tab: PhoneTab): void {
    this.tabs.set(tab.id, tab);
  }

  private static iconSpan(key: string): HTMLElement {
    const span = el("span.ph-tab-icon", { "aria-hidden": true });
    span.append(icon(key));
    return span;
  }

  private renderTabs(): void {
    for (const tab of this.tabs.values()) {
      const btn = el<"button">("button.ph-tab", {
        type: "button",
        role: "tab",
        "aria-selected": "false",
        "aria-label": tab.label,
      },
        PhoneShell.iconSpan(tab.icon),
        // The label is a real element, not a title attribute. Rule 2.
        el("span.ph-tab-label", { text: tab.label }),
      );
      btn.addEventListener("click", () => {
        // Tapping the tab you are already on scrolls to the top, the way every
        // phone app behaves. Cheaper than hunting for the top of a long roll.
        if (this.current === tab.id) this.body.scrollTo({ top: 0, behavior: "smooth" });
        else { this.show(tab.id); haptic(this.prefs); }
      });
      this.buttons.set(tab.id, btn);
      this.tabsEl.append(btn);
    }
  }

  /**
   * The hardware back button, via the history stack.
   *
   * Android delivers back to a WebView as a `popstate` on a pushed entry, and
   * with nothing pushed it goes straight to "close the app". Pushing one
   * sentinel entry at mount and re-pushing after each consumed back gives the
   * viewer and the folder browser a back button that does what the rest of the
   * phone does, rather than dumping the user out of the app from inside a photo.
   */
  private wireBack(): void {
    history.pushState({ fct: "phone" }, "");
    window.addEventListener("popstate", () => {
      const consumed =
        this.viewer.back() ||
        closeTopPanel() ||
        (this.tabs.get(this.current)?.back?.() ?? false);

      // "Home" is whichever tab the person chose to open on, not Photos by
      // decree — back from Albums lands where the app started.
      const home = this.prefs.get().defaultTab;
      if (consumed || this.current !== home) {
        if (!consumed) this.show(home);
        history.pushState({ fct: "phone" }, "");
      }
      // Otherwise: on the home tab, nothing open, nothing to go back to. Let it
      // through, and the app closes — which is the correct behaviour and the
      // one people expect from the root of a gallery.
    });
  }
}

/**
 * Close whichever full-screen panel is on top, if one is open.
 *
 * The phone shell hands anything that is not a picture or a video to the panel
 * that already knows how to open it — the table viewer, the 3D scene, the
 * subtitle editor, eighteen of them. Those panels were written for a keyboard
 * and every one of them closes on Escape; none of them knows what a back
 * gesture is. Without this, backing out of a spreadsheet on a phone closes the
 * whole app, which is the single most confusing thing a phone app can do.
 *
 * Detection is by layer rather than by a list of class names: a panel is a
 * fixed-position child of the body, visible, sitting at z-index 40 or above.
 * A hard-coded list would silently stop covering a panel the day someone adds
 * the nineteenth one.
 */
function closeTopPanel(): boolean {
  let top: HTMLElement | null = null;
  let topZ = -1;

  for (const node of Array.from(document.body.children)) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.hidden || node.classList.contains("ph") || node.classList.contains("phv")) continue;

    const style = getComputedStyle(node);
    if (style.position !== "fixed") continue;
    if (style.display === "none" || style.visibility === "hidden") continue;

    const z = Number.parseInt(style.zIndex, 10);
    if (!Number.isFinite(z) || z < 40) continue;
    if (z >= topZ) { topZ = z; top = node; }
  }

  if (!top) return false;

  // Escape is dispatched **on the panel**, not on the document. Most of these
  // panels bind their key handler to their own root element, and an event
  // dispatched at the document never reaches a listener below it — bubbling
  // runs from the target upwards. Dispatching at the panel itself fires that
  // root listener in its target phase and still reaches the handful of panels
  // that listen on `window` on the way up.
  //
  // A focused control inside the panel would swallow it first if it were a real
  // keypress, which is the behaviour we want: a text field open in the subtitle
  // editor takes the Escape to close itself, and the next back press closes the
  // panel.
  const target = document.activeElement;
  const sink = target instanceof HTMLElement && top.contains(target) ? target : top;
  sink.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );

  // Report what happened, not what was attempted. Every one of these panels
  // closes synchronously — `close()` sets `hidden` or removes the node inside
  // the key handler — so the answer is already true by the time this reads it.
  //
  // Claiming a back press we did not actually consume would be the worse bug of
  // the two: the shell re-pushes a history entry for every press it thinks it
  // handled, so a panel that ignored Escape would swallow back forever and
  // there would be no way out of it at all.
  return !top.isConnected || top.hidden || getComputedStyle(top).display === "none";
}

/** Which desktop panel owns this kind of file. */
function panelFor(entry: FileEntry): string {
  switch (entry.kind) {
    case "audio": return "player";
    case "tabular": return "table";
    case "model3d": return "scene";
    case "document": return "quicklook";
    case "code": return "quicklook";
    default: return "inspector";
  }
}

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}
