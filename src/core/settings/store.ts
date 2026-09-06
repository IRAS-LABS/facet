/**
 * The one place a setting is read from or written to (item 33).
 *
 * Three decisions worth defending, because each one is the kind of thing that
 * looks like a detail and turns into a bug report months later:
 *
 * **Only non-default values are stored.** The file holds what you changed, not
 * what FACET currently believes. If it stored everything, then the day a
 * default improves — a bigger preview budget, a better decode lane count —
 * every existing user would keep the old value forever, having never chosen
 * it. Storing the diff means a default change reaches everyone who never had
 * an opinion, and nobody who did.
 *
 * **Nothing here throws.** A settings store that can throw is a settings store
 * that can stop the app from starting, and a preference is never worth that. A
 * missing file, a truncated file, a file full of the wrong types, a
 * localStorage that is full or disabled — all of them end the same way: the
 * defaults, and the app comes up.
 *
 * **Changes are live by default.** `restart: true` exists in the schema, but it
 * is meant to stay rare. A setting that needs a restart is a setting whose
 * reader cached it at boot, and that is nearly always fixable by reading it
 * when it is used instead. The flag is for the genuine cases, not a licence.
 */

import { coerce, type Setting, type SettingValue } from "./schema";

/**
 * One key holding one JSON object.
 *
 * A key per setting would avoid parsing the lot on every read, but item 42
 * ("import/export settings, one file, portable between machines") wants a
 * single document anyway, and the whole store is a few hundred bytes.
 */
const KEY = "facet.settings";

/** The shape on disk. Versioned so a future migration has somewhere to hook. */
interface Persisted {
  version: 1;
  values: Record<string, SettingValue>;
}

type Listener = (id: string, value: SettingValue) => void;

/**
 * Somewhere to put values. Real code passes `localStorage`; the harness passes
 * a map, and the Android build could pass a file-backed shim without any of
 * this changing.
 */
export interface SettingsBackend {
  read(): string | null;
  write(text: string): void;
}

/** localStorage, with every failure mode swallowed. */
export function browserBackend(): SettingsBackend {
  return {
    read() {
      try {
        return localStorage.getItem(KEY);
      } catch {
        // Private-mode and disabled-storage both land here.
        return null;
      }
    },
    write(text) {
      try {
        localStorage.setItem(KEY, text);
      } catch {
        // Quota, or storage disabled. The in-memory values still apply for
        // this run; they just will not survive it. Losing a preference is not
        // worth an error dialog.
      }
    },
  };
}

/** A backend that keeps everything in memory. For tests, and for a --private run. */
export function memoryBackend(initial: string | null = null): SettingsBackend {
  let text = initial;
  return {
    read: () => text,
    write: (t) => {
      text = t;
    },
  };
}

export class SettingsStore {
  private readonly defs = new Map<string, Setting>();
  /** Only what differs from the default. See the note at the top. */
  private readonly values = new Map<string, SettingValue>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly any = new Set<Listener>();
  private loaded = false;

  constructor(private readonly backend: SettingsBackend = browserBackend()) {}

  /**
   * Declare settings. Safe to call repeatedly as modules come up.
   *
   * Registering the same id twice is a programming error rather than a user
   * one — two modules fighting over one id would make the last writer win
   * silently — so it is reported, but it still does not throw: a duplicated
   * declaration must not be able to stop the app from starting.
   */
  register(...settings: Setting[]): void {
    for (const s of settings) {
      if (this.defs.has(s.id)) {
        console.warn(`settings: ${s.id} declared twice; keeping the first`);
        continue;
      }
      this.defs.set(s.id, s);
    }
    // A value may already be sitting in the file for a setting that had not
    // been declared when the file was read. Re-coerce now that we know its
    // type — otherwise a perfectly good stored value would be ignored.
    if (this.loaded) this.recoerce(settings);
  }

  /** Every declared setting, in declaration order. */
  all(): Setting[] {
    return [...this.defs.values()];
  }

  /** The groups that exist, in the order their first setting was declared. */
  groups(): string[] {
    const seen: string[] = [];
    for (const s of this.defs.values()) if (!seen.includes(s.group)) seen.push(s.group);
    return seen;
  }

  definition(id: string): Setting | undefined {
    return this.defs.get(id);
  }

  /**
   * The current value.
   *
   * Reading an id that was never declared returns `undefined` rather than
   * throwing, and callers are expected to have declared their own settings, so
   * in practice the generic is honest.
   */
  get<T extends SettingValue>(id: string): T {
    this.ensureLoaded();
    const def = this.defs.get(id);
    if (!def) {
      console.warn(`settings: read of undeclared ${id}`);
      return undefined as unknown as T;
    }
    return (this.values.has(id) ? this.values.get(id)! : def.default) as T;
  }

  /** Whether this id has been changed from its default. */
  isSet(id: string): boolean {
    this.ensureLoaded();
    return this.values.has(id);
  }

  /**
   * Change a value. Coerced, persisted, and announced.
   *
   * Setting a value equal to the default *removes* it from the store rather
   * than recording it, which keeps the file a true diff — otherwise toggling a
   * switch on and off again would pin its current default forever.
   */
  set(id: string, raw: unknown): void {
    this.ensureLoaded();
    const def = this.defs.get(id);
    if (!def) {
      console.warn(`settings: write to undeclared ${id}`);
      return;
    }
    const value = coerce(def, raw);
    const before = this.values.has(id) ? this.values.get(id)! : def.default;
    if (value === def.default) this.values.delete(id);
    else this.values.set(id, value);
    if (value !== before) {
      this.persist();
      this.announce(id, value);
    } else {
      // The value did not change but its stored-ness might have (setting it
      // back to the default), so the file still needs writing.
      this.persist();
    }
  }

  /** Put one setting back to its default. */
  reset(id: string): void {
    this.ensureLoaded();
    const def = this.defs.get(id);
    if (!def) return;
    if (!this.values.has(id)) return;
    this.values.delete(id);
    this.persist();
    this.announce(id, def.default);
  }

  /** Put a whole group back. The panel's per-group reset button. */
  resetGroup(group: string): void {
    this.ensureLoaded();
    for (const s of this.defs.values()) if (s.group === group) this.reset(s.id);
  }

  /** Put everything back. */
  resetAll(): void {
    this.ensureLoaded();
    for (const id of [...this.values.keys()]) this.reset(id);
  }

  /**
   * Watch one setting. Returns the unsubscribe.
   *
   * Fires only on an actual change of value, so a listener can be as expensive
   * as it needs to be without being defended against no-op writes.
   */
  on(id: string, fn: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Watch everything — what the panel uses to keep itself in step. */
  onAny(fn: Listener): () => void {
    this.any.add(fn);
    return () => this.any.delete(fn);
  }

  /**
   * The whole store as portable JSON (item 42).
   *
   * Pretty-printed because the point of exporting is that a person can look at
   * it, and it is small enough that the bytes do not matter.
   */
  export(): string {
    this.ensureLoaded();
    const values: Record<string, SettingValue> = {};
    // Sorted so two exports of the same settings are byte-identical and can be
    // diffed or kept in version control.
    for (const id of [...this.values.keys()].sort()) values[id] = this.values.get(id)!;
    return JSON.stringify({ version: 1, values } satisfies Persisted, null, 2);
  }

  /**
   * Replace everything with an exported document.
   *
   * Returns what happened rather than throwing, because the caller — a file
   * picker — needs to tell the user, and "nothing was applied" and "most of it
   * was applied" are different sentences. Unknown ids are *kept* rather than
   * dropped: importing a file from a newer build should not quietly discard
   * the settings this build has not learned about yet, and `register` will
   * pick them up if that module ever loads.
   */
  import(text: string): { applied: number; skipped: number; ok: boolean } {
    this.ensureLoaded();
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return { applied: 0, skipped: 0, ok: false };
    }
    if (!isPersisted(doc)) return { applied: 0, skipped: 0, ok: false };

    const before = new Map(this.values);
    this.values.clear();
    let applied = 0;
    let skipped = 0;
    for (const [id, raw] of Object.entries(doc.values)) {
      const def = this.defs.get(id);
      if (!def) {
        this.values.set(id, raw);
        skipped++;
        continue;
      }
      const value = coerce(def, raw);
      if (value !== def.default) this.values.set(id, value);
      applied++;
    }
    this.persist();

    // Announce everything that actually moved, in either direction, so live
    // readers catch up. Comparing against the snapshot rather than firing for
    // every id keeps an import from re-rendering the world.
    const touched = new Set([...before.keys(), ...this.values.keys()]);
    for (const id of touched) {
      const def = this.defs.get(id);
      if (!def) continue;
      const now = this.values.has(id) ? this.values.get(id)! : def.default;
      const was = before.has(id) ? before.get(id)! : def.default;
      if (now !== was) this.announce(id, now);
    }
    return { applied, skipped, ok: true };
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
      // A truncated or hand-mangled file. Defaults, and the next write fixes it.
      return;
    }
    if (!isPersisted(doc)) return;
    for (const [id, raw] of Object.entries(doc.values)) {
      const def = this.defs.get(id);
      // Undeclared ids are kept verbatim — the module that owns them may not
      // have loaded yet. `register` re-coerces them when it does.
      if (!def) {
        this.values.set(id, raw);
        continue;
      }
      const value = coerce(def, raw);
      if (value !== def.default) this.values.set(id, value);
    }
  }

  /** Re-check stored values against newly arrived declarations. */
  private recoerce(settings: Setting[]): void {
    for (const def of settings) {
      if (!this.values.has(def.id)) continue;
      const value = coerce(def, this.values.get(def.id));
      if (value === def.default) this.values.delete(def.id);
      else this.values.set(def.id, value);
    }
  }

  private announce(id: string, value: SettingValue): void {
    for (const fn of this.listeners.get(id) ?? []) fn(id, value);
    for (const fn of this.any) fn(id, value);
  }

  private persist(): void {
    const values: Record<string, SettingValue> = {};
    for (const [id, v] of this.values) values[id] = v;
    try {
      this.backend.write(JSON.stringify({ version: 1, values } satisfies Persisted));
    } catch {
      // `browserBackend` already swallows its own failures; this catches the
      // ones a different backend can raise — a file-backed shim on Android, a
      // read-only volume. The values still apply for this run. The store's
      // contract is that it never throws, and that has to hold for every
      // backend, not just the one written alongside it.
    }
  }
}

function isPersisted(doc: unknown): doc is Persisted {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  if (d.version !== 1) return false;
  return typeof d.values === "object" && d.values !== null && !Array.isArray(d.values);
}

/** The store the app uses. Tests build their own. */
export const settings = new SettingsStore();
