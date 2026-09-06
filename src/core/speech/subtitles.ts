/**
 * Subtitles: cues, the arithmetic that turns a transcript into readable ones,
 * and the two file formats everything on earth accepts.
 *
 * A transcript and a subtitle track are not the same document. A transcript is
 * read at whatever speed the reader likes, so its unit is the paragraph. A
 * subtitle is read in the gap between looking at it and looking back at the
 * picture, so its unit is "as much as a person can take in before it goes
 * away". That gap is roughly two lines of about forty characters, held for at
 * least a second and no more than seven, at a reading rate somewhere near
 * seventeen characters a second. Those four numbers are the whole craft, and
 * every one of them is arithmetic — which is why this file has no imports
 * beyond the transcript types, loads no model, and touches no DOM.
 *
 * The parser is deliberately one function for both formats. SRT and WebVTT
 * differ in a header line, a decimal separator, and a pile of positioning
 * syntax nobody writing a subtitle by hand ever uses; a tolerant reader that
 * accepts either is smaller than two strict ones and fails on less. The
 * writers stay separate, because what you *emit* should be exactly one format.
 */

import type { Segment, Word } from "./transcript";

/**
 * One subtitle: a span of time and the lines shown during it.
 *
 * `lines` rather than a single string with newlines in it, because every
 * question worth asking about a cue — is a line too long, are there too many
 * of them, where does it break — is a question about the lines, and a string
 * that has to be split before each of those questions is a string that will
 * eventually be split differently in two places.
 *
 * `speaker` carries through from the transcript so an editor can colour the
 * cue and so a re-render can put the name back; it is null for imported files
 * and for transcripts nobody asked to label.
 */
export interface Cue {
  index: number;
  start: number;
  end: number;
  lines: string[];
  speaker: string | null;
}

/** How names are written into the cue text when the transcript has them. */
export type NameStyle = "never" | "change" | "always";

export interface CueOptions {
  /** Longest line, in characters. 42 is the usual broadcast ceiling. */
  chars?: number;
  /** Most lines in one cue. Three is legal and two is readable. */
  lines?: number;
  /** Shortest a cue may be held, in seconds — below this it reads as a flash. */
  min?: number;
  /** Longest a cue may be held. Past this the eye has read it and gone back. */
  max?: number;
  /** Characters a second the reader is assumed to manage. */
  rate?: number;
  /** Blank time left between consecutive cues, so they don't look like one. */
  gap?: number;
  /**
   * A silence this long ends a cue even mid-sentence. Without it a cue whose
   * words straddle a pause is displayed over the pause, which reads as the
   * subtitle being late for the second half.
   */
  pause?: number;
  /** When to write the speaker's name into the cue. */
  names?: NameStyle;
}

/**
 * The defaults, in one object so a caller can spread it, a harness can assert
 * against it, and the settings panel has something to reset to.
 */
export const STYLE: Required<CueOptions> = {
  chars: 42,
  lines: 2,
  min: 1,
  max: 7,
  rate: 17,
  gap: 0.08,
  pause: 1.2,
  names: "change",
};

/** Never emit a cue shorter than this, even when the next one crowds it. */
const FLASH = 0.2;

const clean = (n: number): number => (Number.isFinite(n) ? n : 0);

/** Code points, not UTF-16 units: an emoji is one character to a reader. */
const len = (s: string): number => [...s].length;

/** Ends a sentence — the best place in the world to end a cue. */
const ENDS_SENTENCE = /[.!?…]["'”’)\]]?$/;

/** Ends a clause — the second best place. */
const ENDS_CLAUSE = /[,;:—–-]$/;

/** Punctuation that closes up against the word before it when words are joined. */
const HUGS_LEFT = /^[,.!?;:…%)\]}’”]/;

/* ─────────────────────────  transcript → cues  ───────────────────────── */

/**
 * Turn a transcript into subtitles.
 *
 * The shape of the work is: cut the word stream wherever a cue *must* end
 * (speaker change, long silence), pack each resulting run into cues that fit
 * the reading budget, then settle the timings so nothing flashes, overstays,
 * or overlaps its neighbour.
 *
 * Segments without word timings are not a special case anywhere below —
 * `wordsOf` invents evenly-spread words for them, which is exactly as accurate
 * as the information available and keeps one code path instead of two.
 */
export function cuesFromSegments(
  segments: readonly Segment[],
  opts: CueOptions = {},
): Cue[] {
  const o = { ...STYLE, ...opts };
  const runs = runsOf(segments, o);

  const cues: Cue[] = [];
  let shown: string | null = null;

  for (const run of runs) {
    const lead = prefixFor(run.speaker, shown, o);
    if (run.speaker !== null) shown = run.speaker;

    let first = true;
    for (const chunk of chunkWords(run.words, lead, o)) {
      const text = (first ? lead : "") + joinWords(chunk);
      first = false;
      const start = chunk[0]?.start ?? 0;
      const end = chunk[chunk.length - 1]?.end ?? start;
      cues.push({
        index: cues.length + 1,
        start,
        end: Math.max(end, start),
        lines: wrapLines(text, o.chars, o.lines),
        speaker: run.speaker,
      });
    }
  }

  return settle(cues, o);
}

/** A stretch of words that must live in cues of its own. */
interface Run {
  speaker: string | null;
  words: Word[];
}

/**
 * Cut the transcript wherever a cue is not allowed to continue: a change of
 * speaker, and any silence longer than `pause`.
 *
 * Two people's words in one cue is a real subtitle convention — the one with
 * a dash in front of each line — but it is only worth having when the two
 * turns are a second apart, and getting that judgement wrong puts words in
 * the wrong person's mouth. One speaker per cue is never wrong.
 */
function runsOf(segments: readonly Segment[], o: Required<CueOptions>): Run[] {
  const runs: Run[] = [];
  let prevEnd = -Infinity;

  for (const seg of segments) {
    for (const w of wordsOf(seg)) {
      let cur = runs[runs.length - 1];
      if (!cur || cur.speaker !== seg.speaker || w.start - prevEnd > o.pause) {
        cur = { speaker: seg.speaker, words: [] };
        runs.push(cur);
      }
      cur.words.push(w);
      prevEnd = w.end;
    }
  }

  return runs.filter((r) => r.words.length > 0);
}

/**
 * A segment's words — or, when the model was not asked for word timings,
 * words invented by spreading the segment's span across its text in
 * proportion to how long each word is.
 *
 * Proportional rather than equal: "a" and "extraordinarily" do not take the
 * same time to say, and length is the only evidence available here.
 */
export function wordsOf(seg: Segment): Word[] {
  if (seg.words.length > 0) return seg.words.filter((w) => w.text.trim() !== "");

  const parts = seg.text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];

  const total = parts.reduce((n, p) => n + len(p), 0) || 1;
  const span = Math.max(0, clean(seg.end) - clean(seg.start));
  const out: Word[] = [];
  let at = clean(seg.start);
  for (const p of parts) {
    const take = (span * len(p)) / total;
    out.push({ start: at, end: at + take, text: p });
    at += take;
  }
  return out;
}

/** The name to write in front of a run's first cue, if any. */
function prefixFor(
  speaker: string | null,
  shown: string | null,
  o: Required<CueOptions>,
): string {
  if (speaker === null || o.names === "never") return "";
  if (o.names === "change" && speaker === shown) return "";
  return `${speaker}: `;
}

/**
 * Pack a run's words into cue-sized pieces.
 *
 * Greedy, then backed off to the nearest good break. Greedy alone fills every
 * cue to the brim and cuts sentences two words from the end; the back-off is
 * what makes the output read like subtitles rather than like a paragraph
 * chopped at column 84.
 */
function chunkWords(
  words: readonly Word[],
  lead: string,
  o: Required<CueOptions>,
): Word[][] {
  const out: Word[][] = [];
  let rest = words;
  let head = lead;

  while (rest.length > 0) {
    const cut = takePrefix(rest, head, o);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    head = "";
  }
  return out;
}

/**
 * How many of these words belong in the next cue: as many as fit, then pulled
 * back to a sentence end or a clause end if there is one far enough along to
 * be worth using.
 */
function takePrefix(
  words: readonly Word[],
  lead: string,
  o: Required<CueOptions>,
): number {
  const first = words[0];
  if (!first) return 0;

  let n = 1;
  while (n < words.length) {
    const next = words.slice(0, n + 1);
    const last = next[n];
    if (!last) break;
    if (last.end - first.start > o.max) break;
    if (!fits(lead + joinWords(next), o)) break;
    n += 1;
  }

  // Back off, but never so far that a cue holds a word or two. Half the
  // available words for a sentence end, three fifths for a mere comma: a
  // clause break has to earn more, because breaking there mid-sentence is
  // only better than breaking arbitrarily, not good.
  const sentence = lastMatch(words, n, ENDS_SENTENCE, Math.ceil(n / 2));
  if (sentence > 0) return sentence;
  const clause = lastMatch(words, n, ENDS_CLAUSE, Math.ceil(n * 0.6));
  if (clause > 0) return clause;
  return n;
}

/** The largest cut ≤ `n` and ≥ `least` whose last word matches — 0 if none. */
function lastMatch(
  words: readonly Word[],
  n: number,
  re: RegExp,
  least: number,
): number {
  for (let cut = n; cut >= Math.max(1, least); cut--) {
    if (cut === words.length) continue; // no break needed; the run just ends
    const w = words[cut - 1];
    if (w && re.test(w.text.trim())) return cut;
  }
  return 0;
}

/** Words to text, with punctuation closed up against what it follows. */
export function joinWords(words: readonly Word[]): string {
  let out = "";
  for (const w of words) {
    const t = w.text.trim();
    if (!t) continue;
    if (!out) out = t;
    else out = HUGS_LEFT.test(t) ? out + t : `${out} ${t}`;
  }
  return out;
}

/** Does this text wrap inside the budget? */
function fits(text: string, o: Required<CueOptions>): boolean {
  const lines = wrapLines(text, o.chars, o.lines);
  if (lines.length > o.lines) return false;
  // A single word longer than the line is over budget and there is nothing to
  // be done about it, so it is not a reason to reject the cue.
  return lines.every((l) => len(l) <= o.chars || !l.includes(" "));
}

/* ─────────────────────────────  wrapping  ────────────────────────────── */

/**
 * What a line ending on punctuation is worth, in units of squared slack.
 *
 * 40 buys about nine characters of imbalance: a break after a comma wins
 * unless it leaves the two lines more than nine characters apart. That is the
 * right way round — a reader notices a line broken mid-phrase long before
 * they notice two lines of slightly different length.
 */
const PUNCT_BONUS = 40;

/**
 * Break text into lines: as few as will hold it, and as close to equal length
 * as that allows.
 *
 * Balanced rather than filled. A filled wrap gives "forty-one characters of
 * text followed by" / "one" — which is legal, fits the budget, and looks like
 * a mistake. Nobody notices a balanced break, which is the entire goal.
 *
 * Exact-k dynamic programming rather than a heuristic because a cue is a
 * dozen words and three lines at the very most; the whole table is smaller
 * than the argument for approximating it.
 */
export function wrapLines(text: string, chars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const width = (a: number, b: number): number => {
    let n = b - a - 1;
    for (let i = a; i < b; i++) n += len(words[i] ?? "");
    return n;
  };

  const greedy = fill(words, chars, width);
  const k = greedy.length;
  // Over budget already: hand back the greedy fill so the caller can see how
  // badly, rather than pretending a balanced version of an impossible wrap.
  if (k > maxLines || k <= 1) return greedy.map((r) => words.slice(r[0], r[1]).join(" "));

  const total = width(0, words.length);
  const avg = total / k;
  const n = words.length;
  const INF = Infinity;

  const cost = (a: number, b: number): number => {
    const w = width(a, b);
    if (w > chars && b - a > 1) return INF;
    const slack = (w - avg) * (w - avg);
    const tail = words[b - 1] ?? "";
    const nice = ENDS_SENTENCE.test(tail) || ENDS_CLAUSE.test(tail);
    return slack - (nice && b < n ? PUNCT_BONUS : 0);
  };

  // best[j][i] — cheapest way to put the first i words on j lines.
  const best: number[][] = Array.from({ length: k + 1 }, () => Array(n + 1).fill(INF));
  const from: number[][] = Array.from({ length: k + 1 }, () => Array(n + 1).fill(0));
  best[0]![0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n; i++) {
      for (let p = j - 1; p < i; p++) {
        const prev = best[j - 1]![p]!;
        if (prev === INF) continue;
        const c = prev + cost(p, i);
        if (c < best[j]![i]!) {
          best[j]![i] = c;
          from[j]![i] = p;
        }
      }
    }
  }

  if (best[k]![n] === INF) return greedy.map((r) => words.slice(r[0], r[1]).join(" "));

  const out: string[] = [];
  let i = n;
  for (let j = k; j >= 1; j--) {
    const p = from[j]![i]!;
    out.unshift(words.slice(p, i).join(" "));
    i = p;
  }
  return out;
}

/** Fewest lines, filled left to right — the baseline the balancer improves on. */
function fill(
  words: readonly string[],
  chars: number,
  width: (a: number, b: number) => number,
): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= words.length; i++) {
    if (width(start, i) > chars && i - start > 1) {
      rows.push([start, i - 1]);
      start = i - 1;
    }
  }
  rows.push([start, words.length]);
  return rows;
}

/* ─────────────────────────────  timings  ─────────────────────────────── */

/**
 * Fix up the timings so the track is watchable: hold each cue long enough to
 * be read, never past its welcome, and never on top of the next one.
 *
 * Only the end moves. Pulling a start earlier would put words on screen
 * before they are spoken, which is far more noticeable than a subtitle that
 * lingers a moment.
 */
function settle(cues: readonly Cue[], o: Required<CueOptions>): Cue[] {
  const out = cues.map((c) => ({ ...c }));
  for (let i = 0; i < out.length; i++) {
    const cue = out[i]!;
    const next = out[i + 1];
    const roomEnd = next ? next.start - o.gap : Infinity;
    const need = Math.max(o.min, cueChars(cue) / o.rate);

    let end = Math.max(cue.end, Math.min(cue.start + need, roomEnd));
    end = Math.min(end, roomEnd, cue.start + o.max);
    // Even a crowded cue gets a frame or two; a zero-length cue is invisible
    // and several players treat it as corrupt rather than as brief.
    end = Math.max(end, cue.start + FLASH);
    cue.end = end;
  }
  return renumber(out);
}

/* ─────────────────────────────  measuring  ───────────────────────────── */

/** Characters on screen, newlines not counted — what the reader has to get through. */
export function cueChars(cue: Cue): number {
  return cue.lines.reduce((n, l) => n + len(l), 0);
}

/** Characters a second this cue demands of the reader. */
export function cueRate(cue: Cue): number {
  const span = cue.end - cue.start;
  return span > 0 ? cueChars(cue) / span : Infinity;
}

/** The cue as one string, the way a player would show it. */
export function cueText(cue: Cue): string {
  return cue.lines.join("\n");
}

export type ProblemKind =
  | "empty"
  | "order"
  | "overlap"
  | "short"
  | "long"
  | "fast"
  | "wide"
  | "lines";

export interface Problem {
  /** Position in the array, not the cue's own number — arrays are what get fixed. */
  at: number;
  kind: ProblemKind;
  note: string;
}

/**
 * Everything wrong with a track, in the order a person would fix it.
 *
 * This is a linter, not a validator: a track full of `fast` cues still plays,
 * and a caller that generated cues from a fast talker may reasonably decide
 * to live with it. Nothing here refuses to export.
 */
export function problems(cues: readonly Cue[], opts: CueOptions = {}): Problem[] {
  const o = { ...STYLE, ...opts };
  const found: Problem[] = [];

  cues.forEach((cue, at) => {
    const say = (kind: ProblemKind, note: string): void => {
      found.push({ at, kind, note });
    };
    const span = cue.end - cue.start;

    if (cue.lines.every((l) => l.trim() === "")) say("empty", "no text");
    if (span <= 0) say("order", "ends before it starts");
    else {
      if (span < o.min - 1e-6) say("short", `on screen for ${span.toFixed(2)}s`);
      if (span > o.max + 1e-6) say("long", `on screen for ${span.toFixed(1)}s`);
      const rate = cueRate(cue);
      if (rate > o.rate * 1.35) {
        say("fast", `${Math.round(rate)} characters a second`);
      }
    }

    const prev = cues[at - 1];
    if (prev && cue.start < prev.end - 1e-6) say("overlap", "starts before the one before it ends");

    if (cue.lines.length > o.lines) say("lines", `${cue.lines.length} lines`);
    const widest = Math.max(0, ...cue.lines.map(len));
    if (widest > o.chars) say("wide", `${widest} characters on one line`);
  });

  return found;
}

/* ─────────────────────────────  editing  ────────────────────────────── */

/** Numbered from one, in time order. Every function that returns cues ends here. */
export function renumber(cues: readonly Cue[]): Cue[] {
  return [...cues]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((c, i) => ({ ...c, index: i + 1 }));
}

/**
 * Move every cue by `by` seconds — the fix for a track that is a beat late
 * the whole way through, which is most of what subtitle editing actually is.
 *
 * Cues pushed before zero are clamped rather than dropped: a person nudging a
 * track backwards is not asking to lose the first line.
 */
export function shiftCues(cues: readonly Cue[], by: number): Cue[] {
  return renumber(
    cues.map((c) => {
      const start = Math.max(0, c.start + by);
      return { ...c, start, end: Math.max(start + FLASH, c.end + by) };
    }),
  );
}

/**
 * Scale every time by `factor` — the fix for a track cut for 25 fps played
 * back at 23.976, where the drift grows the further in you get.
 */
export function stretchCues(cues: readonly Cue[], factor: number): Cue[] {
  const f = factor > 0 && Number.isFinite(factor) ? factor : 1;
  return renumber(
    cues.map((c) => ({ ...c, start: c.start * f, end: Math.max(c.start * f + FLASH, c.end * f) })),
  );
}

/** Join a cue to the one after it. Out-of-range indexes change nothing. */
export function mergeCues(
  cues: readonly Cue[],
  at: number,
  opts: CueOptions = {},
): Cue[] {
  const a = cues[at];
  const b = cues[at + 1];
  if (!a || !b) return renumber(cues);
  const o = { ...STYLE, ...opts };

  const merged: Cue = {
    index: a.index,
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    lines: wrapLines(`${cueText(a)} ${cueText(b)}`.replace(/\s+/g, " "), o.chars, o.lines),
    speaker: a.speaker,
  };
  return renumber([...cues.slice(0, at), merged, ...cues.slice(at + 2)]);
}

/**
 * Cut a cue in two at `when`.
 *
 * The text is divided in proportion to where the cut falls, on a word
 * boundary — there is no word-level timing left by the time a cue exists, so
 * proportion is the only evidence, and it is the same evidence the cue was
 * built from in the first place.
 */
export function splitCue(
  cues: readonly Cue[],
  at: number,
  when: number,
  opts: CueOptions = {},
): Cue[] {
  const cue = cues[at];
  if (!cue) return renumber(cues);
  const o = { ...STYLE, ...opts };

  const gap = o.gap;
  // Both halves must be able to exist; a cut in the first frame is a no-op.
  if (when <= cue.start + FLASH || when >= cue.end - FLASH - gap) return renumber(cues);

  const words = cueText(cue).split(/\s+/).filter(Boolean);
  if (words.length < 2) return renumber(cues);

  const share = (when - cue.start) / (cue.end - cue.start);
  const cut = Math.min(words.length - 1, Math.max(1, Math.round(words.length * share)));

  const head: Cue = {
    ...cue,
    end: when,
    lines: wrapLines(words.slice(0, cut).join(" "), o.chars, o.lines),
  };
  const tail: Cue = {
    ...cue,
    start: when + gap,
    lines: wrapLines(words.slice(cut).join(" "), o.chars, o.lines),
  };
  return renumber([...cues.slice(0, at), head, tail, ...cues.slice(at + 1)]);
}

/** Replace a cue's words, re-wrapped to the current style. */
export function setCueText(
  cues: readonly Cue[],
  at: number,
  text: string,
  opts: CueOptions = {},
): Cue[] {
  const cue = cues[at];
  if (!cue) return renumber(cues);
  const o = { ...STYLE, ...opts };
  const lines = wrapLines(text.replace(/\s+/g, " "), o.chars, o.lines);
  return renumber([...cues.slice(0, at), { ...cue, lines }, ...cues.slice(at + 1)]);
}

/** Move one cue's in and out points, keeping it non-degenerate. */
export function setCueTime(
  cues: readonly Cue[],
  at: number,
  start: number,
  end: number,
): Cue[] {
  const cue = cues[at];
  if (!cue) return renumber(cues);
  const s = Math.max(0, clean(start));
  return renumber([
    ...cues.slice(0, at),
    { ...cue, start: s, end: Math.max(s + FLASH, clean(end)) },
    ...cues.slice(at + 1),
  ]);
}

/** Drop a cue. */
export function removeCue(cues: readonly Cue[], at: number): Cue[] {
  if (at < 0 || at >= cues.length) return renumber(cues);
  return renumber([...cues.slice(0, at), ...cues.slice(at + 1)]);
}

/** Whichever cue is on screen at `when`, or null between cues. */
export function cueAt(cues: readonly Cue[], when: number): Cue | null {
  for (const c of cues) {
    if (when >= c.start && when < c.end) return c;
  }
  return null;
}

/* ─────────────────────────────  formats  ────────────────────────────── */

/**
 * `HH:MM:SS,mmm`, or with a full stop for WebVTT.
 *
 * Hours are always written even when zero. SRT parsers in the wild are
 * forgiving about a great many things and reliably strict about this one.
 */
export function timecode(seconds: number, dot = false): string {
  const t = Math.max(0, clean(seconds));
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${dot ? "." : ","}${pad(rest, 3)}`;
}

/**
 * Seconds from a timecode, or null if it isn't one.
 *
 * Accepts both decimal separators, an optional hour, and any number of
 * fractional digits — files written by hand have all of these.
 */
export function parseTime(text: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,6}))?\s*$/.exec(text);
  if (!m) {
    // Bare seconds, which WebVTT does not allow and some tools emit anyway.
    const plain = /^\s*(\d+(?:[.,]\d+)?)\s*$/.exec(text);
    return plain ? Number(plain[1]!.replace(",", ".")) : null;
  }
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return h * 3600 + min * 60 + sec + frac;
}

/** SubRip. The format every player, phone, and TV stick has understood since 2001. */
export function toSRT(cues: readonly Cue[]): string {
  return renumber(cues)
    .map((c) => `${c.index}\n${timecode(c.start)} --> ${timecode(c.end)}\n${cueText(c)}\n`)
    .join("\n");
}

/** WebVTT. What a `<track>` element wants, and the only one a browser will load. */
export function toVTT(cues: readonly Cue[]): string {
  const body = renumber(cues)
    .map(
      (c) =>
        `${c.index}\n${timecode(c.start, true)} --> ${timecode(c.end, true)}\n${cueText(c)}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/** Blocks that are structure, not subtitles. */
const NOT_A_CUE = /^(WEBVTT|NOTE|STYLE|REGION)\b/;

/**
 * Read SRT or WebVTT — whichever this is.
 *
 * Blocks without an arrow are skipped rather than treated as errors, which
 * disposes of the WEBVTT header, NOTE comments, STYLE blocks and stray blank
 * lines in one rule. A missing index line is fine; the numbering is rebuilt
 * from the times regardless, because a file with two cues both numbered 4 is
 * a real thing that turns up and is not worth refusing to open.
 */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0 || NOT_A_CUE.test(lines[0]!.trim())) continue;

    const arrow = lines.findIndex((l) => l.includes("-->"));
    if (arrow < 0) continue;

    const [left, right] = lines[arrow]!.split("-->");
    if (left === undefined || right === undefined) continue;
    const start = parseTime(left);
    // Everything after the end time is WebVTT cue settings (line:, align:,
    // position:). We render our own subtitles, so they are noise here.
    const end = parseTime(right.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null) continue;

    const body = lines.slice(arrow + 1);
    if (body.length === 0) continue;

    cues.push({
      index: cues.length + 1,
      start,
      end: Math.max(start + FLASH, end),
      lines: body,
      speaker: null,
    });
  }

  return labelSpeakers(renumber(cues));
}

/** A capitalised word or two, or "Speaker 3", in front of a colon. */
const LOOKS_LIKE_NAME =
  /^(?:-\s*)?(Speaker \d+|[\p{Lu}][\p{L}'’.-]*(?: [\p{Lu}][\p{L}'’.-]*)?):\s/u;

/**
 * Work out which cues are labelled with a speaker's name.
 *
 * The hard part is not finding `Something: ` at the front of a line — it is
 * that "Note: the tape runs out here" has exactly that shape and was not said
 * by anyone called Note. Judging a single line cannot separate the two, so
 * this judges the file: **a name is a label that recurs.** A person who is
 * worth labelling speaks more than once, and an editorial aside does not.
 *
 * Two exceptions, both unambiguous on sight: `Speaker 3`, which is what every
 * diarising tool including ours emits, and a name in capitals, which is the
 * broadcast convention and is never a sentence.
 */
function labelSpeakers(cues: readonly Cue[]): Cue[] {
  const seen = new Map<string, number>();
  const found = cues.map((c) => {
    const m = LOOKS_LIKE_NAME.exec(c.lines[0] ?? "");
    const name = m ? m[1]! : null;
    if (name) seen.set(name, (seen.get(name) ?? 0) + 1);
    return name;
  });

  const real = (name: string): boolean =>
    (seen.get(name) ?? 0) > 1 ||
    /^Speaker \d+$/.test(name) ||
    (name === name.toUpperCase() && /\p{L}/u.test(name));

  return cues.map((c, i) => {
    const name = found[i];
    return name && real(name) ? { ...c, speaker: name } : c;
  });
}

/** The file extension for a format, without the dot. */
export type SubtitleFormat = "srt" | "vtt";

/** Write cues in the named format. */
export function toSubtitles(cues: readonly Cue[], format: SubtitleFormat): string {
  return format === "vtt" ? toVTT(cues) : toSRT(cues);
}
