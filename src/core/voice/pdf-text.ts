/**
 * A PDF's own text layer, reshaped into the same thing OCR produces.
 *
 * Most PDFs already know what they say -- the text is in the file, with exact
 * positions and no guessing. Running OCR over them would be slower, less
 * accurate and would throw away that certainty, so when the text layer is
 * there this is the path taken.
 *
 * The output is an `OcrPage` even though nothing here recognises anything.
 * That is deliberate: `readingOrder` is the piece that makes a two-column
 * paper listenable, it is already written and already tested, and it takes an
 * `OcrPage`. Producing anything else would mean a second column algorithm for
 * the PDF path, which would drift out of step with the first one within a
 * month. Confidence is reported as 100 throughout, which is honest -- the
 * characters are not guesses.
 *
 * Text layers do not come with lines, paragraphs or blocks. They come as a
 * flat list of positioned runs, often one per word, occasionally one per
 * character, and in an order that reflects how the file was written rather
 * than how it should be read. Grouping them back into lines and blocks is what
 * most of this file does.
 */

import { loadPdfjs } from "@core/explorer/preview";
import { boxOf, type Box, type OcrBlock, type OcrLine, type OcrPage, type OcrWord } from "../ocr/page";

/** A positioned run of text, in top-left page pixels. */
interface Run {
  text: string;
  box: Box;
  /** Baseline, for grouping into lines. */
  base: number;
  /** Nominal glyph height, a stand-in for font size. */
  size: number;
  /**
   * Set when the text runs up or down the page rather than across it. The
   * arXiv stamp down the left edge of a preprint is the one every reader
   * meets: it is a whole sentence, it is real text, and it belongs to the
   * page rather than to the paper.
   */
  sideways: boolean;
}

/**
 * A run is on the same line as the previous one if their baselines are within
 * this fraction of the text height. Superscripts and subscripts shift the
 * baseline by around 0.33 of the height, so the threshold sits below that:
 * a footnote marker should not drag the line box up with it.
 */
const LINE_SLACK = 0.3;

/** Two lines belong to the same block if their gap is under this * pitch. */
const BLOCK_GAP = 1.8;

/** Below this many characters a page is treated as having no text layer. */
const SCAN_CHARS = 24;

/**
 * Pull the text layer out of a PDF.
 *
 * Returns one `OcrPage` per page, in file order, with `blocks` unordered --
 * `readingOrder` is applied later by the document builder, which is also where
 * the two paths converge.
 *
 * `onPage` reports progress. A 60-page paper takes a few seconds and the
 * reader shows a count rather than freezing.
 */
export async function pdfPages(
  bytes: Uint8Array,
  onPage?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<OcrPage[]> {
  const pdfjs = await loadPdfjs();
  // pdf.js takes ownership of the buffer it is given and detaches it, so a
  // caller that still wants its bytes (to render thumbnails, say) would find
  // them gone. Copying is cheaper than that surprise.
  // The loading task is what has to be torn down; the document proxy in this
  // version of pdf.js has no destroy of its own.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;

  try {
    const out: OcrPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await doc.getPage(i);
      try {
        out.push(await onePage(page));
      } finally {
        page.cleanup();
      }
      onPage?.(i, doc.numPages);
    }
    return out;
  } finally {
    void task.destroy();
  }
}

/** Does this page carry real text, or is it a picture of a page? */
export function isScanned(page: OcrPage): boolean {
  let chars = 0;
  for (const b of page.blocks) {
    for (const l of b.lines) {
      for (const w of l.words) chars += w.text.length;
    }
  }
  return chars < SCAN_CHARS;
}

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>["getDocument"]>["promise"]> extends {
  getPage(n: number): Promise<infer P>;
}
  ? P
  : never;

async function onePage(page: PdfPage): Promise<OcrPage> {
  const view = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: Run[] = [];

  for (const item of content.items) {
    if (!("str" in item)) continue;
    const text = item.str;
    if (!text.trim()) continue;

    // transform is [a, b, c, d, e, f]. (e, f) is the text's origin -- the
    // left end of the baseline, measured from the bottom-left of the page.
    // (a, b) is the direction the text advances in and (c, d) the direction
    // its ascenders point, both already scaled by the font size.
    const tr = item.transform as number[];
    const a = tr[0] ?? 0;
    const b = tr[1] ?? 0;
    const c = tr[2] ?? 0;
    const d = tr[3] ?? 0;
    const e = tr[4] ?? 0;
    const f = tr[5] ?? 0;

    const size = item.height || Math.hypot(c, d) || 10;
    const len = item.width || size * 0.5 * text.length;

    // The box is built from the four corners rather than from x and width,
    // because for turned text the run's extent and its height swap over. For
    // ordinary horizontal text this works out to exactly the same rectangle.
    const along = Math.hypot(a, b) || 1;
    const ax = (a / along) * len;
    const ay = (b / along) * len;
    const xs = [e, e + ax, e + c, e + ax + c];
    const ys = [f, f + ay, f + d, f + ay + d];
    const top = Math.max(...ys);

    runs.push({
      text,
      // Flip to a top-left origin.
      box: {
        x: Math.min(...xs),
        y: view.height - top,
        w: Math.max(...xs) - Math.min(...xs),
        h: top - Math.min(...ys),
      },
      base: view.height - f,
      size,
      sideways: Math.abs(b) > Math.abs(a),
    });
  }

  return {
    width: Math.round(view.width),
    height: Math.round(view.height),
    blocks: blocksOf(runs, view.width),
    confidence: 100,
    angle: 0,
    language: "",
  };
}

/** Split a run into words, sharing its width out by character count. */
function wordsOf(run: Run): OcrWord[] {
  const pieces = run.text.split(/(\s+)/);
  const total = run.text.length || 1;
  const out: OcrWord[] = [];
  let at = run.box.x;

  for (const piece of pieces) {
    const w = (piece.length / total) * run.box.w;
    if (piece.trim()) {
      out.push({
        text: piece,
        box: { x: at, y: run.box.y, w, h: run.box.h },
        confidence: 100,
      });
    }
    at += w;
  }
  return out;
}

/**
 * Group runs into lines, then lines into blocks.
 *
 * Lines come first because they are the reliable part: a shared baseline is
 * unambiguous in a way that a shared paragraph is not. Blocks are then built
 * by walking down the lines and cutting where the vertical gap grows past the
 * running line pitch -- the same principle `paragraphsOf` uses on OCR output,
 * applied here because a PDF text layer has no paragraph structure at all.
 *
 * Columns have to be found *here*, before the lines exist, and this is the one
 * thing about the file worth reading twice. A shared baseline is not enough to
 * make a line: on a two-column paper the last line of the left column and a
 * figure label in the right column share a baseline and are not the same line
 * and never were. Grouping them together produces a line that crosses the
 * gutter, and one such line is all it takes -- `readingOrder` finds columns by
 * looking for a vertical strip nothing crosses, so a single crosser leaves the
 * whole page looking like one column and the reader says half a sentence of
 * the abstract followed by an axis label. That is the failure this feature
 * exists to prevent, so it is fixed at the point where it is introduced.
 *
 * Splitting columns *later* is not an option for the same reason: by then the
 * text of the two columns is interleaved inside one line and the information
 * needed to separate them is gone.
 */
function blocksOf(runs: Run[], pageWidth: number): OcrBlock[] {
  if (runs.length === 0) return [];

  const blocks: OcrBlock[] = [];

  // Turned text never joins a line of upright text, whatever their boxes
  // happen to overlap. Each run stands alone, which leaves it where the
  // cleanup pass can recognise it by its shape -- tall, narrow, in the margin.
  const upright: Run[] = [];
  for (const run of runs) {
    if (!run.sideways) {
      upright.push(run);
      continue;
    }
    const line = lineOf([run]);
    if (line) blocks.push({ lines: [line], box: line.box });
  }
  runs = upright;
  if (runs.length === 0) return blocks;

  // One column at a time, so a paragraph is built from the lines above and
  // below it rather than from whatever happened to share its baseline. Blocks
  // come out grouped by column and `readingOrder` puts them in order.
  for (const column of groupLines(runs, pageWidth)) blocks.push(...stack(column));
  return blocks;
}

/** Cut one column's lines, top to bottom, wherever the spacing says to. */
function stack(lines: OcrLine[]): OcrBlock[] {
  const blocks: OcrBlock[] = [];
  let current: OcrLine[] = [];
  let pitch = 0;

  for (const line of lines) {
    const prev = current[current.length - 1];

    if (prev) {
      const gap = line.box.y - (prev.box.y + prev.box.h);
      const height = Math.max(prev.box.h, line.box.h);
      pitch = pitch || height;

      // A new block when the vertical gap opens up, or when the horizontal
      // extent stops overlapping at all -- the second test catches a caption
      // sitting beside a figure, which the gap test alone would swallow.
      const far = gap > pitch * BLOCK_GAP;
      const apart = line.box.x > prev.box.x + prev.box.w || prev.box.x > line.box.x + line.box.w;
      if (far || apart) {
        blocks.push(makeBlock(current));
        current = [];
        pitch = 0;
      }
    }
    current.push(line);
  }

  if (current.length > 0) blocks.push(makeBlock(current));
  return blocks;
}

function makeBlock(lines: OcrLine[]): OcrBlock {
  return { lines, box: boxOf(lines.map((l) => l.box)) };
}

/**
 * A vertical strip has to be this wide, as a fraction of the page, to count as
 * a column gutter. Matches `GUTTER` in `ocr/page`, which does the same job on
 * the OCR path; the two numbers mean the same thing and should move together.
 */
const GUTTER = 0.035;

/** A gutter has to separate at least this many rows to be believed. */
const GUTTER_ROWS = 5;

/**
 * This fraction of the lines past a gutter must start at the same x for it to
 * be a column edge rather than a coincidence. Not all of them: a table sitting
 * in the column, an indented first line and a displayed equation all start
 * somewhere else and are all perfectly ordinary.
 */
const COLUMN_EDGE = 0.6;

/**
 * How far apart two line starts can be and still count as the same edge, as a
 * fraction of the page width -- about a third of an inch on US Letter.
 *
 * Wider than it first looks like it should be, and a bibliography is why. Every
 * entry after the first line of it is indented, so a reference column has two
 * left edges rather than one and neither reaches sixty per cent on its own.
 * That is what knocked the gutter off pages 8, 9 and 11 of the ResNet paper,
 * the last of which is the bibliography, which then got read out in full.
 * Allowing an indent's worth of slack puts those pages back at 0.74, 1.00 and
 * 0.86 while the figure on page 4 -- whose boxes start wherever the drawing
 * says -- stays at 0.52 however much slack it is given, because there is no
 * common edge there to find.
 */
const COLUMN_SLACK = 0.04;

/** How many of these numbers agree with one of them, to within `slack`. */
function agreement(values: readonly number[], slack: number): number {
  let most = 0;
  for (const v of values) {
    let n = 0;
    for (const w of values) if (Math.abs(w - v) <= slack) n++;
    if (n > most) most = n;
  }
  return most;
}

/**
 * Put runs that share a baseline onto one line, left to right, and cut each
 * line where a column gutter runs through the page.
 *
 * Returns one array of lines per column, each already sorted top to bottom.
 * A page with no gutter comes back as a single array, which is the whole of
 * the previous behaviour.
 *
 * Sorting by baseline first and position second is what fixes files whose text
 * layer is in generation order rather than reading order -- a PDF produced by
 * LaTeX routinely emits a whole column's italics after its romans, and read in
 * file order that comes out shuffled.
 */
function groupLines(runs: Run[], pageWidth: number): OcrLine[][] {
  const rows = baselineRows(runs);
  const cuts = guttersOf(rows, pageWidth);

  // No gutter: one column, and nothing about the old behaviour changes.
  if (cuts.length === 0) {
    const only = rows.map(lineOf).filter((l): l is OcrLine => l !== null);
    return only.length > 0 ? [only] : [];
  }

  // One bucket per column, plus a bucket at the end for the lines that span a
  // gutter -- a title, a full-width figure caption, a table rule. Those are
  // left whole: cutting a title in half is a worse answer than reading it.
  const columns: OcrLine[][] = Array.from({ length: cuts.length + 2 }, () => []);
  const spanning = columns.length - 1;

  for (const row of rows) {
    if (cuts.some((x) => spansCut(row, x, pageWidth))) {
      const line = lineOf(row);
      if (line) columns[spanning]?.push(line);
      continue;
    }
    for (let i = 0; i < cuts.length + 1; i++) {
      const from = i === 0 ? -Infinity : (cuts[i - 1] as number);
      const to = i === cuts.length ? Infinity : (cuts[i] as number);
      const line = lineOf(row.filter((r) => r.box.x + r.box.w / 2 >= from
        && r.box.x + r.box.w / 2 < to));
      if (line) columns[i]?.push(line);
    }
  }

  return columns.filter((c) => c.length > 0);
}

/** Does this run cross the line x, rather than sitting to one side of it? */
const straddles = (r: Run, x: number): boolean => r.box.x < x && r.box.x + r.box.w > x;

/**
 * Does this row of runs carry straight across a cut?
 *
 * Not the same question as whether any one run sits astride the cut, and the
 * difference is the whole of a figure caption. A caption arrives as a couple
 * of dozen word-sized runs, none of which happens to land on the cut, so the
 * per-run test says it does not cross, the line is torn into strips and the
 * strips are read one under another -- which is how "See Table 1 for detailed
 * architectures" came out as "See Table 1 for de- tailed architectures" with
 * half a sentence of something else wedged in between. What actually marks a
 * column boundary is a clear gap at the cut, the same gap the cut was found
 * by. Text running across it with no gap is one line and stays one line.
 */
function spansCut(row: readonly Run[], x: number, pageWidth: number): boolean {
  let left = -Infinity;
  let right = Infinity;
  for (const r of row) {
    if (straddles(r, x)) return true;
    if (r.box.x + r.box.w <= x) left = Math.max(left, r.box.x + r.box.w);
    else right = Math.min(right, r.box.x);
  }
  return left > -Infinity && right < Infinity && right - left < pageWidth * GUTTER;
}

/** Runs that share a baseline, in file order, top to bottom. */
function baselineRows(runs: Run[]): Run[][] {
  const sorted = [...runs].sort((a, b) => a.base - b.base || a.box.x - b.box.x);
  const rows: Run[][] = [];
  let group: Run[] = [];

  for (const run of sorted) {
    const head = group[0];
    if (head && Math.abs(run.base - head.base) > head.size * LINE_SLACK) {
      rows.push(group);
      group = [];
    }
    group.push(run);
  }
  if (group.length > 0) rows.push(group);
  return rows;
}

/** One line from a row's runs, left to right, or null if there is nothing. */
function lineOf(row: readonly Run[]): OcrLine | null {
  const words: OcrWord[] = [];
  for (const run of [...row].sort((a, b) => a.box.x - b.box.x)) words.push(...wordsOf(run));
  if (words.length === 0) return null;
  return { words, box: boxOf(words.map((w) => w.box)), confidence: 100 };
}

/**
 * Where the page's column gutters are, as x positions.
 *
 * A candidate x is a gutter when the page repeatedly has text on both sides of
 * it and little sitting across it. Both halves of that matter. Counting empty
 * space alone finds the gap inside a wide table and the ragged right margin of
 * a one-column page, neither of which is a column boundary; requiring text on
 * both sides is what makes it one. Allowing a few crossers is what keeps the
 * title, the page-wide figure and the horizontal rule from hiding a gutter
 * that the other forty rows of the page agree about.
 *
 * "Both sides" is counted two ways, because a page can be plainly two-column
 * and still have no single row with text on both sides of the gutter. A
 * bibliography is the standard example: the two columns set their own line
 * spacing and the baselines stop lining up within the first inch, so every row
 * belongs to one column alone. Rows wholly on the left and rows wholly on the
 * right are then the evidence, and the weaker side is what counts -- a one
 * column page has none on one side of any candidate and scores nothing.
 *
 * Candidates are taken at bin centres rather than at every pixel because the
 * answer only has to be somewhere inside the gutter -- the split is by which
 * side of the line a word's centre falls, so any x in the empty strip gives
 * the same result.
 */
function guttersOf(rows: readonly Run[][], pageWidth: number): number[] {
  if (rows.length < GUTTER_ROWS * 2 || pageWidth <= 0) return [];

  const BINS = 120;
  const step = pageWidth / BINS;
  const out: number[] = [];
  let best: { from: number; to: number; score: number } | null = null;

  const flush = (): void => {
    if (best) out.push((best.from + best.to) / 2);
    best = null;
  };

  // The outer tenth of the page is margin, not a gutter between columns.
  for (let i = Math.round(BINS * 0.1); i < Math.round(BINS * 0.9); i++) {
    const x = (i + 0.5) * step;
    let split = 0;
    let crossed = 0;
    let onlyLeft = 0;
    let onlyRight = 0;
    const starts: number[] = [];

    for (const row of rows) {
      if (row.some((r) => straddles(r, x))) {
        crossed++;
        continue;
      }
      // Text both sides, with a real gap between them. Both halves matter.
      // Without the width test an ordinary wide word space counts as a column
      // boundary; without the both-sides test the right-hand margin scores
      // perfectly on every single row and beats the real gutter.
      let left = -Infinity;
      let right = Infinity;
      for (const r of row) {
        if (r.box.x + r.box.w <= x) left = Math.max(left, r.box.x + r.box.w);
        else if (r.box.x >= x) right = Math.min(right, r.box.x);
      }
      if (right < Infinity) starts.push(right);
      if (left > -Infinity && right < Infinity) {
        // The same test `spansCut` will apply later, so a candidate is scored
        // by exactly the rows it would go on to separate. A row with text
        // either side and no gap between is a row that runs across.
        if (right - left >= pageWidth * GUTTER) split++;
        else crossed++;
      } else if (left > -Infinity) onlyLeft++;
      else if (right < Infinity) onlyRight++;
    }

    const score = split + Math.min(onlyLeft, onlyRight);
    const aligned = agreement(starts, pageWidth * COLUMN_SLACK);

    // A column has an edge. Past a real gutter the text starts at the same
    // place line after line, because that is what setting a column means;
    // past the gap between two boxes in a diagram it starts wherever the next
    // box happens to be. Without this, the network diagram on page 4 of the
    // ResNet paper reads as four columns -- which is exactly what it looks
    // like, and is not what it is.
    const good = score >= GUTTER_ROWS
      && score >= crossed * 2
      && aligned >= starts.length * COLUMN_EDGE;
    if (!good) {
      flush();
      continue;
    }
    // Keep the strongest x within each run of candidates, so two columns give
    // one gutter rather than a dozen adjacent ones. Ties widen the winning
    // stretch instead of keeping its left edge, and the middle is taken.
    if (!best || score > best.score) best = { from: x, to: x, score };
    else if (score === best.score) best.to = x;
  }
  flush();
  return out;
}

