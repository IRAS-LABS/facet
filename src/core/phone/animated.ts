/**
 * Does this picture move?
 *
 * The viewer makes a screen-sized copy of every still it shows, because a
 * 12 MP JPEG is 48 MB of texture and there are three of them on stage during a
 * swipe. The copy is made by decoding the file and drawing it once into a
 * canvas -- and a canvas holds exactly one frame. Hand an animated GIF to that
 * path and what comes back is frame 1, as a JPEG, forever. The file was fine;
 * the optimisation ate the animation.
 *
 * So before the copy is made, the bytes are asked whether there is anything to
 * lose. An animation is handed to the `<img>` whole and the WebView plays it,
 * which is the only way an animation can be played at all: there is no
 * resizing an animation without re-encoding it frame by frame, and no phone
 * should be doing that to look at a reaction GIF.
 *
 * The extension is not the answer. `.png` is APNG about one time in a
 * thousand, `.webp` is animated rather more often than that, and neither says
 * so in its name -- but both say so in their first few dozen bytes, which is
 * why this reads the header rather than the file name.
 */

/** Enough bytes for every marker below; APNG's `acTL` is the deepest. */
export const SNIFF = 4096;

/** Does `head` (the first bytes of a file) begin with `sig`? */
function starts(head: Uint8Array, sig: string, at = 0): boolean {
  for (let i = 0; i < sig.length; i++) {
    if (head[at + i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

/** The offset of `needle` in `head`, or -1. Bounded by `limit`. */
function find(head: Uint8Array, needle: string, limit: number): number {
  const end = Math.min(head.length, limit) - needle.length;
  for (let i = 0; i <= end; i++) {
    if (starts(head, needle, i)) return i;
  }
  return -1;
}

/**
 * True when these bytes are a picture that must not be re-encoded.
 *
 * @param head the first `SNIFF` bytes of the file. Fewer is fine; a truncated
 *   header simply answers false, which costs an animation nobody could have
 *   played anyway.
 */
export function isAnimated(head: Uint8Array): boolean {
  // GIF: always. A still GIF has 256 colours and weighs nothing, so the copy
  // saves no memory worth the risk of guessing wrong about a second frame --
  // and re-encoding a flat-colour palette image to JPEG visibly wrecks it.
  if (starts(head, "GIF8")) return true;

  // APNG: a PNG carrying an `acTL` chunk, which the spec puts before the first
  // `IDAT`. Searching only that far means a still PNG whose pixel data happens
  // to spell `acTL` is not mistaken for an animation.
  if (starts(head, "\x89PNG\r\n\x1a\n")) {
    const idat = find(head, "IDAT", head.length);
    const actl = find(head, "acTL", idat < 0 ? head.length : idat);
    return actl >= 0;
  }

  // WebP: the extended header's flag byte says so. `VP8X` is always the first
  // chunk when it is present, so its flags sit at a fixed offset.
  if (starts(head, "RIFF") && starts(head, "WEBP", 8)) {
    if (starts(head, "VP8X", 12)) return ((head[20] ?? 0) & 0x02) !== 0;
    return false;
  }

  // AVIF: an image *sequence* declares the `avis` brand, in the major brand or
  // among the compatible ones, both of which live inside the `ftyp` box.
  if (starts(head, "ftyp", 4)) {
    const size = ((head[0] ?? 0) << 24) | ((head[1] ?? 0) << 16) | ((head[2] ?? 0) << 8) | (head[3] ?? 0);
    const box = size > 8 && size <= head.length ? size : Math.min(head.length, 64);
    return find(head, "avis", box) >= 0;
  }

  return false;
}
