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
import "../styles/save-bar.css";
import "../styles/sign-view.css";
import { themes } from "@core/theme/theme-engine";
import { loadPdfjs } from "@core/explorer/preview";
import { SignatureStore, browserSigBackend, memorySigBackend } from "@core/sign/store";
import { SignView } from "@ui/sign-view";
import { overwriteWithBackup, splitPath, suffixed, writeFree, type SaveHost } from "@core/save";
import { defaultTypeSpec, typeArt, TYPE_FACES } from "@core/sign/type";

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

/* ───────────────────────────────────────────────── save rules (`@core/save`) ──

   Pure and fast, so they run first: if the naming or the backup order is wrong
   there is no point looking at pixels. The backup order in particular has no
   visible symptom — an overwrite that writes `deed (original).pdf` *after* the
   new bytes produces two identical files and a status line saying the old one
   was kept, which is a lie that only shows up the day someone needs it. */

/** A filesystem in a Map, with the real `write_file` refusal built in. */
function fakeHost(seed: Record<string, string> = {}): SaveHost & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const dec = new TextDecoder();
  return {
    files,
    readAll(path: string) {
      const had = files.get(path);
      if (had === undefined) return Promise.reject(new Error(`${path}: not found`));
      return Promise.resolve(new TextEncoder().encode(had));
    },
    writeFile(path: string, bytes: Uint8Array, overwrite?: boolean) {
      // Exactly what `fsx.rs` does: refuse rather than clobber.
      if (overwrite !== true && files.has(path)) {
        return Promise.reject(new Error(`${path}: already exists`));
      }
      files.set(path, dec.decode(bytes));
      return Promise.resolve(path);
    },
  };
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

async function saveRules(): Promise<void> {
  const a = splitPath("C:/docs/deed.pdf");
  ok("a path splits into dir, stem and extension",
    a.dir === "C:/docs" && a.stem === "deed" && a.ext === ".pdf", JSON.stringify(a));

  const b = splitPath("/home/me/.gitignore");
  ok("a leading dot is a name, not an extension",
    b.stem === ".gitignore" && b.ext === "", JSON.stringify(b));

  const c = splitPath("report.final.docx");
  ok("only the last dot is the extension",
    c.stem === "report.final" && c.ext === ".docx", JSON.stringify(c));

  ok("a copy is offered under a suffixed name",
    suffixed("deed.pdf", "-signed") === "deed-signed.pdf", suffixed("deed.pdf", "-signed"));
  ok("a signed picture is offered as a PNG",
    suffixed("scan.jpg", "-signed", "png") === "scan-signed.png", suffixed("scan.jpg", "-signed", "png"));

  // Numbering. Brackets, not dashes — `deed-signed-2.pdf` reads as a different
  // kind of file rather than as the second attempt at the same one.
  const h = fakeHost({ "d/deed-signed.pdf": "old", "d/deed-signed (2).pdf": "older" });
  const free = await writeFree(h, "d/deed-signed.pdf", bytesOf("new"));
  ok("a copy steps past names that are taken", free === "d/deed-signed (3).pdf", free);
  ok("the copy did not touch what was already there",
    h.files.get("d/deed-signed.pdf") === "old", h.files.get("d/deed-signed.pdf") ?? "gone");

  // The order. Recorded rather than inferred: the only way to be sure the
  // backup holds the *previous* content is to watch when it was written.
  const seen: string[] = [];
  const h2 = fakeHost({ "d/deed.pdf": "ORIGINAL" });
  const spy: SaveHost = {
    readAll: (path, max) => { seen.push(`read ${path}`); return h2.readAll(path, max); },
    writeFile: (path, b2, o) => { seen.push(`write ${path}`); return h2.writeFile(path, b2, o); },
  };
  const done = await overwriteWithBackup(spy, "d/deed.pdf", bytesOf("REPLACED"));
  ok("an overwrite reads, then backs up, then writes",
    seen.join(" | ") === "read d/deed.pdf | write d/deed (original).pdf | write d/deed.pdf",
    seen.join(" | "));
  ok("the backup holds the previous content",
    h2.files.get(done.backup) === "ORIGINAL", h2.files.get(done.backup) ?? "gone");
  ok("the original path holds the new content",
    h2.files.get("d/deed.pdf") === "REPLACED", h2.files.get("d/deed.pdf") ?? "gone");

  // And the part that matters most: a backup that cannot be written must stop
  // the overwrite, not be shrugged off.
  const h3 = fakeHost({ "d/deed.pdf": "ORIGINAL" });
  const refuse: SaveHost = {
    readAll: (path, max) => h3.readAll(path, max),
    writeFile: (path, b3, o) =>
      path.includes("(original)") ? Promise.reject(new Error("disk full")) : h3.writeFile(path, b3, o),
  };
  let stopped = false;
  try {
    await overwriteWithBackup(refuse, "d/deed.pdf", bytesOf("REPLACED"));
  } catch {
    stopped = true;
  }
  ok("a failed backup aborts the overwrite", stopped);
  ok("the file survives a failed backup",
    h3.files.get("d/deed.pdf") === "ORIGINAL", h3.files.get("d/deed.pdf") ?? "gone");
}

/* ──────────────────────────────────────────── typed text (`@core/sign/type`) ──

   This exists because the thing it replaced could not do the job at all. The
   old polyline font in `sign/text.ts` carries thirteen letters and no digits,
   so "type a date next to my signature" produced a blank. Counting ink in the
   render is therefore not a fussy assertion — it is the whole point. */

/** Decode a data URL back to pixels and count what is not transparent. */
async function inkOf(dataUrl: string): Promise<{ ink: number; total: number; sample: string }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let ink = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < d.length; i += 4) {
    if ((d[i + 3] ?? 0) < 128) continue;
    ink++;
    r += d[i] ?? 0;
    g += d[i + 1] ?? 0;
    b += d[i + 2] ?? 0;
  }
  const avg = (n: number): string => Math.round(n / Math.max(1, ink)).toString(16).padStart(2, "0");
  return { ink, total: d.length / 4, sample: `#${avg(r)}${avg(g)}${avg(b)}` };
}

async function typedText(): Promise<void> {
  const spec = defaultTypeSpec();
  ok("a typed mark starts as today's date", /\d/.test(spec.text), spec.text);

  const art = typeArt({ ...spec, text: "12/25/2026" });
  ok("a typed date renders to art", art !== null);
  if (art === null) return;
  ok("the art is a PNG data URL", art.data.startsWith("data:image/png"), art.data.slice(0, 24));
  ok("the art has a sane size", art.w > 40 && art.h > 10 && art.w < 2500, `${art.w}x${art.h}`);
  ok("a typed date is wider than it is tall", art.w > art.h, `${art.w}x${art.h}`);

  const drawn = await inkOf(art.data);
  // The old glyph font would score exactly 0 here, which is the regression.
  ok("the digits actually drew", drawn.ink > 200, `${drawn.ink} opaque pixels`);
  ok("the background stayed transparent", drawn.ink < drawn.total * 0.6,
    `${Math.round((drawn.ink / drawn.total) * 100)}% covered`);

  // Colour is the user's, not the font's.
  const red = typeArt({ ...spec, text: "2026", colour: "#cc0000" });
  ok("a colour was applied to typed text", red !== null);
  if (red !== null) {
    const seen = await inkOf(red.data);
    const [rr = 0, gg = 0, bb = 0] = (seen.sample.match(/[0-9a-f]{2}/g) ?? []).map((x) => parseInt(x, 16));
    ok("typed text takes the chosen colour", rr > 150 && gg < 80 && bb < 80, seen.sample);
  }

  // Every face has to produce something; a stack that resolves to nothing
  // would render a row of blanks and nobody would find out until a signed
  // contract came back empty.
  for (const face of TYPE_FACES) {
    const one = typeArt({ ...spec, text: "Jan 2026", face: face.id });
    const got = one === null ? { ink: 0 } : await inkOf(one.data);
    ok(`the ${face.label} face renders`, got.ink > 100, `${got.ink} pixels`);
  }

  ok("empty text produces nothing rather than a blank stamp",
    typeArt({ ...spec, text: "   " }) === null);
}

/* ────────────────────────────────────── the panel: typed text, delete, library ──

   The complaints this pass exists for, in the order they were made: a placed
   mark that cannot be removed, and a date that has to be drawn by hand because
   it cannot be typed. Both are checked through the real panel and the real
   export, not through the functions underneath them — the functions were fine,
   the wiring was not. */

/** Dark pixels on page 1 of a PDF, rendered at scale 1. */
async function pageInk(pdf: Uint8Array): Promise<number> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: pdf.slice() }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const cv = document.createElement("canvas");
  cv.width = Math.round(vp.width);
  cv.height = Math.round(vp.height);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvas: cv, canvasContext: ctx, viewport: vp }).promise;
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) < 160) dark++;
  return dark;
}

async function signPanel(src: Uint8Array, url: string): Promise<void> {
  let written: Uint8Array | null = null;
  const store = new SignatureStore(memorySigBackend());
  const view = new SignView({
    fileUrl: () => Promise.resolve(url),
    readAll: () => Promise.resolve(src),
    writeFile: (path: string, bytes: Uint8Array) => {
      written = bytes;
      return Promise.resolve(path);
    },
    refresh: () => {},
    store,
  });
  await view.open("C:/tmp/signcheck-sign.pdf", "sign");
  await settle(400);

  /*
   * Everything below is scoped to the panel that is *showing*.
   *
   * `close()` hides a panel, it does not unmount it — the redaction pass above
   * left its own `.fct-signv` in the document. A bare `document.querySelector`
   * therefore finds the dead panel's save bar and side rail first, and the
   * checks quietly measure the wrong screen: the first run of this pass
   * "failed to export" because it clicked the hidden panel's copy button.
   */
  const panel = (): Element => {
    const live = document.querySelector(".fct-signv:not([hidden])");
    if (!live) throw new Error("the signing panel is not showing");
    return live;
  };
  const q = (sel: string): HTMLElement | null => panel().querySelector(sel);
  const buttonSaying = (re: RegExp): HTMLButtonElement | undefined =>
    [...panel().querySelectorAll(".fct-signv-side button")].find((b) => re.test(b.textContent ?? "")) as
      HTMLButtonElement | undefined;

  const typeBtn = buttonSaying(/type text or a date/i);
  ok("the panel offers typed text", typeBtn !== undefined);
  typeBtn?.click();
  await settle(150);

  ok("typing places a mark on the page", q(".fct-signv-mark.is-text") !== null);

  // Complaint one: every mark carries its own remove, whatever kind it is.
  const kill = q(".fct-signv-mark.is-text .fct-signv-kill");
  ok("a typed mark has a remove button", kill !== null);
  kill?.click();
  await settle(150);
  ok("the remove button removes it", q(".fct-signv-mark.is-text") === null);

  // Put one back and export it.
  buttonSaying(/type text or a date/i)?.click();
  await settle(150);
  ok("a typed mark can be placed again after a removal", q(".fct-signv-mark.is-text") !== null);

  const nameIn = q(".fct-savebar-name") as HTMLInputElement | null;
  ok("the copy is offered under a signed name", /-signed\.pdf$/.test(nameIn?.value ?? ""),
    nameIn?.value ?? "none");
  ok("a PDF may be overwritten in place", q(".fct-savebar-btn.is-danger") !== null);

  const before = await pageInk(src);
  q(".fct-savebar-btn.is-primary")?.click();
  for (let i = 0; i < 100 && written === null; i++) await settle(100);
  ok("a typed mark exports", written !== null);
  if (written !== null) {
    // Ink, not bytes: a mark that is dropped on the way out still produces a
    // different-sized file, because the export rewrites the document.
    const after = await pageInk(written);
    ok("the typed date is on the exported page", after > before + 400,
      `${before} -> ${after} dark pixels`);
  }

  // Complaint two: a signature you keep is a signature you can delete.
  const sig = store.add({
    name: "Test hand",
    kind: "signature",
    art: { source: "svg", paths: ["M0 40 L40 0 L80 40"], viewBox: [0, 0, 80, 40] },
    colour: "#12203a",
    aspect: 2,
  });
  await settle(150);
  const card = q(`.fct-signv-sig[data-sig="${sig.id}"]`);
  ok("a saved signature shows in the library", card !== null);

  const tools = card?.querySelectorAll(".fct-signv-sigtool");
  ok("a saved signature has rename and delete", (tools?.length ?? 0) === 2, `${tools?.length ?? 0} tools`);
  (tools?.[1] as HTMLElement | undefined)?.click();
  await settle(150);
  ok("deleting removes it from the library", store.list().every((x) => x.id !== sig.id));

  const undo = buttonSaying(/^undo/i);
  ok("a deletion can be undone", undo !== undefined);
  undo?.click();
  await settle(150);
  ok("undo puts the signature back", store.list().some((x) => x.name === "Test hand"),
    `${store.list().length} kept`);
}

async function run(): Promise<void> {
  // Rules first, pixels second. A naming or backup-order fault makes every
  // geometry result below it meaningless.
  await saveRules();
  await typedText();

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

  const save = document.querySelector(".fct-savebar-btn.is-primary") as HTMLElement | null;
  ok("the save bar offers a copy button", save !== null);
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

  // The panel is done with; the signing pass opens its own on the same bytes.
  view.close?.();
  await settle(120);
  await signPanel(src, url);

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
