/**
 * Actions you write yourself (item 39).
 *
 * The right-click menu is assembled from the same `commands()` list the palette
 * uses — one registry, so a thing can never be in one and missing from the
 * other. This file is what lets that list grow past what FACET ships: a user
 * action is a program, a line of arguments, and the kinds of file it applies to.
 * It surfaces as an ordinary command with the id `act:<id>`, which means the
 * menu builder, the palette and the keyboard editor all pick it up without any
 * of them knowing that user actions exist.
 *
 * **The argument line is parsed here, never handed to a shell.** `cmd /c` and
 * `sh -c` turn a filename containing `&`, a backtick or a quote into somebody
 * else's command, and every folder on this machine is full of filenames nobody
 * chose. So the line is split into argv here, `{tokens}` are substituted into
 * the resulting words *after* splitting — a path containing a space cannot
 * become two arguments no matter what it contains — and Rust spawns the program
 * directly with that vector. See `run_program` in `src-tauri/src/fsx.rs`.
 *
 * The saved shape is `{version:1, actions:[…]}` and the store is defensive about
 * every field, for `rules.ts`'s reason: this file is small enough to hand-edit
 * and one bad character should not cost you the other nine actions.
 */

import type { FileEntry, FileKind } from "./types";

const KEY = "facet.actions";

/** As in `places.ts` — a list you build with a button wants a ceiling. */
const MAX_ACTIONS = 200;

/**
 * When a token expands to nothing.
 *
 * `{ext}` on a file with no extension is the ordinary case, and the word it sits
 * in still has to become *something* or the program's arguments shift left by
 * one and it acts on the wrong thing. An empty string keeps the position.
 */
const EMPTY = "";

export interface UserAction {
  id: string;
  /** What the menu row says. */
  label: string;
  /** The program. An absolute path, or a name on PATH. */
  program: string;
  /** One line, split like a command line: quotes group, whitespace separates. */
  args: string;
  /**
   * Which kinds it is offered for. Empty means anything.
   *
   * Stored as a list rather than a predicate because it has to survive being
   * written to a JSON file and read back by a version of the app that has not
   * been written yet.
   */
  kinds: FileKind[];
  /**
   * One run for the whole selection, or one run per file.
   *
   * The difference matters and cannot be guessed: `7z a out.zip {paths}` is one
   * run over forty files, and `magick {path} {stem}.png` is forty runs.
   */
  each: boolean;
}

interface Persisted {
  version: 1;
  actions: UserAction[];
}

export interface ActionsBackend {
  read(): string | null;
  write(text: string): void;
}

/** localStorage, every failure swallowed — see `settings/store.ts`. */
export function browserActions(): ActionsBackend {
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
        /* the action still runs this session */
      }
    },
  };
}

export function memoryActions(seed: string | null = null): ActionsBackend {
  let value = seed;
  return { read: () => value, write: (text) => { value = text; } };
}

/** Every token the argument line understands, and what it means. */
export const TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["path", "the full path of the file"],
  ["paths", "every selected file, as separate arguments"],
  ["name", "file name with its extension"],
  ["stem", "file name without its extension"],
  ["ext", "the extension, no dot"],
  ["dir", "the folder the file is in"],
  ["folder", "the folder you are looking at"],
];

const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKENS.map(([t]) => t));

/** The command id an action appears under. Also its key in the menu line. */
export function commandIdFor(action: UserAction): string {
  return `act:${action.id}`;
}

/**
 * Split a command line into words.
 *
 * Double quotes group and are removed; a quote inside a word ends the group, as
 * a shell does, so `--out="{dir}/x"` is one word. Backslash is *not* an escape:
 * on the platform this ships on it is the path separator, and treating
 * `C:\Users` as an escape sequence would break far more lines than it would
 * rescue. To pass a literal quote, there is no way — and no program worth
 * calling needs one.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let word = "";
  let quoted = false;
  let started = false;

  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      // A quote is itself the start of a word, so `""` is an empty argument
      // rather than nothing at all — some programs are given one deliberately.
      started = true;
      continue;
    }
    if (!quoted && (ch === " " || ch === "\t")) {
      if (started) out.push(word);
      word = "";
      started = false;
      continue;
    }
    word += ch;
    started = true;
  }
  if (started) out.push(word);
  return out;
}

/** What a token expands to, for one file. */
export interface ActionContext {
  /** The file this run is about. Absent when the action is folder-wide. */
  path?: string;
  /** Everything selected. `{paths}` expands to all of these. */
  paths: readonly string[];
  /** The folder on screen. */
  folder: string;
}

function stemOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

function baseOf(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  return cut >= 0 ? clean.slice(cut + 1) : clean;
}

function dirOf(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  return cut > 0 ? clean.slice(0, cut) : clean;
}

/**
 * Substitute the tokens in one already-split word, for one file.
 *
 * Substitution happens *after* splitting and never re-splits, which is the
 * whole safety property: a path containing a space, a quote or an `&` lands in
 * exactly one argv slot no matter what it contains.
 */
function expandWord(word: string, ctx: ActionContext): string {
  if (!word.includes("{")) return word;
  const path = ctx.path;
  return word.replace(/\{(\w+)\}/g, (whole, token: string) => {
    switch (token) {
      case "path":
        return path ?? EMPTY;
      case "name":
        return path === undefined ? EMPTY : baseOf(path);
      case "stem":
        return path === undefined ? EMPTY : stemOf(baseOf(path));
      case "ext": {
        if (path === undefined) return EMPTY;
        const base = baseOf(path);
        const i = base.lastIndexOf(".");
        return i <= 0 ? EMPTY : base.slice(i + 1);
      }
      case "dir":
        return path === undefined ? EMPTY : dirOf(path);
      case "folder":
        return ctx.folder;
      default:
        // Unknown tokens are left exactly as typed. `problemWith` refuses to
        // save one, so anything reaching here came from a hand-edited file, and
        // passing `{whatever}` through to the program is a great deal easier to
        // diagnose than silently deleting it.
        return whole;
    }
  });
}

/**
 * The whole argv for one run — the split line with every token substituted.
 *
 * `{paths}` is the one token that is not a string: the word holding it becomes
 * one argument per selected file, with the rest of the word repeated around
 * each. That is why `--file={paths}` works and joining them with spaces would
 * not — joined, the program receives a single argument that happens to contain
 * spaces, and acts on nothing.
 */
export function buildArgs(action: UserAction, ctx: ActionContext): string[] {
  const out: string[] = [];
  for (const word of splitArgs(action.args)) {
    if (word.includes("{paths}")) {
      // Rewritten to `{path}` and expanded once per file, so the other tokens
      // in the same word ({stem}, {ext}) belong to the file that copy is about.
      const per = word.replace(/\{paths\}/g, "{path}");
      for (const p of ctx.paths) out.push(expandWord(per, { ...ctx, path: p }));
      continue;
    }
    out.push(expandWord(word, ctx));
  }
  return out;
}

/**
 * Why this action cannot be saved yet, phrased for the person who typed it, or
 * null when it is fine.
 *
 * The unknown-token check earns its place: `{filename}` is the obvious thing to
 * type, it is not a token, and without this it would reach the program
 * literally and the failure would be the program's error message about a file
 * called `{filename}` — which nobody reads as a typo in FACET.
 */
export function problemWith(action: UserAction): string | null {
  if (action.label.trim() === "") return "Give it a name — that is what the menu row says.";
  if (action.program.trim() === "") return "Say which program to run.";
  const bad: string[] = [];
  for (const m of action.args.matchAll(/\{(\w+)\}/g)) {
    const token = m[1] ?? "";
    if (!TOKEN_NAMES.has(token) && !bad.includes(token)) bad.push(token);
  }
  if (bad.length > 0) {
    return `${bad.map((t) => `{${t}}`).join(", ")} ${bad.length === 1 ? "is not a token" : "are not tokens"}. Try ${TOKENS.map(([t]) => `{${t}}`).join(", ")}.`;
  }
  return null;
}

/** Whether this action is offered for what is selected right now. */
export function appliesTo(action: UserAction, selection: readonly FileEntry[]): boolean {
  if (selection.length === 0) return false;
  if (action.kinds.length === 0) return true;
  // Every selected file has to qualify, not just one. An action that ran on
  // three of the eight things you had highlighted would be a surprise, and the
  // menu says nothing about which three.
  return selection.every((e) => action.kinds.includes(e.kind));
}

export class ActionsStore {
  private actions: UserAction[] = [];
  private loaded = false;
  private nextId = 1;

  constructor(private readonly backend: ActionsBackend = browserActions()) {}

  all(): readonly UserAction[] {
    this.ensureLoaded();
    return this.actions;
  }

  get(id: string): UserAction | undefined {
    this.ensureLoaded();
    return this.actions.find((a) => a.id === id);
  }

  /** A blank action, appended, so the editor always has a row to fill in. */
  add(seed: Partial<UserAction> = {}): UserAction {
    this.ensureLoaded();
    const action: UserAction = {
      id: this.freshId(),
      label: seed.label ?? "",
      program: seed.program ?? "",
      args: seed.args ?? "{path}",
      kinds: [...(seed.kinds ?? [])],
      each: seed.each ?? true,
    };
    this.actions.push(action);
    while (this.actions.length > MAX_ACTIONS) this.actions.shift();
    this.persist();
    return action;
  }

  /**
   * Saved on every keystroke, including while it is still incomplete.
   *
   * A half-typed action is not offered — `runnable` filters on `problemWith` —
   * but it is *kept*, because closing the sheet to go and find the path of the
   * program is the normal way to fill this in, and an editor that throws the
   * work away for being unfinished is one nobody uses twice.
   */
  update(id: string, patch: Partial<Omit<UserAction, "id">>): void {
    this.ensureLoaded();
    const a = this.actions.find((x) => x.id === id);
    if (a === undefined) return;
    if (patch.label !== undefined) a.label = patch.label;
    if (patch.program !== undefined) a.program = patch.program;
    if (patch.args !== undefined) a.args = patch.args;
    if (patch.kinds !== undefined) a.kinds = [...patch.kinds];
    if (patch.each !== undefined) a.each = patch.each;
    this.persist();
  }

  remove(id: string): void {
    this.ensureLoaded();
    const i = this.actions.findIndex((a) => a.id === id);
    if (i < 0) return;
    this.actions.splice(i, 1);
    this.persist();
  }

  move(id: string, delta: number): void {
    this.ensureLoaded();
    const i = this.actions.findIndex((a) => a.id === id);
    if (i < 0) return;
    const to = i + delta;
    if (to < 0 || to >= this.actions.length) return;
    const [item] = this.actions.splice(i, 1);
    if (item !== undefined) this.actions.splice(to, 0, item);
    this.persist();
  }

  /** The ones complete enough to offer. */
  runnable(): readonly UserAction[] {
    return this.all().filter((a) => problemWith(a) === null);
  }

  reset(): void {
    this.ensureLoaded();
    this.actions = [];
    this.persist();
  }

  touched(): boolean {
    return this.all().length > 0;
  }

  // ── internals ──

  /**
   * Ids are `a1`, `a2`… and never reused, because the menu order is a line of
   * ids: reusing the id of a deleted action would silently move a new action
   * into the deleted one's place in the menu.
   */
  private freshId(): string {
    let id = `a${this.nextId++}`;
    while (this.actions.some((a) => a.id === id)) id = `a${this.nextId++}`;
    return id;
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
    if (!Array.isArray(d.actions)) return;

    for (const raw of d.actions) {
      const a = raw as Partial<UserAction> | null;
      if (typeof a?.id !== "string" || a.id.trim() === "") continue;
      if (this.actions.some((x) => x.id === a.id)) continue;
      this.actions.push({
        id: a.id,
        label: typeof a.label === "string" ? a.label : "",
        program: typeof a.program === "string" ? a.program : "",
        args: typeof a.args === "string" ? a.args : "",
        kinds: Array.isArray(a.kinds)
          ? (a.kinds.filter((k) => typeof k === "string") as FileKind[])
          : [],
        each: a.each !== false,
      });
      const n = Number(/^a(\d+)$/.exec(a.id)?.[1] ?? 0);
      if (n >= this.nextId) this.nextId = n + 1;
    }
  }

  private persist(): void {
    try {
      this.backend.write(
        JSON.stringify({ version: 1, actions: this.actions } satisfies Persisted),
      );
    } catch {
      /* see `browserActions` */
    }
  }
}
