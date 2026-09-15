/**
 * Reading the paper, not the furniture.
 *
 * A research paper read aloud straight through is close to unlistenable, and
 * not because the recognition is wrong. It is because a page carries a running
 * header, a page number, a journal name, a line-number gutter, figure captions
 * that interrupt mid-argument, footnotes that do the same, and forty pages of
 * references at the end. Hearing "Proceedings of the Thirty-Ninth Conference
 * on Neural Information Processing Systems 7" between every two paragraphs is
 * the single fastest way to stop listening.
 *
 * So this module classifies blocks and marks the furniture. Two rules govern
 * how it does it:
 *
 * It never deletes. Every block keeps its text and gains a `kind` and a `skip`
 * flag with a reason attached, so the reading-order overlay can show what was
 * dropped and why, and one tap puts it back. A cleanup you cannot see and
 * cannot undo is worse than no cleanup, because when it eats a real paragraph
 * -- and eventually it will -- there is no way to tell that it did.
 *
 * It prefers to under-clean. Every rule here needs corroborating evidence
 * across pages or an unambiguous marker. Hearing one stray page number is a
 * small annoyance; losing the first sentence of a section is a real one.
 */

import type { Box } from "../ocr/page";
import type { BlockKind, ReadBlock, ReadDoc } from "./doc";

/** Which of the optional drops are on. Items 10-13 are each a switch. */
export interface CleanOptions {
  /** Running headers and footers repeated across pages (item 8). */
  headers: boolean;
  /** Page numbers (item 9). */
  pageNumbers: boolean;
  /** Figure and table captions (item 10). */
  captions: boolean;
  /** The reference list (item 11). */
  references: boolean;
  /** Footnotes (item 12). */
  footnotes: boolean;
  /** Margin line numbers (item 13). */
  lineNumbers: boolean;
  /** Say "equation" rather than reading symbols (item 15). */
  equations: boolean;
  /** Section headings. Off by default -- most people want to hear these. */
  headings: boolean;
}

export const CLEAN: CleanOptions = {
  headers: true,
  pageNumbers: true,
  captions: false,
  references: true,
  footnotes: false,
  lineNumbers: true,
  equations: true,
  headings: false,
};

/** Bands of the page, as a fraction of its height. */
const TOP = 0.12;
const BOTTOM = 0.88;
/** A footnote sits below this and is set smaller than the body. */
const FOOT = 0.7;
/** A margin gutter is this narrow, as a fraction of page width. */
const MARGIN = 0.06;
/** A repeated line must appear on at least this many pages to be furniture. */
const REPEATS = 3;

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The same text with every run of digits blanked: "Page 7" and "Page 8" match. */
const shape = (s: string): string => norm(s).replace(/\d+/g, "#");

const isRoman = (s: string): boolean => /^[ivxlcdm]+$/i.test(s);

/** Nothing but a number, a roman numeral, or one of those with a word or dash. */
function looksLikePageNumber(text: string): boolean {
  const t = text.trim();
  if (t.length > 24) return false;
  if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(t)) return true;
  if (isRoman(t)) return true;
  return /^(page|p\.?|pg\.?)\s*\d{1,4}$/i.test(t) || /^\d{1,4}\s*(of|\/)\s*\d{1,4}$/i.test(t);
}

/** "Figure 3:", "Fig. 3.", "Table II", "Algorithm 1", "Listing 4". */
const CAPTION =
  /^(fig(?:ure)?s?|tab(?:le)?s?|alg(?:orithm)?s?|list(?:ing)?s?|exhibits?|charts?|plates?|schemes?|eq(?:uation)?s?)\.?\s*(\d+|[ivxlcdm]+)\b/i;

/** The heading that starts the reference list. */
const REFERENCE_HEAD =
  /^(references?|bibliography|works\s+cited|literature\s+cited|reference\s+list)\s*:?\s*$/i;

/** A heading that ends it again: an appendix or a supplement follows refs. */
const AFTER_REFERENCES = /^(appendix|appendices|supplement|supplementary|annex)\b/i;

/** A numbered or bracketed reference entry: "[12] A. Smith...", "12. Smith, A." */
const REFERENCE_ENTRY = /^(\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}\.)\s+\p{Lu}/u;

/** A footnote marker at the very start of a block. */
const FOOTNOTE_MARK = /^(\d{1,3}|[*†‡§¶])[).\s]/;

/** Median of a list. Returns 0 for an empty one. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

/** Typical word height in a block, as a stand-in for its font size. */
function textSize(block: ReadBlock): number {
  const hs = block.words.map((w) => w.box?.h ?? 0).filter((h) => h > 0);
  return median(hs);
}

/**
 * Is this block mostly symbols rather than words?
 *
 * A display equation recognised by OCR comes out as something like
 * "L(0) = -- E \sum_{i} log p 0 (y i | x i ) + A||0||2". Read aloud that is
 * forty seconds of noise in the middle of a sentence. The test is the ratio of
 * letters to everything else, plus a floor on length so that "(1)" -- the
 * equation's own number -- is caught by the short-block rules instead.
 */
function looksLikeEquation(text: string): boolean {
  const t = text.trim();
  if (t.length < 6) return false;

  const letters = (t.match(/\p{L}/gu) ?? []).length;
  const symbols = (t.match(/[=+\-*/^_<>|\\{}[\]()∀-⋿Ͱ-Ͽ∑∫√]/gu) ?? []).length;
  const digits = (t.match(/\p{Nd}/gu) ?? []).length;

  // Real prose is overwhelmingly letters. Anything where symbols and digits
  // together rival the letter count is not a sentence.
  if (letters === 0) return symbols + digits > 0;
  if (symbols < 2) return false;
  return (symbols + digits) / letters > 0.6;
}

/** Fraction of a block's words that are a bare integer. */
function numericShare(block: ReadBlock): number {
  if (block.words.length === 0) return 0;
  const n = block.words.filter((w) => /^\d{1,4}$/.test(w.text)).length;
  return n / block.words.length;
}

/** Where a block sits vertically on its page, 0 at the top, 1 at the bottom. */
function band(block: ReadBlock, size?: { width: number; height: number }): number {
  if (!block.box || !size || !size.height) return 0.5;
  return (block.box.y + block.box.h / 2) / size.height;
}

/** Is the block confined to a narrow left or right margin? */
function inMargin(box: Box | undefined, size?: { width: number; height: number }): boolean {
  if (!box || !size || !size.width) return false;
  if (box.w > size.width * MARGIN) return false;
  const left = box.x < size.width * MARGIN;
  const right = box.x + box.w > size.width * (1 - MARGIN);
  return left || right;
}

function mark(block: ReadBlock, kind: BlockKind, why: string, skip: boolean): void {
  block.kind = kind;
  block.why = why;
  block.skip = skip;
}

/**
 * Classify every block and apply the switches.
 *
 * Runs in place on the document and is safe to run again with different
 * options: it resets `kind`, `skip` and `why` first, so turning "references"
 * back on does not require rebuilding the document. Blocks the user changed by
 * hand carry `byHand` and are left exactly as they are -- a rule must never
 * overrule a correction the user made themselves, which is the whole reason
 * the flag exists.
 */
export function clean(doc: ReadDoc, opts: CleanOptions = CLEAN): ReadDoc {
  const free = doc.blocks.filter((b) => !b.byHand);
  for (const b of free) {
    b.kind = "body";
    b.skip = false;
    delete b.why;
  }

  classifyRepeats(doc, free);
  classifyPerBlock(doc, free);
  classifyReferences(doc, free);
  apply(free, opts);
  return doc;
}

/**
 * Running headers and footers (item 8).
 *
 * The evidence is repetition in the same band of the page across at least
 * three pages. Digits are blanked before comparing so that "Smith et al. 7"
 * and "Smith et al. 8" count as the same header, which they are.
 *
 * The band check is what stops this eating a real repeated sentence out of the
 * body -- a methods section that repeats a stock phrase on every page is not
 * sitting in the top 12% of the page every time, and a running header always
 * is.
 */
function classifyRepeats(doc: ReadDoc, blocks: ReadBlock[]): void {
  if (doc.pages < 2) return;

  const seen = new Map<string, { pages: Set<number>; blocks: ReadBlock[] }>();

  for (const b of blocks) {
    const where = band(b, doc.sizes[b.page]);
    if (where > TOP && where < BOTTOM) continue;
    if (b.words.length > 14) continue;

    const key = `${where < 0.5 ? "t" : "b"}:${shape(b.text)}`;
    if (!key.endsWith(":")) {
      const hit = seen.get(key) ?? { pages: new Set<number>(), blocks: [] };
      hit.pages.add(b.page);
      hit.blocks.push(b);
      seen.set(key, hit);
    }
  }

  // On a two- or three-page document, "on every page" is the best evidence
  // available and REPEATS would never be met.
  const need = Math.min(REPEATS, Math.max(2, doc.pages));

  for (const [key, hit] of seen) {
    if (hit.pages.size < need) continue;
    const top = key.startsWith("t");
    for (const b of hit.blocks) {
      mark(b, top ? "header" : "footer", `repeated on ${hit.pages.size} pages`, false);
    }
  }
}

/** The rules that need only one block to decide. */
function classifyPerBlock(doc: ReadDoc, blocks: ReadBlock[]): void {
  const sizes = blocks.map(textSize).filter((h) => h > 0);
  const body = median(sizes);

  for (const b of blocks) {
    const size = doc.sizes[b.page];
    const where = band(b, size);

    // Page numbers (item 9). Short, numeric, and in a margin band. All three
    // are required: "1" as a whole block in the middle of a page is a list
    // marker or a table cell, not a page number.
    if ((where < TOP || where > BOTTOM) && looksLikePageNumber(b.text)) {
      mark(b, "pageNumber", "page number", false);
      continue;
    }

    // Margin line numbers (item 13). A tall narrow strip of bare integers
    // pressed against the left or right edge -- journals and legal documents
    // set them this way, and OCR reads them as one column of digits.
    if (inMargin(b.box, size) && numericShare(b) > 0.8 && b.words.length >= 3) {
      mark(b, "lineNumber", "margin line numbers", false);
      continue;
    }

    // Text turned on its side in the margin: the arXiv stamp down the edge of
    // a preprint, a journal's copyright strip. It is a whole sentence of real
    // words, so no rule about numbers or repetition catches it, and left in
    // place it is read out in the middle of the abstract. The giveaway is the
    // shape -- as tall as a third of the page and as narrow as the margin.
    if (inMargin(b.box, size) && b.box && size && b.box.h > size.height * 0.2) {
      mark(b, "header", "turned margin text", false);
      continue;
    }

    // Captions (item 10).
    if (CAPTION.test(b.text)) {
      mark(b, "caption", "figure or table caption", false);
      continue;
    }

    // Equations (item 15).
    if (looksLikeEquation(b.text)) {
      mark(b, "equation", "mathematics", false);
      continue;
    }

    // Footnotes (item 12). Low on the page, marked, and set smaller than the
    // body text. The size test is the one that carries the weight: a numbered
    // list item at the bottom of a page looks identical without it.
    const small = body > 0 && textSize(b) > 0 && textSize(b) < body * 0.88;
    if (where > FOOT && small && FOOTNOTE_MARK.test(b.text)) {
      mark(b, "footnote", "footnote", false);
      continue;
    }

    // Headings. Short, no terminal punctuation, and either numbered or set
    // larger than the body.
    const big = body > 0 && textSize(b) > body * 1.12;
    const numbered = /^\d+(\.\d+)*\.?\s+\p{Lu}/u.test(b.text);
    if (b.words.length <= 12 && !/[.?!]$/.test(b.text.trim()) && (big || numbered)) {
      mark(b, "heading", "heading", false);
    }
  }
}

/**
 * The reference list (item 11).
 *
 * Anchored on the heading rather than on what the entries look like, because
 * entry formats vary wildly between fields and a format-only rule either
 * misses half of them or eats numbered lists in the body. Once the heading is
 * found, everything after it is a reference until an appendix heading appears.
 *
 * With no heading at all -- a scan that lost it, or a paper that never had one
 * -- the fallback is a run of at least four consecutive entry-shaped blocks in
 * the last third of the document. Four in a row is hard to produce by accident.
 */
function classifyReferences(doc: ReadDoc, blocks: ReadBlock[]): void {
  let from = -1;

  for (let i = 0; i < blocks.length; i++) {
    if (REFERENCE_HEAD.test((blocks[i] as ReadBlock).text.trim())) from = i;
  }

  if (from < 0) {
    let run = 0;
    for (let i = Math.floor(blocks.length * 0.66); i < blocks.length; i++) {
      if (REFERENCE_ENTRY.test((blocks[i] as ReadBlock).text)) {
        run++;
        if (run >= 4) {
          from = i - run + 1;
          break;
        }
      } else if ((blocks[i] as ReadBlock).kind === "body") {
        run = 0;
      }
    }
    if (from < 0) return;
  }

  for (let i = from; i < blocks.length; i++) {
    const b = blocks[i] as ReadBlock;
    if (i > from && AFTER_REFERENCES.test(b.text.trim())) break;
    if (b.kind === "header" || b.kind === "footer" || b.kind === "pageNumber") continue;
    mark(b, "reference", "reference list", false);
  }

  void doc;
}

/** Turn the switches into `skip` flags. */
function apply(blocks: ReadBlock[], opts: CleanOptions): void {
  const off: Partial<Record<BlockKind, boolean>> = {
    header: opts.headers,
    footer: opts.headers,
    pageNumber: opts.pageNumbers,
    caption: opts.captions,
    reference: opts.references,
    footnote: opts.footnotes,
    lineNumber: opts.lineNumbers,
    heading: opts.headings,
  };

  for (const b of blocks) {
    if (off[b.kind]) {
      b.skip = true;
      b.why ??= b.kind;
    }
  }
}

/**
 * What to actually say for a block.
 *
 * Equations are the only kind whose spoken text differs from its written text:
 * with the switch on, the voice says the word "equation" and moves on, which
 * is what a person reading aloud does. With it off the symbols are read, which
 * is occasionally what someone checking a derivation wants.
 */
export function spoken(block: ReadBlock, opts: CleanOptions = CLEAN): string {
  if (block.kind === "equation" && opts.equations) return "equation";
  return block.text;
}

/** A one-line summary of what was dropped, for the reader to show. */
export function summary(doc: ReadDoc): string {
  const counts = new Map<string, number>();
  for (const b of doc.blocks) {
    if (!b.skip) continue;
    counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return "Reading everything";

  const names: Partial<Record<string, string>> = {
    header: "headers",
    footer: "footers",
    pageNumber: "page numbers",
    caption: "captions",
    reference: "references",
    footnote: "footnotes",
    lineNumber: "line numbers",
    heading: "headings",
  };

  const parts = [...counts].map(([k, n]) => `${n} ${names[k] ?? k}`);
  return `Skipping ${parts.join(", ")}`;
}
