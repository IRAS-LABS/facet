/**
 * Watch-folder rules (item 27) — what fires, on what, and what it produces.
 *
 * Deliberately pure. A rule is a plain record and `taskFor()` turns a rule plus
 * a file into the same enqueue spec a person would have typed into the palette;
 * nothing here touches the filesystem, the queue, or the clock. That is what
 * makes the interesting part — "would this rule really have fired on that
 * file?" — answerable in a test instead of by dropping a file in a folder and
 * waiting.
 *
 * The one rule about rules: **a rule must never fire on its own output.** A
 * convert-to-mp4 rule watching a folder it also writes into is an infinite
 * encode loop that fills the disk overnight, and it is the single most likely
 * way a watch folder ruins someone's week. Two independent guards stop it — the
 * watcher marks every output as already-seen at enqueue time, and `matches()`
 * refuses any name carrying one of FACET's own output suffixes. Either alone
 * would do on a good day; both, because the bad day is expensive.
 */

import type { FileEntry, FileKind } from "@core/explorer/types";
import { extOf } from "@core/explorer/types";

export type WatchAction =
  | { type: "clean" }
  | { type: "blur.faces"; amount?: number }
  | { type: "convert.audio"; format: string; bitrate?: number }
  | { type: "convert.video"; format: string; quality?: number }
  | { type: "move"; to: string }
  | { type: "rename"; pattern: string };

export interface WatchRule {
  id: string;
  /** The folder being watched. Absolute, forward slashes. */
  folder: string;
  enabled: boolean;
  /** Kinds that fire. Empty means every kind. */
  kinds: FileKind[];
  /** Extensions that fire, lowercase and dotless. Empty means every extension. */
  exts: string[];
  /** Substring the name must contain, case-insensitive. Empty means any name. */
  contains: string;
  /** Files below this many bytes never fire. 0 means no floor. */
  minSize: number;
  action: WatchAction;
  /** How many files this rule has actually fired on, and when it last did. */
  fired: number;
  lastFired: number;
}

/**
 * Suffixes FACET itself appends. A file wearing one is assumed to be ours and
 * is never a trigger — see the note at the top about the infinite loop.
 */
const OUTPUT_SUFFIXES = ["-converted", "-clean", "-blurred", "-fixed"];

/** `-clean-2`, `-converted-7`: the collision-stepped forms of the above. */
const STEPPED = /-(?:converted|clean|blurred|fixed)-\d+$/;

export function isOurOutput(name: string): boolean {
  const stem = stemOf(name).toLowerCase();
  if (STEPPED.test(stem)) return true;
  return OUTPUT_SUFFIXES.some((s) => stem.endsWith(s));
}

/** Does this rule fire on this file? Folders never fire; only real files do. */
export function matches(rule: WatchRule, entry: FileEntry): boolean {
  if (!rule.enabled) return false;
  if (entry.kind === "folder") return false;
  if (isOurOutput(entry.name)) return false;
  if (rule.kinds.length > 0 && !rule.kinds.includes(entry.kind)) return false;
  if (rule.exts.length > 0 && !rule.exts.includes(entry.ext.toLowerCase())) return false;
  if (rule.contains && !entry.name.toLowerCase().includes(rule.contains.toLowerCase())) {
    return false;
  }
  // An unknown size is not a small size. A listing that has not stat'd the file
  // yet would otherwise be silently excluded by every rule with a floor.
  if (rule.minSize > 0 && entry.size !== undefined && entry.size < rule.minSize) return false;
  return true;
}

export interface TaskSpec {
  kind: string;
  title: string;
  input: string;
  output: string;
  params: Record<string, unknown>;
}

/**
 * The enqueue spec for one match — the same shape the palette builds by hand.
 *
 * `output` is left empty wherever the runner picks the name, because the runner
 * is the only thing that knows what is on disk when the task finally runs. A
 * watch folder can queue a hundred files in a second and they may not run for
 * an hour; choosing a non-colliding name now would be choosing it against a
 * folder that no longer exists.
 */
export function taskFor(rule: WatchRule, entry: FileEntry): TaskSpec | null {
  const a = rule.action;
  switch (a.type) {
    case "clean":
      return {
        kind: "meta.clean",
        title: `Clean ${entry.name}`,
        input: entry.path,
        output: "",
        params: { mode: "copy" },
      };
    case "blur.faces": {
      // No `mode` key at all, unlike clean. The runner has no in-place path and
      // adding a param that reads as though it might is how an unattended rule
      // ends up eating originals.
      const params: Record<string, unknown> = {};
      if (a.amount !== undefined) params["amount"] = a.amount;
      return {
        kind: "faces.blur",
        title: `Blur faces in ${entry.name}`,
        input: entry.path,
        output: "",
        params,
      };
    }
    case "convert.audio": {
      const params: Record<string, unknown> = { format: a.format };
      if (a.bitrate !== undefined) params["bitrate"] = a.bitrate;
      return {
        kind: "audio.convert",
        title: `${entry.name} → ${a.format}`,
        input: entry.path,
        output: "",
        params,
      };
    }
    case "convert.video": {
      const params: Record<string, unknown> = { format: a.format };
      if (a.quality !== undefined) params["quality"] = a.quality;
      return {
        kind: "video.convert",
        title: `${entry.name} → ${a.format}`,
        input: entry.path,
        output: "",
        params,
      };
    }
    case "move": {
      const to = joinPath(a.to, entry.name);
      // A move onto itself is not an error worth a red row; it is a rule
      // pointed at the folder it watches, and the honest answer is to do
      // nothing at all.
      if (samePath(to, entry.path)) return null;
      return {
        kind: "file.move",
        title: `Move ${entry.name}`,
        input: entry.path,
        output: to,
        params: {},
      };
    }
    case "rename": {
      const name = applyPattern(a.pattern, entry);
      if (!name || name === entry.name) return null;
      return {
        kind: "file.move",
        title: `Rename ${entry.name} → ${name}`,
        input: entry.path,
        output: joinPath(dirName(entry.path), name),
        params: {},
      };
    }
  }
}

/**
 * Rename tokens. `{name}` `{ext}` `{yyyy}` `{mm}` `{dd}` `{n}`.
 *
 * The date tokens read the file's own modified time, not today's — a folder of
 * photos dropped in at once should be named for when they were taken, not for
 * the minute the watcher happened to notice them. `{n}` is the rule's own fire
 * count, which is the only counter that survives a restart.
 */
export function applyPattern(pattern: string, entry: FileEntry, n = 0): string {
  const d = new Date(entry.modified ?? 0);
  const valid = entry.modified !== undefined && Number.isFinite(entry.modified);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return pattern
    .replace(/\{name\}/g, stemOf(entry.name))
    .replace(/\{ext\}/g, entry.ext || extOf(entry.name))
    .replace(/\{yyyy\}/g, valid ? String(d.getFullYear()) : "0000")
    .replace(/\{mm\}/g, valid ? pad(d.getMonth() + 1) : "00")
    .replace(/\{dd\}/g, valid ? pad(d.getDate()) : "00")
    .replace(/\{n\}/g, String(n))
    // Windows would reject the whole write; stripping is friendlier than a red
    // row saying the pattern the user just typed is illegal.
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
}

/** A one-line summary of what a rule does, for the panel and the palette. */
export function describe(rule: WatchRule): string {
  const a = rule.action;
  switch (a.type) {
    case "clean":
      return "strip metadata into a clean copy";
    case "blur.faces":
      return "blur every face into a copy";
    case "convert.audio":
      return `convert to ${a.format}${a.bitrate ? ` at ${a.bitrate}k` : ""}`;
    case "convert.video":
      return `convert to ${a.format}`;
    case "move":
      return `move to ${a.to}`;
    case "rename":
      return `rename to ${a.pattern}`;
  }
}

/** What the rule accepts, in words. Empty filters read as "everything". */
export function describeFilter(rule: WatchRule): string {
  const bits: string[] = [];
  if (rule.kinds.length > 0) bits.push(rule.kinds.join("/"));
  if (rule.exts.length > 0) bits.push(rule.exts.map((e) => `.${e}`).join(" "));
  if (rule.contains) bits.push(`named *${rule.contains}*`);
  if (rule.minSize > 0) bits.push(`over ${Math.round(rule.minSize / 1024)} KB`);
  return bits.length > 0 ? bits.join(", ") : "any new file";
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function dirName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash > 0 ? path.slice(0, slash) : path;
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[/\\]+$/, "")}/${name}`;
}

/** Windows paths differ in case and slash without differing in file. */
export function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

/** Is `child` inside `parent`? Used to stop a move rule feeding itself. */
export function isInside(parent: string, child: string): boolean {
  const p = parent.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const c = child.replace(/\\/g, "/").toLowerCase();
  return c === p || c.startsWith(`${p}/`);
}

// ── Defaults ────────────────────────────────────────────────────────────────

export function emptyRule(folder: string, id: string): WatchRule {
  return {
    id,
    folder,
    enabled: true,
    kinds: [],
    exts: [],
    contains: "",
    minSize: 0,
    action: { type: "clean" },
    fired: 0,
    lastFired: 0,
  };
}

const KINDS: readonly FileKind[] = [
  "image",
  "video",
  "audio",
  "document",
  "tabular",
  "model3d",
  "archive",
  "code",
  "binary",
];

/** Restore one rule from storage, discarding anything that is not a rule. */
export function normaliseRule(raw: unknown): WatchRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const folder = typeof r["folder"] === "string" ? r["folder"] : "";
  const id = typeof r["id"] === "string" ? r["id"] : "";
  if (!folder || !id) return null;
  const action = normaliseAction(r["action"]);
  if (!action) return null;
  return {
    id,
    folder,
    enabled: r["enabled"] !== false,
    kinds: Array.isArray(r["kinds"])
      ? (r["kinds"].filter((k) => KINDS.includes(k as FileKind)) as FileKind[])
      : [],
    exts: Array.isArray(r["exts"])
      ? r["exts"].filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase())
      : [],
    contains: typeof r["contains"] === "string" ? r["contains"] : "",
    minSize: typeof r["minSize"] === "number" && r["minSize"] > 0 ? r["minSize"] : 0,
    action,
    fired: typeof r["fired"] === "number" ? r["fired"] : 0,
    lastFired: typeof r["lastFired"] === "number" ? r["lastFired"] : 0,
  };
}

function normaliseAction(raw: unknown): WatchAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  switch (a["type"]) {
    case "clean":
      return { type: "clean" };
    case "blur.faces": {
      const out: WatchAction = { type: "blur.faces" };
      const amt = num(a["amount"]);
      if (amt !== undefined) out.amount = amt;
      return out;
    }
    case "convert.audio": {
      const out: WatchAction = {
        type: "convert.audio",
        format: typeof a["format"] === "string" ? a["format"] : "mp3",
      };
      const b = num(a["bitrate"]);
      if (b !== undefined) out.bitrate = b;
      return out;
    }
    case "convert.video": {
      const out: WatchAction = {
        type: "convert.video",
        format: typeof a["format"] === "string" ? a["format"] : "mp4",
      };
      const q = num(a["quality"]);
      if (q !== undefined) out.quality = q;
      return out;
    }
    case "move":
      return typeof a["to"] === "string" && a["to"] ? { type: "move", to: a["to"] } : null;
    case "rename":
      return typeof a["pattern"] === "string" && a["pattern"]
        ? { type: "rename", pattern: a["pattern"] }
        : null;
    default:
      return null;
  }
}
