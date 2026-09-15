/**
 * Remembering the reading-order fixes someone made by hand (item 20).
 *
 * The automatic ordering is right on most papers and wrong on a few, and the
 * ones it is wrong on tend to be the ones a person reads more than once -- a
 * thesis, a manual, the paper they are working through this month. Making them
 * re-drag the same two boxes every time they open it would make the fix
 * feel like a workaround rather than a setting.
 *
 * Fixes are keyed by the file's path and guarded by a fingerprint of the
 * parse. If the document changes underneath -- re-scanned, re-exported, a page
 * added -- the block ids no longer mean what they meant, so the saved fixes
 * are dropped rather than applied to the wrong paragraphs. Silently: a reader
 * that opens with an explanation of a data format it no longer uses is worse
 * than one that simply reads the document properly.
 */

import type { ReadDoc } from "./doc";

const KEY = "facet.read.order";
/** Documents kept. Past this, the oldest is dropped. */
const KEEP = 60;

export interface Fixes {
  /** Block ids in the order the user put them. Absent means automatic. */
  order?: string[];
  /** Block ids the user excluded by hand. */
  off?: string[];
  /** Block ids the user re-included after a rule had skipped them. */
  on?: string[];
  /** Guards against applying these to a document that has changed. */
  print: string;
  at: number;
}

export interface OrderBackend {
  read(): string | null;
  write(text: string): void;
}

/** localStorage, with every failure swallowed — see `settings/store.ts`. */
export function browserOrder(): OrderBackend {
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
        /* a reader that cannot remember a fix is still a reader */
      }
    },
  };
}

export function memoryOrder(seed: string | null = null): OrderBackend {
  let value = seed;
  return { read: () => value, write: (text) => { value = text; } };
}

/**
 * A short signature of the parse.
 *
 * Block count and total length, not a hash of the text: it is enough to catch
 * a document that changed, cheap on a 200-page scan, and it cannot be mistaken
 * for a checksum of the file's contents by anyone reading the stored data.
 */
export function fingerprint(doc: ReadDoc): string {
  let chars = 0;
  for (const b of doc.blocks) chars += b.text.length;
  return `${doc.blocks.length}:${chars}:${doc.pages}`;
}

export class OrderStore {
  private all: Record<string, Fixes> = {};
  private loaded = false;

  constructor(private readonly backend: OrderBackend = browserOrder()) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const text = this.backend.read();
    if (!text) return;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.all = parsed as Record<string, Fixes>;
      }
    } catch {
      // A half-written file is not worth an error. Start clean.
      this.all = {};
    }
  }

  private save(): void {
    const keys = Object.keys(this.all);
    if (keys.length > KEEP) {
      // Oldest first, so the ones being used survive.
      const sorted = keys.sort((a, b) => (this.all[a]?.at ?? 0) - (this.all[b]?.at ?? 0));
      for (const k of sorted.slice(0, keys.length - KEEP)) delete this.all[k];
    }
    this.backend.write(JSON.stringify(this.all));
  }

  /** What was remembered for this document, if it still fits. */
  get(doc: ReadDoc): Fixes | null {
    this.load();
    const found = this.all[doc.source];
    if (!found) return null;
    if (found.print !== fingerprint(doc)) return null;
    return found;
  }

  /** Remember the current state of a document's blocks. */
  put(doc: ReadDoc, fixes: Omit<Fixes, "print" | "at">): void {
    this.load();
    const empty = !fixes.order?.length && !fixes.off?.length && !fixes.on?.length;
    if (empty) {
      delete this.all[doc.source];
    } else {
      this.all[doc.source] = { ...fixes, print: fingerprint(doc), at: Date.now() };
    }
    this.save();
  }

  /** Throw away this document's fixes. The reader's "Reset order" button. */
  forget(doc: ReadDoc): void {
    this.load();
    delete this.all[doc.source];
    this.save();
  }
}

/**
 * Put a document into the order the user chose, and apply their exclusions.
 *
 * Returns a new document rather than mutating: the player holds a reference to
 * the one it is reading, and re-ordering underneath it would move the
 * highlight without moving the voice.
 *
 * Blocks missing from a saved order keep their automatic position relative to
 * the block they followed, so adding a paragraph to a document whose order was
 * fixed does not make that paragraph disappear.
 */
export function apply(doc: ReadDoc, fixes: Fixes | null): ReadDoc {
  if (!fixes) return doc;

  let blocks = doc.blocks;

  if (fixes.order?.length) {
    const want = new Map(fixes.order.map((id, i) => [id, i]));
    // Unlisted blocks inherit the rank of the last listed block before them,
    // plus a fraction, which is what keeps them next to their neighbour.
    const rank = new Map<string, number>();
    let last = -1;
    let extra = 0;
    for (const b of doc.blocks) {
      const at = want.get(b.id);
      if (at === undefined) {
        extra += 1;
        rank.set(b.id, last + extra / (doc.blocks.length + 1));
      } else {
        last = at;
        extra = 0;
        rank.set(b.id, at);
      }
    }
    blocks = [...doc.blocks].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }

  const off = new Set(fixes.off ?? []);
  const on = new Set(fixes.on ?? []);
  blocks = blocks.map((b) => {
    if (off.has(b.id)) return { ...b, skip: true, byHand: true, why: "You excluded this" };
    if (on.has(b.id)) return { ...b, skip: false, byHand: true, why: "You included this" };
    return b;
  });

  return { ...doc, blocks };
}
