/**
 * Excel workbooks, read directly.
 *
 * An .xlsx is a zip of XML. Everything hard about reading one is in the
 * details that a naive reader gets wrong and then shows you anyway:
 *
 *  - Text is not in the sheet. It is in `sharedStrings.xml`, and the cell holds
 *    an *index* into it. A reader that ignores this shows a spreadsheet full of
 *    small integers.
 *  - Dates are not dates. They are day counts from 1900 (or 1904, on old Mac
 *    files), and the only thing distinguishing 45000 the date from 45000 the
 *    number is a format id two files away in `styles.xml`.
 *  - 1900 was not a leap year. Excel says it was, because Lotus said it was in
 *    1983 and the bug is now load-bearing for every spreadsheet ever written.
 *  - Cells are sparse. `<c r="D7">` means column D, and rows skip empty cells
 *    entirely, so position in the XML tells you nothing about position in the
 *    grid.
 *
 * The XML is scanned rather than parsed into a DOM. A million-cell sheet is a
 * perfectly ordinary export, and building a DOM node per cell for one is how a
 * viewer earns its reputation for hanging.
 */

import { readDirectory, readEntry, type ZipHost } from "./zipread";

export interface Sheet { name: string; path: string; }

export interface Workbook {
  sheets: Sheet[];
  /** Resolved lazily — a workbook with 40 tabs should cost one tab to open. */
  read(sheet: Sheet): Promise<SheetData>;
}

export interface SheetData {
  rows: string[][];
  columns: number;
  truncated: boolean;
}

/** Above this we stop and say so. Excel's own ceiling is 1,048,576. */
const ROW_CAP = 500_000;

export async function openWorkbook(host: ZipHost, path: string): Promise<Workbook> {
  const entries = await readDirectory(host, path);
  const by = new Map(entries.map((e) => [e.name, e]));
  const text = async (name: string): Promise<string> => {
    const e = by.get(name);
    if (!e) return "";
    return new TextDecoder().decode(await readEntry(host, path, e));
  };

  const wb = await text("xl/workbook.xml");
  if (!wb) throw new Error("not an Excel workbook (no xl/workbook.xml)");

  // rId → part. Without the relationships file a sheet named "Summary" and the
  // file `sheet3.xml` have no reliable connection; the order of `<sheet>` tags
  // is *not* the order of the files.
  const rels = new Map<string, string>();
  for (const m of (await text("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)) {
    // Each attribute is pulled out on its own. XML says nothing about attribute
    // order and writers disagree — openpyxl puts `Target` before `Id`, Excel
    // puts `Id` first — so a single regex spanning both works on one and
    // silently matches nothing on the other.
    const tag = m[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    let t = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (!id || !t) continue;
    if (t.startsWith("/")) t = t.slice(1);
    else if (!t.startsWith("xl/")) t = "xl/" + t;
    rels.set(id, t.replace(/^xl\/\.\.\//, ""));
  }

  const sheets: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = m[0];
    const name = /name="([^"]*)"/.exec(tag)?.[1];
    const rid = /r:id="([^"]*)"/.exec(tag)?.[1];
    const target = rid ? rels.get(rid) : undefined;
    if (name && target && by.has(target)) sheets.push({ name: unescapeXml(name), path: target });
  }
  if (sheets.length === 0) {
    for (const e of entries) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)) {
        sheets.push({ name: e.name.replace(/.*\/|\.xml$/g, ""), path: e.name });
      }
    }
  }

  const epoch1904 = /date1904="(1|true)"/.test(wb);

  let shared: string[] | null = null;
  let dateStyles: Set<number> | null = null;

  return {
    sheets,
    async read(sheet) {
      shared ??= parseSharedStrings(await text("xl/sharedStrings.xml"));
      dateStyles ??= parseDateStyles(await text("xl/styles.xml"));
      const e = by.get(sheet.path);
      if (!e) throw new Error(`missing ${sheet.path}`);
      const xml = new TextDecoder().decode(await readEntry(host, path, e));
      return parseSheet(xml, shared, dateStyles, epoch1904);
    },
  };
}

/**
 * Shared strings.
 *
 * A single `<si>` can be split across any number of `<r>` runs — one per
 * formatting change — so "Hello world" bolded halfway through arrives as two
 * fragments that must be concatenated. Taking only the first `<t>` is the
 * classic bug, and it silently truncates exactly the cells someone bothered to
 * format.
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let s = "";
    for (const t of (si[1] as string).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1] as string;
    out.push(unescapeXml(s));
  }
  return out;
}

/**
 * Which style indices mean "this number is a date".
 *
 * Built-in format ids 14–22 and 45–47 are dates and times by definition; custom
 * ones have to be recognised from their pattern, which is any format code with
 * a y, an m/d combination, or an h — outside of quotes, since `"May"` as a
 * literal in a currency format is not a date.
 */
function parseDateStyles(xml: string): Set<number> {
  const dateFmt = new Set<number>([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = unescapeXml(m[2] as string).replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
    if (/[yY]|[dD]|[hH]|m{3,}/.test(code) && !/^[#0.,\s%$-]*$/.test(code)) {
      dateFmt.add(Number(m[1]));
    }
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const out = new Set<number>();
  let i = 0;
  for (const xf of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(xf[0])?.[1] ?? 0);
    if (dateFmt.has(id)) out.add(i);
    i++;
  }
  return out;
}

function parseSheet(xml: string, shared: string[], dateStyles: Set<number>, epoch1904: boolean): SheetData {
  const rows: string[][] = [];
  let columns = 0;
  let truncated = false;

  for (const rm of xml.matchAll(/<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= ROW_CAP) { truncated = true; break; }
    // `r` is the real row number. Rows that are entirely empty are simply not
    // written, so without this a sheet with a gap silently shifts upwards.
    const rn = Number(/\br="(\d+)"/.exec(rm[1] as string)?.[1] ?? rows.length + 1);
    while (rows.length < rn - 1 && rows.length < ROW_CAP) rows.push([]);
    const row: string[] = [];
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] as string;
      const body = cm[2] ?? "";
      const col = colIndex(/\br="([A-Z]+)/.exec(attrs)?.[1] ?? "");
      const at = col >= 0 ? col : row.length;
      while (row.length < at) row.push("");
      row.push(cellValue(attrs, body, shared, dateStyles, epoch1904));
    }
    rows.push(row);
    if (row.length > columns) columns = row.length;
  }
  // Rectangular on the way out. A row that stopped at its last non-empty cell
  // is correct XML and useless to a grid, which needs to know that the cell
  // under a header is empty rather than absent.
  for (const r of rows) while (r.length < columns) r.push("");
  return { rows, columns, truncated };
}

function cellValue(attrs: string, body: string, shared: string[], dateStyles: Set<number>, epoch1904: boolean): string {
  const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? "n";
  if (type === "inlineStr") {
    let s = "";
    for (const t of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1] as string;
    return unescapeXml(s);
  }
  const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
  if (raw === "") return "";
  if (type === "s") return shared[Number(raw)] ?? "";
  if (type === "str") return unescapeXml(raw);
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (type === "e") return unescapeXml(raw);

  const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
  if (style >= 0 && dateStyles.has(style)) {
    const d = excelDate(Number(raw), epoch1904);
    if (d) return d;
  }
  return raw;
}

/**
 * A day count turned back into a date.
 *
 * Serial 60 is 29 February 1900, a day that did not exist. Excel emits it and
 * every reader has to pretend along, which is why everything after it is
 * shifted by one and why the arithmetic below subtracts 2 rather than 1.
 */
function excelDate(serial: number, epoch1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958466) return null;
  const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = base + Math.round(serial * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  const frac = serial - Math.floor(serial);
  return frac === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

/** `A` → 0, `Z` → 25, `AA` → 26. Base-26 with no zero digit, which is why it is
 *  not the same as parsing a number. */
function colIndex(ref: string): number {
  if (!ref) return -1;
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unescapeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g, (_, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[name as string] ?? _;
  });
}
