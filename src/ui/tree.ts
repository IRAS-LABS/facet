/**
 * The navigation sidebar — places, drives, and a folder tree.
 *
 * This is the thing that makes FACET read as a file explorer rather than as a
 * viewer that happens to list files. A single pane of cards tells you what is
 * in *this* folder; it never tells you where this folder sits, and every real
 * explorer — Windows, Finder, Samsung's My Files, VS Code — answers that with a
 * tree down the left-hand side. The narrow icon rail was never that: it is a
 * set of destinations, and a destination is not a map.
 *
 * The shape is borrowed from the explorer pane in an earlier explorer of ours: one column,
 * text chevrons, twelve pixels of indent per level, single click, hover as the
 * only row decoration, names truncated with the full path on the tooltip.
 * Three things had to change, and each is forced by this being a real disk
 * rather than a database table:
 *
 *   1. **Children load when a node is opened, never before.** That tree fetched
 *      every row up front and built the whole thing in memory. `C:\` has
 *      hundreds of thousands of folders under it; the same approach here would
 *      hang the app on first paint.
 *   2. **Everything starts closed.** Same reason: "expanded by default" is a
 *      reasonable call over five folders and an infinite recursion over a disk.
 *   3. **Folders only.** Putting files in the tree would make it a second, worse
 *      copy of the list that is already filling the rest of the window.
 *
 * The tree is a *view* of navigation, not a driver of it. Whatever moves the
 * app — a card double-click, the address bar, Back, a palette command — calls
 * `reveal()`, and the tree opens itself down to that folder and highlights it.
 * A tree that only tracks its own clicks goes stale the first time you use
 * anything else, and a stale map is worse than none.
 */

import type { DirListing, FileEntry, Place } from "@core/explorer/types";
import { acceptDrops, type DropEffect } from "./dnd";

export interface TreeHost {
  /** A drop landed on a folder row. The shell owns the filesystem. */
  onDrop?(paths: readonly string[], to: string, effect: DropEffect): void;
  list(path: string): Promise<DirListing>;
  /** Called when a row is chosen. The host navigates; the tree does not. */
  open(path: string): void;
  places(): Place[];
  /**
   * Open the sidebar editor (item 38). Optional: the tree is built against a
   * host that may have no such panel — that is how it is tested — and the head
   * simply grows no button when there is nowhere for it to go.
   */
  editPlaces?(): void;
  /**
   * Move a root one step (item 38). Alt+Up/Down on a top-level row.
   *
   * The tree does not reorder anything itself. It knows what order the host gave
   * it and nothing about why, and a tree that shuffled its own roots would be a
   * second opinion about the sidebar competing with the store that owns it.
   */
  movePlace?(path: string, delta: number): void;
}

interface Node {
  path: string;
  name: string;
  depth: number;
  open: boolean;
  /** Children, once fetched. `null` means "never asked". */
  kids: Node[] | null;
  loading: boolean;
  /** Why the folder could not be read, if it could not. */
  error: string;
  /** `drive`, `home`, or a plain folder. Only decides which glyph is drawn. */
  icon: string;
}

const STORAGE_KEY = "facet.tree.v1";
const INDENT = 12;
/**
 * Below this the tree is a column of ellipses and above it the files lose the
 * window. The user can drag anywhere between; these are the ends of the rail.
 */
const MIN_W = 150;
const MAX_W = 480;

export class TreePanel {
  readonly root: HTMLElement;

  #host: TreeHost;
  #body: HTMLElement;
  #roots: Node[] = [];
  #byPath = new Map<string, Node>();
  #current = "";
  #width = 240;
  #collapsed = false;
  #store: Pick<Storage, "getItem" | "setItem">;
  /** The row currently lit as a drop target. Cleared on every re-render. */
  #dropPath: string | null = null;

  constructor(host: TreeHost, store: Pick<Storage, "getItem" | "setItem"> = localStorage) {
    this.#host = host;
    this.#store = store;

    this.root = document.createElement("nav");
    this.root.className = "tree";
    this.root.setAttribute("aria-label", "Folders");

    const head = document.createElement("div");
    head.className = "tree-head";
    const title = document.createElement("span");
    title.className = "tree-title";
    title.textContent = "Folders";
    const collapse = document.createElement("button");
    collapse.className = "tree-mini";
    collapse.type = "button";
    collapse.title = "Hide the folder tree (Ctrl+B)";
    collapse.textContent = "⟨";
    collapse.addEventListener("click", () => this.toggle());
    head.append(title);
    if (host.editPlaces) {
      const edit = document.createElement("button");
      edit.className = "tree-mini";
      edit.type = "button";
      edit.title = "Choose which folders appear here";
      edit.textContent = "⋯";
      edit.addEventListener("click", () => host.editPlaces?.());
      head.append(edit);
    }
    head.append(collapse);

    this.#body = document.createElement("div");
    this.#body.className = "tree-body";

    const grip = document.createElement("div");
    grip.className = "tree-grip";
    grip.title = "Drag to resize";
    this.#dragToResize(grip);

    this.root.append(head, this.#body, grip);
    // The tree is the one place you can drop into a folder you are not looking
    // at, which is most of what makes a file manager a file manager: filing
    // something away should not mean navigating there and back.
    acceptDrops(this.#body, {
      folderAt: (e) => {
        const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".tree-row");
        return row?.dataset["path"] ?? null;
      },
      mark: (path) => this.#markDrop(path),
      run: (paths, to, effect) => this.#host.onDrop?.(paths, to, effect),
    });
    this.#load();
    this.#applyWidth();
  }

  /** Build the top level from the host's places. Safe to call again. */
  async build(): Promise<void> {
    const seen = new Set<string>();
    this.#roots = [];
    this.#byPath.clear();
    for (const place of this.#host.places()) {
      if (place.path === undefined || seen.has(place.path)) continue;
      seen.add(place.path);
      const node: Node = {
        path: place.path,
        name: place.name,
        depth: 0,
        open: false,
        kids: null,
        loading: false,
        error: "",
        icon: place.icon,
      };
      this.#roots.push(node);
      this.#byPath.set(node.path, node);
    }
    this.#render();
  }

  /**
   * Open the tree down to `path` and mark it current.
   *
   * The walk is by string prefix rather than by asking the filesystem, because
   * the answer has to arrive at the same time as the folder does. Anything that
   * waited on a stat per level would leave the highlight lagging a folder
   * behind every time someone clicked quickly.
   */
  async reveal(path: string): Promise<void> {
    this.#current = path;
    const start = this.#roots
      .filter((r) => isInside(path, r.path) || same(path, r.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!start) {
      this.#render();
      return;
    }

    let node = start;
    // Guarded rather than `while (true)`: a filesystem that answers a listing
    // with a path that is not under the one asked for would otherwise spin
    // forever, and network drives do stranger things than that.
    for (let hop = 0; hop < 64 && !same(node.path, path); hop++) {
      await this.#expand(node);
      const next = (node.kids ?? []).find((k) => same(k.path, path) || isInside(path, k.path));
      if (!next) break;
      node = next;
    }
    this.#render();
    this.#scrollToCurrent();
  }

  /** Show or hide the whole pane. Returns the new state. */
  toggle(force?: boolean): boolean {
    this.#collapsed = force ?? !this.#collapsed;
    this.#applyWidth();
    this.#save();
    return !this.#collapsed;
  }

  get visible(): boolean {
    return !this.#collapsed;
  }

  /** Forget every cached listing, keeping what is open open. */
  async refresh(): Promise<void> {
    const open = [...this.#byPath.values()].filter((n) => n.open).map((n) => n.path);
    for (const node of this.#byPath.values()) {
      node.kids = null;
      node.open = false;
      node.error = "";
    }
    for (const path of open.sort((a, b) => a.length - b.length)) {
      const node = this.#byPath.get(path);
      if (node) await this.#expand(node);
    }
    this.#render();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  async #expand(node: Node): Promise<void> {
    node.open = true;
    if (node.kids !== null || node.loading) return;
    node.loading = true;
    this.#render();
    try {
      const listing = await this.#host.list(node.path);
      node.kids = listing.entries
        .filter((e: FileEntry) => e.kind === "folder" && e.hidden !== true)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((e) => {
          const existing = this.#byPath.get(e.path);
          if (existing) return existing;
          const kid: Node = {
            path: e.path,
            name: e.name,
            depth: node.depth + 1,
            open: false,
            kids: null,
            loading: false,
            error: "",
            icon: "folder",
          };
          this.#byPath.set(kid.path, kid);
          return kid;
        });
      node.error = "";
    } catch (err) {
      // A folder that cannot be read is extremely ordinary on Windows —
      // System Volume Information, another user's profile, a disconnected
      // network drive. It says so on its own row and the rest of the tree
      // carries on; throwing here would take the whole sidebar down with it.
      node.kids = [];
      node.error = err instanceof Error ? err.message : String(err);
    } finally {
      node.loading = false;
      this.#render();
    }
  }

  #toggleNode(node: Node): void {
    if (node.open) {
      node.open = false;
      this.#render();
    } else {
      void this.#expand(node);
    }
  }

  /**
   * The whole tree is rebuilt on every change. That is fine at this size — a
   * few hundred rows of two elements each — and it removes an entire class of
   * bug where the model and the DOM disagree about what is open.
   *
   * It does throw away the scroll position and the keyboard focus, so both are
   * carried across by hand. Losing focus mid-arrow-key would make the keyboard
   * navigation below quietly useless: press Right to open a folder and the next
   * Down would go nowhere.
   */
  #render(): void {
    const scroll = this.#body.scrollTop;
    const focused = document.activeElement;
    const focusPath =
      focused instanceof HTMLElement && this.#body.contains(focused)
        ? (focused.dataset["path"] ?? "")
        : "";

    const list = document.createElement("ul");
    list.className = "tree-list";
    let drives = false;
    for (const root of this.#roots) {
      // Windows splits the sidebar into your folders and the machine's disks,
      // and the split is worth keeping: "Pictures" and "C:" are the same kind
      // of row to the code and completely different things to the person.
      if (!drives && root.icon === "drive") {
        drives = true;
        const head = document.createElement("li");
        head.className = "tree-group";
        head.textContent = "This PC";
        list.append(head);
      }
      this.#renderNode(root, list);
    }
    this.#body.replaceChildren(list);
    this.#body.scrollTop = scroll;

    if (focusPath) {
      for (const el of this.#body.querySelectorAll<HTMLElement>(".tree-name")) {
        if (el.dataset["path"] === focusPath) {
          el.focus();
          break;
        }
      }
    }
  }

  #markDrop(path: string | null): void {
    this.#dropPath = path;
    for (const row of this.#body.querySelectorAll<HTMLElement>(".tree-row")) {
      if (row.dataset["path"] === path) row.dataset["drop"] = "1";
      else delete row.dataset["drop"];
    }
  }

  #renderNode(node: Node, into: HTMLElement): void {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tree-row";
    row.dataset["path"] = node.path;
    if (node.path === this.#dropPath) row.dataset["drop"] = "1";
    row.style.paddingInlineStart = `${6 + node.depth * INDENT}px`;
    if (same(node.path, this.#current)) row.setAttribute("aria-current", "true");
    if (node.error) row.dataset["error"] = "1";

    // The chevron and the name are separate controls on purpose. Clicking the
    // arrow should unfold a folder so you can look inside it *without leaving
    // the folder you are in*; clicking the name should take you there. Every
    // explorer worth using makes that distinction and it is the single thing
    // that decides whether a tree is pleasant to browse.
    //
    // A folder we have opened and found no folders inside loses its arrow
    // entirely — same as Explorer. Until it has been opened the arrow is a
    // guess, and it has to be: the only way to know is to read the folder, and
    // reading every folder to decide which arrows to draw is the eager load
    // this tree exists to avoid.
    const leaf = node.kids !== null && node.kids.length === 0 && !node.loading;
    const twist = document.createElement("button");
    twist.className = "tree-twist";
    twist.type = "button";
    twist.tabIndex = -1;
    twist.setAttribute("aria-hidden", "true");
    twist.textContent = node.loading ? "·" : leaf ? "" : node.open ? "▾" : "▸";
    if (node.loading) twist.dataset["busy"] = "1";
    twist.disabled = leaf;
    twist.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#toggleNode(node);
    });

    const name = document.createElement("button");
    name.className = "tree-name";
    name.type = "button";
    name.title = node.error ? `${node.path} — ${node.error}` : node.path;
    name.dataset["path"] = node.path;
    name.setAttribute("aria-expanded", String(node.open));
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.append(glyph(node));
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = node.name;
    name.append(icon, label);
    name.addEventListener("click", () => {
      this.#current = node.path;
      this.#host.open(node.path);
      if (!node.open) void this.#expand(node);
      else this.#render();
    });
    name.addEventListener("keydown", (e) => this.#key(e, node));

    row.append(twist, name);
    li.append(row);

    if (node.open) {
      const kids = node.kids;
      if (node.error) {
        const note = document.createElement("div");
        note.className = "tree-note";
        note.style.paddingInlineStart = `${6 + (node.depth + 1) * INDENT + 14}px`;
        note.textContent = "cannot be opened";
        li.append(note);
      } else if (kids !== null && kids.length > 0) {
        const sub = document.createElement("ul");
        sub.className = "tree-list";
        for (const kid of kids) this.#renderNode(kid, sub);
        li.append(sub);
      }
    }

    into.append(li);
  }

  /**
   * Arrow keys, the way a tree is expected to behave: right opens, left closes
   * or steps out to the parent. Without this the sidebar is unusable without a
   * mouse, and the whole point of a tree is fast movement.
   */
  #key(e: KeyboardEvent, node: Node): void {
    const rows = [...this.#body.querySelectorAll<HTMLElement>(".tree-name")];
    const here = rows.indexOf(e.currentTarget as HTMLElement);
    const focus = (i: number): void => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (next) next.focus();
    };
    // Alt+Up/Down reorders a top-level row instead of moving between rows
    // (item 38). Only at the top level: the rows below a root are the folders
    // that are actually on the disk in the order the disk gives them, and there
    // is nothing there to save an opinion about.
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (node.depth === 0) this.#host.movePlace?.(node.path, e.key === "ArrowUp" ? -1 : 1);
      return;
    }

    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focus(here + 1); break;
      case "ArrowUp": e.preventDefault(); focus(here - 1); break;
      case "ArrowRight":
        e.preventDefault();
        if (!node.open) void this.#expand(node);
        else focus(here + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (node.open) this.#toggleNode(node);
        else focus(here - 1);
        break;
      default:
        break;
    }
  }

  #scrollToCurrent(): void {
    const row = this.#body.querySelector<HTMLElement>('.tree-row[aria-current="true"]');
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  /**
   * Pointer capture, not a window-level mousemove listener. Without capture the
   * drag is lost the moment the pointer outruns the 6 px grip — which it does
   * immediately, because dragging a divider is a fast gesture — and the column
   * sticks halfway.
   */
  #dragToResize(grip: HTMLElement): void {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = this.#width;
      const move = (ev: PointerEvent): void => {
        this.#width = Math.max(MIN_W, Math.min(MAX_W, startW + ev.clientX - startX));
        this.#applyWidth();
      };
      const up = (): void => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        this.#save();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    // A divider you can double-click to collapse is a convention old enough
    // that people try it without being told.
    grip.addEventListener("dblclick", () => this.toggle());
  }

  #applyWidth(): void {
    this.root.hidden = this.#collapsed;
    document.documentElement.style.setProperty(
      "--fct-tree-w",
      this.#collapsed ? "0px" : `${this.#width}px`,
    );
  }

  #save(): void {
    try {
      this.#store.setItem(
        STORAGE_KEY,
        JSON.stringify({ width: this.#width, collapsed: this.#collapsed }),
      );
    } catch {
      // A full or blocked storage must not stop the user resizing a pane.
    }
  }

  #load(): void {
    try {
      const raw = this.#store.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { width?: unknown; collapsed?: unknown };
      if (typeof saved.width === "number" && Number.isFinite(saved.width)) {
        this.#width = Math.max(MIN_W, Math.min(MAX_W, saved.width));
      }
      this.#collapsed = saved.collapsed === true;
    } catch {
      // Corrupt settings fall back to the defaults rather than to a blank app.
    }
  }
}

/** `\` and `/` are the same separator, and Windows does not care about case. */
export function same(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** Is `path` somewhere below `parent`? Not true of `parent` itself. */
export function isInside(path: string, parent: string): boolean {
  const p = norm(parent);
  const c = norm(path);
  if (c === p) return false;
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/*
 * Row icons are drawn, not typed.
 *
 * The obvious thing is a folder character — U+1F5C0 and friends — and it is a
 * trap: Segoe UI has no glyph for them, so on this machine every row came out
 * as a tofu box. Emoji folders (📁) do render but arrive full-colour and
 * cartoon-sized next to 12.5px text. A path in an <svg> inherits `currentColor`,
 * so it dims with the row, brightens on hover, and turns accent when current,
 * for free — which is exactly the behaviour a sidebar icon should have.
 */
const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS: Record<string, string> = {
  folder:
    "M1.6 4.2A1.7 1.7 0 0 1 3.3 2.5h2.9a1 1 0 0 1 .8.4l1 1.3h5.7a1.7 1.7 0 0 1 1.7 1.7v6.2a1.7 1.7 0 0 1-1.7 1.7H3.3a1.7 1.7 0 0 1-1.7-1.7z",
  folderOpen:
    "M1.6 4.2A1.7 1.7 0 0 1 3.3 2.5h2.9a1 1 0 0 1 .8.4l1 1.3h5.7a1.7 1.7 0 0 1 1.7 1.7v1H4.6a1.7 1.7 0 0 0-1.6 1.2l-1.4 4.3zM4.6 8.4h10.6a.6.6 0 0 1 .57.79l-1.4 4.2a1 1 0 0 1-.95.68H2.9a.6.6 0 0 1-.57-.79l1.4-4.2a1 1 0 0 1 .87-.68z",
  drive:
    "M2.2 3.4h11.6a1.7 1.7 0 0 1 1.7 1.7v5.8a1.7 1.7 0 0 1-1.7 1.7H2.2A1.7 1.7 0 0 1 .5 10.9V5.1a1.7 1.7 0 0 1 1.7-1.7zm10.2 3.2a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z",
  home: "M8 1.5 15.2 7.6a.7.7 0 0 1-.45 1.24H13.4v4.5a1.2 1.2 0 0 1-1.2 1.2H9.9v-4.1H6.1v4.1H3.8a1.2 1.2 0 0 1-1.2-1.2v-4.5H1.25A.7.7 0 0 1 .8 7.6z",
};

function glyph(node: Node): SVGSVGElement {
  const key =
    node.icon === "drive" ? "drive"
    : node.icon === "home" ? "home"
    : node.open ? "folderOpen"
    : "folder";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", PATHS[key]!);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
