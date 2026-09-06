/**
 * Metadata: what a file quietly says about you.
 *
 * A photo off a phone carries the camera body, the lens, the exact second, the
 * serial number and — routinely — the coordinates of your house. None of that is
 * visible in a file manager, which is exactly why it survives being posted.
 * This module reads it and, separately, removes it.
 *
 * Everything here is byte work with no dependencies. That is not minimalism for
 * its own sake: an EXIF library that decodes and re-encodes a JPEG to strip a
 * tag *recompresses the picture*, so "remove my location" silently costs image
 * quality. Rewriting the segment list keeps the entropy-coded scan byte-identical
 * — the pixels that come out are the pixels that went in.
 *
 * Formats: JPEG (segments), TIFF and TIFF-based RAW (IFDs), PNG (chunks), WebP
 * (RIFF chunks). HEIC is read-only for now; its metadata lives in a box tree
 * that needs the same parser the decoder wants, and that is its own job.
 */

export interface MetaTag {
  /** Numeric tag id where the format has one, for the "show raw" view. */
  id?: number;
  name: string;
  value: string;
}

export interface MetaGroup {
  name: string;
  tags: MetaTag[];
}

export interface Coords {
  lat: number;
  lon: number;
  /** Metres above sea level, when recorded. */
  alt?: number;
}

export interface Metadata {
  /** Container we recognised: "jpeg", "tiff", "png", "webp", or "" if not. */
  format: string;
  groups: MetaGroup[];
  /** Present only when the file records where it was taken. */
  gps?: Coords;
  /**
   * Whether anything here identifies a person, a place or a device — the flag
   * the UI turns red. Dimensions and colour space are metadata too, and warning
   * about those would train you to ignore the warning.
   */
  sensitive: boolean;
  /** Whether `strip` can remove it without re-encoding the image. */
  strippable: boolean;
}

/** What `strip` took out, so the UI can say so rather than claim success. */
export interface StripResult {
  bytes: Uint8Array;
  removed: string[];
  /** Bytes saved. Usually a few KB; a thumbnail-bearing JPEG can shed 30 KB. */
  saved: number;
}

// ── Tag names ───────────────────────────────────────────────────────────────
//
// Not the full EXIF dictionary — the tags a person would actually look for,
// plus every tag that carries identity. An unknown tag is still shown, by
// number, because "0x9999: 3" is more honest than hiding it.

const TIFF_TAGS: Record<number, string> = {
  0x0100: "Image width",
  0x0101: "Image height",
  0x0102: "Bits per sample",
  0x0103: "Compression",
  0x0106: "Photometric interpretation",
  0x010e: "Description",
  0x010f: "Camera make",
  0x0110: "Camera model",
  0x0111: "Strip offsets",
  0x0112: "Orientation",
  0x0115: "Samples per pixel",
  0x011a: "X resolution",
  0x011b: "Y resolution",
  0x0128: "Resolution unit",
  0x0131: "Software",
  0x0132: "Date/time",
  0x013b: "Artist",
  0x0212: "Chroma subsampling",
  0x0213: "YCbCr positioning",
  0x8298: "Copyright",
  0x8769: "Exif offset",
  0x8825: "GPS offset",
  0x9c9b: "Title",
  0x9c9c: "Comment",
  0x9c9d: "Author",
  0x9c9e: "Keywords",
  0x9c9f: "Subject",
};

const EXIF_TAGS: Record<number, string> = {
  0x829a: "Exposure time",
  0x829d: "F number",
  0x8822: "Exposure program",
  0x8827: "ISO",
  0x9000: "Exif version",
  0x9003: "Taken",
  0x9004: "Digitised",
  // The three time tags a phone writes alongside the timestamps. On their own
  // they look like noise; together they pin a photo to the second, in a named
  // time zone — which is to say, to a place.
  0x9010: "Time zone",
  0x9011: "Time zone (taken)",
  0x9012: "Time zone (digitised)",
  0x9290: "Sub-second",
  0x9291: "Sub-second (taken)",
  0x9292: "Sub-second (digitised)",
  0x9201: "Shutter speed",
  0x9202: "Aperture",
  0x9203: "Brightness",
  0x9204: "Exposure bias",
  0x9205: "Max aperture",
  0x9206: "Subject distance",
  0x9207: "Metering mode",
  0x9208: "Light source",
  0x9209: "Flash",
  0x920a: "Focal length",
  0x927c: "Maker note",
  0x9286: "User comment",
  0xa000: "Flashpix version",
  0xa001: "Colour space",
  0xa002: "Pixel width",
  0xa003: "Pixel height",
  0xa004: "Related audio file",
  0xa005: "Interoperability block",
  0xa20e: "Focal plane X resolution",
  0xa20f: "Focal plane Y resolution",
  0xa402: "Exposure mode",
  0xa403: "White balance",
  0xa404: "Digital zoom",
  0xa405: "Focal length (35mm)",
  0xa406: "Scene type",
  0xa408: "Contrast",
  0xa409: "Saturation",
  0xa40a: "Sharpness",
  // A per-photo identifier the camera generates. Two files carrying the same
  // one came off the same shot, and a file carrying it at all can be matched
  // back to wherever else that string has been seen. It is a tracking number.
  0xa420: "Image unique ID",
  0xa430: "Camera owner",
  0xa431: "Body serial number",
  0xa432: "Lens specification",
  0xa433: "Lens make",
  0xa434: "Lens model",
  0xa435: "Lens serial number",
};

const GPS_TAGS: Record<number, string> = {
  0x0000: "GPS version",
  0x0001: "Latitude ref",
  0x0002: "Latitude",
  0x0003: "Longitude ref",
  0x0004: "Longitude",
  0x0005: "Altitude ref",
  0x0006: "Altitude",
  0x0007: "GPS time",
  0x0008: "Satellites",
  0x0009: "GPS status",
  0x000b: "Dilution of precision",
  0x000c: "Speed unit",
  0x000d: "Speed",
  0x0010: "Direction ref",
  0x0011: "Direction",
  0x001d: "GPS date",
  0x001f: "Position error",
};

/**
 * Tags that identify a person, a place, or a specific piece of hardware.
 * Serial numbers are on this list because they tie every photo you have ever
 * posted to the same camera body, which is the same problem as a name.
 */
const SENSITIVE_TIFF = new Set([0x010f, 0x0110, 0x0131, 0x0132, 0x013b, 0x8298, 0x010e]);
const SENSITIVE_EXIF = new Set([
  0x9003, 0x9004, 0x927c, 0x9286, 0xa430, 0xa431, 0xa433, 0xa434, 0xa435,
  // The time-zone offsets: a bare timestamp is ambiguous by half a planet, and
  // these remove the ambiguity. And the unique ID, which is a tracking number
  // whatever the specification calls it.
  0x9010, 0x9011, 0x9012, 0xa420,
]);

// Human-readable values for enumerated tags. A photo that says "Flash: 9" is
// not information, it is homework.
const ORIENTATION: Record<number, string> = {
  1: "Normal",
  2: "Mirrored",
  3: "Rotated 180°",
  4: "Mirrored, rotated 180°",
  5: "Mirrored, rotated 90° CCW",
  6: "Rotated 90° CW",
  7: "Mirrored, rotated 90° CW",
  8: "Rotated 90° CCW",
};

const METERING: Record<number, string> = {
  0: "Unknown", 1: "Average", 2: "Centre-weighted", 3: "Spot",
  4: "Multi-spot", 5: "Pattern", 6: "Partial", 255: "Other",
};

const EXPOSURE_PROGRAM: Record<number, string> = {
  0: "Not defined", 1: "Manual", 2: "Program", 3: "Aperture priority",
  4: "Shutter priority", 5: "Creative", 6: "Action", 7: "Portrait", 8: "Landscape",
};

const WHITE_BALANCE: Record<number, string> = { 0: "Auto", 1: "Manual" };
const EXPOSURE_MODE: Record<number, string> = { 0: "Auto", 1: "Manual", 2: "Auto bracket" };

// ── Reading ─────────────────────────────────────────────────────────────────

/** Read whatever metadata the bytes carry. Never throws; unknown → empty. */
export function readMetadata(bytes: Uint8Array): Metadata {
  try {
    if (isJpeg(bytes)) return fromJpeg(bytes);
    if (isPng(bytes)) return fromPng(bytes);
    if (isWebp(bytes)) return fromWebp(bytes);
    if (tiffOrder(bytes, 0)) return finish("tiff", fromTiff(bytes, 0), true);
  } catch {
    // A truncated or malformed file is common and is not an error worth
    // surfacing — it simply has no readable metadata.
  }
  return { format: "", groups: [], sensitive: false, strippable: false };
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
}

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function isWebp(b: Uint8Array): boolean {
  return (
    b.length > 12 &&
    str(b, 0, 4) === "RIFF" &&
    str(b, 8, 4) === "WEBP"
  );
}

interface Parsed {
  groups: MetaGroup[];
  gps?: Coords;
  sensitive: boolean;
}

function finish(format: string, p: Parsed, strippable: boolean): Metadata {
  const m: Metadata = {
    format,
    groups: p.groups.filter((g) => g.tags.length > 0),
    sensitive: p.sensitive,
    strippable,
  };
  if (p.gps) m.gps = p.gps;
  return m;
}

function fromJpeg(b: Uint8Array): Metadata {
  const merged: Parsed = { groups: [], sensitive: false };
  const extras: MetaTag[] = [];

  for (const seg of jpegSegments(b)) {
    // APP1 is either EXIF or XMP; both matter, for different reasons.
    if (seg.marker === 0xe1 && str(b, seg.start, 6) === "Exif\0\0") {
      const p = fromTiff(b, seg.start + 6, seg.start + 6);
      merged.groups.push(...p.groups);
      merged.sensitive ||= p.sensitive;
      if (p.gps) merged.gps = p.gps;
    } else if (seg.marker === 0xe1 && str(b, seg.start, 28).startsWith("http://ns.adobe.com/xap")) {
      const xmp = xmpFields(latin1(b, seg.start, seg.len));
      if (xmp.length > 0) {
        merged.groups.push({ name: "XMP", tags: xmp });
        merged.sensitive = true;
      }
    } else if (seg.marker === 0xed) {
      extras.push({ name: "Photoshop/IPTC block", value: `${seg.len} bytes` });
      merged.sensitive = true;
    } else if (seg.marker === 0xfe) {
      const text = latin1(b, seg.start, Math.min(seg.len, 400)).trim();
      if (text) extras.push({ name: "Comment", value: text });
    } else if (seg.marker === 0xe0 && str(b, seg.start, 5) === "JFIF\0") {
      extras.push({ name: "JFIF", value: `${b[seg.start + 5]}.${b[seg.start + 6]}` });
    }
  }

  // Anything past the end-of-image marker is not part of the picture, and on a
  // Samsung phone it is routinely a whole motion-photo clip — three seconds of
  // video *and audio* from before you pressed the shutter, riding along inside
  // what looks like a still. No viewer shows it and no EXIF tool reports it, so
  // it survives every "cleaned" upload. It gets its own line.
  const end = jpegEnd(b, 2);
  if (end < b.length) {
    extras.push({ name: "Appended data", value: describeTrailer(b, end) });
    merged.sensitive = true;
  }

  if (extras.length > 0) merged.groups.push({ name: "Other blocks", tags: extras });
  return finish("jpeg", merged, true);
}

/**
 * One past the JPEG's real end-of-image marker.
 *
 * Cannot be a backwards search for `FF D9`: a trailer may contain those bytes.
 * Must walk forward, because inside the entropy-coded scan a literal 0xFF is
 * stuffed as `FF 00` and restart markers are `FF D0`–`FF D7` — so the first
 * `FF D9` reached by an honest walk is the only real one. Progressive JPEGs
 * have several scans, which is why this keeps going after one.
 */
function jpegEnd(b: Uint8Array, from: number): number {
  let i = from;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1]!;
    if (m === 0xff) { i++; continue; }                 // fill byte
    if (m === 0x00) { i += 2; continue; }              // stuffed 0xFF in the scan
    if (m >= 0xd0 && m <= 0xd7) { i += 2; continue; }  // restart marker
    if (m === 0xd8) { i += 2; continue; }              // SOI
    if (m === 0xd9) return i + 2;                      // EOI — inclusive
    if (i + 4 > b.length) break;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2 || i + 2 + len > b.length) { i += 2; continue; }
    i += 2 + len;
  }
  return b.length;
}

/** Name the trailer if we can, because "8 MB of unknown data" invites shrugging. */
function describeTrailer(b: Uint8Array, at: number): string {
  const size = b.length - at;
  const kb = size < 1024 ? `${size} bytes` : `${Math.round(size / 1024)} KB`;
  const tail = str(b, b.length - 8, 8);
  const blob = str(b, at, Math.min(size, 4096));
  if (tail.endsWith("SEFT") || blob.includes("SEFH")) {
    return `${kb} — Samsung trailer${blob.includes("ftyp") || blob.includes("MotionPhoto")
      ? ", contains a motion-photo video" : ""}`;
  }
  if (blob.includes("ftyp")) return `${kb} — an embedded MP4`;
  if (blob.startsWith("\xff\xd8")) return `${kb} — a second JPEG`;
  return `${kb} after the image ends`;
}

interface Segment {
  marker: number;
  /** First payload byte, past the two length bytes. */
  start: number;
  len: number;
  /** First byte of the 0xFF marker itself, for the rewriter. */
  at: number;
}

/**
 * Walk a JPEG's segment list, stopping at the scan.
 *
 * Everything before SOS is a marker segment with a 16-bit length; the scan
 * itself is entropy-coded bytes with no length at all, which is why a stripper
 * has to stop here and copy the rest verbatim rather than keep parsing.
 */
function* jpegSegments(b: Uint8Array): Generator<Segment> {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    // Standalone markers carry no payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2 || i + 2 + len > b.length) break;
    yield { marker, start: i + 4, len: len - 2, at: i };
    i += 2 + len;
  }
}

/**
 * A TIFF block: the shape EXIF actually is, wherever it is embedded.
 *
 * `base` is where the TIFF header starts; every offset inside the block is
 * relative to it, not to the file — which is the single most common way an EXIF
 * parser goes wrong on a JPEG, where the block sits ~12 bytes in.
 */
function fromTiff(b: Uint8Array, base: number, limitFrom = 0): Parsed {
  const le = tiffOrder(b, base);
  if (le === null) return { groups: [], sensitive: false };
  const rd = reader(b, base, le);

  const ifd0 = rd.u32(4);
  const main: MetaTag[] = [];
  const exif: MetaTag[] = [];
  const gpsTags: MetaTag[] = [];
  let sensitive = false;
  let exifAt = 0;
  let gpsAt = 0;

  for (const e of entries(b, base, le, ifd0, limitFrom)) {
    if (e.tag === 0x8769) { exifAt = Number(e.first ?? 0); continue; }
    if (e.tag === 0x8825) { gpsAt = Number(e.first ?? 0); continue; }
    const name = TIFF_TAGS[e.tag] ?? hex(e.tag);
    main.push({ id: e.tag, name, value: present(e, name) });
    if (SENSITIVE_TIFF.has(e.tag)) sensitive = true;
  }

  if (exifAt > 0) {
    for (const e of entries(b, base, le, exifAt, limitFrom)) {
      const name = EXIF_TAGS[e.tag] ?? hex(e.tag);
      exif.push({ id: e.tag, name, value: present(e, name) });
      if (SENSITIVE_EXIF.has(e.tag)) sensitive = true;
    }
  }

  let gps: Coords | undefined;
  if (gpsAt > 0) {
    const raw = new Map<number, TagEntry>();
    for (const e of entries(b, base, le, gpsAt, limitFrom)) {
      raw.set(e.tag, e);
      const name = GPS_TAGS[e.tag] ?? hex(e.tag);
      gpsTags.push({ id: e.tag, name, value: present(e, name) });
    }
    gps = coordsFrom(raw);
    if (gps) sensitive = true;
  }

  void rd;
  const p: Parsed = {
    groups: [
      { name: "Image", tags: main },
      { name: "Camera", tags: exif },
      { name: "Location", tags: gpsTags },
    ],
    sensitive,
  };
  if (gps) p.gps = gps;
  return p;
}

/** Byte order at a TIFF header: true little-endian, false big, null not TIFF. */
function tiffOrder(b: Uint8Array, at: number): boolean | null {
  if (at + 8 > b.length) return null;
  const le = b[at] === 0x49 && b[at + 1] === 0x49;
  const be = b[at] === 0x4d && b[at + 1] === 0x4d;
  if (!le && !be) return null;
  const magic = le ? b[at + 2]! | (b[at + 3]! << 8) : (b[at + 2]! << 8) | b[at + 3]!;
  // 42 for classic TIFF, 43 for BigTIFF (which we do not parse but can detect).
  if (magic !== 42) return null;
  return le;
}

function reader(b: Uint8Array, base: number, le: boolean) {
  return {
    u16: (o: number): number =>
      le ? b[base + o]! | (b[base + o + 1]! << 8) : (b[base + o]! << 8) | b[base + o + 1]!,
    u32: (o: number): number =>
      (le
        ? b[base + o]! | (b[base + o + 1]! << 8) | (b[base + o + 2]! << 16) | (b[base + o + 3]! << 24)
        : (b[base + o]! << 24) | (b[base + o + 1]! << 16) | (b[base + o + 2]! << 8) | b[base + o + 3]!) >>> 0,
  };
}

interface TagEntry {
  tag: number;
  type: number;
  count: number;
  /** Decoded values: numbers for numeric types, one string for ASCII. */
  values: number[];
  text: string;
  first: number | undefined;
}

/** Bytes each IFD type occupies. Index is the type code; 0 marks unknown. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

function* entries(
  b: Uint8Array,
  base: number,
  le: boolean,
  ifd: number,
  limitFrom: number,
): Generator<TagEntry> {
  const rd = reader(b, base, le);
  if (base + ifd + 2 > b.length) return;
  const count = rd.u16(ifd);
  // A corrupt offset can claim tens of thousands of entries; a real IFD has
  // dozens. Capping keeps a bad file from walking the whole buffer.
  if (count > 512) return;

  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (base + at + 12 > b.length) return;
    const tag = rd.u16(at);
    const type = rd.u16(at + 2);
    const n = rd.u32(at + 4);
    const size = TYPE_SIZE[type] ?? 0;
    if (size === 0 || n > 1 << 20) continue;

    const total = size * n;
    // Four bytes or fewer live in the entry itself; anything larger is an
    // offset. Getting this backwards is the other classic EXIF bug.
    const from = total <= 4 ? at + 8 : rd.u32(at + 8);
    if (base + from + total > b.length || from < 0) continue;
    void limitFrom;

    const values: number[] = [];
    let text = "";

    if (type === 2) {
      text = latin1(b, base + from, total).replace(/\0+$/, "");
    } else if (type === 7 || type === 1 || type === 6) {
      // UNDEFINED and raw bytes: keep a few for display, never megabytes.
      for (let k = 0; k < Math.min(n, 16); k++) values.push(b[base + from + k]!);
    } else {
      const each = reader(b, base + from, le);
      for (let k = 0; k < Math.min(n, 64); k++) {
        const o = k * size;
        if (type === 3) values.push(each.u16(o));
        else if (type === 8) values.push(signed16(each.u16(o)));
        else if (type === 4) values.push(each.u32(o));
        else if (type === 9) values.push(signed32(each.u32(o)));
        else if (type === 5 || type === 10) {
          const num = type === 5 ? each.u32(o) : signed32(each.u32(o));
          const den = type === 5 ? each.u32(o + 4) : signed32(each.u32(o + 4));
          values.push(den === 0 ? 0 : num / den);
        }
      }
    }

    yield { tag, type, count: n, values, text, first: values[0] };
  }
}

function signed16(v: number): number {
  return v > 0x7fff ? v - 0x10000 : v;
}

function signed32(v: number): number {
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

/** A tag as a person would read it, with units and enumerations resolved. */
function present(e: TagEntry, name: string): string {
  if (e.type === 2) return e.text;
  const v = e.values[0];
  if (v === undefined) return e.count > 0 ? `${e.count} bytes` : "";

  switch (name) {
    case "Orientation":
      return ORIENTATION[v] ?? String(v);
    case "Metering mode":
      return METERING[v] ?? String(v);
    case "Exposure program":
      return EXPOSURE_PROGRAM[v] ?? String(v);
    case "White balance":
      return WHITE_BALANCE[v] ?? String(v);
    case "Exposure mode":
      return EXPOSURE_MODE[v] ?? String(v);
    case "Flash":
      // Bit 0 is the only part anyone wants: did it actually fire.
      return (v & 1) === 1 ? "Fired" : "Did not fire";
    case "Exposure time":
      return v >= 1 ? `${round(v, 2)} s` : `1/${Math.round(1 / v)} s`;
    case "F number":
    case "Max aperture":
      return `f/${round(v, 1)}`;
    case "Focal length":
      return `${round(v, 1)} mm`;
    case "Focal length (35mm)":
      return `${Math.round(v)} mm`;
    case "ISO":
      return String(v);
    case "Exposure bias":
      return `${v > 0 ? "+" : ""}${round(v, 2)} EV`;
    case "Image width":
    case "Image height":
    case "Pixel width":
    case "Pixel height":
      return `${v} px`;
    case "Maker note":
      return `${e.count} bytes (camera-private)`;
    case "Exif version":
    case "Flashpix version": {
      // Stored as UNDEFINED, but the bytes are the ASCII digits of the version:
      // 48 50 50 48 is "0220", which is 2.20. Printing the numbers is technically
      // correct and useless.
      const s = e.values.map((x) => String.fromCharCode(x)).join("");
      return /^\d{4}$/.test(s) ? `${Number(s.slice(0, 2))}.${s.slice(2)}` : s;
    }
    case "Colour space":
      return v === 1 ? "sRGB" : v === 0xffff ? "Uncalibrated" : String(v);
    default:
      break;
  }

  if (e.values.length > 1) {
    return e.values.slice(0, 8).map((x) => round(x, 4)).join(", ") +
      (e.values.length > 8 || e.count > e.values.length ? " …" : "");
  }
  return String(round(v, 6));
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Degrees/minutes/seconds plus a hemisphere letter into a single number.
 * This is the tag that matters most and the one nobody knows is there.
 */
function coordsFrom(raw: Map<number, TagEntry>): Coords | undefined {
  const lat = dms(raw.get(0x0002), raw.get(0x0001));
  const lon = dms(raw.get(0x0004), raw.get(0x0003));
  if (lat === null || lon === null) return undefined;
  const c: Coords = { lat, lon };
  const altTag = raw.get(0x0006);
  const alt = altTag?.values[0];
  if (alt !== undefined) {
    // Altitude ref 1 means below sea level; the value itself is unsigned.
    c.alt = round(raw.get(0x0005)?.values[0] === 1 ? -alt : alt, 1);
  }
  return c;
}

function dms(value: TagEntry | undefined, ref: TagEntry | undefined): number | null {
  if (!value || value.values.length < 3) return null;
  const [d = 0, m = 0, s = 0] = value.values;
  let deg = d + m / 60 + s / 3600;
  const hemisphere = (ref?.text || "").trim().toUpperCase();
  if (hemisphere === "S" || hemisphere === "W") deg = -deg;
  return round(deg, 7);
}

// ── PNG and WebP ────────────────────────────────────────────────────────────

function fromPng(b: Uint8Array): Metadata {
  const tags: MetaTag[] = [];
  let sensitive = false;
  let gps: Coords | undefined;
  const groups: MetaGroup[] = [];

  for (const c of pngChunks(b)) {
    if (c.type === "IHDR") {
      const rd = reader(b, c.start, false);
      tags.push({ name: "Image width", value: `${rd.u32(0)} px` });
      tags.push({ name: "Image height", value: `${rd.u32(4)} px` });
      tags.push({ name: "Bit depth", value: String(b[c.start + 8]) });
    } else if (c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt") {
      // Keyword, NUL, then the text. zTXt/iTXt may be deflated after that, and
      // an unreadable compressed payload is still worth reporting as present.
      const blob = latin1(b, c.start, Math.min(c.len, 2048));
      const nul = blob.indexOf("\0");
      const key = nul > 0 ? blob.slice(0, nul) : c.type;
      const val = nul > 0 ? blob.slice(nul + 1).replace(/[\0-]/g, " ").trim() : "";
      tags.push({ name: key, value: val || `${c.len} bytes` });
      sensitive = true;
    } else if (c.type === "eXIf") {
      const p = fromTiff(b, c.start, c.start);
      groups.push(...p.groups);
      sensitive ||= p.sensitive;
      if (p.gps) gps = p.gps;
    } else if (c.type === "tIME") {
      const rd = reader(b, c.start, false);
      const y = rd.u16(0);
      tags.push({
        name: "Modified",
        value: `${y}-${pad(b[c.start + 2]!)}-${pad(b[c.start + 3]!)} ` +
          `${pad(b[c.start + 4]!)}:${pad(b[c.start + 5]!)}:${pad(b[c.start + 6]!)}`,
      });
      sensitive = true;
    }
  }

  const parsed: Parsed = { groups: [{ name: "PNG", tags }, ...groups], sensitive };
  if (gps) parsed.gps = gps;
  return finish("png", parsed, true);
}

interface Chunk {
  type: string;
  start: number;
  len: number;
  /** Offset of the 4-byte length field, where the chunk really begins. */
  at: number;
}

function* pngChunks(b: Uint8Array): Generator<Chunk> {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = (b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 0 || i + 12 + len > b.length) break;
    const type = str(b, i + 4, 4);
    yield { type, start: i + 8, len, at: i };
    if (type === "IEND") break;
    i += 12 + len;
  }
}

function fromWebp(b: Uint8Array): Metadata {
  const tags: MetaTag[] = [];
  const groups: MetaGroup[] = [];
  let sensitive = false;
  let gps: Coords | undefined;

  for (const c of riffChunks(b)) {
    if (c.type === "EXIF") {
      const p = fromTiff(b, c.start, c.start);
      groups.push(...p.groups);
      sensitive ||= p.sensitive;
      if (p.gps) gps = p.gps;
    } else if (c.type === "XMP ") {
      const x = xmpFields(latin1(b, c.start, Math.min(c.len, 8192)));
      if (x.length > 0) {
        groups.push({ name: "XMP", tags: x });
        sensitive = true;
      }
    } else if (c.type === "VP8X") {
      const w = 1 + (b[c.start + 4]! | (b[c.start + 5]! << 8) | (b[c.start + 6]! << 16));
      const h = 1 + (b[c.start + 7]! | (b[c.start + 8]! << 8) | (b[c.start + 9]! << 16));
      tags.push({ name: "Image width", value: `${w} px` });
      tags.push({ name: "Image height", value: `${h} px` });
    }
  }

  const parsed: Parsed = { groups: [{ name: "WebP", tags }, ...groups], sensitive };
  if (gps) parsed.gps = gps;
  return finish("webp", parsed, true);
}

function* riffChunks(b: Uint8Array): Generator<Chunk> {
  let i = 12;
  while (i + 8 <= b.length) {
    const type = str(b, i, 4);
    const len = b[i + 4]! | (b[i + 5]! << 8) | (b[i + 6]! << 16) | (b[i + 7]! << 24);
    if (len < 0 || i + 8 + len > b.length) break;
    yield { type, start: i + 8, len, at: i };
    // RIFF chunks are word-aligned; an odd length is followed by a pad byte.
    i += 8 + len + (len & 1);
  }
}

/**
 * The handful of XMP fields worth surfacing. A full RDF parse is not warranted
 * — XMP is here so you know it exists and that stripping will remove it.
 */
function xmpFields(xml: string): MetaTag[] {
  const want: Array<[string, RegExp]> = [
    ["Creator", /<dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]{1,200})</],
    ["Title", /<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]{1,200})</],
    ["Rights", /<dc:rights>[\s\S]*?<rdf:li[^>]*>([^<]{1,200})</],
    ["Software", /(?:xmp:CreatorTool|tiff:Software)="([^"]{1,200})"/],
    ["Created", /xmp:CreateDate="([^"]{1,64})"/],
    ["Camera", /tiff:Model="([^"]{1,120})"/],
    ["Lens", /aux:Lens="([^"]{1,120})"/],
    ["Serial", /aux:SerialNumber="([^"]{1,64})"/],
  ];
  const out: MetaTag[] = [];
  for (const [name, re] of want) {
    const m = re.exec(xml);
    if (m?.[1]) out.push({ name, value: m[1].trim() });
  }
  return out;
}

// ── Stripping ───────────────────────────────────────────────────────────────

/**
 * Remove metadata without touching the picture.
 *
 * The image data is copied byte for byte; only the containers around it change.
 * That is the whole point — a strip that re-encodes has "fixed" your privacy by
 * degrading the file, and you cannot get those pixels back.
 *
 * Returns null when the format is one we will not rewrite, rather than guessing.
 */
export function strip(bytes: Uint8Array): StripResult | null {
  if (isJpeg(bytes)) return stripJpeg(bytes);
  if (isPng(bytes)) return stripPng(bytes);
  if (isWebp(bytes)) return stripWebp(bytes);
  return null;
}

/**
 * JPEG: keep the structural segments, drop the informational ones.
 *
 * APP0/JFIF stays because some decoders read density from it and it says
 * nothing about you. Everything from APP1 up is EXIF, XMP, ICC-adjacent vendor
 * data, Photoshop resources or maker notes — and COM is a free-text comment.
 * The scan is copied whole from SOS to the end of the file.
 */
function stripJpeg(b: Uint8Array): StripResult {
  const keep: Array<[number, number]> = [];
  const removed: string[] = [];
  let scanAt = b.length;
  let i = 2;

  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda) { scanAt = i; break; }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2 || i + 2 + len > b.length) break;

    const drop =
      (marker >= 0xe1 && marker <= 0xef) || // APP1..APP15
      marker === 0xfe;                       // COM
    if (drop) removed.push(labelFor(b, marker, i + 4, len - 2));
    else keep.push([i, i + 2 + len]);
    i += 2 + len;
  }

  // Stop at the real EOI rather than at the end of the file, so an appended
  // trailer is dropped instead of copied. Keeping it would mean a "cleaned"
  // photo still carried a video of the room.
  const end = jpegEnd(b, 2);
  if (end < b.length) removed.push(describeTrailer(b, end));

  let size = 2;
  for (const [from, to] of keep) size += to - from;
  size += end - scanAt;

  const out = new Uint8Array(size);
  out[0] = 0xff;
  out[1] = 0xd8;
  let w = 2;
  for (const [from, to] of keep) {
    out.set(b.subarray(from, to), w);
    w += to - from;
  }
  out.set(b.subarray(scanAt, end), w);

  return { bytes: out, removed, saved: b.length - out.length };
}

function labelFor(b: Uint8Array, marker: number, start: number, len: number): string {
  if (marker === 0xe1 && str(b, start, 6) === "Exif\0\0") return "EXIF";
  if (marker === 0xe1) return "XMP";
  if (marker === 0xe2) return "ICC/FlashPix block";
  if (marker === 0xed) return "Photoshop/IPTC";
  if (marker === 0xfe) return "Comment";
  return `APP${marker - 0xe0} (${len} bytes)`;
}

/**
 * PNG: drop the text and time chunks and keep everything else, CRCs intact.
 *
 * Chunk CRCs cover only the chunk itself, so removing whole chunks needs no
 * recomputation — one of the few genuinely pleasant things about the format.
 */
function stripPng(b: Uint8Array): StripResult {
  const drop = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME", "dSIG"]);
  const keep: Array<[number, number]> = [];
  const removed: string[] = [];

  for (const c of pngChunks(b)) {
    if (drop.has(c.type)) removed.push(c.type === "eXIf" ? "EXIF" : c.type);
    else keep.push([c.at, c.at + 12 + c.len]);
  }

  let size = 8;
  for (const [from, to] of keep) size += to - from;
  const out = new Uint8Array(size);
  out.set(b.subarray(0, 8), 0);
  let w = 8;
  for (const [from, to] of keep) {
    out.set(b.subarray(from, to), w);
    w += to - from;
  }
  return { bytes: out, removed, saved: b.length - out.length };
}

/**
 * WebP: drop EXIF and XMP chunks and repair the RIFF size field.
 *
 * Unlike PNG the container carries its own total length, so removing a chunk
 * without fixing that header produces a file every decoder rejects.
 */
function stripWebp(b: Uint8Array): StripResult {
  const keep: Array<[number, number]> = [];
  const removed: string[] = [];

  for (const c of riffChunks(b)) {
    const whole = 8 + c.len + (c.len & 1);
    if (c.type === "EXIF" || c.type === "XMP ") removed.push(c.type.trim());
    else keep.push([c.at, c.at + whole]);
  }

  let size = 12;
  for (const [from, to] of keep) size += to - from;
  const out = new Uint8Array(size);
  out.set(b.subarray(0, 12), 0);
  let w = 12;
  for (const [from, to] of keep) {
    out.set(b.subarray(from, to), w);
    w += to - from;
  }

  // RIFF size counts everything after the size field itself.
  const riff = size - 8;
  out[4] = riff & 0xff;
  out[5] = (riff >> 8) & 0xff;
  out[6] = (riff >> 16) & 0xff;
  out[7] = (riff >> 24) & 0xff;

  return { bytes: out, removed, saved: b.length - out.length };
}

// ── Small helpers ───────────────────────────────────────────────────────────

function str(b: Uint8Array, at: number, len: number): string {
  let s = "";
  for (let i = 0; i < len && at + i < b.length; i++) s += String.fromCharCode(b[at + i]!);
  return s;
}

/** Same as `str` but intended for text, where NULs are terminators not data. */
function latin1(b: Uint8Array, at: number, len: number): string {
  return str(b, at, len);
}

function hex(tag: number): string {
  return `0x${tag.toString(16).padStart(4, "0")}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
