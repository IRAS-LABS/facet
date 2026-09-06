/**
 * The keyboard map (item 35).
 *
 * Every shortcut FACET has is declared here as data — id, label, group, the
 * chord it ships with — and the shell asks this module "what did the user just
 * press", never "was that ctrl and K". That inversion is the whole feature:
 * rebinding is then a value in a map rather than an edit to a handler, and the
 * editor in `ui/keys.ts` is generated from the declarations the same way the
 * settings panel is generated from `core/settings/registry.ts`.
 *
 * Three things it is careful about, each of which is a way for a rebindable
 * keymap to be worse than a fixed one:
 *
 *  - **One function decides what a key event is called.** `chordOf` is used
 *    both to capture a new binding and to match a live keypress, so whatever
 *    the browser reports for a key on this keyboard layout — `<` for shift and
 *    comma, `Dead` for an accent key — captures and matches identically. A
 *    keymap that normalises differently in those two places binds keys the user
 *    can then never press.
 *  - **Nothing is stored that was not changed.** Same discipline as the
 *    settings store: the file is a diff, so a default that turns out to be
 *    wrong can still be improved for everyone who never rebound it.
 *  - **A conflict is shown, not resolved.** Two commands on one chord is a
 *    legitimate thing to do on the way to a rearrangement, so binding is never
 *    refused; the second one simply never fires, and both rows say so. Silently
 *    unbinding the other command is how you lose a shortcut you did not know
 *    you were replacing.
 *
 * Scope is deliberately coarse — "always" or "explorer". A surface (the viewer,
 * the player, an editor) owns the keyboard while it is up, so a shortcut that
 * navigates the folder underneath it must not fire; but the ones that get you
 * *out* of somewhere have to work from on top of it. Anything finer would be a
 * per-surface mode system, which is a great deal of machinery for a distinction
 * nobody has asked to make.
 */

export interface KeyCommand {
  /** Stable id. Also what `match` returns and what the shell switches on. */
  id: string;
  label: string;
  group: string;
  /** The chord it ships with, in `chordOf` form. Empty means unbound. */
  default: string;
  scope: "always" | "explorer";
  /**
   * Extra chords that fire the same command *while it is at its default*.
   *
   * This exists for exactly one honest reason: `+` needs shift on most
   * keyboards and `=` is the key it lives on, so "zoom in" has always answered
   * to both. Aliases are dropped the moment the command is rebound, because
   * after that the user's answer to "what zooms in" is the one on the screen.
   */
  alias?: readonly string[];
  /** Searched by the editor, alongside the label and the group. */
  keywords?: readonly string[];
}

const KEY = "facet.keys";

/** Somewhere to put the overrides. The harness passes its own. */
export interface KeyBackend {
  read(): string | null;
  write(text: string): void;
}

/** localStorage, with every failure mode swallowed — see `settings/store.ts`. */
export function browserKeys(): KeyBackend {
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
        /* private mode, quota, disabled — a lost rebind is not worth a crash */
      }
    },
  };
}

export function memoryKeys(seed: string | null = null): KeyBackend {
  let value = seed;
  return { read: () => value, write: (text) => { value = text; } };
}

interface Persisted {
  version: 1;
  keys: Record<string, string>;
}

/** Printable-name overrides. Everything else is used as the browser reports it. */
const NAMES: Record<string, string> = {
  " ": "Space",
  Escape: "Esc",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Delete: "Del",
};

/**
 * What to call a key event.
 *
 * Meta is folded into Ctrl on purpose: FACET ships on Windows and Android, the
 * shell has always accepted either, and a map that distinguishes them would
 * show a Mac user two rows for one shortcut on a machine that has no Ctrl key
 * worth binding.
 *
 * Returns "" for a modifier pressed on its own — holding shift is not a chord,
 * and the editor's capture must not record it as one.
 */
export function chordOf(e: KeyboardEvent): string {
  const k = e.key;
  if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta" || k === "OS") return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  // Shift is recorded only when it is not already visible in the key itself:
  // shift and `1` reports "!", and "Shift+!" is a chord nobody can type.
  if (e.shiftKey && (k.length > 1 || /[a-z]/i.test(k))) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k));
  return parts.join("+");
}

/** True when a chord can be pressed without a modifier — see `match`. */
function bare(chord: string): boolean {
  return !chord.startsWith("Ctrl+") && !chord.startsWith("Alt+") && !chord.includes("+Alt+");
}

export class KeyMap {
  private readonly cmds = new Map<string, KeyCommand>();
  private readonly bound = new Map<string, string>();
  private readonly listeners: (() => void)[] = [];
  private loaded = false;

  constructor(private readonly backend: KeyBackend = browserKeys()) {}

  register(...cmds: KeyCommand[]): void {
    for (const c of cmds) {
      if (this.cmds.has(c.id)) {
        console.warn(`keys: ${c.id} declared twice`);
        continue;
      }
      this.cmds.set(c.id, c);
    }
  }

  all(): KeyCommand[] {
    return [...this.cmds.values()];
  }

  groups(): string[] {
    const seen: string[] = [];
    for (const c of this.cmds.values()) if (!seen.includes(c.group)) seen.push(c.group);
    return seen;
  }

  command(id: string): KeyCommand | undefined {
    return this.cmds.get(id);
  }

  /** The chord in force. "" means the command has been deliberately unbound. */
  chord(id: string): string {
    this.ensureLoaded();
    const custom = this.bound.get(id);
    if (custom !== undefined) return custom;
    return this.cmds.get(id)?.default ?? "";
  }

  /** Whether this command has been rebound from what it shipped with. */
  isSet(id: string): boolean {
    this.ensureLoaded();
    return this.bound.has(id);
  }

  /**
   * Rebind. An empty chord unbinds; binding back to the default *removes* the
   * override rather than recording it, so the file stays a true diff.
   */
  bind(id: string, chord: string): void {
    this.ensureLoaded();
    const def = this.cmds.get(id);
    if (!def) {
      console.warn(`keys: rebind of undeclared ${id}`);
      return;
    }
    if (chord === def.default) this.bound.delete(id);
    else this.bound.set(id, chord);
    this.persist();
    this.announce();
  }

  reset(id: string): void {
    this.ensureLoaded();
    if (!this.bound.has(id)) return;
    this.bound.delete(id);
    this.persist();
    this.announce();
  }

  resetAll(): void {
    this.ensureLoaded();
    if (this.bound.size === 0) return;
    this.bound.clear();
    this.persist();
    this.announce();
  }

  /** Any command that has been rebound. Drives the "changed" dot. */
  get changed(): boolean {
    this.ensureLoaded();
    return this.bound.size > 0;
  }

  /**
   * Which command a key event runs, or null.
   *
   * `surface` means an editor, the player or the viewer is up and owns the
   * keyboard; `typing` means focus is in a field. A bare letter must not fire a
   * command while someone is typing a filename, but a modified chord still
   * should — Ctrl+K is how you leave the field you are stuck in.
   */
  match(e: KeyboardEvent, ctx: { surface?: boolean; typing?: boolean } = {}): string | null {
    this.ensureLoaded();
    const chord = chordOf(e);
    if (chord === "") return null;
    if (ctx.typing === true && bare(chord)) return null;
    for (const c of this.cmds.values()) {
      if (c.scope === "explorer" && ctx.surface === true) continue;
      const now = this.chord(c.id);
      if (now === "") continue;
      const hit = now === chord || (!this.isSet(c.id) && (c.alias?.includes(chord) ?? false));
      if (hit) return c.id;
    }
    return null;
  }

  /**
   * Other commands this chord would collide with.
   *
   * Two "explorer" commands collide with each other; anything "always" collides
   * with everything, because it fires in the explorer too.
   */
  conflicts(chord: string, id: string): KeyCommand[] {
    this.ensureLoaded();
    if (chord === "") return [];
    const mine = this.cmds.get(id);
    if (!mine) return [];
    const out: KeyCommand[] = [];
    for (const c of this.cmds.values()) {
      if (c.id === id) continue;
      if (this.chord(c.id) !== chord) continue;
      if (mine.scope === "explorer" && c.scope === "explorer") out.push(c);
      else if (mine.scope === "always" || c.scope === "always") out.push(c);
    }
    return out;
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  /** Everything overridden, as the file holds it. For item 42's backup. */
  export(): Record<string, string> {
    this.ensureLoaded();
    return Object.fromEntries(this.bound);
  }

  private announce(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        console.warn("keys: a listener threw", err);
      }
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let text: string | null = null;
    try {
      text = this.backend.read();
    } catch {
      return;
    }
    if (text === null || text === "") return;
    try {
      const parsed = JSON.parse(text) as Partial<Persisted>;
      const keys = parsed.keys;
      if (typeof keys !== "object" || keys === null) return;
      for (const [id, chord] of Object.entries(keys)) {
        // A chord for a command this build no longer has is kept out of the map
        // but not thrown away — see `persist`. A string is the only shape that
        // could have come from us; anything else is a hand-edit or a bad file.
        if (typeof chord === "string") this.bound.set(id, chord);
      }
    } catch {
      // A broken file costs the rebinds and nothing else. The defaults are all
      // still there, which is the point of storing only the diff.
      console.warn("keys: the keymap file could not be read; using the defaults");
    }
  }

  private persist(): void {
    try {
      this.backend.write(
        JSON.stringify({ version: 1, keys: Object.fromEntries(this.bound) } satisfies Persisted),
      );
    } catch (err) {
      console.warn("keys: could not save the keymap", err);
    }
  }
}

/** The one the app uses. The harness builds its own over `memoryKeys()`. */
export const keys = new KeyMap();
