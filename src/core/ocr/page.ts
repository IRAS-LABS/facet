/**
 * Recognised text on a page — reading order, paragraphs, search and hit
 * testing (item 32).
 *
 * OCR gives you words with boxes. It does not give you a *document*: the
 * difference between a heap of recognised words and something a person can
 * read, copy and search is entirely in the geometry, and that is what this
 * file is. The engine's job ends at "there is the word `Invoice` at (412, 96)
 * and I am 94% sure"; everything after that — which column it belongs to,
 * which paragraph, whether the hyphen at the end of the line is part of the
 * word or part of the layout — is arithmetic on rectangles, and so it is here,
 * where it can be checked exhaustively without an engine.
 *
 * The one thing worth stating up front, because it drives the whole design:
 * **reading order is not top-to-bottom.** A two-column page read top-to-bottom
 * interleaves two unrelated arguments line by line and produces text that is
 * word-for-word correct and completely useless. Getting this right is most of
 * the value of an OCR feature, and getting it wrong is invisible in a
 * screenshot — the boxes all look perfect.
 *
 * Nothing here imports the engine. `fromRaw` takes the shape tesseract.js
 * happens to return, but it takes it structurally, so the model can be tested
 * against hand-built pages and a different engine could be swapped in behind
 * it without touching a line of this.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrWord {
  text: string;
  box: Box;
  /** 0–100, as every OCR engine reports it. */
  confidence: number;
}

export interface OcrLine {
  words: OcrWord[];
  box: Box;
  confidence: number;
}

export interface OcrBlock {
  lines: OcrLine[];
  box: Box;
}

export interface OcrPage {
  /** Pixels of the image that was recognised — boxes are in this space. */
  width: number;
  height: number;
  blocks: OcrBlock[];
  confidence: number;
  /** What the engine had to rotate to read it, in degrees, or 0. */
  angle: number;
  language: string;
}

/** A scan is usually several pages, and they are read in order. */
export interface OcrDoc {
  pages: OcrPage[];
  source: string;
}

export interface TextOptions {
  /** Follow columns rather than scanning across them. On, always, unless testing. */
  columns?: boolean;
  /** Rejoin words a line break split with a hyphen. */
  dehyphenate?: boolean;
  /** Blank line between paragraphs rather than between blocks. */
  paragraphs?: boolean;
  /** Drop words the engine was less sure of than this. 0 keeps everything. */
  minConfidence?: number;
}

export const TEXT: Required<TextOptions> = {
  columns: true,
  dehyphenate: true,
  paragraphs: true,
  minConfidence: 0,
};

/**
 * A gutter has to be this wide, as a fraction of the page, to be believed.
 *
 * Too small and the space between two words in a heading reads as a column
 * break; too large and a genuine three-column layout collapses. Four per cent
 * of the width is about a centimetre on A4, which is narrower than any real
 * column gap and wider than any word space.
 */
const GUTTER = 0.04;

/**
 * A block this wide is treated as spanning the page rather than living in a
 * column — a headline, a rule, a full-width table.
 *
 * These are what make naive column detection fail: one headline across the top
 * of a two-column page overlaps the gutter, the gutter disappears, and the
 * whole page degrades to top-to-bottom. So they are pulled out first and used
 * as horizontal dividers instead, which is also how a person reads them.
 */
const FULL_WIDTH = 0.7;

// ── Rectangles ──────────────────────────────────────────────────────────────

export const boxOf = (boxes: readonly Box[]): Box => {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

export const contains = (box: Box, x: number, y: number): boolean =>
  x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;

export const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The same rectangle in another space — image pixels to displayed pixels. */
export const mapBox = (box: Box, from: { width: number; height: number }, to: { width: number; height: number }): Box => {
  const sx = from.width === 0 ? 0 : to.width / from.width;
  const sy = from.height === 0 ? 0 : to.height / from.height;
  return { x: box.x * sx, y: box.y * sy, w: box.w * sx, h: box.h * sy };
};

/**
 * The whole page in another space, boxes and all.
 *
 * Used to undo the upscaling the engine does to a low-resolution scan: the
 * recognition happens at 2× or 3×, and every box comes back in that space. If
 * they were left there the overlay would sit at two or three times the size of
 * the picture it is meant to be annotating — and, because the words would
 * still be *correct*, it would look like a rendering bug rather than a units
 * mistake.
 */
export function rescale(page: OcrPage, to: { width: number; height: number }): OcrPage {
  const from = { width: page.width, height: page.height };
  const move = (b: Box): Box => mapBox(b, from, to);
  return {
    ...page,
    width: to.width,
    height: to.height,
    blocks: page.blocks.map((block) => ({
      box: move(block.box),
      lines: block.lines.map((line) => ({
        ...line,
        box: move(line.box),
        words: line.words.map((w) => ({ ...w, box: move(w.box) })),
      })),
    })),
  };
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
};

// ── Reading order ───────────────────────────────────────────────────────────

/**
 * Blocks in the order a person would read them.
 *
 * Three passes, and the order of the passes is the whole trick:
 *
 * 1. Pull out the blocks that span the page. They are dividers, not content in
 *    a column, and leaving them in destroys the gutter that everything else
 *    depends on.
 * 2. Cut the page into horizontal bands at those dividers. A headline half way
 *    down a page starts a new set of columns underneath it — which is exactly
 *    what a magazine does and what a naive detector gets wrong.
 * 3. Inside each band, find the vertical gutters and read the columns left to
 *    right, each top to bottom.
 *
 * Right-to-left scripts are not handled and the language is not consulted;
 * `language` is carried on the page so this is a change in one place when it
 * matters, rather than a wrong assumption spread through the file.
 */
export function readingOrder(page: OcrPage): OcrBlock[] {
  const blocks = page.blocks.filter((b) => b.lines.length > 0);
  if (blocks.length < 2) return blocks;

  const wide = blocks.filter((b) => b.box.w >= page.width * FULL_WIDTH);
  const rest = blocks.filter((b) => b.box.w < page.width * FULL_WIDTH);
  if (rest.length === 0) return byY(blocks);

  // Bands, split at each spanning block.
  const cuts = byY(wide);
  const out: OcrBlock[] = [];
  let from = -Infinity;
  for (const cut of [...cuts, null]) {
    const to = cut ? cut.box.y : Infinity;
    const band = rest.filter((b) => centreY(b) >= from && centreY(b) < to);
    out.push(...columns(band, page.width));
    if (cut) {
      out.push(cut);
      from = cut.box.y + cut.box.h;
    }
  }
  return out;
}

const centreY = (b: OcrBlock): number => b.box.y + b.box.h / 2;
const byY = (bs: readonly OcrBlock[]): OcrBlock[] => [...bs].sort((a, b) => a.box.y - b.box.y);

/**
 * Split a band into columns at any vertical strip no block crosses.
 *
 * The complement of the blocks' x-intervals, taken across the band's own
 * extent rather than the page's: a page with a wide left margin has a large
 * empty strip at x = 0, and reading that as a column boundary would put every
 * block in "column two" and change nothing except by accident.
 */
function columns(band: readonly OcrBlock[], pageWidth: number): OcrBlock[] {
  if (band.length < 2) return byY(band);

  const spans = [...band]
    .map((b) => ({ from: b.box.x, to: b.box.x + b.box.w }))
    .sort((a, b) => a.from - b.from);

  const gaps: Array<{ from: number; to: number }> = [];
  let reach = spans[0]?.to ?? 0;
  for (const s of spans.slice(1)) {
    if (s.from - reach >= pageWidth * GUTTER) gaps.push({ from: reach, to: s.from });
    reach = Math.max(reach, s.to);
  }
  if (gaps.length === 0) return byY(band);

  // Cut at the middle of every gutter, left to right.
  const edges = [-Infinity, ...gaps.map((g) => (g.from + g.to) / 2), Infinity];
  const out: OcrBlock[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i] ?? -Infinity;
    const to = edges[i + 1] ?? Infinity;
    out.push(...byY(band.filter((b) => {
      const c = b.box.x + b.box.w / 2;
      return c >= from && c < to;
    })));
  }
  return out;
}

// ── Paragraphs ──────────────────────────────────────────────────────────────

/**
 * Split a block's lines where the spacing says a paragraph ended.
 *
 * Measured against the block's own median line pitch rather than an absolute
 * number of pixels, because the only thing that generalises across a 150 dpi
 * fax and a 600 dpi scan is the ratio. A gap half again as large as the usual
 * one is a paragraph break in every typographic tradition I can find, and it
 * is comfortably clear of the jitter OCR introduces in baseline positions.
 */
export function paragraphsOf(block: OcrBlock): OcrLine[][] {
  const lines = [...block.lines].sort((a, b) => a.box.y - b.box.y);
  if (lines.length < 2) return lines.length ? [lines] : [];

  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    pitches.push((lines[i]?.box.y ?? 0) - (lines[i - 1]?.box.y ?? 0));
  }
  const usual = median(pitches);

  const out: OcrLine[][] = [];
  let run: OcrLine[] = [lines[0] as OcrLine];
  for (let i = 1; i < lines.length; i++) {
    const gap = (lines[i]?.box.y ?? 0) - (lines[i - 1]?.box.y ?? 0);
    if (usual > 0 && gap > usual * 1.5) {
      out.push(run);
      run = [];
    }
    run.push(lines[i] as OcrLine);
  }
  out.push(run);
  return out;
}

/**
 * Join lines into a paragraph, undoing the hyphens the typesetter added.
 *
 * Only when the break looks mechanical: a hyphen at the very end of a line,
 * letters on both sides of it, and a lower-case letter starting the next line.
 * "Self-" / "employed" rejoins; "Anglo-" / "Saxon" does not, because the S is
 * a capital; and a dash used as punctuation keeps its space. There is no
 * dictionary here and there should not be — a wrong rejoin invents a word that
 * was never on the page, which is worse than a visible hyphen.
 */
export function joinLines(lines: readonly OcrLine[], dehyphenate = true): string {
  let out = "";
  lines.forEach((line, i) => {
    const text = lineText(line);
    if (i === 0) {
      out = text;
      return;
    }
    const next = text;
    if (dehyphenate && /[\p{L}]-$/u.test(out) && /^[\p{Ll}]/u.test(next)) {
      out = `${out.slice(0, -1)}${next}`;
    } else {
      out = `${out} ${next}`;
    }
  });
  return out;
}

export const lineText = (line: OcrLine): string =>
  line.words.map((w) => w.text).filter(Boolean).join(" ");

// ── The document ────────────────────────────────────────────────────────────

/** Everything recognised on the page, as text a person can read. */
export function pageText(page: OcrPage, opts: TextOptions = {}): string {
  const o = { ...TEXT, ...opts };
  const kept = o.minConfidence > 0 ? confident(page, o.minConfidence) : page;
  const blocks = o.columns ? readingOrder(kept) : byY(kept.blocks);

  const chunks: string[] = [];
  for (const block of blocks) {
    if (o.paragraphs) {
      for (const para of paragraphsOf(block)) {
        const text = joinLines(para, o.dehyphenate).trim();
        if (text) chunks.push(text);
      }
    } else {
      const text = joinLines([...block.lines].sort((a, b) => a.box.y - b.box.y), o.dehyphenate).trim();
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n\n");
}

/** The same, for every page, with a blank line and a rule between them. */
export function docText(doc: OcrDoc, opts: TextOptions = {}): string {
  return doc.pages
    .map((p, i) => {
      const body = pageText(p, opts);
      return doc.pages.length > 1 ? `— page ${i + 1} —\n\n${body}` : body;
    })
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

/**
 * The page with the words the engine was unsure of removed.
 *
 * Empty lines and blocks go with them, so nothing downstream has to keep
 * checking for a line that exists but has nothing in it. A word is dropped
 * rather than marked because the caller asked for text they can trust; the
 * original page is untouched and still there for the overlay, which is where
 * a doubtful word should be *shown* rather than silently deleted.
 */
export function confident(page: OcrPage, min: number): OcrPage {
  const blocks = page.blocks
    .map((b) => ({
      ...b,
      lines: b.lines
        .map((l) => ({ ...l, words: l.words.filter((w) => w.confidence >= min) }))
        .filter((l) => l.words.length > 0),
    }))
    .filter((b) => b.lines.length > 0);
  return { ...page, blocks };
}

/** Every word on the page, in reading order. */
export function wordsOf(page: OcrPage): OcrWord[] {
  return readingOrder(page).flatMap((b) =>
    paragraphsOf(b).flatMap((para) => para.flatMap((l) => l.words)),
  );
}

export const wordCount = (page: OcrPage): number => wordsOf(page).length;

/** The engine's own confidence, averaged over words rather than trusted flat. */
export function meanConfidence(page: OcrPage): number {
  const words = wordsOf(page);
  if (words.length === 0) return 0;
  return words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
}

// ── Pointing at it ──────────────────────────────────────────────────────────

/** The word under a point, in image pixels, or null. */
export function wordAt(page: OcrPage, x: number, y: number): OcrWord | null {
  for (const block of page.blocks) {
    if (!contains(block.box, x, y)) continue;
    for (const line of block.lines) {
      if (!contains(line.box, x, y)) continue;
      for (const word of line.words) {
        if (contains(word.box, x, y)) return word;
      }
    }
  }
  return null;
}

/**
 * Every word a dragged rectangle touches, in reading order.
 *
 * Touching, not containing: a marquee that only counts fully-enclosed words
 * drops the first and last word of a selection about half the time, and the
 * user's gesture was "from here to there", not "these exact rectangles".
 */
export function wordsInRect(page: OcrPage, rect: Box): OcrWord[] {
  return wordsOf(page).filter((w) => overlaps(w.box, rect));
}

export const textOfWords = (words: readonly OcrWord[]): string =>
  words.map((w) => w.text).join(" ");

// ── Finding things ──────────────────────────────────────────────────────────

export interface Match {
  /** Where in `pageText` the match starts — for highlighting the text pane. */
  at: number;
  text: string;
  /** The words it covers, for highlighting the image. */
  words: OcrWord[];
  box: Box;
}

/**
 * Find a phrase, across word boundaries, within a line.
 *
 * Deliberately not across lines: a phrase split by a line break is a real
 * match, but the box for it is two disjoint rectangles, and every renderer
 * downstream would need to handle a match that is a list of boxes rather than
 * one. The words are still individually searchable, and this keeps the common
 * case — someone hunting for an invoice number — exact and cheap.
 *
 * Matching folds case and treats any run of whitespace as one space, because
 * the space between two words in an OCR result is an artefact of the layout,
 * not something the user typed or can see.
 */
export function searchPage(page: OcrPage, query: string): Match[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!needle) return [];

  const out: Match[] = [];
  let at = 0;
  for (const block of readingOrder(page)) {
    // Sorted, like `wordsOf` and `paragraphsOf` do: the offsets below are into
    // the same text `pageText` produces, and they can only line up if both
    // walk the lines in the same order.
    for (const line of [...block.lines].sort((a, b) => a.box.y - b.box.y)) {
      const words = line.words;
      const text = words.map((w) => w.text).join(" ");
      const hay = text.toLowerCase();
      let from = 0;
      for (;;) {
        const found = hay.indexOf(needle, from);
        if (found < 0) break;
        const covered = wordsSpanning(words, found, found + needle.length);
        out.push({
          at: at + found,
          text: text.slice(found, found + needle.length),
          words: covered,
          box: boxOf(covered.map((w) => w.box)),
        });
        from = found + Math.max(1, needle.length);
      }
      at += text.length + 1;
    }
  }
  return out;
}

/** Which words a character range in a joined line touches. */
function wordsSpanning(words: readonly OcrWord[], from: number, to: number): OcrWord[] {
  const out: OcrWord[] = [];
  let at = 0;
  for (const w of words) {
    const end = at + w.text.length;
    if (at < to && end > from) out.push(w);
    at = end + 1;
  }
  return out;
}

// ── What is wrong with a scan ───────────────────────────────────────────────

export type ProblemKind = "empty" | "unsure" | "rotated" | "sparse" | "impossible";

export interface Problem {
  kind: ProblemKind;
  note: string;
}

/**
 * Tell the user why the result is disappointing, in the terms they can act on.
 *
 * OCR fails quietly and looks like it worked: a page scanned at 100 dpi comes
 * back with confident-looking boxes around confident-looking nonsense. The
 * user cannot tell that from a good result by looking at the text pane, so the
 * things that predict a bad run — nothing found, low mean confidence, a page
 * the engine had to rotate, a photo with three words on it — are said out loud
 * with the fix attached.
 */
export function problems(page: OcrPage): Problem[] {
  const out: Problem[] = [];
  const words = wordsOf(page);

  if (words.length === 0) {
    out.push({
      kind: "empty",
      note: "No text found. If the page is a photo, try again with it flat, filling the frame, and in even light.",
    });
    return out;
  }

  const mean = meanConfidence(page);
  if (mean < 70) {
    out.push({
      kind: "unsure",
      note: `Low confidence overall (${Math.round(mean)}%). Usually a scan under 300 dpi, or a photo taken at an angle.`,
    });
  }

  if (Math.abs(page.angle) > 1) {
    out.push({
      kind: "rotated",
      note: `The page was turned ${Math.round(page.angle)}° to read it. Straightening the original will improve the result.`,
    });
  }

  const area = page.width * page.height;
  if (area > 0 && words.length < 12 && area > 400_000) {
    out.push({
      kind: "sparse",
      note: `Only ${words.length} word${words.length === 1 ? "" : "s"} on a page this size — check it is the right side up and in focus.`,
    });
  }

  const spill = page.blocks.some(
    (b) => b.box.x + b.box.w > page.width * 1.02 || b.box.y + b.box.h > page.height * 1.02,
  );
  if (spill) {
    out.push({
      kind: "impossible",
      note: "Some text was placed outside the page — the result may be mis-aligned.",
    });
  }

  return out;
}

// ── In from an engine ───────────────────────────────────────────────────────

/**
 * The shape tesseract.js returns, described structurally.
 *
 * Taken as an interface rather than by importing its types so that this file
 * has no dependency on the engine at all: the harness builds these by hand,
 * and swapping the engine is a change to one function rather than to the model
 * underneath it. Every field is optional-tolerant because a real result has
 * `null` in more places than its own type declarations admit.
 */
export interface RawBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RawResult {
  blocks?: Array<{
    bbox?: RawBox;
    paragraphs?: Array<{
      lines?: Array<{
        bbox?: RawBox;
        confidence?: number;
        words?: Array<{ text?: string; bbox?: RawBox; confidence?: number }>;
      }>;
    }>;
  }> | null;
  confidence?: number;
  rotateRadians?: number | null;
}

const toBox = (b: RawBox | undefined): Box =>
  b ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : { x: 0, y: 0, w: 0, h: 0 };

/**
 * Normalise an engine result into a page.
 *
 * Paragraph nesting is flattened away: tesseract's paragraphs come from the
 * same spacing rule `paragraphsOf` applies, and keeping both means two
 * opinions about where a paragraph ends and no way to test either. Lines are
 * the unit that survives, because a line is a thing you can see on the page.
 *
 * Words with no text — the engine emits them for punctuation it discarded and
 * for regions it decided against — are dropped here rather than downstream,
 * since an empty word with a real box otherwise draws an empty highlight the
 * user can click on and select nothing with.
 */
export function fromRaw(
  raw: RawResult,
  size: { width: number; height: number },
  language = "eng",
): OcrPage {
  const blocks: OcrBlock[] = [];
  for (const b of raw.blocks ?? []) {
    const lines: OcrLine[] = [];
    for (const para of b.paragraphs ?? []) {
      for (const l of para.lines ?? []) {
        const words: OcrWord[] = (l.words ?? [])
          .map((w) => ({
            text: (w.text ?? "").trim(),
            box: toBox(w.bbox),
            confidence: w.confidence ?? 0,
          }))
          .filter((w) => w.text.length > 0);
        if (words.length === 0) continue;
        lines.push({
          words,
          box: l.bbox ? toBox(l.bbox) : boxOf(words.map((w) => w.box)),
          confidence: l.confidence ?? median(words.map((w) => w.confidence)),
        });
      }
    }
    if (lines.length === 0) continue;
    blocks.push({ lines, box: b.bbox ? toBox(b.bbox) : boxOf(lines.map((l) => l.box)) });
  }

  return {
    width: size.width,
    height: size.height,
    blocks,
    confidence: raw.confidence ?? 0,
    // Radians in, degrees out: nothing else in this app measures angles in
    // radians, and the number is going in front of a user in `problems`.
    angle: ((raw.rotateRadians ?? 0) * 180) / Math.PI,
    language,
  };
}

/** An empty page, for a run that found nothing or has not happened yet. */
export const blankPage = (width = 0, height = 0, language = "eng"): OcrPage => ({
  width,
  height,
  blocks: [],
  confidence: 0,
  angle: 0,
  language,
});
