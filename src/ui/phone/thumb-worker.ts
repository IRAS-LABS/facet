/**
 * Decode, downscale and re-encode a thumbnail, off the main thread.
 *
 * This exists because of where the time was actually going. Each tile read its
 * original file, decoded it, drew it to a canvas and re-encoded it to JPEG —
 * and the middle three of those ran on the main thread, once per tile, for
 * every tile in a camera roll. The thread that was busy encoding is the same
 * thread that runs the IntersectionObserver callbacks and paints the grid, so
 * the grid stopped filling in exactly when there was most to fill: a fast
 * scroll starved the mechanism that draws the tiles the scroll revealed.
 *
 * Blobs are structured-cloned by reference, so handing one to this worker costs
 * a message and not a copy of the picture. Everything expensive then happens
 * here, and what comes back is a small JPEG the tile can point an `<img>` at.
 *
 * No imports on purpose: a worker that pulls in the app's module graph is a
 * second copy of the app, and this is ninety lines of canvas work.
 */

interface Req {
  id: number;
  blob: Blob;
  px: number;
  /**
   * A display copy for the viewer rather than a grid tile: the long edge is
   * held to `px` whichever way the picture is turned, a picture already
   * smaller than that comes back untouched, and the JPEG is a step cleaner,
   * because this one is looked at full-screen and pinched into.
   */
  display?: boolean;
  /** For a display copy: the box to fit, in device pixels. `px` squared when absent. */
  box?: { w: number; h: number };
}

interface Res {
  id: number;
  blob?: Blob;
  error?: string;
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, blob, px, display, box } = ev.data;
  try {
    const out = display ? await shrinkDisplay(blob, box ?? { w: px, h: px }) : await shrink(blob, px);
    const msg: Res = out ? { id, blob: out } : { id, error: "no output" };
    (self as unknown as Worker).postMessage(msg);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String(e) } satisfies Res);
  }
};

async function shrink(blob: Blob, px: number): Promise<Blob | null> {
  let bmp: ImageBitmap;
  try {
    // The resize options let the codec scale while decoding, so the
    // full-resolution surface is never allocated. Only the long edge is given:
    // supplying both would square-crop, and the tile wants to do its own
    // cropping with `object-fit: cover`.
    bmp = await createImageBitmap(blob, { resizeWidth: px, resizeQuality: "medium" });
  } catch {
    // Some WebViews reject the options rather than ignoring them.
    bmp = await createImageBitmap(blob);
  }

  // Already small: re-encoding would cost more than it saves, and the original
  // bytes are a perfectly good thumbnail.
  if (bmp.width <= px && blob.size < 96_000) {
    bmp.close();
    return blob;
  }

  const scale = Math.min(1, px / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.78 });
}

/**
 * The viewer's display-sized copy: the picture fitted inside `box`.
 *
 * `resizeWidth` alone is wrong here: it fixes the *width*, so a
 * portrait 3000x4000 decodes to 2400x3200 and a 1080x2400 screenshot is
 * *upscaled* to 2400x5333 before being drawn back down. A tile can live with
 * that; a full-screen copy that exists to be cheap cannot. So the orientation
 * is read first from a 128 px decode -- a scaled JPEG decode is a fraction of a
 * full one, and the result is already rotated per EXIF, which the file header
 * is not -- and the real decode is asked for exactly the long edge wanted.
 */
async function shrinkDisplay(blob: Blob, box: { w: number; h: number }): Promise<Blob | null> {
  // Already no bigger than the box whichever way it is turned: the original
  // bytes are the display copy, and re-encoding them would only soften a
  // screenshot. Read from the header, because a decode asked to resize will
  // happily upscale and then there is nothing left to compare against.
  const edge = await longEdge(blob);
  if (edge > 0 && edge <= Math.min(box.w, box.h)) return blob;

  let pw = 0;
  let ph = 0;
  try {
    const probe = await createImageBitmap(blob, { resizeWidth: 128, resizeQuality: "low" });
    pw = probe.width;
    ph = probe.height;
    probe.close();
  } catch {
    // Options rejected: fall through to a plain decode and measure that.
  }

  let bmp: ImageBitmap;
  if (edge > 0 && pw > 0 && ph > 0) {
    // The probe is oriented the way the picture will be drawn; the header's
    // long edge is the same either way. Together they are the true drawn size.
    const ow = pw >= ph ? edge : (edge * pw) / ph;
    const oh = ph > pw ? edge : (edge * ph) / pw;
    const k = Math.min(box.w / ow, box.h / oh);
    if (k >= 1) return blob;
    const resizeWidth = Math.max(1, Math.round(ow * k));
    try {
      bmp = await createImageBitmap(blob, { resizeWidth, resizeQuality: "medium" });
    } catch {
      bmp = await createImageBitmap(blob);
    }
  } else {
    bmp = await createImageBitmap(blob);
  }

  // Fit the box; never grow. A decode asked for a width lands a per cent
  // short of it now and then (the aspect came from a 128 px probe), so the
  // draw below is not clamped to 1 -- the copy is meant to be exactly the
  // size the viewer will draw it at.
  const k = Math.min(box.w / bmp.width, box.h / bmp.height);
  if (edge === 0 && k >= 1) {
    bmp.close();
    return blob;
  }
  const dw = Math.max(1, Math.round(bmp.width * k));
  const dh = Math.max(1, Math.round(bmp.height * k));
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, 0, 0, dw, dh);
  bmp.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.86 });
}

/**
 * The long edge of a JPEG or PNG from its header, 0 when unknown.
 *
 * Orientation does not matter here: the long edge is the same whichever way
 * EXIF says the picture is turned, which is exactly why it is the number to
 * compare against the screen.
 */
async function longEdge(blob: Blob): Promise<number> {
  const head = new DataView(await blob.slice(0, 65536).arrayBuffer());
  if (head.byteLength < 24) return 0;
  // PNG: signature, then IHDR with width and height at 16 and 20.
  if (head.getUint32(0) === 0x89504e47) {
    return Math.max(head.getUint32(16), head.getUint32(20));
  }
  // JPEG: walk the markers to the first SOFn.
  if (head.getUint16(0) !== 0xffd8) return 0;
  let at = 2;
  while (at + 9 < head.byteLength) {
    if (head.getUint8(at) !== 0xff) return 0;
    const marker = head.getUint8(at + 1);
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const len = head.getUint16(at + 2);
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return Math.max(head.getUint16(at + 5), head.getUint16(at + 7));
    if (marker === 0xda) return 0;
    at += 2 + len;
  }
  return 0;
}
