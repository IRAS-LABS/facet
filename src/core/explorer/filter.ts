/**
 * What "show me only these" means, as a line of text (item 37).
 *
 * A filter here is a string you can type, not a form you fill in:
 * `report kind:image size:>2mb after:2026-01-01`. That choice is the same one
 * the field lists made in `fields.ts` and for the same reason — a line survives
 * being read, saved under a name, hand-edited, pasted to somebody else and
 * stored per folder, and none of those are true of a nested object behind a
 * dialog. It also means the filter box and a saved filter are the same thing,
 * so there is nothing to keep in step.
 *
 * **Nothing in here throws and nothing is rejected.** A token this build does
 * not understand — `foo:bar`, `size:banana`, a stray `C:` from a pasted path —
 * is not an error, it is text to match the name against. Every alternative ends
 * with a file explorer refusing to filter until you have typed something it
 * approves of, which is a worse experience than showing you too many files.
 *
 * Rules are ANDed, because that is what narrowing means: each word you add
 * takes files away. `-` in front of a token negates it, which is the only way
 * to say "everything except" without inventing a syntax for OR that nobody
 * would remember.
 */

import { formatSize, type FileEntry, type FileKind } from "./types";

export interface Rule {
  /** The token this came from, verbatim, so a chip can show what was typed. */
  source: string;
  /** How to say it in a status bar: "kind is image", "size ≥ 2 MB". */
  label: string;
  test(e: FileEntry): boolean;
}

export interface Query {
  rules: Rule[];
  /** True when this filter would keep everything — the common case. */
  empty: boolean;
}

/** The empty query, shared. Nothing mutates a Query. */
export const NO_FILTER: Query = { rules: [], empty: true };

/**
 * What people call the kinds.
 *
 * `kind:photo` has to work: the internal name for the kind is "image" because
 * that is what the union member is called, and nobody types the name of a union
 * member. Aliases are cheap and the absence of one reads as a bug.
 */
const KIND_ALIASES: Record<string, FileKind> = {
  folder: "folder", dir: "folder", directory: "folder",
  image: "image", photo: "image", pic: "image", picture: "image", img: "image",
  video: "video", movie: "video", clip: "video", vid: "video",
  audio: "audio", music: "audio", sound: "audio", song: "audio",
  document: "document", doc: "document", pdf: "document", text: "document",
  tabular: "tabular", table: "tabular", sheet: "tabular", spreadsheet: "tabular", data: "tabular",
  model3d: "model3d", model: "model3d", "3d": "model3d", mesh: "model3d",
  archive: "archive", zip: "archive", compressed: "archive",
  code: "code", source: "code", script: "code",
  binary: "binary", other: "binary",
};

const SIZE_UNITS: Record<string, number> = {
  "": 1, b: 1,
  k: 1024, kb: 1024,
  m: 1024 ** 2, mb: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4,
};

/**
 * Split a filter line into tokens, keeping quoted runs whole.
 *
 * Quotes are the only escape there is. A file called `annual report.pdf` needs
 * `"annual report"` and nothing more elaborate; backslash escaping in a box
 * that mostly holds Windows paths would be actively hostile.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur !== "") out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** Bytes from `10mb`, `500k`, `1.5g`, `4096`. Null when it is not a size. */
function bytes(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i.exec(text.trim());
  if (!m) return null;
  const unit = SIZE_UNITS[m[2]!.toLowerCase()];
  if (unit === undefined) return null;
  return Number(m[1]) * unit;
}

/**
 * A moment from `today`, `yesterday`, `7d`, `2026-01-01`, `2026-01`.
 *
 * Everything resolves to the *start* of its day, which is what makes
 * `after:today` mean "since midnight" rather than "in the next few hours".
 * `now` is injectable so a harness can assert a date without waiting a day.
 */
export function when(text: string, now: number = Date.now()): number | null {
  const t = text.trim().toLowerCase();
  const midnight = (d: Date): number => {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  if (t === "today") return midnight(new Date(now));
  if (t === "yesterday") return midnight(new Date(now - 86_400_000));
  const rel = /^(\d+)\s*([dwmy])$/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const days = { d: 1, w: 7, m: 30, y: 365 }[rel[2]!]!;
    return midnight(new Date(now - n * days * 86_400_000));
  }
  // Anchored to noon so a date typed as `2026-01-01` is the first of January in
  // the local zone rather than whatever that instant is in UTC — off-by-one-day
  // filters are the single most confusing thing a date field can do.
  const ymd = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(t);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, ymd[3] === undefined ? 1 : Number(ymd[3]), 12);
    return Number.isNaN(d.getTime()) ? null : midnight(d);
  }
  return null;
}

/** A date back out as `2026-01-01`, for a label. */
function dateLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function contains(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

/** A rule that matches the token as plain text against the name. */
function textRule(token: string): Rule {
  return {
    source: token,
    label: `name has "${token}"`,
    test: (e) => contains(e.name, token),
  };
}

/**
 * One token into one rule.
 *
 * Returns a text rule for anything it cannot make sense of — see the note at
 * the top. `null` is never returned, because a token that vanished would leave
 * the box saying one thing and the folder showing another.
 */
function ruleFor(token: string, now: number): Rule {
  const colon = token.indexOf(":");
  // A bare word, or something like `C:/Users` where the "key" is a drive.
  if (colon <= 0) return textRule(token);
  const key = token.slice(0, colon).toLowerCase();
  const raw = token.slice(colon + 1);
  if (raw === "") return textRule(token);

  switch (key) {
    case "name": {
      return { source: token, label: `name has "${raw}"`, test: (e) => contains(e.name, raw) };
    }
    case "kind": {
      const kinds = raw.split(",").map((s) => KIND_ALIASES[s.trim().toLowerCase()]).filter((k): k is FileKind => k !== undefined);
      if (kinds.length === 0) return textRule(token);
      return {
        source: token,
        label: `kind is ${kinds.join(" or ")}`,
        test: (e) => kinds.includes(e.kind),
      };
    }
    case "ext":
    case "type": {
      const exts = raw.split(",").map((s) => s.trim().replace(/^\./, "").toLowerCase()).filter((s) => s !== "");
      if (exts.length === 0) return textRule(token);
      return {
        source: token,
        label: `type is ${exts.join(" or ").toUpperCase()}`,
        test: (e) => exts.includes(e.ext),
      };
    }
    case "size": {
      const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(raw);
      const n = m ? bytes(m[2]!) : null;
      if (n === null) return textRule(token);
      const op = m?.[1] ?? ">=";
      const shown = formatSize(n);
      // Folders have no size to compare (see `fields.ts`), and a size filter
      // that silently swept every folder out of the view would make the folder
      // you were about to open disappear because you asked for large videos.
      const label =
        op === ">" ? `size > ${shown}` :
        op === "<" ? `size < ${shown}` :
        op === "<=" ? `size ≤ ${shown}` :
        op === "=" ? `size is ${shown}` :
        `size ≥ ${shown}`;
      return {
        source: token,
        label,
        test: (e) => {
          if (e.kind === "folder") return false;
          const s = e.size ?? 0;
          switch (op) {
            case ">": return s > n;
            case "<": return s < n;
            case "<=": return s <= n;
            case "=": return s === n;
            default: return s >= n;
          }
        },
      };
    }
    case "after":
    case "since":
    case "modified": {
      const at = when(raw, now);
      if (at === null) return textRule(token);
      return {
        source: token,
        label: `modified after ${dateLabel(at)}`,
        test: (e) => (e.modified ?? 0) >= at,
      };
    }
    case "before":
    case "until": {
      const at = when(raw, now);
      if (at === null) return textRule(token);
      return {
        source: token,
        label: `modified before ${dateLabel(at)}`,
        test: (e) => (e.modified ?? 0) < at,
      };
    }
    case "is": {
      const what = raw.toLowerCase();
      if (what === "folder" || what === "dir") {
        return { source: token, label: "folders only", test: (e) => e.kind === "folder" };
      }
      if (what === "file") {
        return { source: token, label: "files only", test: (e) => e.kind !== "folder" };
      }
      if (what === "hidden") {
        return { source: token, label: "hidden only", test: (e) => e.hidden === true };
      }
      const kind = KIND_ALIASES[what];
      if (kind !== undefined) {
        return { source: token, label: `kind is ${kind}`, test: (e) => e.kind === kind };
      }
      return textRule(token);
    }
    default:
      return textRule(token);
  }
}

/** Turn a rule around. Kept here so the label negates too. */
function negate(r: Rule, token: string): Rule {
  return { source: token, label: `not ${r.label}`, test: (e) => !r.test(e) };
}

/**
 * Read a filter line.
 *
 * `now` is a parameter rather than a call to the clock inside each rule so that
 * `after:today` means the same thing for every file in one listing — a filter
 * evaluated per entry against a moving clock is a filter that can disagree with
 * itself halfway down a folder.
 */
export function parse(text: string | undefined, now: number = Date.now()): Query {
  const tokens = tokenize(text ?? "");
  const rules: Rule[] = [];
  for (const token of tokens) {
    const neg = token.startsWith("-") || token.startsWith("!");
    const body = neg ? token.slice(1) : token;
    if (body === "") continue;
    const rule = ruleFor(body, now);
    rules.push(neg ? negate(rule, token) : rule);
  }
  return { rules, empty: rules.length === 0 };
}

export function matches(e: FileEntry, q: Query): boolean {
  for (const r of q.rules) if (!r.test(e)) return false;
  return true;
}

/** Everything that survives. Returns the input array untouched when empty. */
export function apply(entries: FileEntry[], q: Query): FileEntry[] {
  return q.empty ? entries : entries.filter((e) => matches(e, q));
}

/** What the filter is doing, for the status bar. "" when it is doing nothing. */
export function describe(q: Query): string {
  return q.rules.map((r) => r.label).join(" · ");
}

/**
 * Ready-made filters, offered in the menu next to the box.
 *
 * These are plain query strings rather than a special kind of object, so
 * picking one drops its text into the box where it can then be edited — which
 * is how anybody learns the syntax without being taught it.
 */
export const PRESETS: ReadonlyArray<{ name: string; query: string }> = [
  { name: "Pictures", query: "kind:image" },
  { name: "Videos", query: "kind:video" },
  { name: "Audio", query: "kind:audio" },
  { name: "Documents", query: "kind:document" },
  { name: "Folders only", query: "is:folder" },
  { name: "Big files (over 100 MB)", query: "size:>100mb" },
  { name: "Changed today", query: "modified:today" },
  { name: "Changed this week", query: "modified:7d" },
];
