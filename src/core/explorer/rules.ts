/**
 * How each folder was last left, and filters saved under a name (item 37).
 *
 * Two things live here because they are the same thing seen from two ends. A
 * per-folder rule is a filter and a sort order remembered *for you*, keyed by
 * where you were; a saved filter is one remembered *by you*, keyed by a name
 * you chose. Both are a query string plus a sort, both persist to one document,
 * and splitting them would mean two files, two backends and two chances for a
 * migration to only get one of them.
 *
 * Why remember per folder at all: a Downloads folder wants newest-first and a
 * project folder wants by name, and being made to re-sort every time you arrive
 * is the sort of small tax that makes people stop using a file manager. Why it
 * is a setting that can be turned off: the same behaviour, to somebody who
 * expects one global order, reads as the app randomly changing its mind.
 *
 * **A filter is never remembered as "what is on screen right now".** It is
 * remembered when you change it, and applied when you arrive. The difference
 * matters: navigating into a folder with a filter typed must not smear that
 * filter across the folder you land in, and every explorer that has done it has
 * been reported as a bug.
 */

import { isGroup, type GroupKey } from "./grouping";
import { isMode, type ViewMode } from "./modes";
import type { SortKey } from "./types";

const KEY = "facet.rules";

/**
 * The cap on remembered folders.
 *
 * There is no expiry and no cleanup pass; the oldest entry is dropped when the
 * limit is hit. 400 folders is far more than anybody navigates between in a
 * session and about 40 KB at worst, and an uncapped map keyed by every folder
 * ever opened is a file that only grows.
 */
const MAX_FOLDERS = 400;

/**
 * Everything a View menu can change about one folder.
 *
 * Every field is optional and every absent field means "whatever the global
 * setting says" — that is what makes this a diff rather than a snapshot, and it
 * is what lets the per-folder memory be switched off without erasing anything.
 * Adding a field here is most of the work of adding a View menu entry; the rest
 * is `sanitize` below and the reducer in the shell.
 */
export interface FolderRule {
  sort?: SortKey;
  ascending?: boolean;
  /** Splits the folder under headings — see `grouping.ts`. */
  group?: GroupKey;
  /** A filter line — see `filter.ts`. Absent or "" means no filter. */
  filter?: string;
  /** A layout — see `modes.ts`. Absent means whatever the global default is. */
  mode?: ViewMode;
  /**
   * Icon size, as the card width in px that `ViewConfig.cardSize` means.
   *
   * A number rather than a `"large" | "medium"` enum because the underlying
   * setting is already a number with a slider on it, and a folder that
   * remembered "large" would have to guess what large meant if that slider ever
   * moved. The View menu offers named steps on top of it; this stores what the
   * step resolved to.
   */
  cardSize?: number;
  foldersFirst?: boolean;
  showHidden?: boolean;
}

export interface SavedFilter {
  name: string;
  query: string;
}

interface Persisted {
  version: 1;
  folders: Record<string, FolderRule>;
  /** Insertion order, oldest first — what the cap evicts from. */
  order: string[];
  saved: SavedFilter[];
}

export interface RulesBackend {
  read(): string | null;
  write(text: string): void;
}

/** localStorage, with every failure mode swallowed — see `settings/store.ts`. */
export function browserRules(): RulesBackend {
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
        /* private mode, quota, disabled — a forgotten sort order is not a crash */
      }
    },
  };
}

export function memoryRules(seed: string | null = null): RulesBackend {
  let value = seed;
  return { read: () => value, write: (text) => { value = text; } };
}

/**
 * The lookup key for a path.
 *
 * Windows does not care about case and Android content URIs do, so the case is
 * folded only for paths that look like Windows ones. Doing it unconditionally
 * would merge two genuinely different Android folders; not doing it at all
 * would give `C:/Users` and `c:/users` separate memories, which the address bar
 * makes trivially easy to produce.
 */
export function keyOf(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = /^[a-z]:\//i.test(trimmed) || trimmed.startsWith("//");
  return windows ? trimmed.toLowerCase() : trimmed;
}

export class RulesStore {
  private folders = new Map<string, FolderRule>();
  private saved: SavedFilter[] = [];
  private loaded = false;

  constructor(private readonly backend: RulesBackend = browserRules()) {}

  /** What was remembered for this folder, or undefined. */
  get(path: string): FolderRule | undefined {
    this.ensureLoaded();
    return this.folders.get(keyOf(path));
  }

  /**
   * Merge a change into a folder's memory.
   *
   * A patch rather than a whole rule because the callers are separate: the sort
   * headers know about sort, the filter box knows about the filter, and neither
   * should have to read the other's state back to avoid erasing it.
   *
   * A patch that empties the rule removes it, which keeps this a diff of what
   * you actually chose rather than a record of every folder you have visited.
   */
  set(path: string, patch: FolderRule): void {
    this.ensureLoaded();
    const key = keyOf(path);
    const next: FolderRule = { ...(this.folders.get(key) ?? {}), ...patch };
    if (next.filter !== undefined && next.filter.trim() === "") delete next.filter;
    if (Object.keys(next).length === 0) {
      this.folders.delete(key);
    } else {
      // Re-inserting moves it to the end, which is what makes the cap evict the
      // least recently *changed* folder rather than the least recently created.
      this.folders.delete(key);
      this.folders.set(key, next);
      while (this.folders.size > MAX_FOLDERS) {
        const oldest = this.folders.keys().next();
        if (oldest.done === true) break;
        this.folders.delete(oldest.value);
      }
    }
    this.persist();
  }

  forget(path: string): void {
    this.ensureLoaded();
    if (this.folders.delete(keyOf(path))) this.persist();
  }

  forgetAll(): void {
    this.ensureLoaded();
    this.folders.clear();
    this.persist();
  }

  /** How many folders are remembered — the settings panel says so on its button. */
  count(): number {
    this.ensureLoaded();
    return this.folders.size;
  }

  // ── saved filters ──

  all(): SavedFilter[] {
    this.ensureLoaded();
    return [...this.saved];
  }

  /** Save under a name, replacing a filter of the same name. */
  save(name: string, query: string): void {
    this.ensureLoaded();
    const trimmed = name.trim();
    if (trimmed === "" || query.trim() === "") return;
    const at = this.saved.findIndex((f) => f.name.toLowerCase() === trimmed.toLowerCase());
    const entry: SavedFilter = { name: trimmed, query: query.trim() };
    if (at >= 0) this.saved[at] = entry;
    else this.saved.push(entry);
    this.persist();
  }

  remove(name: string): void {
    this.ensureLoaded();
    const before = this.saved.length;
    this.saved = this.saved.filter((f) => f.name.toLowerCase() !== name.trim().toLowerCase());
    if (this.saved.length !== before) this.persist();
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

    // Read through `order` rather than the object's own key order, because the
    // eviction cap depends on knowing which entry is oldest and JSON object key
    // order is only guaranteed for non-numeric keys. Paths are not numeric, but
    // depending on that is a bet with nothing to win.
    const src = d.folders ?? {};
    const order = Array.isArray(d.order) ? d.order : Object.keys(src);
    for (const key of order) {
      const rule = (src as Record<string, unknown>)[key];
      const clean = sanitize(rule);
      if (clean) this.folders.set(key, clean);
    }
    if (Array.isArray(d.saved)) {
      for (const f of d.saved) {
        if (typeof f?.name === "string" && typeof f?.query === "string" && f.name.trim() !== "") {
          this.saved.push({ name: f.name, query: f.query });
        }
      }
    }
  }

  private persist(): void {
    const folders: Record<string, FolderRule> = {};
    const order: string[] = [];
    for (const [k, v] of this.folders) {
      folders[k] = v;
      order.push(k);
    }
    try {
      this.backend.write(JSON.stringify({ version: 1, folders, order, saved: this.saved } satisfies Persisted));
    } catch {
      /* see `browserRules` — the values still apply for this run */
    }
  }
}

const SORTS: readonly string[] = ["name", "size", "modified", "kind"];

/**
 * The card-size setting's own bounds — see the note in `sanitize`.
 *
 * Exported because the View menu's named steps and the bigger/smaller keys have
 * to land inside the same window this clamps to. A step that resolved to 500
 * would be stored as 420 and drawn at 500 until the next reload, which is a
 * disagreement between the screen and the disk that nothing on screen explains.
 */
export const MIN_CARD = 90;
export const MAX_CARD = 420;

/**
 * A stored rule, checked.
 *
 * Everything unrecognised is dropped rather than kept, which is the opposite of
 * what the settings store does with unknown ids — and deliberately so. There,
 * an unknown id probably belongs to a module that has not loaded yet. Here, the
 * shape is closed: a `sort` this build cannot sort by would be handed straight
 * to a switch statement and silently fall through to name.
 */
function sanitize(raw: unknown): FolderRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out: FolderRule = {};
  if (typeof r.sort === "string" && SORTS.includes(r.sort)) out.sort = r.sort as SortKey;
  if (typeof r.ascending === "boolean") out.ascending = r.ascending;
  if (typeof r.filter === "string" && r.filter.trim() !== "") out.filter = r.filter;
  // Asked rather than listed: this file used to name the two modes itself,
  // which meant adding a third silently made every folder saved in it open in
  // the wrong one.
  if (isMode(r.mode)) out.mode = r.mode;
  if (isGroup(r.group)) out.group = r.group;
  // Bounded, not merely finite. This number is written straight into a CSS
  // length and used as a grid column width: a stored 0 gives a folder of
  // zero-width cards and a stored 1e9 gives one card the size of a city, and in
  // both cases the folder looks empty and there is no visible control to undo
  // it with. The bounds are the card-size setting's own.
  if (typeof r.cardSize === "number" && Number.isFinite(r.cardSize)) {
    out.cardSize = Math.min(MAX_CARD, Math.max(MIN_CARD, Math.round(r.cardSize)));
  }
  if (typeof r.foldersFirst === "boolean") out.foldersFirst = r.foldersFirst;
  if (typeof r.showHidden === "boolean") out.showHidden = r.showHidden;
  return Object.keys(out).length === 0 ? null : out;
}
