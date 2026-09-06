/**
 * Snappy, decompression only.
 *
 * It is the default codec for Parquet and there is no `DecompressionStream`
 * for it, so it is either this or no Parquet. Decompression is the small half
 * of Snappy: a varint length, then a stream of tags that are either "copy this
 * many literal bytes" or "go back this far and repeat this many".
 *
 * The one thing that catches people out is that a copy may overlap its own
 * output — offset 1, length 40 means "repeat the last byte forty times", which
 * is how Snappy encodes a run. `copyWithin` would read the pre-copy bytes and
 * quietly produce garbage, so the loop below is a loop on purpose.
 */

export function snappyDecompress(input: Uint8Array): Uint8Array {
  let p = 0;
  let shift = 0;
  let size = 0;
  for (;;) {
    if (p >= input.length) throw new Error("snappy: truncated length");
    const b = input[p++] as number;
    size |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 32) throw new Error("snappy: bad length");
  }

  const out = new Uint8Array(size);
  let o = 0;

  while (p < input.length) {
    const tag = input[p++] as number;
    const kind = tag & 0x03;

    if (kind === 0) {
      // Literal. Lengths above 60 are stored in the following 1–4 bytes.
      let len = (tag >> 2) + 1;
      if (len > 60) {
        const n = len - 60;
        len = 0;
        for (let i = 0; i < n; i++) len |= (input[p + i] as number) << (8 * i);
        len = (len >>> 0) + 1;
        p += n;
      }
      if (p + len > input.length || o + len > size) throw new Error("snappy: literal overruns");
      out.set(input.subarray(p, p + len), o);
      p += len;
      o += len;
      continue;
    }

    let len: number, offset: number;
    if (kind === 1) {
      len = 4 + ((tag >> 2) & 0x07);
      offset = ((tag >> 5) << 8) | (input[p++] as number);
    } else if (kind === 2) {
      len = (tag >> 2) + 1;
      offset = (input[p] as number) | ((input[p + 1] as number) << 8);
      p += 2;
    } else {
      len = (tag >> 2) + 1;
      offset = ((input[p] as number) | ((input[p + 1] as number) << 8) |
        ((input[p + 2] as number) << 16) | ((input[p + 3] as number) << 24)) >>> 0;
      p += 4;
    }

    if (offset === 0 || offset > o || o + len > size) throw new Error("snappy: bad copy");
    // Byte at a time: the source and destination are allowed to overlap, and
    // for a run they always do.
    for (let i = 0, from = o - offset; i < len; i++) out[o + i] = out[from + i] as number;
    o += len;
  }

  if (o !== size) throw new Error(`snappy: produced ${o} of ${size} bytes`);
  return out;
}
