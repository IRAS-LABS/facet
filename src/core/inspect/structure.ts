/**
 * What a file is made of.
 *
 * A hex dump tells you the bytes and nothing else. The difference between a
 * dump and an *inspector* is that the inspector knows `FF D8` starts a JPEG,
 * that the four bytes after a PNG chunk are its length, and that the thing at
 * the end of a zip is where the file list actually lives. This module turns a
 * file into a list of named regions so the dump can be annotated.
 *
 * Everything is a forward walk over a byte prefix, with two rules that matter:
 *
 * It never trusts a length field. Every offset is bounds-checked and every
 * advance must be positive, because a corrupt or hostile file is exactly the
 * kind of thing you open a hex inspector to look at, and a parser that loops
 * forever on one is useless at the only moment you needed it.
 *
 * It says when it ran out. A prefix read cannot see the whole file, so a walk
 * that reaches the end of what it was given reports `truncated` rather than
 * pretending the file ends there.
 */

/** What a stretch of bytes is for. Drives colour, and nothing else. */
export type RegionKind = "header" | "meta" | "data" | "index" | "trailer" | "unknown";

export interface Region {
  start: number;
  /** Exclusive. */
  end: number;
  name: string;
  /** The one line worth reading about it. */
  note?: string;
  kind: RegionKind;
  children?: Region[];
}

export interface Structure {
  /** Container we recognised, or "" — an unknown file is still worth dumping. */
  format: string;
  regions: Region[];
  /** True when the walk hit the end of the bytes it was given, not the file. */
  truncated: boolean;
}

/** Bytes from the end of the file, when the caller could get them. */
export interface Tail {
  bytes: Uint8Array;
  /** Absolute offset of `bytes[0]`. */
  offset: number;
}

/**
 * The structure of a file from a prefix of it, plus a suffix where one is
 * available. Never throws: a malformed file returns the regions it managed to
 * read, which is the useful answer rather than an empty one.
 */
export function structure(head: Uint8Array, size: number, tail?: Tail): Structure {
  try {
    for (const [test, walk] of WALKERS) {
      if (test(head)) {
        const s = walk(head, size, tail);
        return { ...s, regions: tidy(s.regions, size) };
      }
    }
  } catch {
    // A walker that threw has already lost; fall through to the honest answer
    // rather than losing the dump along with it.
  }
  return { format: "", regions: [], truncated: head.length < size };
}

/**
 * The last word on every offset a walker produces.
 *
 * A corrupt length field turns into a start past the end of the file, and a
 * walker that clamps only its `end` then emits a region that runs backwards.
 * Fuzzing found exactly that in two of the walkers below, which is a good
 * argument for one guard at the exit rather than a clamp at every push: the
 * next walker written gets it for free, and nothing downstream ever has to
 * wonder whether an offset it was handed is real.
 */
function tidy(regions: Region[], size: number): Region[] {
  const out: Region[] = [];
  for (const r of regions) {
    const start = Math.max(0, Math.min(r.start, size));
    const end = Math.max(0, Math.min(r.end, size));
    if (end <= start) continue;
    out.push({
      ...r,
      start,
      end,
      // Names come out of the file's own bytes — a section name or an archive
      // entry — so a corrupt one can carry control characters straight into
      // the tree. It gets printed, so it gets cleaned.
      name: r.name.replace(/[\p{Cc}\p{Cf}]/gu, "·"),
      ...(r.children ? { children: tidy(r.children, size) } : {}),
    });
  }
  return out;
}

// ── Dispatch ────────────────────────────────────────────────────────────────

type Walker = (head: Uint8Array, size: number, tail?: Tail) => Structure;

const WALKERS: ReadonlyArray<readonly [(b: Uint8Array) => boolean, Walker]> = [
  [(b) => magic(b, [0xff, 0xd8, 0xff]), jpeg],
  [(b) => magic(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), png],
  [(b) => str(b, 0, 3) === "GIF", gif],
  [(b) => str(b, 0, 4) === "RIFF", riff],
  [(b) => str(b, 4, 4) === "ftyp" || isBox(b), isobmff],
  [(b) => magic(b, [0x50, 0x4b, 0x03, 0x04]) || magic(b, [0x50, 0x4b, 0x05, 0x06]), zip],
  [(b) => magic(b, [0x1f, 0x8b]), gzip],
  [(b) => magic(b, [0x7f, 0x45, 0x4c, 0x46]), elf],
  [(b) => magic(b, [0x4d, 0x5a]), pe],
  [(b) => str(b, 0, 5) === "%PDF-", pdf],
];

// ── JPEG ────────────────────────────────────────────────────────────────────

const JPEG_MARKERS: Record<number, string> = {
  0xc0: "SOF0 — baseline frame", 0xc1: "SOF1", 0xc2: "SOF2 — progressive frame",
  0xc4: "DHT — Huffman table", 0xc8: "JPG", 0xcc: "DAC",
  0xd8: "SOI — start of image", 0xd9: "EOI — end of image",
  0xda: "SOS — start of scan", 0xdb: "DQT — quantisation table",
  0xdc: "DNL", 0xdd: "DRI — restart interval", 0xde: "DHP", 0xdf: "EXP",
  0xe0: "APP0 — JFIF", 0xe1: "APP1 — Exif or XMP", 0xe2: "APP2 — ICC profile",
  0xed: "APP13 — Photoshop", 0xee: "APP14 — Adobe", 0xfe: "COM — comment",
};

function jpeg(head: Uint8Array, size: number): Structure {
  const regions: Region[] = [];
  let i = 0;
  let truncated = false;

  while (i + 1 < head.length) {
    if (head[i] !== 0xff) { i++; continue; }
    const m = head[i + 1] as number;
    if (m === 0xff || m === 0x00) { i++; continue; }

    const name = JPEG_MARKERS[m] ?? (m >= 0xe0 && m <= 0xef ? `APP${m - 0xe0}` : `Marker 0x${hex(m)}`);

    // Standalone markers carry no length byte.
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) {
      regions.push({ start: i, end: i + 2, name, kind: m === 0xd9 ? "trailer" : "header" });
      if (m === 0xd9) {
        // Anything after this is not the picture — and on a Samsung phone it is
        // routinely a whole motion-photo video riding along inside a still.
        if (i + 2 < size) {
          regions.push({
            start: i + 2, end: size, kind: "trailer",
            name: "Appended data",
            note: "after the end-of-image marker — not part of the picture",
          });
        }
        return { format: "jpeg", regions, truncated: false };
      }
      i += 2;
      continue;
    }

    if (i + 4 > head.length) { truncated = true; break; }
    const len = u16(head, i + 2);
    if (len < 2) { i += 2; continue; }
    const end = Math.min(i + 2 + len, head.length);
    regions.push({ start: i, end, name, kind: m === 0xda ? "data" : "meta", ...idNote(head, i, m, len) });

    if (m === 0xda) {
      // The entropy-coded scan runs from the end of the SOS header to the next
      // real marker, and it is the only part of a JPEG that is the picture.
      const from = i + 2 + len;
      const to = scanEnd(head, from);
      regions.push({
        start: from, end: Math.min(to, head.length), kind: "data",
        name: "Entropy-coded scan",
        note: "the compressed picture itself",
      });
      if (to >= head.length && head.length < size) truncated = true;
      i = to;
      continue;
    }
    i += 2 + len;
  }
  return { format: "jpeg", regions, truncated: truncated || head.length < size };
}

/** Where a scan ends: the next marker that is not stuffing or a restart. */
function scanEnd(b: Uint8Array, from: number): number {
  let i = from;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1] as number;
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    return i;
  }
  return b.length;
}

/** APP segments announce themselves in their first bytes; say which it is. */
function idNote(b: Uint8Array, at: number, marker: number, len: number): { note?: string } {
  if (marker < 0xe0 || marker > 0xef) return {};
  const id = str(b, at + 4, Math.min(len - 2, 12)).split("\0")[0] ?? "";
  return id ? { note: `${id}, ${len - 2} bytes` } : { note: `${len - 2} bytes` };
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const PNG_CHUNKS: Record<string, string> = {
  IHDR: "image header", PLTE: "palette", IDAT: "image data", IEND: "end",
  tEXt: "text", zTXt: "compressed text", iTXt: "international text",
  eXIf: "Exif block", tIME: "last modified", pHYs: "pixel size",
  gAMA: "gamma", cHRM: "chromaticity", sRGB: "colour space", iCCP: "ICC profile",
  tRNS: "transparency", bKGD: "background", acTL: "animation control",
  fcTL: "frame control", fdAT: "frame data",
};

function png(head: Uint8Array, size: number): Structure {
  const regions: Region[] = [
    { start: 0, end: 8, name: "Signature", kind: "header", note: "\\x89PNG\\r\\n\\x1a\\n" },
  ];
  let i = 8;
  let truncated = false;

  while (i + 8 <= head.length) {
    const len = u32(head, i);
    const type = str(head, i + 4, 4);
    const end = i + 12 + len;
    if (len > size || end < i) break;
    regions.push({
      start: i, end: Math.min(end, head.length),
      name: `${type} — ${PNG_CHUNKS[type] ?? "unknown chunk"}`,
      note: `${len} bytes of payload`,
      kind: type === "IDAT" || type === "fdAT" ? "data"
        : type === "IEND" ? "trailer"
        : type === "IHDR" ? "header" : "meta",
      ...(type === "IHDR" && i + 21 <= head.length
        ? {
            children: [{
              start: i + 8, end: i + 21, kind: "header" as const, name: "Header fields",
              note: `${u32(head, i + 8)} × ${u32(head, i + 12)}, ` +
                `${head[i + 16]}-bit, colour type ${head[i + 17]}` +
                (head[i + 20] === 1 ? ", interlaced" : ""),
            }],
          }
        : {}),
    });
    if (end > head.length) { truncated = true; break; }
    if (type === "IEND") return { format: "png", regions, truncated: false };
    i = end;
  }
  return { format: "png", regions, truncated: truncated || head.length < size };
}

// ── GIF ─────────────────────────────────────────────────────────────────────

function gif(head: Uint8Array, size: number): Structure {
  const regions: Region[] = [
    { start: 0, end: 6, name: "Signature", kind: "header", note: str(head, 0, 6) },
  ];
  if (head.length < 13) return { format: "gif", regions, truncated: true };

  const flags = head[10] as number;
  const gctSize = (flags & 0x80) !== 0 ? 3 * (1 << ((flags & 7) + 1)) : 0;
  regions.push({
    start: 6, end: 13, name: "Screen descriptor", kind: "header",
    note: `${u16le(head, 6)} × ${u16le(head, 8)}`,
  });
  let i = 13;
  if (gctSize > 0) {
    regions.push({ start: 13, end: 13 + gctSize, name: "Global colour table", kind: "meta",
      note: `${gctSize / 3} colours` });
    i += gctSize;
  }

  while (i < head.length) {
    const b = head[i] as number;
    if (b === 0x3b) {
      regions.push({ start: i, end: i + 1, name: "Trailer", kind: "trailer" });
      return { format: "gif", regions, truncated: false };
    }
    if (b === 0x21) {
      // Extension: label, then a chain of length-prefixed sub-blocks.
      const label = head[i + 1] ?? 0;
      const end = subBlocksEnd(head, i + 2);
      regions.push({
        start: i, end: Math.min(end, head.length), kind: "meta",
        name: label === 0xf9 ? "Graphic control extension"
          : label === 0xff ? "Application extension"
          : label === 0xfe ? "Comment extension" : `Extension 0x${hex(label)}`,
      });
      if (end > head.length) break;
      i = end;
      continue;
    }
    if (b === 0x2c) {
      if (i + 10 > head.length) break;
      const f = head[i + 9] as number;
      const lct = (f & 0x80) !== 0 ? 3 * (1 << ((f & 7) + 1)) : 0;
      const dataStart = i + 10 + lct + 1; // + the LZW minimum-code-size byte
      const end = subBlocksEnd(head, dataStart);
      regions.push({
        start: i, end: Math.min(end, head.length), kind: "data",
        name: "Image block",
        note: `${u16le(head, i + 5)} × ${u16le(head, i + 7)} at ${u16le(head, i + 1)},${u16le(head, i + 3)}`,
      });
      if (end > head.length) break;
      i = end;
      continue;
    }
    break;
  }
  return { format: "gif", regions, truncated: head.length < size };
}

/** GIF's length-prefixed sub-block chain, terminated by a zero length. */
function subBlocksEnd(b: Uint8Array, from: number): number {
  let i = from;
  while (i < b.length) {
    const n = b[i] as number;
    if (n === 0) return i + 1;
    i += n + 1;
  }
  return b.length + 1;
}

// ── RIFF (WebP, WAV, AVI) ───────────────────────────────────────────────────

function riff(head: Uint8Array, size: number): Structure {
  const form = str(head, 8, 4);
  const declared = u32le(head, 4) + 8;
  const regions: Region[] = [{
    start: 0, end: 12, name: `RIFF — ${form}`, kind: "header",
    // A RIFF that disagrees with its own file size is the classic symptom of a
    // chunk removed without repairing the header, and decoders reject it.
    note: declared === size ? `${declared} bytes, agrees with the file`
      : `declares ${declared} bytes, file is ${size}`,
  }];

  let i = 12;
  let truncated = false;
  while (i + 8 <= head.length) {
    const id = str(head, i, 4);
    const len = u32le(head, i + 4);
    const end = i + 8 + len + (len & 1); // chunks pad to even
    if (end <= i) break;
    regions.push({
      start: i, end: Math.min(end, head.length), name: `${id} chunk`,
      note: `${len} bytes`,
      kind: id === "data" || id === "VP8 " || id === "VP8L" ? "data" : "meta",
    });
    if (end > head.length) { truncated = true; break; }
    i = end;
  }
  return { format: form === "WEBP" ? "webp" : form === "WAVE" ? "wav" : "riff",
    regions, truncated: truncated || head.length < size };
}

// ── ISO base media (MP4, MOV, HEIC) ─────────────────────────────────────────

/** Boxes whose payload is more boxes. */
const BOX_CONTAINERS = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "udta", "moof",
  "traf", "mvex", "meta", "iprp", "ipco", "stsd",
]);

function isBox(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  const t = str(b, 4, 4);
  return /^[a-zA-Z0-9 ]{4}$/.test(t) && u32(b, 0) >= 8 && ["ftyp", "moov", "mdat", "styp", "free", "skip"].includes(t);
}

function isobmff(head: Uint8Array, size: number): Structure {
  const walk = (from: number, to: number, depth: number): [Region[], boolean] => {
    const out: Region[] = [];
    let i = from;
    let cut = false;
    while (i + 8 <= Math.min(to, head.length)) {
      let len = u32(head, i);
      const type = str(head, i + 4, 4);
      let body = i + 8;
      if (len === 1) {
        // 64-bit size. Reading the high word is honest even though a file that
        // needs it is larger than anything this will be pointed at.
        if (i + 16 > head.length) { cut = true; break; }
        len = u32(head, i + 8) * 2 ** 32 + u32(head, i + 12);
        body = i + 16;
      } else if (len === 0) {
        len = to - i; // "to the end"
      }
      const end = i + len;
      if (len < 8 || end <= i) break;

      // `meta` is a full box: a version/flags word sits before its children.
      const childFrom = type === "meta" ? body + 4 : body;
      const [kids, kidCut] = BOX_CONTAINERS.has(type) && depth < 6
        ? walk(childFrom, Math.min(end, head.length), depth + 1)
        : [[] as Region[], false];

      out.push({
        start: i, end: Math.min(end, head.length),
        name: `${type} box`,
        note: boxNote(head, i, type, len),
        kind: type === "mdat" ? "data" : type === "ftyp" ? "header" : "meta",
        ...(kids.length > 0 ? { children: kids } : {}),
      });
      if (end > head.length) { cut = true; break; }
      cut = cut || kidCut;
      i = end;
    }
    return [out, cut];
  };

  const [regions, cut] = walk(0, size, 0);
  const ftyp = regions[0];
  const brand = ftyp && ftyp.name.startsWith("ftyp") ? str(head, 8, 4) : "";
  return {
    format: brand === "heic" || brand === "heix" || brand === "mif1" ? "heic" : "mp4",
    regions,
    truncated: cut || head.length < size,
  };
}

function boxNote(b: Uint8Array, at: number, type: string, len: number): string {
  if (type === "ftyp") return `brand ${str(b, at + 8, 4)}, ${len} bytes`;
  if (type === "mdat") return `${len} bytes of media — the audio and video themselves`;
  return `${len} bytes`;
}

// ── ZIP ─────────────────────────────────────────────────────────────────────

function zip(head: Uint8Array, size: number, tail?: Tail): Structure {
  const regions: Region[] = [];
  let i = 0;
  let truncated = false;

  while (i + 30 <= head.length) {
    if (u32le(head, i) !== 0x04034b50) break;
    const nameLen = u16le(head, i + 26);
    const extraLen = u16le(head, i + 28);
    const compressed = u32le(head, i + 18);
    const flags = u16le(head, i + 6);
    const name = str(head, i + 30, Math.min(nameLen, 120));
    const headerEnd = i + 30 + nameLen + extraLen;
    const end = headerEnd + compressed;

    regions.push({
      start: i, end: Math.min(end, head.length), kind: "data",
      name: `Entry — ${name || "(unnamed)"}`,
      note: `${compressed} bytes stored, method ${u16le(head, i + 8)}` +
        // Bit 3 means the sizes are written *after* the data, so the local
        // header's size fields are zero and a walk from the front cannot
        // find the next entry. Saying so beats stopping silently.
        ((flags & 8) !== 0 ? " — sizes in a trailing descriptor" : ""),
    });
    if (end > head.length) { truncated = true; break; }
    if (compressed === 0 && (flags & 8) !== 0) { truncated = true; break; }
    i = end;
  }

  // The file list lives at the end, which is why a zip can be appended to and
  // still open, and why the front-to-back walk above is the *less* reliable one.
  if (tail) {
    const at = findEocd(tail.bytes);
    if (at >= 0) {
      const count = u16le(tail.bytes, at + 10);
      const cdSize = u32le(tail.bytes, at + 12);
      const cdOff = u32le(tail.bytes, at + 16);
      regions.push({
        start: cdOff, end: cdOff + cdSize, kind: "index",
        name: "Central directory",
        note: `${count} entr${count === 1 ? "y" : "ies"} — the authoritative file list`,
      });
      regions.push({
        start: tail.offset + at, end: size, kind: "trailer",
        name: "End of central directory",
      });
    }
  }
  return { format: "zip", regions, truncated: truncated || (!tail && head.length < size) };
}

/** The EOCD signature, searched backwards — the record is last by definition. */
function findEocd(b: Uint8Array): number {
  for (let i = b.length - 22; i >= 0; i--) {
    if (u32le(b, i) === 0x06054b50) return i;
  }
  return -1;
}

// ── gzip ────────────────────────────────────────────────────────────────────

function gzip(head: Uint8Array, size: number): Structure {
  const flags = head[3] ?? 0;
  let i = 10;
  const regions: Region[] = [{
    start: 0, end: 10, name: "Header", kind: "header",
    note: `method ${head[2]}, flags 0x${hex(flags)}`,
  }];
  if ((flags & 4) !== 0 && i + 2 <= head.length) {
    const n = u16le(head, i);
    regions.push({ start: i, end: i + 2 + n, name: "Extra field", kind: "meta" });
    i += 2 + n;
  }
  if ((flags & 8) !== 0) {
    const end = zEnd(head, i);
    regions.push({ start: i, end, name: "Original file name", kind: "meta", note: str(head, i, end - i - 1) });
    i = end;
  }
  if ((flags & 16) !== 0) {
    const end = zEnd(head, i);
    regions.push({ start: i, end, name: "Comment", kind: "meta" });
    i = end;
  }
  regions.push({ start: i, end: Math.max(i, size - 8), name: "Deflate stream", kind: "data" });
  regions.push({
    start: Math.max(i, size - 8), end: size, name: "CRC and length", kind: "trailer",
    note: "uncompressed size, modulo 4 GB",
  });
  return { format: "gzip", regions, truncated: false };
}

function zEnd(b: Uint8Array, from: number): number {
  let i = from;
  while (i < b.length && b[i] !== 0) i++;
  return i + 1;
}

// ── ELF ─────────────────────────────────────────────────────────────────────

function elf(head: Uint8Array, size: number): Structure {
  const bits = head[4] === 2 ? 64 : 32;
  const le = head[5] === 1;
  const r = (at: number, n: number): number => {
    let v = 0;
    for (let k = 0; k < n; k++) v += (head[at + (le ? k : n - 1 - k)] ?? 0) * 2 ** (8 * k);
    return v;
  };
  const regions: Region[] = [{
    start: 0, end: bits === 64 ? 64 : 52, name: "ELF header", kind: "header",
    note: `${bits}-bit, ${le ? "little" : "big"}-endian, type ${r(16, 2)}, machine ${r(18, 2)}`,
  }];
  const phOff = bits === 64 ? r(32, 8) : r(28, 4);
  const shOff = bits === 64 ? r(40, 8) : r(32, 4);
  const phSize = r(bits === 64 ? 54 : 42, 2);
  const phNum = r(bits === 64 ? 56 : 44, 2);
  const shSize = r(bits === 64 ? 58 : 46, 2);
  const shNum = r(bits === 64 ? 60 : 48, 2);
  if (phOff > 0) {
    regions.push({ start: phOff, end: phOff + phSize * phNum, kind: "index",
      name: "Program headers", note: `${phNum} segments — what the loader maps` });
  }
  if (shOff > 0) {
    regions.push({ start: shOff, end: shOff + shSize * shNum, kind: "index",
      name: "Section headers", note: `${shNum} sections — what the linker used` });
  }
  return { format: "elf", regions, truncated: head.length < size };
}

// ── PE (exe, dll) ───────────────────────────────────────────────────────────

function pe(head: Uint8Array, size: number): Structure {
  const regions: Region[] = [{
    start: 0, end: 64, name: "DOS header", kind: "header",
    note: "the MZ stub — a real 16-bit program that prints a refusal",
  }];
  const lfanew = u32le(head, 60);
  if (lfanew <= 0 || lfanew + 24 > head.length) {
    return { format: "pe", regions, truncated: head.length < size };
  }
  regions.push({ start: 64, end: lfanew, name: "DOS stub", kind: "data" });
  const machine = u16le(head, lfanew + 4);
  const sections = u16le(head, lfanew + 6);
  const optSize = u16le(head, lfanew + 20);
  regions.push({
    start: lfanew, end: lfanew + 24, name: "PE header", kind: "header",
    note: `machine 0x${hex(machine)}, ${sections} sections`,
  });
  regions.push({ start: lfanew + 24, end: lfanew + 24 + optSize, kind: "header",
    name: "Optional header", note: "entry point, image base, data directories" });

  let t = lfanew + 24 + optSize;
  for (let k = 0; k < sections && t + 40 <= head.length; k++, t += 40) {
    const name = str(head, t, 8).replace(/\0+$/, "");
    const raw = u32le(head, t + 20);
    const rawSize = u32le(head, t + 16);
    regions.push({ start: t, end: t + 40, name: `Section header — ${name}`, kind: "index",
      note: `${rawSize} bytes at ${raw}` });
    if (raw > 0 && rawSize > 0) {
      regions.push({ start: raw, end: Math.min(raw + rawSize, size), kind: "data",
        name: `Section — ${name}` });
    }
  }
  return { format: "pe", regions, truncated: head.length < size };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

function pdf(head: Uint8Array, size: number, tail?: Tail): Structure {
  const regions: Region[] = [{
    start: 0, end: 9, name: "Header", kind: "header", note: str(head, 0, 8),
  }];
  if (tail) {
    const text = str(tail.bytes, 0, tail.bytes.length);
    const sx = text.lastIndexOf("startxref");
    if (sx >= 0) {
      const at = Number((text.slice(sx + 9).match(/\d+/) ?? ["0"])[0]);
      regions.push({
        start: tail.offset + sx, end: size, kind: "trailer",
        name: "startxref",
        note: `the cross-reference table is at byte ${at} — a PDF is read from the back`,
      });
      if (at > 0 && at < size) {
        regions.push({ start: at, end: Math.min(at + 512, size), kind: "index",
          name: "Cross-reference table", note: "where every object lives" });
      }
    }
  }
  return { format: "pdf", regions, truncated: head.length < size };
}

// ── bytes ───────────────────────────────────────────────────────────────────

function magic(b: Uint8Array, bytes: number[]): boolean {
  if (b.length < bytes.length) return false;
  return bytes.every((v, i) => b[i] === v);
}

function str(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < Math.min(at + n, b.length); i++) s += String.fromCharCode(b[i] as number);
  return s;
}

const u16 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) * 2 ** 24 + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
const u32le = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) + ((b[at + 1] ?? 0) << 8) + ((b[at + 2] ?? 0) << 16) + (b[at + 3] ?? 0) * 2 ** 24;

const hex = (n: number): string => n.toString(16).padStart(2, "0");
