/**
 * The readable document: what the voice actually walks through.
 *
 * Everything that can be read aloud -- a scanned image, a PDF with a real text
 * layer, an HTML page, a plain text file -- is turned into this one shape, and
 * the player, the highlighter and the reading-order overlay only ever see this
 * shape. That is the whole point: the player must not care whether the words
 * came from OCR or from a PDF's own text layer, because the moment it does,
 * every feature has to be written twice and one of the two copies is wrong.
 *
 * A word carries its box when the source had one. Images and PDFs do; a text
 * file does not. The box is what lets the reader highlight on the page itself
 * and lets a tap on a word start the voice there, so the adapters go out of
 * their way to keep it, and the UI degrades to plain-text highlighting when it
 * is absent rather than pretending the feature exists.
 *
 * Offsets are per block, not per document. A document's text is not one string
 * -- blocks get reordered, excluded and re-included as the user corrects the
 * reading order -- so a global offset would be invalidated by every edit. Per
 * block, `from`/`to` stay true no matter what happens around them.
 */

import type { Box, OcrLine, OcrPage, OcrWord } from "../ocr/page";
import { boxOf, paragraphsOf, readingOrder } from "../ocr/page";
import { chunk, sentences, type Span } from "./sentences";

/**
 * What a block is, as far as reading aloud is concerned.
 *
 * This is not a typographic classification -- it is a list of the decisions a
 * listener would make. "body" is read. "header", "footer" and "pageNumber" are
 * the furniture nobody wants to hear once a page. The rest are the ones where
 * reasonable people differ, so each gets its own switch in the reader.
 */
export type BlockKind =
  | "body"
  | "heading"
  | "caption"
  | "reference"
  | "footnote"
  | "header"
  | "footer"
  | "pageNumber"
  | "equation"
  | "lineNumber";

/** One word, with where it sits in its block's text and on the page. */
export interface ReadWord {
  text: string;
  /** Offset into the owning block's `text`. `to` is exclusive. */
  from: number;
  to: number;
  /** Where it is on the page, in the page's own pixel space. Absent for text. */
  box?: Box;
  /** 0-100, from OCR. 100 for text that was never guessed at. */
  confidence: number;
}

/** One utterance: the unit the voice speaks and the highlighter highlights. */
export interface ReadSentence {
  /** Offsets into the owning block's `text`. */
  from: number;
  to: number;
  /** Indices into the owning block's `words`. */
  first: number;
  last: number;
}

/** A paragraph, heading, caption or piece of furniture. */
export interface ReadBlock {
  /** Stable within one document. Used by saved per-document corrections. */
  id: string;
  kind: BlockKind;
  /** 0-based. */
  page: number;
  text: string;
  words: ReadWord[];
  sentences: ReadSentence[];
  box?: Box;
  /** Excluded from reading -- by a cleanup rule, or by the user. */
  skip: boolean;
  /** Why it was skipped, for the overlay to show. */
  why?: string;
  /** Set when the user moved or excluded this block by hand. */
  byHand?: boolean;
}

export interface ReadDoc {
  /** The file this came from. Identifies saved corrections. */
  source: string;
  blocks: ReadBlock[];
  pages: number;
  /** Page pixel sizes, indexed by page. Empty when there is no page geometry. */
  sizes: { width: number; height: number }[];
  /** The document own title, where the format carried one. */
  title?: string;
  /**
   * Pages that had no text layer, so the reader can offer to recognise them
   * rather than quietly reading the eight pages that did and stopping.
   */
  scanned?: number[];
}

/**
 * The longest utterance to hand a voice in one go.
 *
 * Long utterances are worse in three separate ways: the voice takes longer to
 * react to pause and to a speed change, the word-level highlight drifts further
 * from the audio, and Kokoro's own input limit is near here anyway. 300 lands
 * comfortably under all three.
 */
export const MAX_UTTERANCE = 300;

/** Is this word's text nothing but punctuation? */
const isBare = (s: string): boolean => !/[\p{L}\p{N}]/u.test(s);

/**
 * Build a block's text and word offsets in one pass.
 *
 * The text is built *from* the words rather than taken from the source and
 * matched back, because matching back is where offset bugs live: a double
 * space, a soft hyphen or a ligature in the source and every offset after it
 * is wrong. Building forwards, the offsets cannot disagree with the text.
 *
 * Words hyphenated across a line join here into one word whose box covers both
 * halves (item 14). That matters beyond tidiness -- "informa-" and "tion" as
 * two words makes the voice say two nonsense fragments, and the highlight jump
 * to the end of one line and back to the start of the next mid-word.
 */
function buildWords(input: readonly OcrLine[]): { text: string; words: ReadWord[] } {
  const words: ReadWord[] = [];
  const lines = input.map((l) => l.words.slice());
  let text = "";

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] as OcrWord[];
    for (let wi = 0; wi < line.length; wi++) {
      const w = line[wi] as OcrWord;
      if (!w.text) continue;

      // A trailing hyphen on the last word of a line, with a following line to
      // borrow from, never leaves a gap behind it -- the two halves are one
      // word on the page and must be one word in the voice. Whether the hyphen
      // itself survives is the only question, and the conservative test
      // answers it: a lower-case letter continues a broken word, so
      // "informa-" / "tion" loses the hyphen, while "Anglo-" / "Saxon",
      // "152-" / "layer" and "CIFAR-" / "10" keep it. Getting that wrong
      // either way is audible -- "informa tion" stumbles and "152layer" is a
      // word nobody wrote.
      //
      // The exception is a compound that happens to have been broken at one of
      // its own hyphens, which the rest of it gives away: "English-" / "to-
      // German" is not a word split into syllables, it is "English-to-German"
      // split at its first hyphen, and the giveaway is the hyphen still
      // standing in the piece that follows. Without this the Transformer
      // abstract says "Englishto-German".
      const next = lines[li + 1];
      if (wi === line.length - 1 && next && next.length > 0 && /[\p{L}\p{N}]-$/u.test(w.text)) {
        const head = next[0] as OcrWord;
        const compound = /\p{L}-\p{L}/u.test(head.text);
        const syllable = !compound && /\p{L}-$/u.test(w.text) && /^\p{Ll}/u.test(head.text);
        if (syllable || /^[\p{L}\p{N}]/u.test(head.text)) {
          const joined = syllable ? w.text.slice(0, -1) + head.text : w.text + head.text;
          next.shift();
          if (text) text += " ";
          const from = text.length;
          text += joined;
          words.push({
            text: joined,
            from,
            to: text.length,
            box: boxOf([w.box, head.box]),
            confidence: Math.min(w.confidence, head.confidence),
          });
          continue;
        }
      }

      if (text) text += " ";
      const from = text.length;
      text += w.text;
      words.push({ text: w.text, from, to: text.length, box: w.box, confidence: w.confidence });
    }
  }

  return { text, words };
}

/** Turn a span into a sentence by finding the words it covers. */
function withWords(span: Span, words: readonly ReadWord[]): ReadSentence | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as ReadWord;
    if (w.to <= span.from || w.from >= span.to) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return null;
  return { from: span.from, to: span.to, first, last };
}

/**
 * Attach sentence spans to a block, splitting any that run too long.
 *
 * A span that covers no words at all -- a run of pure punctuation left behind
 * by a failed recognition -- is dropped rather than kept, because the player
 * advances by word and would sit on it forever.
 */
function buildSentences(text: string, words: readonly ReadWord[]): ReadSentence[] {
  const out: ReadSentence[] = [];
  for (const s of sentences(text)) {
    for (const part of chunk(text, s, MAX_UTTERANCE)) {
      const span = withWords(part, words);
      if (span) out.push(span);
    }
  }
  return out;
}

/** Split a plain string into words with offsets. Used by the text adapters. */
function plainWords(clean: string): ReadWord[] {
  const words: ReadWord[] = [];
  let at = 0;
  for (const piece of clean.split(" ")) {
    if (piece) words.push({ text: piece, from: at, to: at + piece.length, confidence: 100 });
    at += piece.length + 1;
  }
  return words;
}

let counter = 0;

/** Make a block from lines that are already in reading order. */
function blockFrom(lines: readonly OcrLine[], page: number): ReadBlock | null {
  const { text, words } = buildWords(lines);
  if (!text || words.every((w) => isBare(w.text))) return null;

  return {
    id: `b${page}_${counter++}`,
    kind: "body",
    page,
    text,
    words,
    sentences: buildSentences(text, words),
    box: boxOf(lines.map((l) => l.box)),
    skip: false,
  };
}

/**
 * Turn recognised pages into a readable document.
 *
 * `readingOrder` does the part that matters most and is easy to get wrong -- a
 * two-column paper read top-to-bottom interleaves two arguments line by line
 * and is useless -- so this function does not attempt its own ordering. It
 * splits what comes back into paragraphs, because a block from OCR is often
 * several paragraphs and the player skips by paragraph.
 *
 * Nothing is classified or dropped here. That is `cleanup`'s job, and keeping
 * the two apart means the reading-order overlay can show every block that was
 * found, including the ones about to be skipped, with the reason.
 */
export function fromPages(pages: readonly OcrPage[], source: string): ReadDoc {
  counter = 0;
  const blocks: ReadBlock[] = [];

  pages.forEach((page, i) => {
    for (const block of readingOrder(page)) {
      for (const para of paragraphsOf(block)) {
        const b = blockFrom(para, i);
        if (b) blocks.push(b);
      }
    }
  });

  return {
    source,
    blocks,
    pages: pages.length,
    sizes: pages.map((p) => ({ width: p.width, height: p.height })),
  };
}

/**
 * Turn plain text into a readable document.
 *
 * Used for .txt, .md, code files and for a selection the user made by hand.
 * Blank lines separate blocks; a Markdown heading becomes a heading block so
 * the "skip headings" switch works on Markdown the same way it works on a PDF.
 */
export function fromText(text: string, source: string): ReadDoc {
  counter = 0;
  const blocks: ReadBlock[] = [];

  for (const part of text.split(/\n[ \t]*\n+/)) {
    const clean = part.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const words = plainWords(clean);

    blocks.push({
      id: `t${counter++}`,
      kind: /^#{1,6}\s/.test(part.trim()) ? "heading" : "body",
      page: 0,
      text: clean,
      words,
      sentences: buildSentences(clean, words),
      skip: false,
    });
  }

  return { source, blocks, pages: 1, sizes: [] };
}

/** A block an adapter built itself, before offsets and sentences exist. */
export interface RawBlock {
  text: string;
  kind?: BlockKind;
  page?: number;
  box?: Box;
}

/** Build a document out of blocks an adapter produced itself. */
export function fromBlocks(
  parts: readonly RawBlock[],
  source: string,
  pages = 1,
  sizes: { width: number; height: number }[] = [],
): ReadDoc {
  counter = 0;
  const blocks: ReadBlock[] = [];

  for (const part of parts) {
    const clean = part.text.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const words = plainWords(clean);

    blocks.push({
      id: `x${counter++}`,
      kind: part.kind ?? "body",
      page: part.page ?? 0,
      text: clean,
      words,
      sentences: buildSentences(clean, words),
      ...(part.box ? { box: part.box } : {}),
      skip: false,
    });
  }

  return { source, blocks, pages, sizes };
}

/** A position in the play list. */
export interface Step {
  block: number;
  sentence: number;
}

/** The play list: sentences of non-skipped blocks, in document order. */
export function steps(doc: ReadDoc): Step[] {
  const out: Step[] = [];
  doc.blocks.forEach((b, bi) => {
    if (b.skip) return;
    b.sentences.forEach((_, si) => out.push({ block: bi, sentence: si }));
  });
  return out;
}

/** The text of one step. */
export function stepText(doc: ReadDoc, step: Step): string {
  const b = doc.blocks[step.block];
  const s = b?.sentences[step.sentence];
  if (!b || !s) return "";
  return b.text.slice(s.from, s.to);
}

/** How many words will be spoken. Drives the position counter. */
export function spokenWords(doc: ReadDoc): number {
  let n = 0;
  for (const b of doc.blocks) {
    if (!b.skip) n += b.words.length;
  }
  return n;
}

/** Everything that will be read, as one string. For export and for checks. */
export function readableText(doc: ReadDoc): string {
  return doc.blocks
    .filter((b) => !b.skip)
    .map((b) => b.text)
    .join("\n\n");
}
