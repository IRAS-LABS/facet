/**
 * Checks the OCR model and the panel over it (item 32).
 *
 * The claim OCR has to defend is not "the letters are right" — that is
 * Tesseract's problem and it is very good at it — but **the page is put back
 * together the way a person reads it**. A two-column page read straight across
 * gives a transcript that is word-for-word correct and completely useless, a
 * paragraph break in the wrong place turns a table into prose, and a hyphen
 * left at a line end leaves a word that is not a word. Those are all geometry,
 * they are all in `page.ts`, and they are all checked here against pages built
 * by hand — no engine, no download, no photograph.
 *
 * The pages below are deliberately synthetic. A fixture scan would test
 * Tesseract; hand-built boxes test *us*, and they can be placed exactly on the
 * edge of every rule — a gutter one pixel too narrow, a gap one pixel short of
 * a paragraph — which no real scan ever obliges by doing.
 *
 * Dev-only. Loaded by /dev/ocrcheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/ocrcheck.html
 */

import "../styles/base.css";
import "../styles/ocr.css";

import {
  blankPage,
  boxOf,
  confident,
  contains,
  docText,
  fromRaw,
  joinLines,
  lineText,
  mapBox,
  meanConfidence,
  overlaps,
  pageText,
  paragraphsOf,
  problems,
  readingOrder,
  rescale,
  searchPage,
  textOfWords,
  wordAt,
  wordCount,
  wordsInRect,
  wordsOf,
  type Box,
  type OcrBlock,
  type OcrLine,
  type OcrPage,
  type OcrWord,
  type RawResult,
} from "@core/ocr/page";
import { LANGUAGES, nameOfLanguage, scaleFor, type Recogniser } from "@core/ocr/engine";
import { OcrView, OCR_EXTS, type OcrHost } from "@ui/ocr-view";

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.log("FAIL", name, " ", detail);
  }
};

// ── A page, as rectangles ───────────────────────────────────────────────────

/** A word 12 px per character wide and 20 tall — near enough to a 12 pt face. */
const W = (text: string, x: number, y: number, confidence = 95): OcrWord => ({
  text,
  box: { x, y, w: text.length * 12, h: 20 },
  confidence,
});

/** A line of words laid left to right with 8 px between them. */
function L(y: number, x: number, words: string[], confidence = 95): OcrLine {
  const out: OcrWord[] = [];
  let at = x;
  for (const t of words) {
    const word = W(t, at, y, confidence);
    out.push(word);
    at += word.box.w + 8;
  }
  return { words: out, box: boxOf(out.map((w) => w.box)), confidence };
}

const B = (lines: OcrLine[]): OcrBlock => ({ lines, box: boxOf(lines.map((l) => l.box)) });

const P = (blocks: OcrBlock[], width = 1000, height = 1400): OcrPage => ({
  width,
  height,
  blocks,
  confidence: 92,
  angle: 0,
  language: "eng",
});

/** A block of `count` lines of the same three words, 30 px apart. */
function column(x: number, y: number, count: number, tag: string): OcrBlock {
  const lines: OcrLine[] = [];
  for (let i = 0; i < count; i++) lines.push(L(y + i * 30, x, [`${tag}${i + 1}`, "words", "here"]));
  return B(lines);
}

/**
 * A block wide enough to count as spanning the page — 716 px of a 1000 px
 * page, comfortably over the 70% rule, which is what makes it a divider rather
 * than something living in a column.
 */
const banner = (y: number, tag: string): OcrBlock =>
  B([
    L(y, 50, [tag, "HEADLINE", "STRETCHES", "ALL", "THE", "WAY", "ACROSS", "THIS", "ENTIRE", "WIDE", "PAGE"]),
  ]);

const firstWordOf = (block: OcrBlock): string => block.lines[0]?.words[0]?.text ?? "";
const order = (page: OcrPage): string => readingOrder(page).map(firstWordOf).join(",");

// ── Rectangles ──────────────────────────────────────────────────────────────
{
  const a: Box = { x: 10, y: 10, w: 100, h: 50 };
  const b: Box = { x: 60, y: 40, w: 100, h: 50 };
  ok("a union covers both", JSON.stringify(boxOf([a, b])) === JSON.stringify({ x: 10, y: 10, w: 150, h: 80 }));
  ok("a union of nothing is nothing", boxOf([]).w === 0 && boxOf([]).h === 0);
  ok("a point inside is inside", contains(a, 50, 30));
  ok("…and one outside is not", !contains(a, 50, 200));
  ok("…and the edge counts as inside", contains(a, 110, 60));
  ok("overlapping rectangles overlap", overlaps(a, b));
  ok("…and separated ones do not", !overlaps(a, { x: 500, y: 500, w: 10, h: 10 }));
  ok("…and touching edges do not count as overlap", !overlaps(a, { x: 110, y: 10, w: 10, h: 10 }));

  const moved = mapBox(a, { width: 100, height: 100 }, { width: 200, height: 50 });
  ok("a box maps into another space", moved.x === 20 && moved.y === 5 && moved.w === 200 && moved.h === 25);
  ok("…and a zero-sized space does not divide by zero",
    Number.isFinite(mapBox(a, { width: 0, height: 0 }, { width: 10, height: 10 }).x));
}

// ── Reading order ───────────────────────────────────────────────────────────
{
  // Two columns: the left runs to x = 198, the right starts at 550, so there
  // are 352 px of gutter where the rule asks for 40.
  const left = column(50, 100, 4, "L");
  const right = column(550, 100, 4, "R");
  const two = P([right, left]);
  ok("two columns are read left column first, whatever order they arrived in",
    order(two) === "L1,R1", order(two));
  ok("…and scanning across gives a different, wrong answer",
    pageText(two, { columns: false }) !== pageText(two, { columns: true }));

  // 30 px between two blocks, where the rule wants 40. Not a column break, so
  // the blocks stay in the order the engine gave them rather than being
  // reshuffled left-to-right on the strength of a word space.
  const tight = P([column(228, 100, 3, "Z"), column(50, 100, 3, "A")]);
  ok("a 30 px gap on a 1000 px page is a word space, not a column break",
    order(tight) === "Z1,A1", order(tight));

  const head = banner(20, "TOP");
  ok("the banner really does span the page", head.box.w >= 700, String(head.box.w));
  ok("a spanning headline is read before the columns under it",
    order(P([left, right, head])) === "TOP,L1,R1", order(P([left, right, head])));

  // A heading part way down starts a fresh pair of columns beneath it.
  const magazine = P([
    column(550, 500, 3, "d"),
    column(550, 100, 3, "b"),
    banner(400, "MID"),
    column(50, 500, 3, "c"),
    column(50, 100, 3, "a"),
  ]);
  ok("a heading part way down divides the columns above from those below",
    order(magazine) === "a1,b1,MID,c1,d1", order(magazine));

  const three = P([column(700, 60, 3, "c"), column(60, 60, 3, "a"), column(380, 60, 3, "b")]);
  ok("three columns come out in order", order(three) === "a1,b1,c1", order(three));

  // Two blocks in one column, one under the other. The empty left margin is
  // not a gutter — reading it as one would put everything in "column two".
  const stacked = P([column(300, 100, 2, "x"), column(300, 200, 2, "y")]);
  ok("a wide left margin is not a column break", order(stacked) === "x1,y1", order(stacked));

  ok("an empty page has no order to get wrong", readingOrder(P([])).length === 0);
  ok("blocks with no lines are dropped", readingOrder(P([B([]), left])).length === 1);
}

// ── Paragraphs ──────────────────────────────────────────────────────────────
{
  const block = B([
    L(0, 50, ["one"]),
    L(30, 50, ["two"]),
    L(60, 50, ["three"]),
    L(120, 50, ["four"]),
    L(150, 50, ["five"]),
  ]);
  const paras = paragraphsOf(block);
  ok("a double gap starts a new paragraph", paras.length === 2, String(paras.length));
  ok("…and the lines land in the right one", paras[0]?.length === 3 && paras[1]?.length === 2);

  ok("even spacing is one paragraph",
    paragraphsOf(B([L(0, 50, ["a"]), L(30, 50, ["b"]), L(60, 50, ["c"])])).length === 1);

  // Pitch 36, gap 42, rule 1.5× — just under, so it holds together. This is
  // the case an absolute pixel threshold gets wrong on a high-dpi scan.
  ok("a gap under the threshold does not split",
    paragraphsOf(B([L(0, 50, ["a"]), L(30, 50, ["b"]), L(72, 50, ["c"])])).length === 1);

  ok("one line is one paragraph", paragraphsOf(B([L(0, 50, ["a"])])).length === 1);
  ok("no lines is no paragraphs", paragraphsOf(B([])).length === 0);

  const jumbled = B([L(60, 50, ["last"]), L(0, 50, ["first"]), L(30, 50, ["middle"])]);
  ok("lines are ordered by where they are, not how they arrived",
    paragraphsOf(jumbled)[0]?.map((l) => lineText(l)).join(" ") === "first middle last");
}

// ── Hyphens ─────────────────────────────────────────────────────────────────
{
  const join = (a: string[], b: string[]): string => joinLines([L(0, 0, a), L(30, 0, b)]);

  ok("a mechanical break is rejoined", join(["self-"], ["employed"]) === "selfemployed");
  ok("…including mid-sentence", join(["a", "well-"], ["known", "case"]) === "a wellknown case");
  ok("a capital after the hyphen is a real compound", join(["Anglo-"], ["Saxon"]) === "Anglo- Saxon");
  ok("a dash on its own is not a hyphenated word", join(["and", "-"], ["then"]) === "and - then");
  ok("a digit before the hyphen is left alone", join(["1998-"], ["ish"]) === "1998- ish");
  ok("ordinary lines join with a space", join(["the", "cat"], ["sat", "down"]) === "the cat sat down");
  ok("dehyphenation can be turned off",
    joinLines([L(0, 0, ["self-"]), L(30, 0, ["employed"])], false) === "self- employed");
  ok("one line joins to itself", joinLines([L(0, 0, ["alone"])]) === "alone");
  ok("no lines join to nothing", joinLines([]) === "");
}

// ── Text out ────────────────────────────────────────────────────────────────
{
  const page = P([
    B([L(0, 50, ["The", "first", "para-"]), L(30, 50, ["graph", "ends", "here."])]),
    B([L(200, 50, ["A", "second", "block."])]),
  ]);
  ok("the page comes out as a person would read it aloud",
    pageText(page) === "The first paragraph ends here.\n\nA second block.",
    JSON.stringify(pageText(page)));
  ok("word count is what it says", wordCount(page) === 9, String(wordCount(page)));

  const doc = { pages: [page, P([B([L(0, 50, ["Page", "two."])])])], source: "x.pdf" };
  ok("a document numbers its pages",
    docText(doc).includes("— page 1 —") && docText(doc).includes("— page 2 —"), docText(doc));
  ok("…and a single page is not numbered",
    !docText({ pages: [page], source: "x.png" }).includes("page 1"));
  ok("an empty page contributes nothing", docText({ pages: [blankPage()], source: "" }) === "");
}

// ── Doubt ───────────────────────────────────────────────────────────────────
{
  const page = P([B([L(0, 50, ["sure", "words"], 96), L(30, 50, ["dubious", "guess"], 40)])]);
  ok("mean confidence is over words, not blocks",
    Math.round(meanConfidence(page)) === 68, String(meanConfidence(page)));

  const kept = confident(page, 75);
  ok("filtering drops the doubtful words", wordCount(kept) === 2, String(wordCount(kept)));
  ok("…and the line they were alone on", kept.blocks[0]?.lines.length === 1);
  ok("…and the original is untouched", wordCount(page) === 4);
  ok("filtering everything leaves an empty page but still a page",
    confident(page, 99).blocks.length === 0 && confident(page, 99).width === page.width);
  ok("text can be asked to leave doubt out",
    !pageText(page, { minConfidence: 75 }).includes("dubious"));
  ok("mean confidence of nothing is zero", meanConfidence(blankPage()) === 0);
}

// ── Pointing ────────────────────────────────────────────────────────────────
{
  const page = P([B([L(100, 50, ["alpha", "beta", "gamma"])])]);
  const words = wordsOf(page);
  const alpha = words[0] as OcrWord;
  const beta = words[1] as OcrWord;

  ok("a word is found under the point", wordAt(page, beta.box.x + 5, 105)?.text === "beta");
  ok("…and empty space finds nothing", wordAt(page, 900, 900) === null);
  ok("…and the gap between two words finds nothing",
    wordAt(page, alpha.box.x + alpha.box.w + 4, 105) === null);

  const all = wordsInRect(page, { x: 0, y: 0, w: 1000, h: 1400 });
  ok("a marquee over everything takes everything", all.length === 3);
  ok("…in reading order", textOfWords(all) === "alpha beta gamma");
  ok("a marquee that only clips a word still takes it",
    wordsInRect(page, { x: beta.box.x + beta.box.w - 2, y: 100, w: 4, h: 20 }).length === 1);
  ok("…and one that misses takes nothing",
    wordsInRect(page, { x: 0, y: 800, w: 100, h: 100 }).length === 0);
  ok("selected words join with spaces", textOfWords([alpha, beta]) === "alpha beta");
}

// ── Finding ─────────────────────────────────────────────────────────────────
{
  const page = P([
    B([L(0, 50, ["Invoice", "number", "44812", "is", "overdue"])]),
    B([L(200, 50, ["the", "invoice", "again"])]),
  ]);

  ok("a word is found", searchPage(page, "44812").length === 1);
  ok("case is folded", searchPage(page, "INVOICE").length === 2, String(searchPage(page, "INVOICE").length));
  ok("a phrase is found across two words", searchPage(page, "invoice number").length === 1);
  ok("…and it covers both of them", (searchPage(page, "invoice number")[0]?.words.length ?? 0) === 2);
  ok("…and its box is the union, not just the first word",
    (searchPage(page, "invoice number")[0]?.box.w ?? 0) > (wordsOf(page)[0] as OcrWord).box.w);
  ok("a phrase split across lines is not claimed", searchPage(page, "overdue the").length === 0);
  ok("nothing matches nothing", searchPage(page, "zebra").length === 0);
  ok("an empty query matches nothing rather than everything", searchPage(page, "   ").length === 0);
  ok("matches come back in reading order",
    searchPage(page, "invoice").every((m, i, xs) => i === 0 || m.at > (xs[i - 1]?.at ?? 0)));
  ok("the offset points at the match in the text the pane shows",
    pageText(page).slice(searchPage(page, "44812")[0]?.at ?? -1).startsWith("44812"),
    String(searchPage(page, "44812")[0]?.at));

  ok("every occurrence is found", searchPage(P([B([L(0, 50, ["ha", "ha", "ha"])])]), "ha").length === 3);
}

// ── What is wrong with a scan ───────────────────────────────────────────────
{
  ok("an empty page says so", problems(blankPage(1000, 1400))[0]?.kind === "empty");
  ok("…and says what to do about it",
    (problems(blankPage(1000, 1400))[0]?.note ?? "").includes("photo"));

  const good = P([column(50, 50, 12, "g")]);
  ok("a clean page has nothing to report", problems(good).length === 0, JSON.stringify(problems(good)));

  const unsure = P([
    {
      ...(good.blocks[0] as OcrBlock),
      lines: (good.blocks[0] as OcrBlock).lines.map((l) => ({
        ...l,
        words: l.words.map((w) => ({ ...w, confidence: 45 })),
      })),
    },
  ]);
  ok("low confidence is reported", problems(unsure).some((p) => p.kind === "unsure"));
  ok("…with the number in it",
    (problems(unsure).find((p) => p.kind === "unsure")?.note ?? "").includes("45%"));

  ok("a page the engine had to turn is reported",
    problems({ ...good, angle: 7 }).some((p) => p.kind === "rotated"));
  ok("…but a fraction of a degree is not",
    !problems({ ...good, angle: 0.4 }).some((p) => p.kind === "rotated"));

  ok("three words on a big page is reported",
    problems(P([B([L(0, 50, ["three", "lonely", "words"])])])).some((p) => p.kind === "sparse"));
  ok("…but not on a thumbnail",
    !problems(P([B([L(0, 5, ["three", "lonely", "words"])])], 400, 300))
      .some((p) => p.kind === "sparse"));

  ok("text placed outside the page is reported",
    problems(P([column(50, 50, 12, "g")], 100, 100)).some((p) => p.kind === "impossible"));
}

// ── In from the engine ──────────────────────────────────────────────────────
{
  const raw: RawResult = {
    confidence: 88,
    rotateRadians: Math.PI / 2,
    blocks: [
      {
        bbox: { x0: 10, y0: 20, x1: 210, y1: 60 },
        paragraphs: [
          {
            lines: [
              {
                bbox: { x0: 10, y0: 20, x1: 210, y1: 40 },
                confidence: 90,
                words: [
                  { text: "Hello", bbox: { x0: 10, y0: 20, x1: 100, y1: 40 }, confidence: 95 },
                  { text: "  ", bbox: { x0: 100, y0: 20, x1: 110, y1: 40 }, confidence: 10 },
                  { text: "world", bbox: { x0: 110, y0: 20, x1: 210, y1: 40 }, confidence: 85 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const page = fromRaw(raw, { width: 400, height: 300 }, "eng+heb");

  ok("corners become a position and a size",
    JSON.stringify(page.blocks[0]?.box) === JSON.stringify({ x: 10, y: 20, w: 200, h: 40 }),
    JSON.stringify(page.blocks[0]?.box));
  ok("blank words are dropped", wordCount(page) === 2, String(wordCount(page)));
  ok("radians come out as degrees", Math.round(page.angle) === 90, String(page.angle));
  ok("the size is the image's, not the boxes'", page.width === 400 && page.height === 300);
  ok("the language is carried through", page.language === "eng+heb");
  ok("paragraph nesting is flattened away, lines are not", page.blocks[0]?.lines.length === 1);

  ok("a result with no blocks is an empty page, not a crash",
    fromRaw({ blocks: null }, { width: 10, height: 10 }).blocks.length === 0);
  ok("a line whose words are all blank is dropped",
    fromRaw(
      { blocks: [{ paragraphs: [{ lines: [{ words: [{ text: " " }] }] }] }] },
      { width: 10, height: 10 },
    ).blocks.length === 0);
  ok("a missing bbox is derived from the words inside it",
    fromRaw(
      { blocks: [{ paragraphs: [{ lines: [{ words: [{ text: "x", bbox: { x0: 5, y0: 5, x1: 15, y1: 25 } }] }] }] }] },
      { width: 100, height: 100 },
    ).blocks[0]?.box.h === 20);
}

// ── Undoing the upscale ─────────────────────────────────────────────────────
{
  const big = P([B([L(100, 100, ["word"])])], 2000, 2800);
  const small = rescale(big, { width: 1000, height: 1400 });
  const word = wordsOf(small)[0] as OcrWord;
  ok("the page takes the new size", small.width === 1000 && small.height === 1400);
  ok("…and every word comes with it", word.box.x === 50 && word.box.y === 50);
  ok("…including the lines and blocks around them",
    small.blocks[0]?.box.x === 50 && small.blocks[0]?.lines[0]?.box.x === 50);
  ok("…and nothing that was read is changed", word.text === "word" && word.confidence === 95);

  ok("a small scan is scaled up", scaleFor(600, 800) === 2, String(scaleFor(600, 800)));
  ok("…by a whole number", Number.isInteger(scaleFor(437, 900)));
  ok("…never past the cap", scaleFor(60, 80) === 3, String(scaleFor(60, 80)));
  ok("a scan already big enough is left alone", scaleFor(2480, 3500) === 1);
  ok("a zero-sized image does not divide by zero", scaleFor(0, 0) === 1);
}

// ── Languages ───────────────────────────────────────────────────────────────
{
  ok("codes have names", nameOfLanguage("eng") === "English");
  ok("…including combined ones", nameOfLanguage("eng+heb") === "English + Hebrew");
  ok("…and an unknown code is shown as itself", nameOfLanguage("xyz") === "xyz");
  ok("every offered language has a code and a name",
    LANGUAGES.every((l) => l.code.length > 0 && l.name.length > 0));
  ok("no language is offered twice", new Set(LANGUAGES.map((l) => l.code)).size === LANGUAGES.length);
  ok("PDFs and the usual pictures are all offered to the panel",
    ["pdf", "png", "jpg", "tiff"].every((e) => OCR_EXTS.includes(e)));
}

// ── The panel ───────────────────────────────────────────────────────────────

/*
 * Scoped to the panel that is *open*, for the reason written down in
 * subcheck: a closed panel stays in the DOM, and a bare `.ocr-word` would
 * count boxes in one that was shut two blocks ago.
 */
const LIVE = ".ocr:not([hidden])";
const all = <T extends HTMLElement>(sel: string): T[] =>
  [...document.querySelectorAll<T>(`${LIVE} ${sel}`)];
const $ = <T extends HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(`${LIVE} ${sel}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const btn = (label: string): HTMLButtonElement | null =>
  all<HTMLButtonElement>("button").find((b) => b.textContent === label) ?? null;
const press = (label: string): void => btn(label)?.click();

/** A checkbox by the words next to it, rather than by its position in the bar. */
const checkbox = (label: string): HTMLInputElement | null => {
  for (const wrap of all<HTMLElement>(".ocr-check")) {
    if ((wrap.querySelector("span")?.textContent ?? "") === label) {
      return wrap.querySelector<HTMLInputElement>("input");
    }
  }
  return null;
};

const noteOf = (): string => $(".ocr-note")?.textContent ?? "";
const flagsOf = (): string[] => all(".ocr-flag").map((f) => f.textContent ?? "");
const boxesOf = (): HTMLElement[] => all(".ocr-word");
const parasOf = (): string[] => all(".ocr-para").map((p) => p.textContent ?? "");

/** A real, decodable picture, made here rather than fetched. */
function picture(width = 900, height = 1200): string {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#111111";
    ctx.font = "40px sans-serif";
    ctx.fillText("Invoice 44812", 60, 120);
  }
  return c.toDataURL("image/png");
}

const SCAN = "C:/scans/invoice.png";

/**
 * What the stub engine hands back.
 *
 * Six words, the second three read badly, which puts the mean at 67.5% — just
 * under the 70% the model calls doubtful. That is on purpose: one run then
 * exercises the warning strip and the doubtful-word marking together.
 */
const RESULT = P([
  B([L(40, 50, ["Invoice", "number", "44812"])]),
  B([L(140, 50, ["Amount", "due", "today"], 40)]),
]);

async function viewChecks(): Promise<void> {
  const disk: Array<{ path: string; bytes: Uint8Array }> = [];
  let refreshed = 0;
  let cancels = 0;
  let lastLanguage = "";
  let askedForPdf = false;
  let fed = { width: 0, height: 0 };

  const engine: Recogniser = {
    read: (image, opts) => {
      lastLanguage = opts?.language ?? "";
      askedForPdf = opts?.pdf === true;
      fed = { width: image.width, height: image.height };
      opts?.onProgress?.({ what: "Reading", done: 0.5 });
      return Promise.resolve(
        opts?.pdf
          ? { page: RESULT, pdf: new TextEncoder().encode("%PDF-1.4 fake") }
          : { page: RESULT },
      );
    },
    cancel: () => {
      cancels++;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };

  const host: OcrHost = {
    fileUrl: () => Promise.resolve(picture()),
    writeFile: (path, bytes) => {
      disk.push({ path, bytes });
      return Promise.resolve(path);
    },
    refresh: () => {
      refreshed++;
    },
    engine,
  };

  // The clipboard belongs to whoever is at the keyboard, not to the harness —
  // an earlier check in this project quietly overwrote what someone had
  // copied. Captured here, never written to for real.
  let clipboard = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (t: string) => {
        clipboard = t;
        return Promise.resolve();
      },
    },
  });

  const view = new OcrView(host);

  // ── Opening ───────────────────────────────────────────────────────────────
  {
    await view.open(SCAN);
    ok("the panel opens on the file", view.isOpen && view.openPath === SCAN);
    ok("…titled with the name, not the path",
      $(".ocr-title")?.textContent === "invoice.png", $(".ocr-title")?.textContent ?? "");
    ok("…and says what to do next", noteOf().includes("Read"), noteOf());
    ok("nothing is drawn before anything is read", boxesOf().length === 0);
    ok("the picture is on screen at its own size",
      ($(".ocr-canvas") as HTMLCanvasElement | null)?.width === 900);
    ok("a save name is offered beside the original",
      ($(".ocr-name") as HTMLInputElement | null)?.value === "invoice.txt");
    ok("all-pages is not offered for a single picture", checkbox("All pages")?.disabled === true);
    ok("there is no PDF to save yet", btn("Save PDF")?.disabled === true);
  }

  // ── Reading ───────────────────────────────────────────────────────────────
  {
    press("Read");
    await sleep(30);
    ok("a box is drawn for every word", boxesOf().length === wordCount(RESULT),
      `${boxesOf().length} vs ${wordCount(RESULT)}`);
    ok("…positioned in per-cent, so zoom cannot move them off their words",
      (boxesOf()[0]?.style.left ?? "").endsWith("%"), boxesOf()[0]?.style.left ?? "");
    ok("…and the doubtful ones are marked",
      boxesOf().filter((b) => b.classList.contains("ocr-doubt")).length === 3,
      String(boxesOf().filter((b) => b.classList.contains("ocr-doubt")).length));
    ok("the text is in the pane, as paragraphs", parasOf().length === 2, parasOf().join(" | "));
    ok("…in reading order", (parasOf()[0] ?? "").startsWith("Invoice"), parasOf()[0] ?? "");
    ok("the count and the confidence are said out loud",
      noteOf().includes("6 words") && noteOf().includes("%"), noteOf());
    ok("…and which language it was read in", noteOf().includes("English"), noteOf());
    ok("the page is there for anything that asks", view.pages.size === 1);
    ok("the engine was told which language", lastLanguage === "eng", lastLanguage);
    ok("…and was not asked for a PDF nobody wanted", !askedForPdf);
    ok("it was handed the picture, not a thumbnail", fed.width === 900 && fed.height === 1200);
    ok("the progress bar is put away when it is done", $(".ocr-progress")?.hidden === true);
  }

  // ── Marking doubt ─────────────────────────────────────────────────────────
  {
    const box = checkbox("Mark doubtful words");
    box?.click();
    await sleep(10);
    ok("doubt marking can be turned off", boxesOf().every((b) => !b.classList.contains("ocr-doubt")));
    box?.click();
    await sleep(10);
    ok("…and back on", boxesOf().some((b) => b.classList.contains("ocr-doubt")));
  }

  // ── Warnings ──────────────────────────────────────────────────────────────
  {
    ok("a page this doubtful is flagged",
      flagsOf().some((f) => f.includes("Low confidence")), flagsOf().join(" | "));
    ok("…in a sentence with the fix attached, not a symbol",
      (flagsOf()[0] ?? "").includes("dpi"), flagsOf()[0] ?? "");
    ok("…and visible without hovering anything", $(".ocr-flag")?.hidden === false);
  }

  // ── Finding ───────────────────────────────────────────────────────────────
  {
    const find = $(".ocr-find") as HTMLInputElement;
    const type = (text: string): void => {
      find.value = text;
      find.dispatchEvent(new Event("input", { bubbles: true }));
    };

    type("44812");
    await sleep(10);
    ok("a match is highlighted on the picture",
      boxesOf().filter((b) => b.classList.contains("ocr-hit")).length === 1);
    ok("…and in the text", all("mark").length === 1);
    ok("…and counted", noteOf().includes("1 match"), noteOf());

    type("zebra");
    await sleep(10);
    ok("a miss says so rather than going quiet", noteOf().includes("not on this page"), noteOf());
    ok("…and highlights nothing",
      boxesOf().filter((b) => b.classList.contains("ocr-hit")).length === 0);

    type("");
    await sleep(10);
    ok("clearing the search clears the marks", all("mark").length === 0);
  }

  // ── Copying ───────────────────────────────────────────────────────────────
  {
    press("Copy");
    await sleep(20);
    ok("copy takes the whole page when nothing is chosen",
      clipboard === "Invoice number 44812\n\nAmount due today", JSON.stringify(clipboard));
  }

  // ── Saving ────────────────────────────────────────────────────────────────
  {
    press("Save text");
    await sleep(20);
    ok("the text is written beside the original",
      disk.at(-1)?.path === "C:/scans/invoice.txt", disk.at(-1)?.path ?? "");
    ok("…with the text in it",
      new TextDecoder().decode(disk.at(-1)?.bytes ?? new Uint8Array()).includes("44812"));
    ok("…and the folder is told to refresh", refreshed === 1, String(refreshed));
    ok("…and it says where it went", noteOf().includes("invoice.txt"), noteOf());

    const name = $(".ocr-name") as HTMLInputElement;
    name.value = "  ";
    press("Save text");
    await sleep(20);
    ok("an empty name is refused rather than guessed at",
      noteOf().includes("name") && disk.length === 1, `${noteOf()} / ${disk.length}`);
    name.value = "invoice.txt";
  }

  // ── A searchable PDF ──────────────────────────────────────────────────────
  {
    checkbox("Searchable PDF")?.click();
    press("Read");
    await sleep(30);
    ok("the engine is asked for one when the box is ticked", askedForPdf);
    ok("…and only then does the button come alive", btn("Save PDF")?.disabled === false);

    press("Save PDF");
    await sleep(30);
    ok("the PDF is written beside the original, never over it",
      disk.at(-1)?.path === "C:/scans/invoice (searchable).pdf", disk.at(-1)?.path ?? "");
    ok("…and it is a PDF",
      new TextDecoder().decode((disk.at(-1)?.bytes ?? new Uint8Array()).slice(0, 5)) === "%PDF-");
    checkbox("Searchable PDF")?.click();
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────
  {
    press("+");
    ok("bigger is bigger", ($(".ocr-shot") as HTMLElement).style.width === "150%");
    for (let i = 0; i < 9; i++) press("+");
    ok("…and stops at the biggest", ($(".ocr-shot") as HTMLElement).style.width === "400%");
    for (let i = 0; i < 9; i++) press("−");
    ok("…and at the smallest", ($(".ocr-shot") as HTMLElement).style.width === "100%");
  }

  // ── Choosing words off the picture ────────────────────────────────────────
  {
    const layer = $(".ocr-boxes") as HTMLElement;
    // The stage has no layout worth speaking of in a harness, so give it one:
    // the panel converts client coordinates through this rectangle, and with a
    // zero-sized one every point collapses to the origin.
    layer.getBoundingClientRect = () =>
      ({
        left: 0, top: 0, width: 1000, height: 1400, right: 1000, bottom: 1400, x: 0, y: 0,
        toJSON: () => "",
      }) as DOMRect;
    layer.setPointerCapture = () => undefined;

    const at = (x: number, y: number, type: string): PointerEvent =>
      new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1 });

    const word = wordsOf(RESULT)[2] as OcrWord;
    const cx = word.box.x + word.box.w / 2;
    const cy = word.box.y + word.box.h / 2;
    layer.dispatchEvent(at(cx, cy, "pointerdown"));
    layer.dispatchEvent(at(cx, cy, "pointerup"));
    await sleep(10);
    ok("a click chooses the word under it", noteOf().includes("44812"), noteOf());
    ok("…and says how sure the engine was of it", noteOf().includes("95%"), noteOf());
    ok("…and marks it on the picture",
      boxesOf().filter((b) => b.classList.contains("ocr-picked")).length === 1);

    press("Copy");
    await sleep(20);
    ok("copy then takes the chosen word alone", clipboard === "44812", clipboard);

    layer.dispatchEvent(at(40, 30, "pointerdown"));
    layer.dispatchEvent(at(500, 80, "pointermove"));
    ok("a drag draws a marquee", $(".ocr-marquee")?.hidden === false);
    layer.dispatchEvent(at(500, 80, "pointerup"));
    await sleep(10);
    ok("…which is put away when the button comes up", $(".ocr-marquee")?.hidden === true);
    ok("…and chooses every word it touched", noteOf().includes("3 words"), noteOf());
    press("Copy");
    await sleep(20);
    ok("…in reading order", clipboard === "Invoice number 44812", clipboard);
  }

  // ── Stopping ──────────────────────────────────────────────────────────────
  {
    view.close();
    ok("closing puts the panel away", !view.isOpen);

    const patient = new OcrView({
      ...host,
      engine: { ...engine, read: () => new Promise<never>(() => undefined) },
    });
    await patient.open(SCAN);
    press("Read");
    await sleep(20);
    ok("a run in flight shows a progress bar", $(".ocr-progress")?.hidden === false);
    press("Stop");
    await sleep(20);
    ok("…and stopping reaches the engine", cancels === 1, String(cancels));
    ok("…and takes the bar away", $(".ocr-progress")?.hidden === true);
    patient.close();
  }

  // ── When it goes wrong ────────────────────────────────────────────────────
  {
    const broken = new OcrView({
      ...host,
      fileUrl: () => Promise.resolve("data:image/png;base64,notapicture"),
    });
    await broken.open(SCAN);
    await sleep(30);
    ok("a file that will not open says so rather than showing nothing",
      noteOf().includes("Cannot open"), noteOf());
    ok("…and does not offer to read it", btn("Read")?.disabled === true);
    broken.close();

    const angry = new OcrView({
      ...host,
      engine: { ...engine, read: () => Promise.reject(new Error("the worker died")) },
    });
    await angry.open(SCAN);
    press("Read");
    await sleep(30);
    ok("an engine that fails is reported in its own words",
      noteOf().includes("the worker died"), noteOf());
    ok("…and the panel is still usable afterwards", btn("Read")?.disabled === false);
    angry.close();

    const empty = new OcrView({
      ...host,
      engine: { ...engine, read: () => Promise.resolve({ page: blankPage(900, 1200) }) },
    });
    await empty.open(SCAN);
    press("Read");
    await sleep(30);
    ok("a page with nothing on it is not an error", noteOf().includes("Nothing readable"), noteOf());
    ok("…and says what to try instead", flagsOf().some((f) => f.includes("photo")), flagsOf().join("|"));
    press("Copy");
    await sleep(20);
    ok("…and copying it copies nothing rather than an empty file",
      noteOf().includes("nothing to copy"), noteOf());
    empty.close();
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

void viewChecks().then(() => {
  const line = `ocr: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  document.title = line;
  const head = document.createElement("h2");
  head.textContent = line;
  head.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(head);
});
