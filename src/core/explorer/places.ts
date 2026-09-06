/**
 * Which folders sit in the sidebar, in which order (item 38).
 *
 * **This is a diff over what the disk reports, not a replacement for it.** The
 * adapter discovers the places that exist on this machine — home, Pictures,
 * Videos, Music, Documents, and every drive that is currently mounted — and that
 * list is not stable: a USB stick appears, a network drive drops, a profile gets
 * renamed. A store that held the whole sidebar as a saved list would show you a
 * drive that was unplugged a month ago and would never show you the one you just
 * plugged in, and there is no amount of merging that fixes that afterwards. So
 * what is saved is only what you *changed*: folders you pinned, discovered ones
 * you hid, names you gave them, and the order. Everything else is whatever the
 * machine says today.
 *
 * That is the same shape as `rules.ts` and for the same reason — a preference
 * file should record decisions, not state.
 *
 * One constraint the ordering has to respect: the sidebar draws a "This PC"
 * heading before the first drive, so the drives have to stay together at the
 * bottom. Reordering therefore happens *within* your folders and *within* the
 * drives, never across the line. Letting a pinned folder be dragged below a
 * drive would file it under "This PC", which is not a thing the person doing the
 * dragging asked for.
 */

import { keyOf } from "./rules";
import type { Place } from "./types";

const KEY = "facet.places";

/**
 * A cap, for the same reason `rules.ts` has one: this file is written by a
 * button that is easy to hold down. Nobody has a hundred pinned folders, and a
 * sidebar with a hundred rows is not a sidebar.
 */
const MAX_PINNED = 100;

/** A folder you pinned yourself. */
export interface UserPlace {
  id: string;
  name: string;
  path: string;
  icon: string;
}

interface Persisted {
  version: 1;
  pinned: UserPlace[];
  /** Ids of discovered places that have been hidden. */
  hidden: string[];
  /** Ids in the order you put them. Partial — anything unlisted keeps its own. */
  order: string[];
  /** id → the name you gave it, when it is not the one it came with. */
  named: Record<string, string>;
}

export interface PlacesBackend {
  read(): string | null;
  write(text: string): void;
}

/** localStorage, with every failure swallowed — see `settings/store.ts`. */
export function browserPlaces(): PlacesBackend {
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
        /* a sidebar that cannot save its order is still a sidebar */
      }
    },
  };
}

export function memoryPlaces(seed: string | null = null): PlacesBackend {
  let value = seed;
  return { read: () => value, write: (text) => { value = text; } };
}

/** The id a pinned folder gets. Derived from the path, so pinning twice is once. */
export function idFor(path: string): string {
  return `user:${keyOf(path)}`;
}

/** The last segment of a path, which is the name people expect a pin to have. */
export function nameFor(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  const tail = cut >= 0 ? clean.slice(cut + 1) : clean;
  // `C:` has no tail, and a drive root pinned as "" is an invisible row.
  return tail === "" ? clean || path : tail;
}

export class PlacesStore {
  private pinned: UserPlace[] = [];
  private hidden = new Set<string>();
  private order: string[] = [];
  private named = new Map<string, string>();
  private loaded = false;
  /**
   * What the machine reported the last time anyone asked.
   *
   * Not persisted, and not the source of anything — it exists so the verbs can
   * speak in terms of *paths* while the hidden list is keyed by *id*. Hiding
   * Pictures stores the id `pics`; later pinning `C:/Users/me/Pictures` has only
   * a path in hand, and without this there is no way to tell that those two are
   * the same row. The button would appear to do nothing, which is the worst
   * thing a button can do.
   */
  private lastSeen: readonly Place[] = [];

  constructor(private readonly backend: PlacesBackend = browserPlaces()) {}

  /**
   * The sidebar, given what the adapter found.
   *
   * Pure: it reads the two lists and returns a third, so the caller can hand it
   * whatever the disk last said without this having to know when that changed.
   */
  resolve(discovered: readonly Place[]): Place[] {
    this.ensureLoaded();
    this.lastSeen = discovered;

    const out: Place[] = [];
    const seen = new Set<string>();
    for (const p of discovered) {
      if (this.hidden.has(p.id)) continue;
      seen.add(p.id);
      const name = this.named.get(p.id);
      out.push(name === undefined ? p : { ...p, name });
    }
    for (const u of this.pinned) {
      // A folder you pinned that the machine also reports — Pictures, say — is
      // one row, not two. The discovered one wins because it carries the icon
      // and the platform's own name for it.
      if (seen.has(u.id) || out.some((p) => p.path !== undefined && keyOf(p.path) === keyOf(u.path))) {
        continue;
      }
      out.push({
        id: u.id,
        name: this.named.get(u.id) ?? u.name,
        icon: u.icon,
        path: u.path,
        pinned: true,
      });
    }

    // Drives last, always. See the note at the top: the "This PC" heading is
    // drawn at the first drive, so a folder after one would end up under it.
    const folders = out.filter((p) => p.icon !== "drive");
    const drives = out.filter((p) => p.icon === "drive");
    return [...this.sorted(folders), ...this.sorted(drives)];
  }

  /**
   * Pin a folder.
   *
   * Pinning something already in the sidebar un-hides it rather than adding a
   * duplicate — the button says "pin this folder" and the person pressing it
   * means "I want to see this in the sidebar", which is one outcome whether or
   * not the machine happened to report it.
   */
  pin(path: string, name?: string, icon = "folder"): void {
    this.ensureLoaded();
    const id = idFor(path);
    const key = keyOf(path);
    let changed = false;

    // Un-hide anything this path names — your own pin removed earlier, or a
    // discovered place you took out. The second case is why `lastSeen` exists:
    // the hidden list holds `pics`, and all we have here is a path.
    const discoveredId = this.lastSeen.find(
      (p) => p.path !== undefined && keyOf(p.path) === key,
    )?.id;
    for (const hid of [...this.hidden]) {
      if (hid === id || hid === discoveredId || keyOf(hid.replace(/^user:/, "")) === key) {
        this.hidden.delete(hid);
        changed = true;
      }
    }

    // Un-hiding a discovered place is the whole job — adding a second row for a
    // folder the machine already reports would leave a pin behind that `remove`
    // could never get rid of, because the discovered row wins and would keep
    // resurrecting it.
    if (discoveredId !== undefined) {
      if (changed) this.persist();
      return;
    }

    if (!this.pinned.some((p) => p.id === id)) {
      this.pinned.push({ id, name: name?.trim() || nameFor(path), path, icon });
      // The oldest pin goes rather than the newest being refused: a button that
      // silently does nothing is worse than one that quietly costs you a pin you
      // made a hundred folders ago.
      while (this.pinned.length > MAX_PINNED) this.pinned.shift();
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * Take a place out of the sidebar.
   *
   * One verb for two storage shapes: a pin of yours is deleted, a discovered one
   * is remembered as hidden. From the outside they are the same act, and making
   * the caller know which kind it is holding would leak this file's internals
   * into every button.
   */
  remove(id: string): void {
    this.ensureLoaded();
    const before = this.pinned.length;
    this.pinned = this.pinned.filter((p) => p.id !== id);
    if (this.pinned.length === before) this.hidden.add(id);
    this.named.delete(id);
    this.order = this.order.filter((o) => o !== id);
    this.persist();
  }

  /** Put a hidden discovered place back. */
  restore(id: string): void {
    this.ensureLoaded();
    if (this.hidden.delete(id)) this.persist();
  }

  hiddenIds(): string[] {
    this.ensureLoaded();
    return [...this.hidden];
  }

  /** Rename a row. An empty name puts the original back. */
  rename(id: string, name: string): void {
    this.ensureLoaded();
    const trimmed = name.trim();
    if (trimmed === "") this.named.delete(id);
    else this.named.set(id, trimmed);
    this.persist();
  }

  /**
   * Move a place one step up or down among its own kind.
   *
   * `resolve` is given so this can work in terms of what is on screen. The order
   * is stored as a list of ids over the *resolved* sidebar, which means a pin
   * that is currently hidden — a drive that is unplugged — keeps its position
   * for when it comes back rather than being shuffled to the end.
   */
  move(id: string, delta: number, current: readonly Place[]): void {
    this.ensureLoaded();
    const kind = current.find((p) => p.id === id)?.icon === "drive" ? "drive" : "folder";
    const group = current.filter((p) => (p.icon === "drive" ? "drive" : "folder") === kind);
    const at = group.findIndex((p) => p.id === id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= group.length) return;
    const ids = group.map((p) => p.id);
    const [held] = ids.splice(at, 1);
    ids.splice(to, 0, held!);

    // Written back as: everything already ordered that is not in this group,
    // then this group in its new order. Ids from the other group keep whatever
    // position they had.
    const others = this.order.filter((o) => !ids.includes(o));
    this.order = [...others, ...ids];
    this.persist();
  }

  /** True when this folder is already a row in the sidebar. */
  has(path: string, current: readonly Place[]): boolean {
    const key = keyOf(path);
    return current.some((p) => p.path !== undefined && keyOf(p.path) === key);
  }

  /** Back to whatever the machine reports, in the machine's order. */
  reset(): void {
    this.ensureLoaded();
    this.pinned = [];
    this.hidden.clear();
    this.order = [];
    this.named.clear();
    this.persist();
  }

  /** Whether anything has been changed at all — for the settings "changed" dot. */
  touched(): boolean {
    this.ensureLoaded();
    return (
      this.pinned.length > 0 || this.hidden.size > 0 || this.order.length > 0 || this.named.size > 0
    );
  }

  // ── internals ──

  /**
   * Anything named in `order` first, in that order; everything else keeps the
   * position it arrived in, after. A partial order is the point: pinning a
   * folder must not renumber the whole sidebar, and a machine that reports a new
   * drive should show it rather than dropping it for being unknown.
   */
  private sorted(list: Place[]): Place[] {
    const rank = new Map(this.order.map((id, i) => [id, i]));
    return list
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        const ra = rank.get(a.p.id);
        const rb = rank.get(b.p.id);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return a.i - b.i;
      })
      .map((x) => x.p);
  }

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

    if (Array.isArray(d.pinned)) {
      for (const raw of d.pinned) {
        const p = raw as Partial<UserPlace> | null;
        // A pin with no path is a row that goes nowhere; there is nothing to
        // salvage, so it is dropped rather than repaired into a dead button.
        if (typeof p?.path !== "string" || p.path.trim() === "") continue;
        this.pinned.push({
          id: typeof p.id === "string" && p.id !== "" ? p.id : idFor(p.path),
          name: typeof p.name === "string" && p.name.trim() !== "" ? p.name : nameFor(p.path),
          path: p.path,
          icon: typeof p.icon === "string" && p.icon !== "" ? p.icon : "folder",
        });
      }
    }
    if (Array.isArray(d.hidden)) {
      for (const id of d.hidden) if (typeof id === "string" && id !== "") this.hidden.add(id);
    }
    if (Array.isArray(d.order)) {
      for (const id of d.order) if (typeof id === "string" && id !== "") this.order.push(id);
    }
    if (typeof d.named === "object" && d.named !== null) {
      for (const [id, name] of Object.entries(d.named)) {
        if (typeof name === "string" && name.trim() !== "") this.named.set(id, name);
      }
    }
  }

  private persist(): void {
    try {
      this.backend.write(
        JSON.stringify({
          version: 1,
          pinned: this.pinned,
          hidden: [...this.hidden],
          order: this.order,
          named: Object.fromEntries(this.named),
        } satisfies Persisted),
      );
    } catch {
      /* see `browserPlaces` — the change still applies for this run */
    }
  }
}
