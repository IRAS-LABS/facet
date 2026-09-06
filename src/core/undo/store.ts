/**
 * Edits that outlive the process.
 *
 * The photo editor already keeps an undo stack; it lives in a field and dies
 * with the window. This is the part that makes it real: every change is written
 * to IndexedDB under the path of the file it belongs to, so closing FACET —
 * deliberately or otherwise — is not the same as throwing the work away.
 *
 * Three things this is careful about, because each of them is a way to lose
 * work while appearing to protect it:
 *
 *  - **The file may have moved on underneath.** A saved edit records the size
 *    and mtime it was drawn against. If those no longer match, the edit is
 *    still handed back, but flagged `stale` — the caller shows it rather than
 *    silently compositing week-old regions onto a photo that has since been
 *    replaced.
 *  - **Brush strokes are not small.** A few minutes of painting is thousands of
 *    points, and sixty snapshots of that is megabytes. Documents are trimmed
 *    from the oldest undo step forward until they fit, so a long session
 *    degrades to a shorter history rather than to a failed write.
 *  - **Nothing here is a backup.** It is scratch state for files the user has
 *    open. Old documents are pruned, and a document is dropped outright when
 *    its edits are discarded. Exporting a copy does *not* drop it: the regions
 *    are still there on the screen, still unsaved against the original, and
 *    clearing them out from under a session that is still going is the same
 *    kind of loss this exists to prevent.
 *
 * IndexedDB rather than localStorage: localStorage is synchronous (it blocks
 * the frame that is drawing the stroke being saved), is capped at a few
 * megabytes, and stores strings, which means every read re-parses the whole
 * history. None of those are survivable for this.
 *
 * It is not a free choice, though: IndexedDB cannot be written while a window
 * is being destroyed, so the last unflushed work has to be pushed out earlier —
 * see `arm` at the foot of this file. `../undo/session.ts` holds a folder path
 * rather than megabytes and makes the opposite trade for exactly that reason.
 */

import { PREF } from "@core/settings/registry";
import { settings } from "@core/settings/store";

const DB_NAME = "facet-undo";
const DB_VERSION = 1;
const STORE = "docs";

/**
 * Most-recent documents kept. Beyond this, the oldest are pruned on write.
 *
 * Read live rather than frozen at import, so item 43's control takes effect on
 * the next save instead of on the next launch — and so the harness, which
 * constructs its own store, still gets the declared default.
 */
const keepDocs = (): number => settings.get<number>(PREF.undoKeep) ?? 40;

/** Serialized ceiling for one document, before its history starts shedding. */
const DOC_BUDGET = 4 * 1024 * 1024;

/** History steps kept even when a document is over budget. */
const MIN_HISTORY = 5;

/** Writes are coalesced over this window; a stroke fires dozens of changes. */
const SAVE_DEBOUNCE = 500;

export interface EditDoc {
  /** The file this belongs to. Also the primary key. */
  key: string;
  /** What kind of editor wrote it, so a future one does not misread it. */
  kind: "photo";
  /** The live state, as the editor's own JSON. */
  state: string;
  /** Undo and redo, oldest first, in the same encoding as `state`. */
  undo: string[];
  redo: string[];
  /** Epoch ms of the last change. Drives both pruning and the restore note. */
  at: number;
  /**
   * What the file looked like when this was drawn against it. Explicitly
   * `| undefined` rather than merely optional: an entry that was never stat'd
   * has to be storable as "unknown", and under exactOptionalPropertyTypes the
   * two are different things.
   */
  size?: number | undefined;
  modified?: number | undefined;
}

export interface Restored extends EditDoc {
  /**
   * The file changed on disk after this was saved. The edit is still returned —
   * throwing away work because a timestamp moved is worse than showing it — but
   * it must not be applied without saying so.
   */
  stale: boolean;
}

let db: Promise<IDBDatabase> | null = null;

/**
 * The same connection, reachable without awaiting — see `flushNow`. A write
 * that starts a microtask after `pagehide` is racing a document that is already
 * being torn down, and the last thing drawn is what loses.
 */
let live: IDBDatabase | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const store = d.createObjectStore(STORE, { keyPath: "key" });
        // Pruning wants the oldest first and nothing else, so the only index
        // is the one that answers that question without reading every value.
        store.createIndex("at", "at");
      }
    };
    req.onsuccess = () => { live = req.result; resolve(req.result); };
    req.onerror = () => { reject(req.error ?? new Error("indexeddb refused to open")); };
  });
  return db;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => { resolve(req.result); };
        req.onerror = () => { reject(req.error ?? new Error("indexeddb request failed")); };
      }),
  );
}

/**
 * Shrink a document to fit the budget by dropping its oldest history.
 *
 * The current state is never dropped — a document that cannot hold its own
 * present is worse than no document. Redo goes before undo because redo is
 * only reachable by first undoing, and undo is the thing that was asked for.
 */
function trim(doc: EditDoc): EditDoc {
  const weigh = (d: EditDoc): number =>
    d.state.length + d.undo.reduce((n, s) => n + s.length, 0) + d.redo.reduce((n, s) => n + s.length, 0);

  const out: EditDoc = { ...doc, undo: [...doc.undo], redo: [...doc.redo] };
  while (weigh(out) > DOC_BUDGET && out.redo.length > 0) out.redo.shift();
  while (weigh(out) > DOC_BUDGET && out.undo.length > MIN_HISTORY) out.undo.shift();
  return out;
}

async function prune(): Promise<void> {
  const keys = await tx<IDBValidKey[]>("readonly", (s) => s.index("at").getAllKeys());
  const keep = keepDocs();
  if (keys.length <= keep) return;
  const d = await open();
  const t = d.transaction(STORE, "readwrite");
  const store = t.objectStore(STORE);
  // getAllKeys on the `at` index comes back oldest first, so the excess is the
  // front of the list.
  for (const k of keys.slice(0, keys.length - keep)) store.delete(k);
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const latest = new Map<string, EditDoc>();

/**
 * Queue a document to be written.
 *
 * Deliberately fire-and-forget from the caller's point of view: an editor that
 * awaits its own autosave stutters on every stroke, and a failed write here is
 * not something the user can act on mid-drag. Failures are logged and the next
 * change tries again.
 */
export function save(doc: EditDoc): void {
  latest.set(doc.key, doc);
  const already = pending.get(doc.key);
  if (already !== undefined) clearTimeout(already);
  pending.set(
    doc.key,
    setTimeout(() => {
      pending.delete(doc.key);
      void flushOne(doc.key);
    }, SAVE_DEBOUNCE),
  );
}

async function flushOne(key: string): Promise<void> {
  const doc = latest.get(key);
  if (!doc) return;
  latest.delete(key);
  try {
    await tx("readwrite", (s) => s.put(trim(doc)));
    await prune();
  } catch (e) {
    console.warn("facet: could not persist edits for", key, e);
  }
}

/**
 * Write everything queued, now.
 *
 * Called on close and on `pagehide`. The debounce that keeps a drag smooth is
 * exactly the window in which the last half-second of work is lost, so there
 * has to be a way to close it.
 */
export async function flush(): Promise<void> {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  await Promise.all([...latest.keys()].map((k) => flushOne(k)));
}

export async function load(
  key: string,
  file: { size?: number; modified?: number },
): Promise<Restored | null> {
  let doc: EditDoc | undefined;
  try {
    doc = await tx<EditDoc | undefined>("readonly", (s) => s.get(key) as IDBRequest<EditDoc | undefined>);
  } catch (e) {
    console.warn("facet: could not read saved edits for", key, e);
    return null;
  }
  if (!doc) return null;
  // Both are compared only when both sides know the answer. An entry that was
  // never stat'd must not make every saved edit look stale.
  const changed =
    (doc.size !== undefined && file.size !== undefined && doc.size !== file.size) ||
    (doc.modified !== undefined && file.modified !== undefined && doc.modified !== file.modified);
  return { ...doc, stale: changed };
}

export async function drop(key: string): Promise<void> {
  const t = pending.get(key);
  if (t !== undefined) clearTimeout(t);
  pending.delete(key);
  latest.delete(key);
  try {
    await tx("readwrite", (s) => s.delete(key));
  } catch (e) {
    console.warn("facet: could not clear saved edits for", key, e);
  }
}

/** Every saved document, most recently touched first. For crash recovery. */
export async function all(): Promise<EditDoc[]> {
  try {
    const docs = await tx<EditDoc[]>("readonly", (s) => s.getAll() as IDBRequest<EditDoc[]>);
    return docs.sort((a, b) => b.at - a.at);
  } catch (e) {
    console.warn("facet: could not list saved edits", e);
    return [];
  }
}

export async function clear(): Promise<void> {
  await flush();
  try {
    await tx("readwrite", (s) => s.clear());
  } catch (e) {
    console.warn("facet: could not clear saved edits", e);
  }
}

/**
 * Everything queued, written in the handler's own task.
 *
 * `flush` awaits `open()` before it touches the store, which is one microtask
 * too many when the document is already being torn down. So the puts here are
 * issued directly against the connection that is already open, and pruning —
 * housekeeping, not the user's work — is left for the next run.
 *
 * **This is best-effort, and on a real teardown it is expected to lose.**
 * IndexedDB commits asynchronously no matter how synchronously the put is
 * issued, and a closing document aborts the transaction underneath it. Measured
 * while building the session record, which used to live in this database and
 * came back reading as a crash after every clean exit. So this is not the
 * mitigation — `arm` below is. This is the free extra attempt, which does land
 * when the page is being replaced rather than destroyed.
 */
function flushNow(): void {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  if (!live || latest.size === 0) { void flush(); return; }
  try {
    const store = live.transaction(STORE, "readwrite").objectStore(STORE);
    for (const doc of latest.values()) store.put(trim(doc));
    latest.clear();
  } catch (e) {
    console.warn("facet: could not persist edits on the way out", e);
  }
}

/**
 * Close the debounce window at every moment the page is still alive.
 *
 * Since the write cannot be relied on at teardown, the answer is to have
 * nothing left to write by the time teardown arrives. Losing focus and being
 * hidden both happen while the document is fully functional and the transaction
 * commits normally, and between them they cover how a window actually gets
 * closed: something else is clicked, or it is minimised, or the taskbar is used
 * — all of which blur it first.
 *
 * What remains at risk is a window destroyed while it still has focus and a
 * stroke still in the debounce: at most the last half-second of one drag. That
 * is the honest limit, and it is why `flushNow` still runs on the way out even
 * though it usually loses.
 */
function arm(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("blur", () => { void flush(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
  // `pagehide` rather than `beforeunload`: beforeunload does not fire reliably
  // when a Tauri window is closed from the OS chrome.
  window.addEventListener("pagehide", flushNow);
}

arm();
