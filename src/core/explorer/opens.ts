/**
 * What FACET opens a file with, internally (item 40).
 *
 * Item 39 decided what the right-click menu *offers*. This decides what **Open**
 * actually does — and they are the same kind of problem, so they get the same
 * kind of answer: a small stored diff over a built-in default, resolved by a
 * pure function, with the UI reading the resolver rather than reimplementing it.
 *
 * Before this file, `openEntry` was a `switch` on `entry.kind`. That switch was
 * right about the common case and unfixable about every other one: a `.json` is
 * "code" and opens in the inspector, but somebody who is looking at forty
 * `.json` files today wants the table view every time and has no way to say so.
 * The kind of a file is FACET's guess about what it *is*; the association is the
 * user's decision about what to *do with it*, and those are not the same
 * sentence.
 *
 * **Three layers, most specific first.** An extension beats a kind, a kind beats
 * the built-in default:
 *
 *     .json → table          (this extension, always)
 *     code  → inspector      (everything else FACET calls code)
 *     ⟨built in⟩             (what FACET shipped believing)
 *
 * Two properties fall out of that ordering and both are the point. Setting a
 * kind never silently rewrites the four extensions you had already pinned. And
 * a preference file that names a handler this build has never heard of — because
 * it was written by a later version, or by hand — costs you that one row and not
 * the whole file, because `resolve` only ever returns a handler that is actually
 * on offer right now.
 *
 * **Availability is a separate question from preference, and asked later.** The
 * table view only handles some of what the explorer calls `tabular`, every
 * editor needs the desktop binary, and none of that is knowable when the
 * preference is written. So `resolve` takes the list of handlers that can take
 * *this* file *right now* and falls back down the layers until something on that
 * list answers — which is the same rule item 39's menu uses for a command that
 * is not on offer, for the same reason: a preference is never a promise.
 */

import type { FileEntry, FileKind } from "./types";

const KEY = "facet.opens";

/**
 * Every way FACET can open a file.
 *
 * Ids are stable strings and not an enum: they are written to a file that a
 * later version has to read, and `"viewer"` survives a refactor that renumbers
 * an enum. `system` is deliberately in this list rather than being a special
 * case beside it — "hand it to Windows" is a legitimate answer to "what should
 * open this", and modelling it as an ordinary handler is what lets a user say
 * *always* do that for `.psd` without the resolver growing a branch.
 */
export type HandlerId =
  | "viewer"
  | "player"
  | "scene"
  | "table"
  | "inspector"
  | "meta"
  | "vedit"
  | "aedit"
  | "quicklook"
  | "system";

export interface Handler {
  id: HandlerId;
  /** What a menu row says. Sentence case, no trailing punctuation. */
  label: string;
  /** One line for the chooser, explaining when you would pick it. */
  blurb: string;
}

/**
 * In the order a chooser should list them: the viewers first, then the editors,
 * then the two inspectors, then the escape hatch out to Windows.
 */
export const HANDLERS: readonly Handler[] = [
  { id: "viewer", label: "Picture viewer", blurb: "Zoom, pan, blur and draw. Arrow keys walk the folder." },
  { id: "player", label: "Player", blurb: "Video and audio, with the speed and timelapse controls." },
  { id: "scene", label: "3D viewer", blurb: "Orbit a model. glTF, GLB, OBJ, STL and PLY." },
  { id: "table", label: "Table view", blurb: "Rows and columns, for CSV, TSV, Excel and Parquet." },
  { id: "vedit", label: "Video editor", blurb: "Trim, speed, blur faces, re-encode." },
  { id: "aedit", label: "Audio editor", blurb: "Trim, gain, noise and voice filtering." },
  { id: "inspector", label: "Hex inspector", blurb: "The bytes, for when nothing else will tell you." },
  { id: "meta", label: "Metadata", blurb: "What the file says about you, and the button that removes it." },
  { id: "quicklook", label: "Quick look", blurb: "The peek panel, without leaving the folder." },
  { id: "system", label: "The default Windows app", blurb: "Hand it to whatever Windows already opens it with." },
];

const HANDLER_IDS: ReadonlySet<string> = new Set(HANDLERS.map((h) => h.id));

export function handlerLabel(id: HandlerId): string {
  return HANDLERS.find((h) => h.id === id)?.label ?? id;
}

/** Whether a string off disk is a handler this build knows. */
export function isHandler(id: unknown): id is HandlerId {
  return typeof id === "string" && HANDLER_IDS.has(id);
}

/**
 * What FACET shipped believing, by kind.
 *
 * This is the old `switch` in `openEntry`, moved rather than rewritten — the
 * defaults were already right, they just had nowhere to be overridden from.
 * `folder` is absent on purpose: opening a folder means walking into it, that is
 * not a handler, and offering to open a folder in the hex inspector would be a
 * joke played on whoever chose it.
 */
export const BUILT_IN: Readonly<Record<Exclude<FileKind, "folder">, HandlerId>> = {
  image: "viewer",
  video: "player",
  audio: "player",
  tabular: "table",
  document: "system",
  code: "system",
  archive: "system",
  // Was `system` until item 13 gave FACET something to open one with. The five
  // formats the viewer reads are a subset of the eleven the explorer calls
  // `model3d`, so this is a preference that `resolveOpen` will decline for a
  // `.blend` — which is exactly the fall-through the layers exist for.
  model3d: "scene",
  binary: "system",
};

interface Persisted {
  version: 1;
  /** Lowercase extension, no dot → handler. */
  byExt: Record<string, HandlerId>;
  /** Kind → handler. Only the kinds actually changed appear. */
  byKind: Partial<Record<FileKind, HandlerId>>;
}

export interface OpensBackend {
  read(): string | null;
  write(text: string): void;
}

/** localStorage, every failure swallowed — see `settings/store.ts`. */
export function browserOpens(): OpensBackend {
  return {
    read: () => {
      try {
        return localStorage.getItem(KEY);
      } catch {
        return null;
      }
    },
    write: (text) => {
      try {
        localStorage.setItem(KEY, text);
      } catch {
        /* the choice still holds for this session */
      }
    },
  };
}

export function memoryOpens(seed: string | null = null): OpensBackend {
  let value = seed;
  return { read: () => value, write: (text) => { value = text; } };
}

/**
 * A ceiling, as everywhere else a list grows by a button.
 *
 * High enough that nobody reaches it by using the app and low enough that a
 * corrupt or generated file cannot make startup slow.
 */
const MAX_EXTS = 400;

/** Normalise however the extension arrived: `.PNG`, `PNG`, `png` all match. */
export function normalizeExt(ext: string): string {
  return ext.trim().replace(/^\.+/, "").toLowerCase();
}

/**
 * The three layers, in order, for one file — *before* availability is
 * considered. Exported because the chooser wants to say which layer a row is
 * currently getting its answer from, and recomputing that in the view would be
 * two implementations of one rule.
 */
export interface Choice {
  handler: HandlerId;
  /** Which layer answered. */
  from: "ext" | "kind" | "built-in";
}

export class OpensStore {
  private byExt = new Map<string, HandlerId>();
  private byKind = new Map<FileKind, HandlerId>();
  private loaded = false;

  constructor(private readonly backend: OpensBackend = browserOpens()) {}

  /** Every extension the user has pinned, in insertion order. */
  extensions(): ReadonlyArray<readonly [string, HandlerId]> {
    this.ensureLoaded();
    return [...this.byExt.entries()];
  }

  /** The handler for a kind, or undefined where the built-in still stands. */
  forKind(kind: FileKind): HandlerId | undefined {
    this.ensureLoaded();
    return this.byKind.get(kind);
  }

  forExt(ext: string): HandlerId | undefined {
    this.ensureLoaded();
    return this.byExt.get(normalizeExt(ext));
  }

  /**
   * What the layers say for this file, ignoring what is available.
   *
   * A folder is not a file to be handled and never reaches here — the shell
   * navigates into it before asking.
   */
  choose(entry: Pick<FileEntry, "kind" | "ext">): Choice {
    this.ensureLoaded();
    const byExt = this.byExt.get(normalizeExt(entry.ext));
    if (byExt !== undefined) return { handler: byExt, from: "ext" };
    const byKind = this.byKind.get(entry.kind);
    if (byKind !== undefined) return { handler: byKind, from: "kind" };
    return { handler: builtInFor(entry.kind), from: "built-in" };
  }

  setExt(ext: string, handler: HandlerId | null): void {
    this.ensureLoaded();
    const key = normalizeExt(ext);
    if (key === "") return;
    if (handler === null) this.byExt.delete(key);
    else this.byExt.set(key, handler);
    while (this.byExt.size > MAX_EXTS) {
      const oldest = this.byExt.keys().next().value;
      if (oldest === undefined) break;
      this.byExt.delete(oldest);
    }
    this.persist();
  }

  setKind(kind: FileKind, handler: HandlerId | null): void {
    this.ensureLoaded();
    // Folders are not opened *with* anything, so accepting a handler for one
    // would store a preference that can never be read.
    if (kind === "folder") return;
    if (handler === null) this.byKind.delete(kind);
    else this.byKind.set(kind, handler);
    this.persist();
  }

  reset(): void {
    this.ensureLoaded();
    this.byExt.clear();
    this.byKind.clear();
    this.persist();
  }

  /** Whether anything here is the user's doing. Drives the ↺ in the panel. */
  touched(): boolean {
    this.ensureLoaded();
    return this.byExt.size > 0 || this.byKind.size > 0;
  }

  // ── internals ──

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let text: string | null;
    try {
      text = this.backend.read();
    } catch {
      return;
    }
    if (!text) return;
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof doc !== "object" || doc === null) return;
    const d = doc as Partial<Persisted>;
    if (d.version !== 1) return;

    // Each entry is checked on its own: a file with one unknown handler in it
    // keeps every other line, which is the whole reason these files are small
    // and readable in the first place.
    if (typeof d.byExt === "object" && d.byExt !== null) {
      for (const [rawExt, handler] of Object.entries(d.byExt)) {
        const ext = normalizeExt(rawExt);
        if (ext === "" || !isHandler(handler)) continue;
        if (this.byExt.size >= MAX_EXTS) break;
        this.byExt.set(ext, handler);
      }
    }
    if (typeof d.byKind === "object" && d.byKind !== null) {
      for (const [kind, handler] of Object.entries(d.byKind)) {
        if (kind === "folder" || !isHandler(handler)) continue;
        if (!(kind in BUILT_IN)) continue;
        this.byKind.set(kind as FileKind, handler);
      }
    }
  }

  private persist(): void {
    try {
      this.backend.write(
        JSON.stringify({
          version: 1,
          byExt: Object.fromEntries(this.byExt),
          byKind: Object.fromEntries(this.byKind),
        } satisfies Persisted),
      );
    } catch {
      /* see `browserOpens` */
    }
  }
}

/** The shipped answer for a kind. `folder` has none and gets the escape hatch. */
export function builtInFor(kind: FileKind): HandlerId {
  return kind === "folder" ? "system" : BUILT_IN[kind];
}

/**
 * The handler that will actually run, given what is available for this file.
 *
 * `available` is what the shell can offer *for this file, right now* — it knows
 * that the table view only takes some tabular extensions and that every editor
 * needs the desktop binary, and neither fact is knowable where the preference
 * was written. Falling down the layers rather than failing is deliberate: a
 * preference is matched against reality, never trusted over it.
 *
 * Returns null only when nothing at all can open the file, which on desktop
 * cannot happen (`system` always answers) and in the browser preview routinely
 * does.
 */
export function resolveOpen(
  entry: Pick<FileEntry, "kind" | "ext">,
  store: OpensStore,
  available: readonly HandlerId[],
): HandlerId | null {
  const can = new Set(available);
  const chosen = store.choose(entry);
  if (can.has(chosen.handler)) return chosen.handler;
  // The extension said something unavailable — try the kind before the default,
  // so a per-extension override does not cost you a per-kind one you also set.
  if (chosen.from === "ext") {
    const byKind = store.forKind(entry.kind);
    if (byKind !== undefined && can.has(byKind)) return byKind;
  }
  const shipped = builtInFor(entry.kind);
  if (can.has(shipped)) return shipped;
  // Last resort. `system` first and not merely first in `HANDLERS` order,
  // because "hand it to Windows" is the one answer that is never *wrong* for a
  // file FACET has no opinion about — opening an unknown file in the metadata
  // panel because m sorts before s would be a worse answer arrived at by
  // alphabet. Below that, `HANDLERS` order, so the fallback is at least stable
  // rather than being whatever the caller happened to list first.
  if (can.has("system")) return "system";
  for (const h of HANDLERS) if (can.has(h.id)) return h.id;
  return null;
}
