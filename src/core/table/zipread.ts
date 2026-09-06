/**
 * Reading one file out of a zip without unpacking the zip.
 *
 * An .xlsx is a zip. So is an .ods, a .docx, an .epub and a .jar. Opening one
 * normally means handing the whole thing to a library that inflates every
 * entry; but a spreadsheet's sheet data is one entry among a dozen, and the
 * rest — themes, styles, printer settings, a thumbnail — is weight nobody
 * asked for.
 *
 * So this does what the format was designed for: read the index at the end,
 * find the one entry, read exactly its bytes, inflate exactly those. On a
 * 200 MB workbook where the sheet is 12 MB, that is the difference between a
 * spinner and no spinner.
 *
 * Inflate comes from the browser's own `DecompressionStream("deflate-raw")` —
 * the same zlib the rest of the platform uses. Shipping a hand-written inflate
 * next to a correct one already in the process would be indefensible.
 */

export interface ZipEntry {
  name: string;
  /** Offset of the local file header, which is not where the data starts. */
  headerOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else we decline rather than guess. */
  method: number;
}

export interface ZipHost {
  readRange(path: string, offset: number, len: number): Promise<number[]>;
  readTail(path: string, len: number): Promise<[number[], number]>;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC = 0x07064b50;

/**
 * The entry list, read from the end.
 *
 * The comment field at the end of a zip is up to 64 KB, so the record we are
 * looking for can be up to that far from the last byte — searching backwards
 * from the very end and giving up after a few hundred bytes is why some tools
 * "cannot open" a perfectly good archive that happens to carry a comment.
 */
export async function readDirectory(host: ZipHost, path: string): Promise<ZipEntry[]> {
  const [tailArr, tailOff] = await host.readTail(path, 66 * 1024);
  const tail = new Uint8Array(tailArr);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory record)");

  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  // Zip64. The 32-bit fields saturate at 0xffffffff and the real numbers live
  // in a separate record — a 5 GB archive with 70 000 files is not exotic any
  // more, and a reader that ignores this silently reads the wrong offset.
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (dv.getUint32(i, true) !== EOCD64_LOC) continue;
      const rel = Number(dv.getBigUint64(i + 8, true));
      const rec = new Uint8Array(await host.readRange(path, rel, 56));
      const rdv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
      count = Number(rdv.getBigUint64(32, true));
      cdSize = Number(rdv.getBigUint64(40, true));
      cdOffset = Number(rdv.getBigUint64(48, true));
      break;
    }
  }

  // The directory is usually already inside the tail we read; only go back to
  // disk when it is not.
  let cd: Uint8Array;
  if (cdOffset >= tailOff && cdOffset + cdSize <= tailOff + tail.length) {
    cd = tail.subarray(cdOffset - tailOff, cdOffset - tailOff + cdSize);
  } else {
    cd = new Uint8Array(await host.readRange(path, cdOffset, cdSize));
  }

  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cdv.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = cdv.getUint16(p + 28, true);
    const extraLen = cdv.getUint16(p + 30, true);
    const commentLen = cdv.getUint16(p + 32, true);
    const entry: ZipEntry = {
      name: new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen)),
      method: cdv.getUint16(p + 10, true),
      compressedSize: cdv.getUint32(p + 20, true),
      uncompressedSize: cdv.getUint32(p + 24, true),
      headerOffset: cdv.getUint32(p + 42, true),
    };
    // Zip64 again, per entry, in the extra field.
    if (entry.uncompressedSize === 0xffffffff || entry.compressedSize === 0xffffffff ||
        entry.headerOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cdv.getUint16(e, true);
        const len = cdv.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (entry.uncompressedSize === 0xffffffff) { entry.uncompressedSize = Number(cdv.getBigUint64(q, true)); q += 8; }
          if (entry.compressedSize === 0xffffffff) { entry.compressedSize = Number(cdv.getBigUint64(q, true)); q += 8; }
          if (entry.headerOffset === 0xffffffff) { entry.headerOffset = Number(cdv.getBigUint64(q, true)); }
          break;
        }
        e += 4 + len;
      }
    }
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * One entry's bytes.
 *
 * The local header's name and extra lengths are read fresh rather than reused
 * from the central directory, because the two are allowed to differ — the
 * extra field in particular routinely does, and trusting the directory's copy
 * puts the read a few bytes into the compressed data, where inflate fails with
 * something unhelpful.
 */
export async function readEntry(host: ZipHost, path: string, entry: ZipEntry): Promise<Uint8Array> {
  const hdr = new Uint8Array(await host.readRange(path, entry.headerOffset, 30));
  const hdv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
  if (hdv.getUint32(0, true) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const dataAt = entry.headerOffset + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true);
  const raw = new Uint8Array(await host.readRange(path, dataAt, entry.compressedSize));
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`${entry.name} uses compression method ${entry.method}`);
  return inflateRaw(raw);
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array);
    total += (value as Uint8Array).length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
