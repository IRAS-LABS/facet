/**
 * Redaction harness — is what we call irreversible actually irreversible?
 *
 * `signcheck.ts` asks whether a cover landed in the right place. This asks the
 * harder question underneath it: given that it landed there, can anyone get
 * back what was under it. Those are separate failures and only one of them is
 * visible in a screenshot. A bar in the wrong place is obvious to the person
 * who saved the file. A bar that is 4% transparent looks identical to a solid
 * one at a glance, on a phone, in daylight — and `out = orig x (1 - a)` is a
 * single divide away from the original for anyone who thinks to try it.
 *
 * So every assertion here is about *pixels the user cannot see*, and they fall
 * into three groups.
 *
 * **The fill is exact.** Not "dark", not "mostly black" — every sampled pixel
 * inside a redaction must be the fill colour to the byte, at alpha 255. Any
 * residue at all is signal: a bar at 99% opacity over black text on white
 * leaves the text at value 2 or 3, which is invisible on screen and trivially
 * recovered by pulling the levels apart.
 *
 * **The weakening controls cannot reach it.** The regions checked below are
 * deliberately hostile — opacity 0.35, feather 0.08, colorAmount 0.4, the sort
 * of values a restored session or a hand-edited config could carry in. They
 * are what `harden()` exists for, and the only way to know it is wired in is to
 * feed them through the real `renderBlur` and read what comes out.
 *
 * **The edge is sealed.** Canvas antialiases every filled path, so the
 * boundary of an unsealed bar is a one-pixel ring at partial alpha with the
 * original showing through it. One pixel of a character is not nothing: it is
 * the height of the ascenders, and there are OCR models that will take that
 * bet. The ring is sampled explicitly.
 *
 * A control case runs alongside — the same region as `gaussian` — for one
 * reason: a check that cannot fail proves nothing. If the gaussian case also
 * came out uniform, the harness would be measuring a blank canvas and every
 * pass above would be worthless.
 */

import "../styles/base.css";
import { themes } from "@core/theme/theme-engine";
import { newRegion, opaque, renderBlur, type BlurRegion } from "@core/edit/blur";
import { flattenPdf } from "@core/sign/flatten";
import { stampPdf } from "@core/sign/stamp";
import { placement } from "@core/sign/stamp";

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

const W = 400;
const H = 300;

/**
 * Something with a lot of structure in it, at full contrast.
 *
 * Deliberately not a photograph and not flat colour. Fine stripes plus text
 * are the worst case for every reversal technique at once: they are high
 * frequency, so a blur leaves a recoverable signature; they are regular, so a
 * pixelation is solvable; and they are pure black on pure white, so the very
 * smallest residual transparency shows up as a measurable difference rather
 * than getting lost in a noisy mid-grey.
 */
function source(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#000000";
  for (let x = 0; x < W; x += 4) g.fillRect(x, 0, 2, H);
  g.font = "bold 28px sans-serif";
  g.fillText("SECRET 4029 1123", 20, 160);
  return c;
}

/** Run one region over the source picture and give back its pixels. */
function render(r: BlurRegion): ImageData {
  const src = source();
  const dst = document.createElement("canvas");
  renderBlur(dst, src, W, H, [r]);
  return dst.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, W, H);
}

/** Every distinct RGBA in a box, as "r,g,b,a" strings. */
function coloursIn(d: ImageData, x0: number, y0: number, x1: number, y1: number): Set<string> {
  const seen = new Set<string>();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * d.width + x) * 4;
      seen.add(`${d.data[i]},${d.data[i + 1]},${d.data[i + 2]},${d.data[i + 3]}`);
    }
  }
  return seen;
}

/** A region over the middle of the picture, with every weakening dial turned up. */
function hostile(shape: BlurRegion["shape"], kind: BlurRegion["kind"]): BlurRegion {
  return {
    ...newRegion(shape, "r1"),
    kind,
    rect: { x: 0.25, y: 0.3, w: 0.5, h: 0.3 },
    points: [
      { x: 0.25, y: 0.3 },
      { x: 0.75, y: 0.3 },
      { x: 0.75, y: 0.6 },
      { x: 0.25, y: 0.6 },
    ],
    // The three that weaken a cover, all set to values that would leak.
    opacity: 0.35,
    feather: 0.08,
    colorAmount: 0.4,
    amount: 0.04,
    color: "#000000",
  };
}

/**
 * The pixel box sampled as "inside the redaction", for all three shapes.
 *
 * Tighter than it looks like it needs to be, and the ellipse is why: the
 * regions are all defined by the same 0.25–0.75 by 0.3–0.6 box, but an ellipse
 * only fills the inscribed oval, so the corners of that box are *outside* the
 * shape and hold ordinary picture. The first run of this harness sampled them
 * and reported grey — which was the check being wrong, not the redaction. This
 * box fits inside the oval with room to spare, so a stray colour in it means
 * something leaked rather than that the sample wandered off the bar. What
 * happens at the edge is a separate question and has its own assertion below.
 */
const IN = { x0: Math.round(W * 0.4), y0: Math.round(H * 0.38), x1: Math.round(W * 0.6), y1: Math.round(H * 0.52) };

async function run(): Promise<void> {
  // ── The fill is exact, for every shape that can carry one ────────────────
  for (const shape of ["rect", "ellipse", "polygon"] as const) {
    const d = render(hostile(shape, "redact"));
    const seen = coloursIn(d, IN.x0, IN.y0, IN.x1, IN.y1);
    ok(
      `${shape}: redaction is one exact colour, nothing else`,
      seen.size === 1 && seen.has("0,0,0,255"),
      [...seen].slice(0, 4).join(" / "),
    );
  }

  // ── The control: the same thing as a blur must NOT be uniform ────────────
  {
    const d = render(hostile("rect", "gaussian"));
    const seen = coloursIn(d, IN.x0, IN.y0, IN.x1, IN.y1);
    ok("control: a gaussian at the same settings still varies", seen.size > 20, `${seen.size} colours`);
  }

  // ── The edge ring: no partial alpha anywhere on the boundary ─────────────
  {
    const d = render(hostile("rect", "redact"));
    // Walk the four edges of the region's own box, a pixel inside it. Without
    // the seal this is the antialiased ring and comes back at alpha < 255 or
    // with the stripes bleeding through.
    const bx0 = Math.round(W * 0.25) + 1;
    const by0 = Math.round(H * 0.3) + 1;
    const bx1 = Math.round(W * 0.75) - 1;
    const by1 = Math.round(H * 0.6) - 1;
    let worst = 255;
    let bled = 0;
    const at = (x: number, y: number): void => {
      const i = (y * d.width + x) * 4;
      worst = Math.min(worst, d.data[i + 3]!);
      if (d.data[i]! !== 0 || d.data[i + 1]! !== 0 || d.data[i + 2]! !== 0) bled++;
    };
    for (let x = bx0; x <= bx1; x++) { at(x, by0); at(x, by1); }
    for (let y = by0; y <= by1; y++) { at(bx0, y); at(bx1, y); }
    ok("the boundary ring is fully opaque", worst === 255, `lowest alpha ${worst}`);
    ok("nothing bleeds through the boundary ring", bled === 0, `${bled} pixels`);
  }

  // ── A see-through colour cannot be smuggled in through `color` ───────────
  {
    const d = render({ ...hostile("rect", "redact"), color: "#00000080" });
    const seen = coloursIn(d, IN.x0, IN.y0, IN.x1, IN.y1);
    ok(
      "a half-transparent fill colour is forced opaque",
      seen.size === 1 && seen.has("0,0,0,255"),
      [...seen].slice(0, 4).join(" / "),
    );
  }
  ok("opaque() strips #rrggbbaa", opaque("#11223344") === "#112233", opaque("#11223344"));
  ok("opaque() strips #rgba", opaque("#1234") === "#123", opaque("#1234"));
  ok("opaque() strips rgba()", opaque("rgba(1, 2, 3, 0.5)") === "rgb(1, 2, 3)", opaque("rgba(1, 2, 3, 0.5)"));
  ok("opaque() leaves a plain colour alone", opaque("#abcdef") === "#abcdef", opaque("#abcdef"));

  // ── Invert: the protected area survives, everything else is sealed ───────
  {
    const d = render({ ...hostile("rect", "redact"), invert: true });
    const inside = coloursIn(d, IN.x0, IN.y0, IN.x1, IN.y1);
    const outside = coloursIn(d, 4, 4, 40, 40);
    ok("inverted: the kept area is untouched", inside.size > 1, `${inside.size} colours`);
    ok(
      "inverted: everything else is exactly the fill",
      outside.size === 1 && outside.has("0,0,0,255"),
      [...outside].slice(0, 4).join(" / "),
    );
  }

  // ── PDF: a drawn cover ignores a see-through opacity ─────────────────────
  {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    for (let i = 0; i < 6; i++) {
      page.drawText("SECRET 4029 1123 SECRET", { x: 20, y: 150 - i * 20, size: 12, font, color: rgb(0, 0, 0) });
    }
    const src = await doc.save();

    const out = await stampPdf(src, [], [], {
      redactions: [{
        page: 0,
        // The panel cannot produce this any more, but a saved session can.
        place: { ...placement({ x: 10, y: 40, w: 280, h: 120 }), opacity: 0.3 },
        colour: "#000000",
      }],
    });
    const box = await coverPixels(out, 300, 200, { x: 0.15, y: 0.3, w: 0.7, h: 0.4 });
    ok(
      "PDF: a cover saved at 30% opacity is drawn solid",
      box.size === 1 && box.has("0,0,0,255"),
      [...box].slice(0, 4).join(" / "),
    );

    // ── flattenPdf: the text is gone and the page kept its size ────────────
    const locked = await flattenPdf(out);
    const re = await PDFDocument.load(locked);
    const size = re.getPage(0).getSize();
    ok("flatten: the page count is unchanged", re.getPageCount() === 1, `${re.getPageCount()}`);
    ok(
      "flatten: the page kept its exact size",
      Math.abs(size.width - 300) < 0.5 && Math.abs(size.height - 200) < 0.5,
      `${size.width}x${size.height}`,
    );
    const before = await textOf(out);
    const after = await textOf(locked);
    // The control first: if the stamped document did not read as text either,
    // the check below would pass on a broken extractor and prove nothing.
    ok("control: the stamped PDF's text can be extracted", before.includes("SECRET"), `${before.length} chars`);
    ok("flatten: no text can be extracted at all", after.trim() === "", JSON.stringify(after.slice(0, 40)));
  }

  const line = `redact: ${passed} passed, ${failed} failed`;
  console.log(line);
  document.title = line;
  const p = document.createElement("pre");
  p.textContent = line;
  document.body.append(p);
}

/**
 * Render one page of a PDF and report the distinct colours in a fractional box.
 *
 * Reading the page back through pdf.js rather than trusting the operators is
 * the whole value of it: pdf-lib will happily tell you it wrote a rectangle
 * with opacity 1, and what matters is what a reader composites onto the page.
 */
async function coverPixels(
  bytes: Uint8Array,
  ptW: number,
  ptH: number,
  box: { x: number; y: number; w: number; h: number },
): Promise<Set<string>> {
  const { loadPdfjs } = await import("@core/explorer/preview");
  const pdfjs = await loadPdfjs();
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const task = pdfjs.getDocument({ data: copy });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const view = page.getViewport({ scale: 2 });
    const c = document.createElement("canvas");
    c.width = Math.round(view.width);
    c.height = Math.round(view.height);
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: g, viewport: view }).promise;
    const sx = c.width / ptW;
    const sy = c.height / ptH;
    const d = g.getImageData(0, 0, c.width, c.height);
    return coloursIn(
      d,
      Math.round(box.x * ptW * sx),
      Math.round(box.y * ptH * sy),
      Math.round((box.x + box.w) * ptW * sx),
      Math.round((box.y + box.h) * ptH * sy),
    );
  } finally {
    await task.destroy();
  }
}

/**
 * Everything a reader can pull out of the file as text.
 *
 * This started life as a scan of the raw bytes for `BT`/`Tj` operators, which
 * was wrong in the way that matters: pdf-lib compresses its content streams,
 * so the scan found no text in the *source* document either and the assertion
 * built on it passed for the wrong reason. A check that cannot fail is worse
 * than no check, because it is counted.
 *
 * Going through pdf.js instead is both correct and the right question: this is
 * the same extraction `pdftotext`, a search index, or anyone curious about a
 * redacted document would perform. If it comes back empty, there is nothing
 * there to come back.
 */
async function textOf(bytes: Uint8Array): Promise<string> {
  const { loadPdfjs } = await import("@core/explorer/preview");
  const pdfjs = await loadPdfjs();
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const task = pdfjs.getDocument({ data: copy });
  const doc = await task.promise;
  try {
    let all = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      for (const item of content.items) if ("str" in item) all += item.str;
    }
    return all;
  } finally {
    await task.destroy();
  }
}

void run();
