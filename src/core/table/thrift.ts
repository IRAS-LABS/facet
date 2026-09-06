/**
 * Thrift's compact binary protocol, enough of it to read a Parquet footer.
 *
 * Parquet's metadata is a Thrift struct, and there is no way to learn where a
 * column's data lives without decoding it. The compact protocol is a small
 * format — varints, zigzag, and a field header that stores the *delta* from
 * the previous field id so consecutive fields cost four bits — but the delta
 * is exactly the part that punishes a shortcut: read one field wrong and every
 * id after it is wrong too, silently, with plausible-looking values.
 *
 * Structs come back as a map from field id to value rather than as named
 * fields, because the wire format carries ids and nothing else. Naming happens
 * one layer up, where the schema is known.
 */

export type ThriftValue = number | bigint | boolean | Uint8Array | ThriftStruct | ThriftValue[];
export type ThriftStruct = Map<number, ThriftValue>;

const T_STOP = 0, T_TRUE = 1, T_FALSE = 2, T_BYTE = 3, T_I16 = 4, T_I32 = 5,
  T_I64 = 6, T_DOUBLE = 7, T_BINARY = 8, T_LIST = 9, T_SET = 10, T_MAP = 11, T_STRUCT = 12;

export class ThriftReader {
  private p = 0;
  constructor(private readonly b: Uint8Array) {}

  get offset(): number { return this.p; }

  private byte(): number {
    if (this.p >= this.b.length) throw new Error("thrift: ran off the end");
    return this.b[this.p++] as number;
  }

  /** Unsigned LEB128. Capped at ten bytes so a corrupt file cannot spin. */
  private varint(): bigint {
    let shift = 0n, out = 0n;
    for (let n = 0; n < 10; n++) {
      const b = BigInt(this.byte());
      out |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) return out;
      shift += 7n;
    }
    throw new Error("thrift: varint too long");
  }

  /** Zigzag: the sign is the low bit, so small negatives stay one byte. */
  private zigzag(): bigint {
    const v = this.varint();
    return (v >> 1n) ^ -(v & 1n);
  }

  struct(): ThriftStruct {
    const out: ThriftStruct = new Map();
    let id = 0;
    for (;;) {
      const h = this.byte();
      const type = h & 0x0f;
      if (type === T_STOP) return out;
      const delta = (h & 0xf0) >> 4;
      // A zero delta means the id is written out in full, which is how a struct
      // with a field id above 15 or out of order is encoded.
      id = delta === 0 ? Number(this.zigzag()) : id + delta;
      out.set(id, this.value(type));
    }
  }

  private value(type: number): ThriftValue {
    switch (type) {
      case T_TRUE: return true;
      case T_FALSE: return false;
      case T_BYTE: { const v = this.byte(); return v > 127 ? v - 256 : v; }
      case T_I16: case T_I32: return Number(this.zigzag());
      case T_I64: {
        const v = this.zigzag();
        // Row counts and offsets fit in a double until they are astronomical;
        // handing back a Number where it is exact keeps every caller simpler.
        return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v;
      }
      case T_DOUBLE: {
        const dv = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8);
        this.p += 8;
        return dv.getFloat64(0, true);
      }
      case T_BINARY: {
        const n = Number(this.varint());
        if (n < 0 || this.p + n > this.b.length) throw new Error("thrift: bad binary length");
        const out = this.b.subarray(this.p, this.p + n);
        this.p += n;
        return out;
      }
      case T_LIST: case T_SET: {
        const h = this.byte();
        let size = (h & 0xf0) >> 4;
        // 15 means "long form": the real count follows as a varint.
        if (size === 15) size = Number(this.varint());
        const et = h & 0x0f;
        const out: ThriftValue[] = [];
        for (let i = 0; i < size; i++) out.push(this.value(et));
        return out;
      }
      case T_MAP: {
        const size = Number(this.varint());
        if (size === 0) return [];
        const kv = this.byte();
        const out: ThriftValue[] = [];
        for (let i = 0; i < size; i++) {
          out.push(this.value((kv & 0xf0) >> 4));
          out.push(this.value(kv & 0x0f));
        }
        return out;
      }
      case T_STRUCT: return this.struct();
      default: throw new Error(`thrift: unknown type ${type}`);
    }
  }
}

export const asNum = (v: ThriftValue | undefined, fallback = 0): number =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : fallback;

export const asStr = (v: ThriftValue | undefined): string =>
  v instanceof Uint8Array ? new TextDecoder().decode(v) : "";

export const asStruct = (v: ThriftValue | undefined): ThriftStruct | undefined =>
  v instanceof Map ? v : undefined;

export const asList = (v: ThriftValue | undefined): ThriftValue[] =>
  Array.isArray(v) ? v : [];
