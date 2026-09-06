/**
 * Parquet, read one row group at a time.
 *
 * Parquet is columnar, which is exactly why a viewer can afford it: the footer
 * says where every column of every row group lives, so showing rows 900 000 to
 * 900 050 of a 4 GB file means reading a handful of pages, not a file. That is
 * the whole reason this format exists and it would be a shame to open it by
 * loading it.
 *
 * What is implemented is what real files contain: PLAIN, RLE dictionary, and
 * RLE/bit-packed levels; data pages v1 and v2; uncompressed, Snappy and gzip.
 * What is not — LZO, Brotli, Zstd, and repeated (list/map) columns — is
 * declined by name rather than approximated, because a table viewer that shows
 * subtly wrong numbers is worse than one that says it cannot read something.
 */

import { ThriftReader, asList, asNum, asStr, asStruct, type ThriftStruct, type ThriftValue } from "./thrift";
import { snappyDecompress } from "./snappy";

export interface ParquetHost {
  readRange(path: string, offset: number, len: number): Promise<number[]>;
  readTail(path: string, len: number): Promise<[number[], number]>;
}

interface Column {
  name: string;
  /** Parquet physical type id. */
  type: number;
  converted: number;
  logical: string;
  optional: boolean;
  /** Element width, for FIXED_LEN_BYTE_ARRAY. */
  typeLength: number;
  scale: number;
}

interface Chunk {
  column: number;
  codec: number;
  numValues: number;
  firstPage: number;
  compressedSize: number;
}

interface RowGroup { rows: number; chunks: Chunk[]; }

export interface ParquetFile {
  columns: string[];
  rows: number;
  createdBy: string;
  groups: { rows: number; firstRow: number }[];
  /** Values for a slice of rows, as display strings. Reads only what it needs. */
  read(fromRow: number, count: number): Promise<string[][]>;
}

const CODEC = ["uncompressed", "snappy", "gzip", "lzo", "brotli", "lz4", "zstd", "lz4_raw"];

/** Indexed by the Parquet Encoding enum, gaps and all — 1 was never assigned. */
const ENCODING: Record<number, string> = {
  0: "PLAIN", 2: "PLAIN_DICTIONARY", 3: "RLE", 4: "BIT_PACKED",
  5: "DELTA_BINARY_PACKED", 6: "DELTA_LENGTH_BYTE_ARRAY", 7: "DELTA_BYTE_ARRAY",
  8: "RLE_DICTIONARY", 9: "BYTE_STREAM_SPLIT",
};

export async function openParquet(host: ParquetHost, path: string, size: number): Promise<ParquetFile> {
  // 64 KB covers the footer of almost any file; the ones it does not are the
  // ones with thousands of row groups, and those get a second read. Reading a
  // megabyte up front instead would mean a small Parquet file is always read
  // whole, which defeats the entire reason for opening it this way.
  const [tailArr, tailOff] = await host.readTail(path, Math.min(size, 64 * 1024));
  const tail = new Uint8Array(tailArr);
  if (asciiAt(tail, tail.length - 4) !== "PAR1") throw new Error("not a Parquet file (no PAR1 at the end)");

  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const footerLen = dv.getUint32(tail.length - 8, true);
  const footerAt = size - 8 - footerLen;
  if (footerAt < 4) throw new Error("Parquet footer length is impossible");

  const footer = footerAt >= tailOff
    ? tail.subarray(footerAt - tailOff, footerAt - tailOff + footerLen)
    : new Uint8Array(await host.readRange(path, footerAt, footerLen));

  const meta = new ThriftReader(footer).struct();
  const rows = asNum(meta.get(3));
  const createdBy = asStr(meta.get(6));
  const columns = readSchema(asList(meta.get(2)));

  const byPath = new Map(columns.map((c, i) => [c.name, i]));
  const groups: RowGroup[] = [];
  for (const g of asList(meta.get(4))) {
    const gs = asStruct(g);
    if (!gs) continue;
    const chunks: Chunk[] = [];
    for (const c of asList(gs.get(1))) {
      const cm = asStruct(asStruct(c)?.get(3));
      if (!cm) continue;
      const name = asList(cm.get(3)).map((p) => asStr(p)).join(".");
      const dictAt = asNum(cm.get(11), 0);
      const dataAt = asNum(cm.get(9));
      chunks.push({
        column: byPath.get(name) ?? -1,
        codec: asNum(cm.get(4)),
        numValues: asNum(cm.get(5)),
        // The dictionary page comes first when there is one, and its offset is
        // the only correct place to start reading the chunk.
        firstPage: dictAt > 0 && dictAt < dataAt ? dictAt : dataAt,
        compressedSize: asNum(cm.get(7)),
      });
    }
    groups.push({ rows: asNum(gs.get(3)), chunks });
  }

  const starts: number[] = [];
  let at = 0;
  for (const g of groups) { starts.push(at); at += g.rows; }

  // One row group's worth of decoded columns, kept so scrolling inside a group
  // costs nothing. One is enough: scrolling is local, and a row group is
  // typically 128 MB of source data, which is not a thing to hold two of.
  let cached: { group: number; values: string[][] } | null = null;

  const group = async (gi: number): Promise<string[][]> => {
    if (cached?.group === gi) return cached.values;
    const g = groups[gi];
    if (!g) return [];
    const out: string[][] = columns.map(() => []);
    for (const chunk of g.chunks) {
      if (chunk.column < 0) continue;
      const col = columns[chunk.column] as Column;
      const bytes = new Uint8Array(await host.readRange(path, chunk.firstPage, chunk.compressedSize));
      out[chunk.column] = await readChunk(bytes, col, chunk, g.rows);
    }
    cached = { group: gi, values: out };
    return out;
  };

  return {
    columns: columns.map((c) => c.name),
    rows, createdBy,
    groups: groups.map((g, i) => ({ rows: g.rows, firstRow: starts[i] as number })),
    async read(fromRow, count) {
      const out: string[][] = [];
      for (let gi = 0; gi < groups.length && out.length < count; gi++) {
        const gStart = starts[gi] as number;
        const gRows = (groups[gi] as RowGroup).rows;
        if (fromRow + count <= gStart || fromRow >= gStart + gRows) continue;
        const cols = await group(gi);
        const from = Math.max(0, fromRow - gStart);
        const to = Math.min(gRows, fromRow + count - gStart);
        for (let r = from; r < to; r++) {
          out.push(columns.map((_, ci) => (cols[ci] as string[])[r] ?? ""));
        }
      }
      return out;
    },
  };
}

/**
 * The leaf columns.
 *
 * The schema is a flattened tree: element 0 is the root, and each element says
 * how many children follow it. Only the leaves hold data, and a leaf's real
 * name is its path — `address.city`, not `city` — which is also the key the
 * column chunks use to identify themselves.
 */
function readSchema(elements: ThriftValue[]): Column[] {
  const nodes = elements.map((e) => asStruct(e) ?? new Map<number, never>());
  const out: Column[] = [];
  let i = 0;

  const visit = (prefix: string, repeatedAbove: boolean): void => {
    const n = nodes[i++];
    if (!n) return;
    const name = asStr(n.get(4));
    const children = asNum(n.get(5), 0);
    const rep = asNum(n.get(3), 0); // 0 required, 1 optional, 2 repeated
    const full = prefix ? `${prefix}.${name}` : name;
    if (children > 0) {
      for (let c = 0; c < children; c++) visit(full, repeatedAbove || rep === 2);
      return;
    }
    out.push({
      name: full,
      type: asNum(n.get(1), -1),
      converted: asNum(n.get(6), -1),
      logical: logicalName(asStruct(n.get(10))),
      optional: rep === 1 || repeatedAbove,
      typeLength: asNum(n.get(2), 0),
      scale: asNum(n.get(7), 0),
    });
  };

  const root = nodes[i++];
  const rootChildren = asNum(root?.get(5), 0);
  for (let c = 0; c < rootChildren; c++) visit("", false);
  return out;
}

/** LogicalType is a union: exactly one field is set, and its id is the type. */
function logicalName(t: ThriftStruct | undefined): string {
  if (!t) return "";
  const names: Record<number, string> = {
    1: "string", 2: "map", 3: "list", 4: "enum", 5: "decimal", 6: "date",
    7: "time", 8: "timestamp", 10: "integer", 11: "unknown", 12: "json",
    13: "bson", 14: "uuid",
  };
  for (const id of t.keys()) if (names[id]) return names[id];
  return "";
}

async function decompress(data: Uint8Array, codec: number, expect: number): Promise<Uint8Array> {
  if (codec === 0) return data;
  if (codec === 1) return snappyDecompress(data);
  if (codec === 2) {
    const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    const parts: Uint8Array[] = [];
    const reader = s.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as Uint8Array);
    }
    const out = new Uint8Array(expect);
    let at = 0;
    for (const p of parts) { out.set(p.subarray(0, out.length - at), at); at += p.length; }
    return out;
  }
  throw new Error(`compressed with ${CODEC[codec] ?? codec}, which this reader does not implement`);
}

/** Every page of one column chunk, decoded into display strings. */
async function readChunk(bytes: Uint8Array, col: Column, chunk: Chunk, rows: number): Promise<string[]> {
  const out: string[] = [];
  let dict: string[] | null = null;
  let p = 0;

  while (p < bytes.length && out.length < rows) {
    const reader = new ThriftReader(bytes.subarray(p));
    const h = reader.struct();
    const headerLen = reader.offset;
    const kind = asNum(h.get(1));
    const uncompressed = asNum(h.get(2));
    const compressed = asNum(h.get(3));
    const body = bytes.subarray(p + headerLen, p + headerLen + compressed);
    p += headerLen + compressed;
    if (body.length === 0) break;

    if (kind === 2) {
      const dh = asStruct(h.get(7));
      const raw = await decompress(body, chunk.codec, uncompressed);
      dict = plain(raw, col, asNum(dh?.get(1)));
      continue;
    }
    if (kind === 1) continue; // index page — no values

    if (kind === 0) {
      const dh = asStruct(h.get(5));
      const raw = await decompress(body, chunk.codec, uncompressed);
      const n = asNum(dh?.get(1));
      const enc = asNum(dh?.get(2));
      let q = 0;
      let defined: Uint8Array | null = null;
      if (col.optional) {
        // v1 writes the level data length as an i32 before the levels.
        const len = new DataView(raw.buffer, raw.byteOffset + q, 4).getUint32(0, true);
        defined = rleLevels(raw.subarray(q + 4, q + 4 + len), n);
        q += 4 + len;
      }
      pushValues(out, raw.subarray(q), col, enc, n, dict, defined);
      continue;
    }

    if (kind === 3) {
      const dh = asStruct(h.get(8));
      const n = asNum(dh?.get(1));
      const repLen = asNum(dh?.get(6));
      const defLen = asNum(dh?.get(5));
      // v2 keeps the levels *outside* the compressed region — the one structural
      // difference from v1, and the one that makes a v1 reader produce garbage
      // on a v2 page rather than failing.
      const levels = body.subarray(0, repLen + defLen);
      const rest = body.subarray(repLen + defLen);
      const raw = h.get(7) === false
        ? rest
        : await decompress(rest, chunk.codec, uncompressed - repLen - defLen);
      const defined = col.optional ? rleLevels(levels.subarray(repLen), n) : null;
      pushValues(out, raw, col, asNum(dh?.get(4)), n, dict, defined);
    }
  }
  return out;
}

function pushValues(
  out: string[], data: Uint8Array, col: Column, encoding: number,
  n: number, dict: string[] | null, defined: Uint8Array | null,
): void {
  const present = defined ? countOnes(defined) : n;
  let values: string[];
  if (encoding === 2 || encoding === 8) {
    // PLAIN_DICTIONARY and RLE_DICTIONARY. The first byte is the bit width,
    // then it is the RLE/bit-packed hybrid with no length prefix — it runs to
    // the end of the page.
    if (!dict) throw new Error(`${col.name}: dictionary-encoded page with no dictionary`);
    const width = data[0] as number;
    const idx = rleHybrid(data.subarray(1), present, width);
    values = Array.from(idx, (i) => dict[i] ?? "");
  } else if (encoding === 0) {
    values = plain(data, col, present);
  } else if (encoding === 5) {
    values = deltaBinaryPacked(data, col, present);
  } else if (encoding === 6 || encoding === 7) {
    values = deltaByteArray(data, col, present, encoding === 7);
  } else if (encoding === 9) {
    values = plain(byteStreamJoin(data, width(col), present), col, present);
  } else if (encoding === 3 && col.type === 0) {
    // RLE booleans, which is what a v2 page uses instead of a bit per value.
    values = Array.from(rleHybrid(data.subarray(4), present, 1), (v) => (v ? "true" : "false"));
  } else {
    throw new Error(`${col.name}: encoding ${ENCODING[encoding] ?? encoding} is not implemented`);
  }

  if (!defined) { out.push(...values); return; }
  // Nulls take no space in the value stream, so the definition levels are the
  // only thing that says where they were.
  let v = 0;
  for (let i = 0; i < n; i++) out.push(defined[i] ? (values[v++] ?? "") : "");
}

function countOnes(a: Uint8Array): number {
  let n = 0;
  for (const v of a) if (v) n++;
  return n;
}

/** Definition levels for a flat optional column: one bit each, 1 = present. */
function rleLevels(data: Uint8Array, n: number): Uint8Array {
  const vals = rleHybrid(data, n, 1);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (vals[i] ?? 0) > 0 ? 1 : 0;
  return out;
}

/**
 * Parquet's RLE / bit-packed hybrid.
 *
 * A varint header whose low bit picks the mode: clear means a run of one
 * repeated value, set means a group of bit-packed values in multiples of eight.
 * Mixing the two in one stream is the point — long runs of nulls cost two
 * bytes, and a scattered column still packs tightly.
 */
function rleHybrid(data: Uint8Array, count: number, width: number): Int32Array {
  const out = new Int32Array(count);
  if (width === 0) return out;
  const byteWidth = Math.ceil(width / 8);
  let p = 0, o = 0;

  while (o < count && p < data.length) {
    let shift = 0, header = 0;
    for (;;) {
      if (p >= data.length) return out;
      const b = data[p++] as number;
      header |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) return out;
    }

    if ((header & 1) === 0) {
      const runLen = header >>> 1;
      let value = 0;
      for (let i = 0; i < byteWidth; i++) value |= (data[p + i] ?? 0) << (8 * i);
      p += byteWidth;
      for (let i = 0; i < runLen && o < count; i++) out[o++] = value;
    } else {
      const groups = header >>> 1;
      for (let g = 0; g < groups && o < count; g++) {
        // Values are packed least-significant-bit first and may straddle bytes,
        // so it is read as a sliding bit cursor rather than byte by byte.
        const bits = width * 8;
        const bytes = bits / 8;
        let acc = 0n;
        for (let i = 0; i < bytes; i++) acc |= BigInt(data[p + i] ?? 0) << BigInt(8 * i);
        p += bytes;
        const mask = (1n << BigInt(width)) - 1n;
        for (let i = 0; i < 8 && o < count; i++) {
          out[o++] = Number((acc >> BigInt(width * i)) & mask);
        }
      }
    }
  }
  return out;
}

/**
 * DELTA_BINARY_PACKED — how modern writers store integers.
 *
 * It is the default for INT32 and INT64 in duckdb and in recent parquet-mr, so
 * "PLAIN and dictionary is enough" stopped being true some years ago. The idea
 * is that consecutive integers in a real column are close together: store the
 * first value, then the differences, then the *minimum* difference per block so
 * the rest fit in a handful of bits each. An id column costs about five bits a
 * row instead of thirty-two.
 *
 * The part worth being careful about is the pointer: a miniblock always
 * occupies its full width even when the last few values in it are past the end
 * of the column, so skipping the tail without advancing past the padding puts
 * every following block one miniblock out of step.
 */
function deltaInts(data: Uint8Array, count: number, from = 0): { values: bigint[]; next: number } {
  let p = from;
  const uvarint = (): number => {
    let shift = 0n, out = 0n;
    for (;;) {
      const b = BigInt(data[p++] as number);
      out |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) return Number(out);
      shift += 7n;
      if (shift > 70n) throw new Error("delta: varint too long");
    }
  };
  const zigzag = (): bigint => {
    let shift = 0n, out = 0n;
    for (;;) {
      const b = BigInt(data[p++] as number);
      out |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) break;
      shift += 7n;
      if (shift > 70n) throw new Error("delta: varint too long");
    }
    return (out >> 1n) ^ -(out & 1n);
  };

  const blockSize = uvarint();
  const miniblocks = uvarint();
  const total = Math.min(uvarint(), count);
  let value = zigzag();

  const perMini = blockSize / miniblocks;
  const out: bigint[] = [];
  if (total > 0) out.push(value);

  while (out.length < total && p < data.length) {
    const minDelta = zigzag();
    const widths: number[] = [];
    for (let m = 0; m < miniblocks; m++) widths.push(data[p++] as number);
    for (const width of widths) {
      const bytes = (perMini * width) / 8;
      if (out.length < total && width > 0) {
        let acc = 0n;
        for (let i = 0; i < bytes; i++) acc |= BigInt(data[p + i] ?? 0) << BigInt(8 * i);
        const mask = (1n << BigInt(width)) - 1n;
        for (let j = 0; j < perMini && out.length < total; j++) {
          value += minDelta + ((acc >> BigInt(width * j)) & mask);
          out.push(value);
        }
      } else if (out.length < total) {
        // Width zero: every delta in this miniblock is exactly min_delta.
        for (let j = 0; j < perMini && out.length < total; j++) {
          value += minDelta;
          out.push(value);
        }
      }
      // Advance past the whole miniblock whether or not its values were wanted.
      p += bytes;
    }
  }
  return { values: out, next: p };
}

function deltaBinaryPacked(data: Uint8Array, col: Column, count: number): string[] {
  const { values } = deltaInts(data, count);
  const date = col.converted === 6 || col.logical === "date";
  return values.map((v) => {
    if (date) return new Date(Number(v) * EPOCH_DAY).toISOString().slice(0, 10);
    if (isDecimal(col)) return scaled(v, col.scale);
    if (col.type === 2) return timestamp(v, col) ?? String(v);
    return String(v);
  });
}

/**
 * The two delta encodings for strings.
 *
 * DELTA_LENGTH_BYTE_ARRAY separates the lengths from the bytes: all the lengths
 * delta-packed up front, then every string concatenated with no separators.
 * DELTA_BYTE_ARRAY goes further and stores each value as "reuse this many
 * characters from the previous value, then these new ones" — which on a sorted
 * column of URLs or names is close to free, and is why duckdb reaches for it.
 *
 * The shared prefix makes each value depend on the one before it, so a reader
 * cannot start in the middle of a page. That is fine here: a page is the unit
 * that gets read anyway.
 */
function deltaByteArray(data: Uint8Array, col: Column, count: number, incremental: boolean): string[] {
  const dec = new TextDecoder();
  const utf8 = col.converted === 0 || col.logical === "string" || col.logical === "json";
  const prefixes = incremental ? deltaInts(data, count) : null;
  const lengths = deltaInts(data, count, prefixes?.next ?? 0);
  let p = lengths.next;
  const out: string[] = [];
  let previous = new Uint8Array(0);

  for (let i = 0; i < count; i++) {
    const len = Number(lengths.values[i] ?? 0n);
    const pre = Number(prefixes?.values[i] ?? 0n);
    if (len < 0 || p + len > data.length) break;
    const value = new Uint8Array(pre + len);
    value.set(previous.subarray(0, pre), 0);
    value.set(data.subarray(p, p + len), pre);
    p += len;
    previous = value;
    out.push(utf8 ? dec.decode(value) : hex(value));
  }
  return out;
}

/**
 * BYTE_STREAM_SPLIT, reassembled.
 *
 * Floating-point numbers compress badly because their bytes are unrelated to
 * each other — the exponent byte of a column of prices is nearly constant while
 * the low mantissa byte is noise. So this encoding stores all the first bytes
 * together, then all the second bytes, and so on, which gives the general-
 * purpose compressor afterwards something it can actually work with. Undoing it
 * is pure transposition.
 */
function byteStreamJoin(data: Uint8Array, width: number, count: number): Uint8Array {
  if (width <= 0 || count <= 0) return data;
  const n = Math.min(count, Math.floor(data.length / width));
  const out = new Uint8Array(n * width);
  for (let k = 0; k < width; k++) {
    const stream = k * n;
    for (let i = 0; i < n; i++) out[i * width + k] = data[stream + i] as number;
  }
  return out;
}

/** Bytes per value for the fixed-width physical types. */
function width(col: Column): number {
  switch (col.type) {
    case 1: case 4: return 4;
    case 2: case 5: return 8;
    case 3: return 12;
    case 7: return col.typeLength;
    default: return 0;
  }
}

const EPOCH_DAY = 86400000;

/** PLAIN: values back to back, in whatever the physical type's layout is. */
function plain(data: Uint8Array, col: Column, n: number): string[] {
  const out: string[] = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  const utf8 = col.converted === 0 || col.logical === "string" || col.logical === "json";

  for (let i = 0; i < n; i++) {
    switch (col.type) {
      case 0: { // BOOLEAN — one bit each
        out.push(((data[i >> 3] as number) >> (i & 7)) & 1 ? "true" : "false");
        break;
      }
      case 1: {
        if (p + 4 > data.length) return out;
        const v = dv.getInt32(p, true); p += 4;
        // DATE is a day count, and showing it as 19723 helps nobody.
        out.push(col.converted === 6 || col.logical === "date"
          ? new Date(v * EPOCH_DAY).toISOString().slice(0, 10)
          : isDecimal(col) ? scaled(BigInt(v), col.scale) : String(v));
        break;
      }
      case 2: {
        if (p + 8 > data.length) return out;
        const v = dv.getBigInt64(p, true); p += 8;
        // A DECIMAL is stored as a plain integer, and the scale that turns it
        // back into money lives in the schema. Without this, every price in the
        // file is off by a factor of ten thousand and looks entirely plausible.
        out.push(isDecimal(col) ? scaled(v, col.scale) : timestamp(v, col) ?? String(v));
        break;
      }
      case 3: { // INT96 — a legacy nanosecond timestamp, still everywhere
        if (p + 12 > data.length) return out;
        const nanos = dv.getBigUint64(p, true);
        const julian = dv.getUint32(p + 8, true);
        p += 12;
        const ms = (julian - 2440588) * EPOCH_DAY + Number(nanos / 1000000n);
        out.push(Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? stamp(ms) : "");
        break;
      }
      case 4: { if (p + 4 > data.length) return out; out.push(fmt(dv.getFloat32(p, true))); p += 4; break; }
      case 5: {
        if (p + 8 > data.length) return out;
        out.push(isDecimal(col) ? dv.getFloat64(p, true).toFixed(col.scale) : fmt(dv.getFloat64(p, true)));
        p += 8;
        break;
      }
      case 6: {
        if (p + 4 > data.length) return out;
        const len = dv.getUint32(p, true); p += 4;
        if (p + len > data.length) return out;
        const b = data.subarray(p, p + len); p += len;
        out.push(utf8 ? new TextDecoder().decode(b) : hex(b));
        break;
      }
      case 7: {
        const len = col.typeLength;
        if (len <= 0 || p + len > data.length) return out;
        const b = data.subarray(p, p + len); p += len;
        out.push(col.converted === 5 ? decimal(b, col.scale) : hex(b));
        break;
      }
      default: return out;
    }
  }
  return out;
}

function timestamp(v: bigint, col: Column): string | null {
  const l = col.logical === "timestamp";
  let ms: number | null = null;
  if (col.converted === 9 || (l && col.converted < 0)) ms = Number(v);
  else if (col.converted === 10) ms = Number(v / 1000n);
  else if (col.converted === 6) ms = Number(v) * EPOCH_DAY;
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return stamp(ms);
}

function stamp(ms: number): string {
  const s = new Date(ms).toISOString().replace("T", " ").slice(0, 23);
  // A column of whole seconds should not be a column of `.000`.
  return s.endsWith(".000") ? s.slice(0, -4) : s;
}

const isDecimal = (col: Column): boolean => col.converted === 5 || col.logical === "decimal";

function decimal(b: Uint8Array, scale: number): string {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  // Two's complement: the top bit of the first byte is the sign.
  if ((b[0] as number) & 0x80) v -= 1n << BigInt(8 * b.length);
  return scaled(v, scale);
}

/** An integer and a scale, back into the number a person wrote. */
function scaled(v: bigint, scale: number): string {
  if (scale <= 0) return String(v);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/**
 * A float, printed as a float.
 *
 * `3` and `3.0` are the same number and not the same cell: in a column of
 * measurements the trailing zero is the only thing on screen saying this is a
 * floating-point column and not a count. Integers get it back.
 */
const fmt = (v: number): string =>
  Number.isInteger(v) && Math.abs(v) < 1e21 ? `${v}.0` : String(Number(v.toPrecision(15)));
const hex = (b: Uint8Array): string =>
  Array.from(b.subarray(0, 24), (x) => x.toString(16).padStart(2, "0")).join("") + (b.length > 24 ? "…" : "");
const asciiAt = (b: Uint8Array, at: number): string =>
  at < 0 ? "" : String.fromCharCode(...b.subarray(at, at + 4));
