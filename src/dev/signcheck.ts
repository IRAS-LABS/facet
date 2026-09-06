/**
 * Redaction harness — does a blacked-out area land where it was put?
 *
 * `stamp.ts` was already checked against real PDF bytes, and the panel was
 * checked on screen. The span between them was not: `rasterPage()` renders a
 * page to a picture, paints the covers onto it, and hands that picture to the
 * exporter, and it had never once executed. The dev shell's mock filesystem
 * answers `fileUrl()` with an empty string, so no PDF in the browser harness
 * ever decodes and every path downstream of "actually load the file" is
 * unreachable there.
 *
 * That matters more than an untested function usually does. Inside
 * `rasterPage()` is a coordinate flip — a PDF measures y up from the bottom of
 * the page, a canvas measures it down from the top — and if it is wrong the
 * cover lands mirrored about the middle of the page. The export still
 * succeeds, the file still opens, and the words meant to be destroyed are
 * still sitting there in plain sight, with a black bar somewhere else. A
 * redaction that fails loudly is a bug; one that fails quietly is the reason
 * people get hurt by this feature.
 *
 * So this harness is deliberately not a unit test of the arithmetic. It builds
 * a real PDF, opens the real panel on it, clicks the real save button, and
 * reads the *pixels* of what came out. The cover is placed by the panel's own
 * default — `y: pageH * 0.55`, height `pageH * 0.035` — which in a picture of
 * the page means rows 41.5%–45% down from the top. Get the flip backwards and
 * it lands at 55%–58.5% instead. The two bands do not overlap, so sampling
 * both settles it: one must be black, the other must not.
 */

import "../styles/base.css";
import "../styles/sign-view.css";
import { themes } from "@core/theme/theme-engine";
import { loadPdfjs } from "@core/explorer/preview";
import { SignatureStore, browserSigBackend } from "@core/sign/store";
import { SignView } from "@ui/sign-view";

themes.init();

let passed = 0;
let failed = 0;

function ok(what: string, cond: boolean, saw = ""): void {
  if (cond) {
    passed++;
    console.log(`ok    ${what}`);
  } else {
    failed++;
    console.error(`FAIL  ${what}${saw ? `  — saw ${saw}` : ""}`);
  }
}

/** Give the panel's own async work — page render, export — room to finish. */
const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A real two-page PDF with real text on it.
 *
 * Built rather than shipped as a fixture: the point of the check is the
 * geometry, the pages need to be a known size, and a binary in the repo for
 * this would be one more thing to keep and to accidentally publish.
 */
async function sourcePdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([612, 792]);
    // Text down the whole page, so whichever band the cover lands on has
    // something under it to destroy and the other band has something left.
    for (let i = 0; i < 30; i++) {
      page.drawText(`page ${p + 1} line ${i} the quick brown fox jumps over it`, {
        x: 54,
        y: 740 - i * 24,
        size: 11,
        font,
        color: rgb(0, 0, 0),
      });
    }
  }
  return doc.save();
}

/** Is this row of the rendered page mostly ink? */
function rowIsBlack(data: ImageData, y: number): boolean {
  let dark = 0;
  // The centre fifth only. The panel's default cover is 35% of the page wide
  // and centred, so a wider sample can never be mostly ink no matter how
  // solid the cover is — which is what the first run of this check measured,
  // and it read as "the redaction did not happen".
  const from = Math.round(data.width * 0.4);
  const to = Math.round(data.width * 0.6);
  for (let x = from; x < to; x++) {
    const i = (y * data.width + x) * 4;
    const r = data.data[i] ?? 255;
    const g = data.data[i + 1] ?? 255;
    const b = data.data[i + 2] ?? 255;
    if (r < 60 && g < 60 && b < 60) dark++;
  }
  // A line of text darkens a fraction of the row; a cover darkens nearly all
  // of it. 90% is comfortably above the one and below the other.
  return dark > (to - from) * 0.9;
}

/** How much of a band of rows is a solid cover. */
function bandBlack(data: ImageData, top: number, bottom: number): number {
  let hits = 0;
  for (let y = top; y < bottom; y++) if (rowIsBlack(data, y)) hits++;
  return hits / Math.max(1, bottom - top);
}

async function run(): Promise<void> {
  const src = await sourcePdf();
  ok("built a source PDF", src.length > 1000, `${src.length} bytes`);

  const blob = new Blob([src as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  let written: Uint8Array | null = null;
  const view = new SignView({
    fileUrl: () => Promise.resolve(url),
    readAll: () => Promise.resolve(src),
    writeFile: (path, bytes) => {
      written = bytes;
      return Promise.resolve(path);
    },
    refresh: () => {},
    store: new SignatureStore(browserSigBackend()),
  });

  // Straight into the job, exactly as the phone's "Black out" button does.
  await view.open("C:/tmp/signcheck.pdf", "redact");
  await settle(400);

  const cover = document.querySelector(".fct-signv-mark");
  ok("a cover was placed on open", cover !== null);

  // Burn-in is the default and is the path under test; confirm the panel is
  // actually in it rather than quietly drawing a decoration.
  const toggle = [...document.querySelectorAll(".fct-signv-toggle")]
    .find((b) => /text underneath|text stays/i.test(b.textContent ?? ""));
  ok("the burn-in switch is on", toggle?.getAttribute("aria-pressed") === "true",
    toggle?.textContent ?? "no switch");

  const save = document.querySelector(".fct-signv-save") as HTMLElement | null;
  ok("the save button exists", save !== null);
  save?.click();

  for (let i = 0; i < 100 && written === null; i++) await settle(100);
  ok("export produced a file", written !== null);
  if (written === null) return;

  // ── Read the result back as a picture, and look at it ────────────────────
  const pdfjs = await loadPdfjs();
  const out = written as Uint8Array;
  const doc = await pdfjs.getDocument({ data: out.slice() }).promise;
  ok("page count survived", doc.numPages === 2, String(doc.numPages));

  const page = await doc.getPage(1);
  const text = await page.getTextContent();
  const chars = text.items.map((i) => ("str" in i ? i.str : "")).join("").trim();
  ok("the words on the redacted page are gone, not covered", chars.length === 0,
    `${chars.length} chars`);

  const view2 = page.getViewport({ scale: 1 });
  const cv = document.createElement("canvas");
  cv.width = Math.round(view2.width);
  cv.height = Math.round(view2.height);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvas: cv, canvasContext: ctx, viewport: view2 }).promise;
  const pix = ctx.getImageData(0, 0, cv.width, cv.height);

  // The page is a picture now, not a blank one.
  ok("the rebuilt page is not blank", bandBlack(pix, 0, cv.height) < 0.9);

  // The cover sits at PDF y 0.55H..0.585H. Measured from the top of a picture
  // that is rows 0.415H..0.45H. The mirror of it — where a wrong flip would
  // put it — is rows 0.55H..0.585H.
  const rightTop = Math.round(cv.height * 0.425);
  const rightBottom = Math.round(cv.height * 0.44);
  const wrongTop = Math.round(cv.height * 0.56);
  const wrongBottom = Math.round(cv.height * 0.575);

  // Where the solid rows actually are, as a fraction of page height. Printed
  // always, not only on failure: "it is not where I expected" and "it is
  // mirrored" are different bugs and the numbers tell them apart at a glance.
  const bands: string[] = [];
  let runFrom = -1;
  for (let y = 0; y <= cv.height; y++) {
    const solid = y < cv.height && rowIsBlack(pix, y);
    if (solid && runFrom < 0) runFrom = y;
    if (!solid && runFrom >= 0) {
      if (y - runFrom > 2) {
        bands.push(`${(runFrom / cv.height * 100).toFixed(1)}%–${(y / cv.height * 100).toFixed(1)}%`);
      }
      runFrom = -1;
    }
  }
  console.log(`solid bands down the page: ${bands.join(", ") || "none"} (page ${cv.width}×${cv.height})`);

  const here = bandBlack(pix, rightTop, rightBottom);
  const there = bandBlack(pix, wrongTop, wrongBottom);

  ok("the cover landed where it was placed", here > 0.9, `${Math.round(here * 100)}% solid`);
  ok("the cover did NOT land mirrored", there < 0.1, `${Math.round(there * 100)}% solid`);

  // Page 2 had no cover and no crop; it must come through untouched.
  const p2 = await doc.getPage(2);
  const t2 = await p2.getTextContent();
  const c2 = t2.items.map((i) => ("str" in i ? i.str : "")).join("").trim();
  ok("the untouched page kept its text", c2.length > 200, `${c2.length} chars`);

  URL.revokeObjectURL(url);
}

run().then(
  () => {
    const line = `signcheck: ${passed} passed, ${failed} failed`;
    console.log(failed === 0 ? `PASS  ${line}` : `FAIL  ${line}`);
    document.title = failed === 0 ? `PASS ${passed}` : `FAIL ${failed}`;
  },
  (err: unknown) => {
    console.error("signcheck threw", err);
    document.title = `THREW ${String(err)}`;
  },
);
