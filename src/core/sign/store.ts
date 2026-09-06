/**
 * Saved signatures — the drawn ones, the imported ones, and the initials.
 *
 * A signature is not a preference, so it does not live in the settings store.
 * It is small user-authored *content*: it took effort to make, it is reused for
 * years, and losing one is annoying in a way that losing a toggle is not. That
 * difference drives every decision here.
 *
 * **Strokes are stored, not pixels.** A saved signature keeps the raw pointer
 * path plus the ink settings that were live when it was drawn, so it can be
 * re-rendered at any size, in any colour, with the thickness turned up later —
 * none of which is possible once it has been flattened to a PNG. It is also
 * roughly forty times smaller, which is what makes it safe to keep in
 * localStorage next to everything else the app stores there.
 *
 * **Points are packed.** A stroke is a flat `[x, y, dt, p, …]` run of numbers
 * at two decimal places rather than an array of objects. A three-stroke
 * signature is about 1.5 kB packed against 40 kB as objects, and localStorage
 * is a few megabytes shared with the rest of the app.
 *
 * **A full store never fails a save.** Quota is reclaimed by dropping the
 * least-recently-used entry and retrying, because the alternative — refusing to
 * save the signature the user just spent a minute drawing — is the worse
 * outcome by a wide margin.
 */

import type { InkSettings, InkStroke } from "./ink";
import { DEFAULT_INK } from "./ink";

const KEY = "facet.signatures";

/** How many of each kind are kept. Past this, the least recently used goes. */
export const MAX_ENTRIES = 24;
/** Ceiling on an imported raster signature, so one scan cannot fill the store. */
export const MAX_IMAGE_BYTES = 400_000;

/**
 * Signatures and initials are the same object with different defaults — same
 * pad, same ink, same export path — so they share a store and differ by a tag.
 * Keeping them apart matters only when offering a default: a PDF asking for
 * initials should not suggest a full name.
 */
export type SigKind = "signature" | "initials";

/** Drawn by hand. The good case: resizable, recolourable, tiny. */
export interface DrawnArt {
  source: "drawn";
  strokes: InkStroke[];
  ink: InkSettings;
}

/**
 * Imported from an SVG. Paths only — the importer has already flattened
 * transforms and thrown away everything that is not geometry.
 */
export interface SvgArt {
  source: "svg";
  paths: string[];
  /** `[minX, minY, width, height]` the paths are expressed in. */
  viewBox: [number, number, number, number];
}

/** Imported from a photo of a signature. Fixed colour, fixed resolution. */
export interface ImageArt {
  source: "image";
  /** A data URL. Kept under {@link MAX_IMAGE_BYTES}. */
  data: string;
  w: number;
  h: number;
}

export type SigArt = DrawnArt | SvgArt | ImageArt;

export interface Signature {
  id: string;
  name: string;
  kind: SigKind;
  art: SigArt;
  /**
   * Ink colour as `#rrggbb`. Held on the signature rather than baked into the
   * art so the same signature can be black on a contract and blue where a form
   * demands blue ink. Ignored for `image` art, which carries its own colours.
   */
  colour: string;
  /** Width ÷ height of the trimmed ink. Placement needs it before rendering. */
  aspect: number;
  created: number;
  /** Touched on every use, so the pruner drops what is genuinely unused. */
  used: number;
}

/* ─────────────────────────────────────────────────────────────── packing ── */

/**
 * Points to a flat number run.
 *
 * `t` is stored as a delta from the previous sample because the absolute value
 * is a `performance.now()` reading in the millions — five wasted digits per
 * point. Pressure is stored as 0..100 and `-1` when absent, which keeps the run
 * a uniform stride of four; a variable stride would save a little and cost a
 * parser.
 */
function packStroke(s: InkStroke): number[] {
  const out: number[] = [];
  let prevT = 0;
  for (let i = 0; i < s.points.length; i++) {
    const p = s.points[i];
    if (!p) continue;
    out.push(
      Math.round(p.x * 100) / 100,
      Math.round(p.y * 100) / 100,
      i === 0 ? 0 : Math.max(0, Math.round(p.t - prevT)),
      p.p === undefined ? -1 : Math.round(p.p * 100),
    );
    prevT = p.t;
  }
  return out;
}

function unpackStroke(run: readonly number[]): InkStroke {
  const points: InkStroke["points"] = [];
  let t = 0;
  for (let i = 0; i + 3 < run.length; i += 4) {
    const x = run[i];
    const y = run[i + 1];
    const dt = run[i + 2];
    const pr = run[i + 3];
    if (x === undefined || y === undefined || dt === undefined) continue;
    t += dt;
    points.push(pr === undefined || pr < 0 ? { x, y, t } : { x, y, t, p: pr / 100 });
  }
  return { points };
}

/* ──────────────────────────────────────────────────────────── persistence ── */

interface PersistedSig {
  id: string;
  name: string;
  kind: SigKind;
  colour: string;
  aspect: number;
  created: number;
  used: number;
  art:
    | { source: "drawn"; runs: number[][]; ink: InkSettings }
    | { source: "svg"; paths: string[]; viewBox: [number, number, number, number] }
    | { source: "image"; data: string; w: number; h: number };
}

interface Persisted {
  version: 1;
  items: PersistedSig[];
}

/** Somewhere to put the JSON. Mirrors the settings store so tests can swap it. */
export interface SigBackend {
  read(): string | null;
  write(text: string): void;
}

export function browserSigBackend(): SigBackend {
  return {
    read() {
      try {
        return localStorage.getItem(KEY);
      } catch {
        return null;
      }
    },
    write(text) {
      try {
        localStorage.setItem(KEY, text);
      } catch {
        // Rethrown as a signal the store can act on: it prunes and retries.
        // Swallowing here would silently lose the signature.
        throw new Error("quota");
      }
    },
  };
}

export function memorySigBackend(initial: string | null = null): SigBackend {
  let text = initial;
  return {
    read: () => text,
    write: (t) => {
      text = t;
    },
  };
}

function toPersisted(s: Signature): PersistedSig {
  const base = {
    id: s.id,
    name: s.name,
    kind: s.kind,
    colour: s.colour,
    aspect: s.aspect,
    created: s.created,
    used: s.used,
  };
  switch (s.art.source) {
    case "drawn":
      return { ...base, art: { source: "drawn", runs: s.art.strokes.map(packStroke), ink: s.art.ink } };
    case "svg":
      return { ...base, art: { source: "svg", paths: s.art.paths, viewBox: s.art.viewBox } };
    case "image":
      return { ...base, art: { source: "image", data: s.art.data, w: s.art.w, h: s.art.h } };
  }
}

/**
 * Rebuild one entry, or `null` if it is not recognisably a signature.
 *
 * Deliberately forgiving about missing scalars and strict about the art: a
 * signature with a lost colour is still the user's signature and gets black
 * ink, but a signature with no geometry is nothing and is dropped rather than
 * shown as an empty card the user cannot explain.
 */
function fromPersisted(raw: unknown): Signature | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<PersistedSig>;
  if (typeof r.id !== "string" || typeof r.art !== "object" || r.art === null) return null;

  let art: SigArt;
  const a = r.art as PersistedSig["art"];
  if (a.source === "drawn" && Array.isArray(a.runs)) {
    const strokes = a.runs.filter(Array.isArray).map(unpackStroke).filter((s) => s.points.length > 0);
    if (strokes.length === 0) return null;
    art = { source: "drawn", strokes, ink: { ...DEFAULT_INK, ...(a.ink ?? {}) } };
  } else if (a.source === "svg" && Array.isArray(a.paths) && Array.isArray(a.viewBox)) {
    const paths = a.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length === 0) return null;
    const [vx, vy, vw, vh] = a.viewBox;
    if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return null;
    art = { source: "svg", paths, viewBox: [vx ?? 0, vy ?? 0, vw, vh] };
  } else if (a.source === "image" && typeof a.data === "string" && a.data.startsWith("data:")) {
    art = { source: "image", data: a.data, w: a.w || 1, h: a.h || 1 };
  } else {
    return null;
  }

  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "Signature",
    kind: r.kind === "initials" ? "initials" : "signature",
    art,
    colour: typeof r.colour === "string" ? r.colour : "#111318",
    aspect: typeof r.aspect === "number" && r.aspect > 0 ? r.aspect : 3,
    created: typeof r.created === "number" ? r.created : Date.now(),
    used: typeof r.used === "number" ? r.used : 0,
  };
}

/* ───────────────────────────────────────────────────────────────── store ── */

type Listener = (items: readonly Signature[]) => void;

export class SignatureStore {
  private items: Signature[] = [];
  private listeners = new Set<Listener>();

  constructor(private backend: SigBackend) {
    this.load();
  }

  private load(): void {
    const text = this.backend.read();
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as Partial<Persisted>;
      if (!Array.isArray(parsed.items)) return;
      this.items = parsed.items
        .map(fromPersisted)
        .filter((s): s is Signature => s !== null)
        .sort((a, b) => b.used - a.used || b.created - a.created);
    } catch {
      // A corrupt store is treated as an empty one. Signatures are precious but
      // not precious enough to block the app on, and the file is unreadable
      // either way.
    }
  }

  /**
   * Write, pruning until it fits.
   *
   * The loop matters on a device where the store shares its quota with previews
   * and drafts: without it, one large imported image signature would make every
   * subsequent save fail, and the user's only clue would be that signatures
   * stop appearing after a restart.
   */
  private save(): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const payload: Persisted = { version: 1, items: this.items.map(toPersisted) };
      try {
        this.backend.write(JSON.stringify(payload));
        return;
      } catch {
        if (this.items.length <= 1) return; // Nothing left to give; keep it in memory.
        this.dropLeastUsed();
      }
    }
  }

  private dropLeastUsed(): void {
    let worst = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i];
      const b = this.items[worst];
      if (!a || !b) continue;
      if (a.used < b.used || (a.used === b.used && a.created < b.created)) worst = i;
    }
    this.items.splice(worst, 1);
  }

  private emit(): void {
    const snapshot = this.list();
    for (const fn of this.listeners) fn(snapshot);
  }

  /** Most recently used first — the order the picker shows them in. */
  list(kind?: SigKind): readonly Signature[] {
    const all = [...this.items].sort((a, b) => b.used - a.used || b.created - a.created);
    return kind ? all.filter((s) => s.kind === kind) : all;
  }

  get(id: string): Signature | undefined {
    return this.items.find((s) => s.id === id);
  }

  /** The one to offer without asking: most recently used of that kind. */
  preferred(kind: SigKind): Signature | undefined {
    return this.list(kind)[0];
  }

  add(input: Omit<Signature, "id" | "created" | "used">): Signature {
    if (input.art.source === "image" && input.art.data.length > MAX_IMAGE_BYTES) {
      throw new Error("image signature too large");
    }
    const sig: Signature = { ...input, id: newId(), created: Date.now(), used: Date.now() };
    this.items.unshift(sig);
    while (this.items.length > MAX_ENTRIES) this.dropLeastUsed();
    this.save();
    this.emit();
    return sig;
  }

  /**
   * Change name, colour, or ink settings on an existing signature.
   *
   * Editing ink in place — rather than forcing a redraw — is the point of
   * storing strokes: thickness, boldness and contrast are all re-renders, so
   * getting the weight wrong at capture time costs nothing.
   */
  update(id: string, patch: Partial<Pick<Signature, "name" | "colour" | "aspect">> & { ink?: InkSettings }): void {
    const sig = this.items.find((s) => s.id === id);
    if (!sig) return;
    if (patch.name !== undefined) sig.name = patch.name;
    if (patch.colour !== undefined) sig.colour = patch.colour;
    if (patch.aspect !== undefined) sig.aspect = patch.aspect;
    if (patch.ink !== undefined && sig.art.source === "drawn") sig.art.ink = { ...patch.ink };
    this.save();
    this.emit();
  }

  /** Mark used, so the picker's first suggestion tracks actual habit. */
  touch(id: string): void {
    const sig = this.items.find((s) => s.id === id);
    if (!sig) return;
    sig.used = Date.now();
    this.save();
    this.emit();
  }

  remove(id: string): void {
    const i = this.items.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.items.splice(i, 1);
    this.save();
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Everything, as a JSON document.
   *
   * A signature is the one thing here worth carrying between machines by hand,
   * and it is the one thing a browser wiping site data destroys with no
   * warning. Export is the backup story.
   */
  exportJSON(): string {
    return JSON.stringify({ version: 1, items: this.items.map(toPersisted) } satisfies Persisted, null, 1);
  }

  /** Merge an exported document in. Returns how many arrived. */
  importJSON(text: string): number {
    let parsed: Partial<Persisted>;
    try {
      parsed = JSON.parse(text) as Partial<Persisted>;
    } catch {
      return 0;
    }
    if (!Array.isArray(parsed.items)) return 0;

    let added = 0;
    for (const raw of parsed.items) {
      const sig = fromPersisted(raw);
      if (!sig) continue;
      // Re-id on import. Two machines that both exported after a shared start
      // would otherwise collide, and silently overwriting a signature is worse
      // than ending up with two.
      this.items.unshift({ ...sig, id: newId() });
      added++;
    }
    while (this.items.length > MAX_ENTRIES) this.dropLeastUsed();
    this.save();
    this.emit();
    return added;
  }
}

function newId(): string {
  return `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
