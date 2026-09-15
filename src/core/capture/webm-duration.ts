/**
 * Give a streamed WebM its real length.
 *
 * `MediaRecorder` writes the header in the first millisecond of a take, when
 * the length is not known. Chromium does put a Duration in Info, but it is a
 * placeholder of 1 — one millisecond — and nothing ever corrects it. ffprobe
 * reads such a take as `duration=0.001`, and Android's WebView believes it
 * about as far: a 25-second voice note opened the transcription panel reading
 * `0:00 of audio`, and the dock's transport read `0:04` until it had played
 * through once (test phone, 2026-09-13).
 *
 * The take is written to disk as it records, so the header is on disk long
 * before the length exists. What makes this cheap is that the placeholder is a
 * fixed-width float: its bytes can be overwritten in place at stop, with no
 * insert and no rewrite of the file. So the first chunk is read for where that
 * float sits, and the recorder patches it when the take ends.
 *
 * Pure byte work, no DOM, so the recorder and the checks share it.
 */

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const CLUSTER = 0x1f43b675;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

interface Vint {
  value: number;
  width: number;
  /** All value bits set — the "size unknown" marker a live stream uses. */
  unknown: boolean;
}

function readId(b: Uint8Array, at: number): { id: number; width: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const width = Math.clz32(first) - 23;
  if (width < 1 || width > 4 || at + width > b.length) return null;
  let id = 0;
  for (let i = 0; i < width; i++) id = id * 256 + (b[at + i] as number);
  return { id, width };
}

function readSize(b: Uint8Array, at: number): Vint | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const width = Math.clz32(first) - 23;
  if (width < 1 || width > 8 || at + width > b.length) return null;
  let value = first & (0xff >> width);
  let allOnes = value === 0xff >> width;
  for (let i = 1; i < width; i++) {
    const byte = b[at + i] as number;
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  return { value, width, unknown: allOnes };
}

function readUint(b: Uint8Array, at: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + (b[at + i] as number);
  return v;
}

export interface DurationSlot {
  /** Offset of the float's first byte, from the start of the file. */
  at: number;
  /** 4 or 8: the float's width, which the patch must match exactly. */
  width: 4 | 8;
  /** Nanoseconds per Duration unit, from the file's own TimecodeScale. */
  scale: number;
}

/**
 * Where the Duration float is in the first chunk of a take.
 *
 * Null whenever anything is not as expected — not WebM, Info not wholly inside
 * this chunk, no Duration, a width that is not a float. A take left reading
 * 1 ms is the status quo; a patch aimed at the wrong bytes would be a corrupt
 * recording, and that is not an acceptable price for fixing a label.
 */
export function findDuration(head: Uint8Array): DurationSlot | null {
  const top = readId(head, 0);
  if (top?.id !== EBML) return null;
  const topSize = readSize(head, top.width);
  if (topSize === null || topSize.unknown) return null;
  const segAt = top.width + topSize.width + topSize.value;

  const seg = readId(head, segAt);
  if (seg?.id !== SEGMENT) return null;
  const segSize = readSize(head, segAt + seg.width);
  if (segSize === null) return null;
  let at = segAt + seg.width + segSize.width;

  while (at < head.length) {
    const el = readId(head, at);
    if (el === null || el.id === CLUSTER) return null;
    const size = readSize(head, at + el.width);
    if (size === null || size.unknown) return null;
    const bodyAt = at + el.width + size.width;
    const end = bodyAt + size.value;
    if (end > head.length) return null;

    if (el.id !== INFO) {
      at = end;
      continue;
    }

    let scale = 1_000_000;
    let slot: { at: number; width: 4 | 8 } | null = null;
    for (let c = bodyAt; c < end; ) {
      const child = readId(head, c);
      if (child === null) return null;
      const cs = readSize(head, c + child.width);
      if (cs === null || cs.unknown) return null;
      const cBody = c + child.width + cs.width;
      if (cBody + cs.value > end) return null;
      if (child.id === TIMECODE_SCALE && cs.value >= 1 && cs.value <= 8) {
        scale = readUint(head, cBody, cs.value) || scale;
      } else if (child.id === DURATION && (cs.value === 4 || cs.value === 8)) {
        slot = { at: cBody, width: cs.value };
      }
      c = cBody + cs.value;
    }
    return slot === null ? null : { ...slot, scale };
  }
  return null;
}

/** The bytes that go over the slot, for a take `seconds` long. */
export function durationBytes(seconds: number, slot: DurationSlot): Uint8Array {
  const out = new Uint8Array(slot.width);
  const units = (Math.max(0, seconds) * 1e9) / slot.scale;
  const view = new DataView(out.buffer);
  if (slot.width === 4) view.setFloat32(0, units);
  else view.setFloat64(0, units);
  return out;
}

/** Both steps at once, for a take held in memory and written whole at stop. */
export function withDuration(bytes: Uint8Array, seconds: number): Uint8Array {
  const slot = findDuration(bytes.subarray(0, 64_000));
  if (slot === null || seconds <= 0) return bytes;
  bytes.set(durationBytes(seconds, slot), slot.at);
  return bytes;
}
