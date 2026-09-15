/**
 * Loading a picture so the canvas it is drawn into stays readable.
 *
 * The bytes come through `fetch` and a blob URL rather than going straight into
 * `img.src`, and that detour is what makes "Save signed copy" and OCR work on
 * the phone.
 *
 * On Android a file is served from the asset protocol, which is a different
 * origin from the page. An `<img>` loaded cross-origin without a CORS request
 * *taints* every canvas it is drawn into, and a tainted canvas refuses both
 * `toBlob` and `getImageData`. So the page rendered perfectly, every mark
 * landed where it should, and Save answered "Failed to execute 'toBlob' on
 * 'HTMLCanvasElement': Tainted canvas" -- and OCR, which reads the same canvas
 * back, would have failed the same way for the same reason. A blob URL is
 * same-origin by construction, so the canvas stays clean wherever the bytes
 * came from.
 *
 * `crossOrigin = "anonymous"` is the other cure and the worse one: it makes the
 * load itself depend on a response header, so a build that stops sending that
 * header turns a working preview into a broken one. Here a fetch that fails
 * costs nothing -- the plain URL still draws, exactly as before.
 */
export async function loadPicture(url: string, whenBroken: string): Promise<HTMLImageElement> {
  let blobUrl = "";
  try {
    blobUrl = URL.createObjectURL(await (await fetch(url)).blob());
  } catch {
    blobUrl = "";
  }
  try {
    const node = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.addEventListener("load", () => resolve(img));
      img.addEventListener("error", () => reject(new Error(whenBroken)));
      img.src = blobUrl || url;
    });
    // `load` only means the bytes arrived. `decoding = "async"` leaves the
    // pixels to be produced later, on the first draw -- and the `finally`
    // below pulls the blob URL out from under that draw. Whatever redraws
    // hides it: the editor paints every frame, so its second frame is correct.
    // A one-shot consumer does not get a second frame. The OCR panel draws the
    // picture once and reads it straight back, and on the phone the same page
    // of clean text came back as 60 words at 94% one run and two words at 27%
    // the next. Auto-detect reads that canvas too, so the same race could have
    // let a face through a blur the user believed had covered it.
    //
    // Awaiting the decode means the bitmap exists before the URL goes away.
    // The catch is not optional: `decode()` rejects on an image the engine can
    // draw but not pre-decode, and there the old behaviour is still right.
    try {
      await node.decode();
    } catch {
      /* fall through -- drawing still works, this was only the early wait */
    }
    return node;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}
