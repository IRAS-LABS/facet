/**
 * Delimited text, read the way a spreadsheet reads it rather than the way
 * `split(",")` does.
 *
 * The whole file is never a string. A viewer that calls `.split("\n")` on a
 * 900 MB export has already lost — it costs a gigabyte of memory before the
 * first row is on screen, and it is wrong anyway, because a quoted field is
 * allowed to contain both the delimiter and the newline. So this parses byte
 * windows and hands back only the rows that finished inside the window, along
 * with how far it got, so the caller can carry the remainder into the next one.
 *
 * Quoting follows RFC 4180 and then the two things real files do that RFC 4180
 * does not mention: a doubled quote inside a quoted field is one quote, and a
 * quote appearing in the middle of an *unquoted* field is a literal character,
 * not the start of quoting. Excel writes the first; half the world's log
 * exporters write the second.
 */

/** What a file turned out to be, worked out from a sample rather than the extension. */
export interface Dialect {
  delimiter: string;
  /** UTF-16 is not exotic — it is what Excel writes when you pick "Unicode Text". */
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  /** How many bytes of byte-order mark to skip. */
  bom: number;
  hasHeader: boolean;
}

const CANDIDATES = [",", "\t", ";", "|"];

/**
 * Work out the dialect from the first few kilobytes.
 *
 * Picks the delimiter that yields the most *consistent* column count across
 * lines, not the one that appears most often. A prose column full of commas
 * beats tab on raw count in a tab-separated file, and loses badly on
 * consistency — which is the property that actually matters.
 */
export function sniff(head: Uint8Array): Dialect {
  let encoding: Dialect["encoding"] = "utf-8";
  let bom = 0;
  if (head[0] === 0xff && head[1] === 0xfe) { encoding = "utf-16le"; bom = 2; }
  else if (head[0] === 0xfe && head[1] === 0xff) { encoding = "utf-16be"; bom = 2; }
  else if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) { bom = 3; }
  else if (head.length > 8 && head[1] === 0 && head[3] === 0 && head[5] === 0) {
    // No mark, but every other byte is zero: UTF-16 written by something that
    // did not bother. Guessing here beats rendering the file as `a·b·c·`.
    encoding = "utf-16le";
  }

  const text = decode(head.subarray(bom), encoding).slice(0, 64 * 1024);
  let best = { delimiter: ",", score: -1 };
  for (const delimiter of CANDIDATES) {
    const { rows } = parseRows(text, delimiter, true);
    const sample = rows.slice(0, 40).filter((r) => r.length > 0);
    if (sample.length < 2) continue;
    const counts = sample.map((r) => r.length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] ?? 1;
    if (mode < 2) continue;
    const agree = sample.filter((r) => r.length === mode).length / sample.length;
    // Consistency first, then width — a tie between one column and nine goes to
    // nine, because one column means the delimiter was never found.
    const score = agree * 100 + Math.min(mode, 50);
    if (score > best.score) best = { delimiter, score };
  }

  const { rows } = parseRows(text, best.delimiter, true);
  return { delimiter: best.delimiter, encoding, bom, hasHeader: looksLikeHeader(rows) };
}

/**
 * Whether the first row is names rather than data.
 *
 * The test is a difference in *kind*: a header row is text where the rows below
 * it are numbers or dates. Files whose data is all text are ambiguous, and the
 * tie goes to "yes, it is a header", because that is what a person with a CSV
 * almost always has — and because getting it wrong is one click to fix.
 */
function looksLikeHeader(rows: string[][]): boolean {
  const first = rows[0];
  const rest = rows.slice(1, 20).filter((r) => r.length === first?.length);
  if (!first || rest.length === 0) return true;
  if (first.some((c) => c.trim() === "")) return false;
  const numericIn = (r: string[]): number => r.filter((c) => isNumeric(c)).length;
  const below = rest.reduce((n, r) => n + numericIn(r), 0) / rest.length;
  return numericIn(first) < below;
}

export function isNumeric(s: string): boolean {
  const t = s.trim().replace(/[,$%\s]/g, "");
  return t !== "" && Number.isFinite(Number(t));
}

/** The numeric value used for sorting, or NaN. Handles 1,234.50, $9.99, 12%. */
export function numeric(s: string): number {
  const t = s.trim();
  const n = Number(t.replace(/[,$\s]/g, "").replace(/%$/, ""));
  return Number.isFinite(n) ? (/%$/.test(t) ? n / 100 : n) : Number.NaN;
}

export function decode(bytes: Uint8Array, encoding: Dialect["encoding"]): string {
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}

/**
 * Parse as many complete rows as the text contains.
 *
 * `consumed` is where the last complete row ended. Anything after it is a
 * partial row that the caller must prepend to the next window — dropping it
 * instead is how a viewer loses one row per window and nobody notices until
 * the totals are wrong.
 *
 * With `all`, the trailing partial row is returned too, for the sniffing pass
 * and for the end of a file that does not end in a newline.
 */
export function parseRows(text: string, delimiter: string, all = false): { rows: string[][]; consumed: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false; // this field began with a quote
  let consumed = 0;

  const endField = (): void => { row.push(field); field = ""; started = false; };
  const endRow = (at: number): void => {
    endField();
    rows.push(row);
    row = [];
    consumed = at;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (c === '"' && field === "" && !started) { quoted = true; started = true; continue; }
    if (c === delimiter) { endField(); continue; }
    if (c === "\r") {
      // A carriage return at the very end of a window is ambiguous: the `\n`
      // that completes it may be the first byte of the next window. Leaving it
      // unconsumed costs one character of carry and avoids emitting a phantom
      // empty row at every window boundary that happens to land inside a CRLF.
      if (i === text.length - 1 && !all) break;
      if (text[i + 1] === "\n") i++;
      endRow(i + 1);
      continue;
    }
    if (c === "\n") { endRow(i + 1); continue; }
    field += c;
  }

  if (all && (field !== "" || row.length > 0)) {
    endField();
    rows.push(row);
    consumed = text.length;
  }
  return { rows, consumed };
}

/**
 * Row boundaries in raw bytes, which is where an index has to be built.
 *
 * Scanning the decoded string instead looks tidier and is quadratic: every
 * boundary would need its character offset converted back to a byte offset,
 * and each conversion re-measures the text from the start. Bytes avoid it
 * entirely, and UTF-8 makes it exactly correct rather than merely fast —
 * `"`, `\r`, `\n` and every delimiter are ASCII, and UTF-8 guarantees no ASCII
 * byte ever appears inside a multi-byte sequence. There is nothing to
 * misinterpret.
 *
 * UTF-16 is handled by reading a unit at a time and ignoring the high half,
 * which is valid for the same reason: the structural characters are all below
 * 128, and a surrogate pair never contains one.
 */
export function scanBytes(
  b: Uint8Array, quoted: boolean, wide: 0 | 2, little: boolean,
): { starts: number[]; endedInQuote: boolean; consumed: number } {
  const starts: number[] = [];
  const step = wide === 2 ? 2 : 1;
  const lo = wide === 2 && !little ? 1 : 0;
  let consumed = 0;
  for (let i = 0; i + step <= b.length; i += step) {
    const c = b[i + lo] as number;
    if (wide === 2 && (b[i + (lo ? 0 : 1)] as number) !== 0) continue; // not ASCII
    if (quoted) {
      if (c === 0x22) {
        if ((b[i + step + lo] as number | undefined) === 0x22) i += step;
        else quoted = false;
      }
      continue;
    }
    if (c === 0x22) { quoted = true; continue; }
    if (c === 0x0d || c === 0x0a) {
      if (c === 0x0d && i + step * 2 > b.length) break; // possible split CRLF
      if (c === 0x0d && (b[i + step + lo] as number | undefined) === 0x0a) i += step;
      starts.push(i + step);
      consumed = i + step;
    }
  }
  return { starts, endedInQuote: quoted, consumed };
}

/** Where each row begins, in bytes. Element 0 is always the first data byte. */
export type RowIndex = number[];

export interface IndexProgress {
  /** Called as the scan advances, so a 2 GB file can show a bar instead of a freeze. */
  onProgress?: (bytesDone: number, rowsFound: number) => void;
  /** Checked between windows. Returning true abandons the scan. */
  cancelled?: () => boolean;
}

/**
 * Byte offsets of every row, built by streaming the file once.
 *
 * This is what makes the rest possible: with it, showing row 4 000 000 costs
 * one read at one offset. Without it the only way to find that row is to read
 * everything before it, which is the behaviour every "it hangs on big files"
 * complaint is actually describing.
 *
 * Only the offsets are kept — eight bytes a row, so a ten-million-row file
 * indexes into 80 MB and never holds a single field of text.
 */
export async function buildIndex(
  read: (offset: number, len: number) => Promise<Uint8Array>,
  size: number,
  dialect: Dialect,
  progress: IndexProgress = {},
): Promise<{ index: RowIndex; cancelled: boolean }> {
  const WINDOW = 4 * 1024 * 1024;
  const index: RowIndex = [dialect.bom];
  const wide = dialect.encoding === "utf-8" ? 0 : 2;
  const little = dialect.encoding !== "utf-16be";
  let base = dialect.bom;
  let quoted = false;

  while (base < size) {
    if (progress.cancelled?.()) return { index, cancelled: true };
    const chunk = await read(base, Math.min(WINDOW, size - base));
    if (chunk.length === 0) break;
    const r = scanBytes(chunk, quoted, wide, little);
    for (const s of r.starts) index.push(base + s);
    if (r.consumed > 0) {
      // Rewind to the last complete row and re-read the partial one with the
      // next window. `endedInQuote` describes the *end* of the window, which is
      // past that point — and a row boundary is by definition never inside a
      // quoted field, so the state to resume with is "not quoted".
      base += r.consumed;
      quoted = false;
    } else {
      // No boundary anywhere in four megabytes: one enormous row, or a quoted
      // field that spans windows. Advance regardless, or this never terminates.
      base += chunk.length;
      quoted = r.endedInQuote;
    }
    progress.onProgress?.(base, index.length);
  }

  // A file ending in a newline leaves a boundary at EOF, which is not a row.
  while (index.length > 1 && (index[index.length - 1] as number) >= size) index.pop();
  return { index, cancelled: false };
}
