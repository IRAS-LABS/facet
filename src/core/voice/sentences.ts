/**
 * Where one sentence ends and the next begins (item 40).
 *
 * This is the unit the player skips by, highlights and resumes from, so it has
 * to be right on the documents people actually read. The naive rule — split on
 * `.`, `?`, `!` — produces garbage on exactly the kind of paper this feature
 * exists for: "Smith et al. (2019) showed", "see Fig. 3", "a 0.05 threshold",
 * "U.S. policy", "e.g. the second case". Every one of those is a mid-sentence
 * full stop, and every one of them makes the voice stop dead in the middle of
 * a clause and the highlight jump to the wrong place.
 *
 * So the rule here is the opposite way round: a full stop ends a sentence only
 * when nothing argues against it. The arguments are all local and cheap — what
 * the word before it was, what the character after it is — which is why this
 * file has no imports and can be checked exhaustively in a harness.
 *
 * Nothing here knows about voices, pages or the DOM. It takes a string and
 * returns offsets into that same string, so the caller keeps ownership of the
 * text and can map the offsets back onto whatever it drew.
 */

/** A sentence as offsets into the text it came from. `to` is exclusive. */
export interface Span {
  from: number;
  to: number;
}

/**
 * Words that take a full stop and keep going.
 *
 * Deliberately short and deliberately lower-cased at the comparison, because a
 * long list is a liability: every entry is a chance to swallow a real sentence
 * end. These are the ones that actually occur mid-sentence in academic prose
 * often enough to matter. Titles ("Dr", "Prof") are here because a paper's
 * acknowledgements are full of them.
 */
const ABBREVIATIONS = new Set([
  // Latin and citation
  "al", "cf", "e.g", "eg", "et", "etc", "i.e", "ie", "ibid", "viz", "vs", "v",
  // Structure references
  "fig", "figs", "eq", "eqs", "sec", "secs", "ch", "chap", "tab", "tabs",
  "ref", "refs", "pp", "p", "no", "nos", "vol", "vols", "ed", "eds", "app",
  // Titles
  "dr", "prof", "mr", "mrs", "ms", "st", "jr", "sr",
  // Units and months that appear with stops in older typography
  "approx", "est", "inc", "ltd", "co", "dept", "univ",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** Sentence-ending punctuation. */
const ENDERS = new Set([".", "!", "?", "…"]);

/**
 * Closers allowed to sit between the stop and the gap.
 *
 * `(Smith 2019.)` and `"...done."` both genuinely end there, and the quote or
 * bracket belongs to the sentence that is ending rather than the one starting.
 */
const CLOSERS = new Set(["\"", "'", "”", "’", ")", "]", "}", "»"]);

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();
const isSpace = (c: string): boolean => /\s/.test(c);

/**
 * The word immediately before an offset, lower-cased, stops stripped.
 *
 * "e.g." arrives here as "e.g" because the final stop is the one being judged;
 * that is why the abbreviation list spells it that way too.
 */
function wordBefore(text: string, at: number): string {
  let i = at;
  while (i > 0 && !isSpace(text[i - 1] as string)) i--;
  return text.slice(i, at).toLowerCase();
}

/** The next character that is not a space, and where it is. */
function nextNonSpace(text: string, from: number): { ch: string; at: number } {
  let i = from;
  while (i < text.length && isSpace(text[i] as string)) i++;
  return { ch: text[i] ?? "", at: i };
}

/**
 * Does the stop at `at` really end a sentence?
 *
 * The checks are ordered cheapest-first and each one only has to be right
 * about its own case. A stop survives all of them or it is not a boundary.
 */
function endsHere(text: string, at: number): boolean {
  const ch = text[at] as string;

  // A run of stops is one boundary, judged at its last character.
  if (ENDERS.has(text[at + 1] ?? "")) return false;

  if (ch === ".") {
    const before = wordBefore(text, at);

    // "0.05", "3.2 GHz", "v1.4" -- a stop between two digits is a decimal
    // point, never a sentence end.
    if (isDigit(text[at - 1] ?? "") && isDigit(text[at + 1] ?? "")) return false;

    // A known abbreviation. "et al." is the one that matters most: it ends
    // nearly every citation and is followed by a capital surname often enough
    // that the capital-letter test below cannot save us.
    if (ABBREVIATIONS.has(before)) return false;

    // A single initial: "J. Smith", "H. G. Wells". One letter before the stop,
    // and the letter is upper case.
    if (before.length === 1 && isUpper(text[at - 1] as string)) return false;

    // An acronym written with stops: "U.S.", "N.A.S.A.". Every other character
    // back to the space is a stop.
    if (/^(?:[a-z]\.)+[a-z]$/.test(before)) return false;

    // A numbered list or section marker at the start of a line: "3." or "4.2."
    if (/^\d+(?:\.\d+)*$/.test(before) && isLineStart(text, at - before.length)) return false;
  }

  // What comes next has to look like a new sentence.
  const after = nextNonSpace(text, skipClosers(text, at + 1));

  // End of the text is always a boundary.
  if (after.ch === "") return true;

  // No gap at all means it was not a boundary: "3.5", "www.example.com".
  if (after.at === at + 1) return false;

  // A lower-case letter after the gap says the sentence continued -- the stop
  // was doing some other job. A digit is allowed to start a sentence ("2019
  // saw..."), and so is any opening bracket or quote.
  if (/[a-z]/.test(after.ch)) return false;

  return true;
}

/** Walk past closing quotes and brackets that belong to the sentence ending. */
function skipClosers(text: string, from: number): number {
  let i = from;
  while (i < text.length && CLOSERS.has(text[i] as string)) i++;
  return i;
}

/** Is `at` the first non-space character of its line? */
function isLineStart(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i] as string;
    if (c === "\n") return true;
    if (!isSpace(c)) return false;
  }
  return true;
}

/**
 * Split text into sentences.
 *
 * Returns spans rather than strings so the caller can highlight the original
 * without searching for the text again -- searching would find the wrong copy
 * the moment a sentence repeats, which in a paper's method section it does.
 *
 * Text with no terminal punctuation at all -- a heading, a table cell, a line
 * of a bulleted list -- comes back as one span covering the whole thing, which
 * is the right unit to skip by for those.
 */
export function sentences(text: string): Span[] {
  const out: Span[] = [];
  let from = 0;

  for (let i = 0; i < text.length; i++) {
    if (!ENDERS.has(text[i] as string)) continue;
    if (!endsHere(text, i)) continue;

    const to = skipClosers(text, i + 1);
    const span = trim(text, from, to);
    if (span) out.push(span);
    from = to;
  }

  const last = trim(text, from, text.length);
  if (last) out.push(last);
  return out;
}

/** Narrow a span to its non-space content; null if there is none. */
function trim(text: string, from: number, to: number): Span | null {
  let a = from;
  let b = to;
  while (a < b && isSpace(text[a] as string)) a++;
  while (b > a && isSpace(text[b - 1] as string)) b--;
  return b > a ? { from: a, to: b } : null;
}

/**
 * Break a span that is too long to be one utterance.
 *
 * A voice has to be interruptible and the highlight has to keep up, and both
 * get worse the longer the chunk. Some prose genuinely runs three hundred
 * characters without a full stop -- legal text and older academic writing do
 * it constantly -- so a hard ceiling is needed on top of the sentence rule.
 *
 * Splitting happens at the weakest punctuation available (semicolon, then
 * colon, then comma) nearest the middle, and only at a real clause boundary.
 *
 * When there is no punctuation at all to split on, the span is still split, at
 * the space nearest the middle. That case is not hypothetical: text lifted off
 * a scan loses commas constantly, and a whole paragraph can arrive as one
 * unpunctuated run. Left whole it would be one utterance -- one highlight
 * sitting on four hundred characters, and a stop button that does nothing
 * until it finishes -- which is worse than a pause in a slightly odd place.
 * The break is never inside a word.
 */
export function chunk(text: string, span: Span, max: number): Span[] {
  if (span.to - span.from <= max) return [span];

  for (const marks of [[";"], [":"], [","], [" "]]) {
    const at = bestBreak(text, span, marks);
    if (at > 0) {
      return [
        ...chunk(text, { from: span.from, to: at }, max),
        ...chunk(text, { from: at, to: span.to }, max),
      ];
    }
  }
  return [span];
}

/** The break nearest the middle, among the marks given, or -1. */
function bestBreak(text: string, span: Span, marks: string[]): number {
  const middle = (span.from + span.to) / 2;
  let best = -1;
  let closest = Infinity;

  const onSpace = marks[0] === " ";

  for (let i = span.from + 1; i < span.to - 1; i++) {
    if (onSpace ? !isSpace(text[i] as string) : !marks.includes(text[i] as string)) continue;
    // A mark ends a clause only when a gap follows it. A space *is* the gap,
    // so applying that test to the fallback would reject every candidate.
    if (!onSpace && !isSpace(text[i + 1] ?? "")) continue;

    // Both halves have to be worth having. A comma four characters in is a
    // list marker, not a clause boundary.
    const left = i + 1 - span.from;
    const right = span.to - (i + 1);
    if (left < 24 || right < 24) continue;

    const d = Math.abs(i - middle);
    if (d < closest) {
      closest = d;
      best = i + 1;
    }
  }
  return best;
}
