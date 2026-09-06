/**
 * The watcher (item 27) — the thing that notices, and decides when to act.
 *
 * It polls. There is a `notify`-style OS watch available on the Rust side and
 * it would fire sooner, but it would not answer the question that actually
 * matters here, which is not *when did this file appear* but **when did it stop
 * changing**. A 4 GB video dropped into a watch folder appears the instant the
 * copy starts, at zero bytes, and grows for two minutes. An OS event fires on
 * the create and again on every write; either way something has to sit there
 * watching the size settle before handing the file to ffmpeg. Polling does that
 * directly and costs one directory listing every few seconds.
 *
 * Three properties this thing lives or dies by:
 *
 * 1. **A new watch folder fires on nothing.** Turning a rule on over a folder
 *    that already holds four hundred photos must not queue four hundred jobs.
 *    The first sweep silently adopts whatever is already there; there is an
 *    explicit "run it on what's already here" for when that is what you meant.
 *
 * 2. **A file fires only once it is stable.** Same size across `settle`
 *    consecutive sweeps. Handing ffmpeg a file still being written produces a
 *    truncated output and a red row, and the user's copy still succeeds, so the
 *    evidence of what went wrong is gone by the time they look.
 *
 * 3. **Nothing we produced is ever a trigger.** A rename rule whose output
 *    lands back in the folder it watches would rename its own output forever.
 *    Outputs go into a `produced` set that persists and is only forgotten when
 *    the file itself is gone.
 */

import type { DirListing, FileEntry } from "@core/explorer/types";
import {
  isInside,
  matches,
  normaliseRule,
  samePath,
  taskFor,
  type TaskSpec,
  type WatchRule,
} from "./rules";

export interface WatchOptions {
  list(path: string): Promise<DirListing>;
  /** Hand a matched file to the batch queue. */
  enqueue(spec: TaskSpec): void;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  key?: string;
  now?: () => number;
  /** Milliseconds between sweeps. */
  interval?: number;
  /** Consecutive sweeps a file's size must hold before it fires. */
  settle?: number;
}

interface FolderState {
  /** Set once the folder's existing contents have been taken as the baseline. */
  adopted: boolean;
  /** Paths already dealt with. Pruned as files leave. */
  seen: Set<string>;
  /**
   * Paths this watcher itself created — the loop guard from the note above.
   *
   * The flag is "has this file actually turned up yet", and it is the whole
   * trick. A claim is made the instant a task is *queued*, which is minutes
   * before the file exists; pruning claims by absence the way `seen` is pruned
   * would throw every claim away on the very next sweep, and a rename rule
   * would go straight back to renaming its own output. So a claim is only
   * forgotten once the file has been seen at least once and then gone.
   */
  produced: Map<string, boolean>;
}

/** A file waiting to stop growing. In memory only — a size is not worth saving. */
interface Settling {
  size: number;
  ticks: number;
}

const KEY = "facet.watch.v1";
const INTERVAL = 4000;
const SETTLE = 2;
/** Per folder. A watch folder with more paths than this is not a watch folder. */
const MAX_SEEN = 5000;

export class WatchService {
  #rules: WatchRule[] = [];
  #folders = new Map<string, FolderState>();
  #settling = new Map<string, Settling>();
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #sweeping = false;
  #opts: Required<Omit<WatchOptions, "storage">> & {
    storage: Pick<Storage, "getItem" | "setItem"> | null;
  };
  #seq = 0;
  /** Last sweep's outcome, for the panel: "watching 2 folders · 3 queued". */
  #lastError = "";
  #lastSweep = 0;

  constructor(opts: WatchOptions) {
    this.#opts = {
      list: opts.list,
      enqueue: opts.enqueue,
      storage: opts.storage === undefined ? safeStorage() : opts.storage,
      key: opts.key ?? KEY,
      now: opts.now ?? ((): number => Date.now()),
      interval: opts.interval ?? INTERVAL,
      settle: Math.max(1, opts.settle ?? SETTLE),
    };
    this.#load();
  }

  // ── Rules ─────────────────────────────────────────────────────────────────

  rules(): readonly WatchRule[] {
    return this.#rules;
  }

  get(id: string): WatchRule | undefined {
    return this.#rules.find((r) => r.id === id);
  }

  addRule(rule: Omit<WatchRule, "id" | "fired" | "lastFired"> & { id?: string }): WatchRule {
    const full: WatchRule = {
      ...rule,
      id: rule.id ?? `w${++this.#seq}-${this.#opts.now().toString(36)}`,
      fired: 0,
      lastFired: 0,
    };
    this.#rules.push(full);
    this.#save();
    this.#emit();
    return full;
  }

  updateRule(id: string, patch: Partial<WatchRule>): void {
    const rule = this.get(id);
    if (!rule) return;
    Object.assign(rule, patch, { id: rule.id });
    // The folder may have moved. Whatever baseline the old one had is not this
    // one's, so it re-adopts rather than firing on a folder it has never seen.
    this.#save();
    this.#emit();
  }

  removeRule(id: string): void {
    this.#rules = this.#rules.filter((r) => r.id !== id);
    this.#gcFolders();
    this.#save();
    this.#emit();
  }

  /** Folders currently under watch, deduplicated — several rules may share one. */
  watched(): string[] {
    const out: string[] = [];
    for (const r of this.#rules) {
      if (!r.enabled) continue;
      if (!out.some((f) => samePath(f, r.folder))) out.push(r.folder);
    }
    return out;
  }

  // ── Running ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.sweep(), this.#opts.interval);
    void this.sweep();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Change the sweep period, live (item 43).
   *
   * Restarting the timer rather than waiting for the next tick, because the
   * reason anyone lowers this is a folder they are watching right now — and
   * the reason anyone raises it is a network drive that is already costing
   * them, which should stop costing them at once rather than in four seconds.
   * Does not sweep on the spot: `start()` does that, and re-sweeping on every
   * keystroke in a number field would hammer the disk being complained about.
   */
  setInterval(ms: number): void {
    this.#opts.interval = Math.max(1000, Math.round(ms));
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.sweep(), this.#opts.interval);
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  /** The sweep period actually in force, in ms — after clamping. */
  get interval(): number {
    return this.#opts.interval;
  }

  get lastError(): string {
    return this.#lastError;
  }

  get lastSweep(): number {
    return this.#lastSweep;
  }

  /**
   * One pass over every watched folder. Safe to call by hand; overlapping calls
   * are dropped rather than queued, because a sweep that takes longer than the
   * interval is a slow disk, and stacking sweeps on a slow disk makes it slower.
   */
  async sweep(): Promise<number> {
    if (this.#sweeping) return 0;
    this.#sweeping = true;
    let queued = 0;
    let error = "";
    try {
      for (const folder of this.watched()) {
        try {
          queued += await this.#sweepFolder(folder);
        } catch (e) {
          // One unreachable folder — an unplugged drive, a renamed directory —
          // must not stop the others. It is reported, not thrown.
          error = e instanceof Error ? e.message : String(e);
        }
      }
    } finally {
      this.#sweeping = false;
      this.#lastError = error;
      this.#lastSweep = this.#opts.now();
      if (queued > 0) this.#save();
      this.#emit();
    }
    return queued;
  }

  async #sweepFolder(folder: string): Promise<number> {
    const listing = await this.#opts.list(folder);
    const state = this.#state(folder);
    const present = new Set<string>();
    let queued = 0;

    for (const entry of listing.entries) {
      if (entry.kind === "folder") continue;
      present.add(entry.path);

      if (state.produced.has(entry.path)) {
        state.produced.set(entry.path, true); // it has arrived; now it may expire
        continue;
      }
      if (state.seen.has(entry.path)) continue;

      if (!state.adopted) continue; // handled below, in one go

      if (!this.#stable(entry)) continue;

      queued += this.#fire(folder, entry);
      state.seen.add(entry.path);
      this.#settling.delete(entry.path);
    }

    if (!state.adopted) {
      // The baseline. Everything here now is old news by definition.
      for (const p of present) state.seen.add(p);
      state.adopted = true;
    }

    // Forget files that have left. A file deleted and dropped back in is a new
    // file and should fire again — that is what re-dropping it means.
    prune(state.seen, present);
    // Only claims whose file has been and gone. A claim on something that has
    // not landed yet is the one thing standing between a rename rule and its
    // own output.
    for (const [path, arrived] of state.produced) {
      if (arrived && !present.has(path)) state.produced.delete(path);
    }
    for (const path of [...this.#settling.keys()]) {
      if (!present.has(path) && isInside(folder, path)) this.#settling.delete(path);
    }
    trim(state.seen, MAX_SEEN);

    return queued;
  }

  /** Enqueue every enabled rule on this folder that matches. */
  #fire(folder: string, entry: FileEntry): number {
    let queued = 0;
    for (const rule of this.#rules) {
      if (!samePath(rule.folder, folder)) continue;
      if (!matches(rule, entry)) continue;
      const spec = taskFor(rule, entry);
      if (!spec) continue;
      this.#opts.enqueue(spec);
      // Claimed before it exists. A move or rename lands back in a watched
      // folder within the second, and it must arrive already spoken for.
      if (spec.output) this.#claim(spec.output);
      rule.fired += 1;
      rule.lastFired = this.#opts.now();
      queued += 1;
    }
    return queued;
  }

  /** Mark a path as ours, in whichever watched folder it lands in. */
  #claim(path: string): void {
    for (const [folder, state] of this.#folders) {
      if (isInside(folder, path)) state.produced.set(path, false);
    }
  }

  /** Has this file held the same size long enough to be handed to an encoder? */
  #stable(entry: FileEntry): boolean {
    const size = entry.size ?? 0;
    const prev = this.#settling.get(entry.path);
    if (!prev || prev.size !== size) {
      this.#settling.set(entry.path, { size, ticks: 1 });
      return this.#opts.settle <= 1;
    }
    prev.ticks += 1;
    return prev.ticks >= this.#opts.settle;
  }

  /**
   * Run a rule over what is already in its folder, on purpose.
   *
   * The counterpart to silent adoption: adoption is the right default because
   * nobody wants four hundred jobs for turning a switch on, but "actually, do
   * the backlog too" is a real thing to want, and it should be a button rather
   * than a trick involving touching every file.
   */
  async applyNow(id: string): Promise<number> {
    const rule = this.get(id);
    if (!rule) return 0;
    const listing = await this.#opts.list(rule.folder);
    const state = this.#state(rule.folder);
    let queued = 0;
    for (const entry of listing.entries) {
      if (entry.kind === "folder") continue;
      if (state.produced.has(entry.path)) continue;
      if (!matches(rule, entry)) continue;
      const spec = taskFor(rule, entry);
      if (!spec) continue;
      this.#opts.enqueue(spec);
      if (spec.output) this.#claim(spec.output);
      state.seen.add(entry.path);
      rule.fired += 1;
      rule.lastFired = this.#opts.now();
      queued += 1;
    }
    state.adopted = true;
    this.#save();
    this.#emit();
    return queued;
  }

  /**
   * Forget a folder's baseline, so the next sweep treats everything in it as
   * new. The escape hatch for "it adopted files I wanted processed".
   */
  reset(folder: string): void {
    const state = this.#state(folder);
    state.seen.clear();
    // Deliberately *not* cleared, and this is the difference between resetting
    // a folder and deleting its state: forgetting what we produced would let
    // the rule fire on its own past output the moment it is told to look again.
    // `state.produced` stays.
    state.adopted = true;
    this.#save();
    this.#emit();
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #state(folder: string): FolderState {
    for (const [key, state] of this.#folders) {
      if (samePath(key, folder)) return state;
    }
    const fresh: FolderState = { adopted: false, seen: new Set(), produced: new Map() };
    this.#folders.set(folder, fresh);
    return fresh;
  }

  /** Drop the baseline of folders nothing watches any more. */
  #gcFolders(): void {
    const live = this.#rules.map((r) => r.folder);
    for (const key of [...this.#folders.keys()]) {
      if (!live.some((f) => samePath(f, key))) this.#folders.delete(key);
    }
  }

  #emit(): void {
    for (const cb of this.#listeners) cb();
  }

  #save(): void {
    const store = this.#opts.storage;
    if (!store) return;
    try {
      const folders: Record<
        string,
        { adopted: boolean; seen: string[]; produced: [string, boolean][] }
      > = {};
      for (const [key, state] of this.#folders) {
        folders[key] = {
          adopted: state.adopted,
          seen: [...state.seen],
          produced: [...state.produced],
        };
      }
      store.setItem(
        this.#opts.key,
        JSON.stringify({ v: 1, seq: this.#seq, rules: this.#rules, folders }),
      );
    } catch {
      /* A full or disabled store must not take the watcher down with it. */
    }
  }

  #load(): void {
    const store = this.#opts.storage;
    if (!store) return;
    let raw: string | null = null;
    try {
      raw = store.getItem(this.#opts.key);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const rules = Array.isArray(data["rules"]) ? data["rules"] : [];
      for (const r of rules) {
        const rule = normaliseRule(r);
        if (rule) this.#rules.push(rule);
      }
      this.#seq = typeof data["seq"] === "number" ? data["seq"] : this.#rules.length;
      const folders = data["folders"];
      if (typeof folders === "object" && folders !== null) {
        for (const [key, value] of Object.entries(folders as Record<string, unknown>)) {
          const v = value as Record<string, unknown>;
          this.#folders.set(key, {
            // A folder restored without its baseline would re-fire on every
            // file in it, so an unreadable entry counts as adopted.
            adopted: v["adopted"] !== false,
            seen: new Set(Array.isArray(v["seen"]) ? (v["seen"] as string[]) : []),
            produced: new Map(
              Array.isArray(v["produced"]) ? (v["produced"] as [string, boolean][]) : [],
            ),
          });
        }
      }
    } catch {
      /* Corrupt state means no rules, not a broken app. */
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function prune(set: Set<string>, present: Set<string>): void {
  for (const p of set) if (!present.has(p)) set.delete(p);
}

function trim(set: Set<string>, max: number): void {
  if (set.size <= max) return;
  let drop = set.size - max;
  for (const p of set) {
    if (drop-- <= 0) break;
    set.delete(p);
  }
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
