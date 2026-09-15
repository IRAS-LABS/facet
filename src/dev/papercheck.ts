/**
 * Item 37 — read-aloud against real research papers.
 *
 * Everything else in `readcheck` is built from pages this file made up, which
 * is what makes those checks stable and what makes them insufficient. A page
 * built by hand has the gutter where the code expects it and the running head
 * where the rule looks for it. A real paper does not care what the code
 * expects.
 *
 * So this runs two open-access arXiv papers end to end through exactly the
 * pipeline the reader uses -- `build` then `clean` then `steps` -- and checks
 * the four things the feature actually promises:
 *
 *   1. The text comes out at all, from the PDF's own text layer, with no OCR.
 *   2. The running head and the page number are dropped, on every page.
 *   3. A two-column page is read down the left column and then down the
 *      right, not across the gutter line by line.
 *   4. The bibliography is not read out.
 *
 * It also prints the first stretch of what would actually be spoken, in order,
 * because the numbers above can all pass while the result is still nonsense
 * and the only way to know that is to read it.
 *
 * The PDFs live in `dev/papers/` and are not in the repository -- they are
 * somebody else's work and there is no reason to vendor them. Fetch them with:
 *
 *   curl -sL -o dev/papers/resnet.pdf    https://arxiv.org/pdf/1512.03385v1
 *   curl -sL -o dev/papers/attention.pdf https://arxiv.org/pdf/1706.03762v7
 *
 * If they are missing, every check here is reported as skipped rather than
 * passed, so a green total on a machine without them means nothing and says so.
 */

import { build } from "@core/voice/source";
import { CLEAN, clean, summary } from "@core/voice/cleanup";
import { steps, stepText, spokenWords, type ReadBlock, type ReadDoc } from "@core/voice/doc";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.log("FAIL", name, " ", detail);
  }
}

function skipped(name: string, why: string): void {
  console.log("skip", name, " ", why);
}

function say(line: string): void {
  const pre = document.createElement("pre");
  pre.textContent = line;
  pre.style.cssText = "margin:0;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap";
  document.body.appendChild(pre);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Blocks on one page, in the order the reader would speak them. */
const onPage = (doc: ReadDoc, page: number): ReadBlock[] =>
  doc.blocks.filter((b) => b.page === page);

/** The horizontal centre of a block as a fraction of the page width. */
function centre(doc: ReadDoc, b: ReadBlock): number | null {
  const size = doc.sizes[b.page];
  if (!b.box || !size) return null;
  return (b.box.x + b.box.w / 2) / size.width;
}

/**
 * Is this page laid out in two columns?
 *
 * Judged from the blocks themselves rather than from anything the PDF says,
 * because the PDF says nothing: there are blocks well left of the middle and
 * blocks well right of it. A title page has a banner across the top and still
 * counts, which is why blocks straddling the middle are allowed as long as
 * they are a minority.
 */
function twoColumn(doc: ReadDoc, page: number): boolean {
  const cs = onPage(doc, page)
    .map((b) => centre(doc, b))
    .filter((c): c is number => c !== null);
  if (cs.length < 8) return false;
  const left = cs.filter((c) => c < 0.45).length;
  const right = cs.filter((c) => c > 0.55).length;
  const across = cs.length - left - right;
  return left >= 3 && right >= 3 && across <= cs.length * 0.35;
}

/**
 * Does each column run down the page?
 *
 * Counting how often the reader crosses the gutter sounds like the test and is
 * not: a title band, a full-width figure and a footnote rule all legitimately
 * send it back across, and a page with three of them is not broken. What is
 * always true, band or no band, is that the blocks on one side come out in the
 * order they sit on the page. Reading line by line across the gutter -- the
 * failure this whole feature exists to avoid -- breaks that immediately,
 * because the left-hand pieces then arrive interleaved and out of order.
 *
 * Only paragraph-sized blocks are looked at. The labels inside a network
 * diagram sit in columns too, and the reader does group them by column, but a
 * diagram has no true reading order to be right or wrong about and demanding
 * one would be inventing a requirement. Blocks spanning the gutter are ignored
 * rather than counted either way.
 */
const PARAGRAPH = 80;

function columnsGoDown(doc: ReadDoc, page: number): { good: boolean; why: string } {
  const size = doc.sizes[page];
  if (!size) return { good: true, why: "" };

  for (const [name, side] of [["left", "L"], ["right", "R"]] as const) {
    let last = -Infinity;
    for (const b of onPage(doc, page)) {
      const c = centre(doc, b);
      if (c === null || !b.box) continue;
      if ((c < 0.45 ? "L" : c > 0.55 ? "R" : "-") !== side) continue;
      if (b.text.length < PARAGRAPH) continue;
      // A hair of slack: an equation set off from the paragraph above it can
      // share a top edge with it once the box is rounded.
      if (b.box.y < last - size.height * 0.01) {
        return { good: false, why: `${name} column goes back up at "${b.text.slice(0, 40)}"` };
      }
      last = b.box.y;
    }
  }
  return { good: true, why: "" };
}

/** The spoken text of the whole document, run together, spaces normalised. */
const spoken = (doc: ReadDoc): string =>
  steps(doc).map((s) => stepText(doc, s)).join(" ").replace(/\s+/g, " ");

// ── One paper ───────────────────────────────────────────────────────────────

/**
 * Sentences that must come out of each paper word for word.
 *
 * This is the only honest proof that the reading order is right. Every
 * measurement above can pass on a document that is quietly nonsense; a
 * sentence either survives the trip intact or it does not. Each of these was
 * chosen for what it crosses:
 *
 *   - ResNet's first is the abstract, which sits beside a figure whose axis
 *     labels used to be spliced into it mid-sentence.
 *   - ResNet's second runs off the bottom of the left-hand column of page 3
 *     and continues at the top of the right-hand one.
 *   - Attention's second is the sentence after it, which is here because of
 *     four words in the middle of it. "English-to-German" is broken across a
 *     line at its own first hyphen, and the rule that heals a word split into
 *     syllables used to eat that hyphen and say "Englishto-German". The whole
 *     sentence is quoted rather than the compound alone: the compound also
 *     appears, unbroken, in the conclusion, so a shorter phrase passed this
 *     check while the abstract was still wrong.
 */
const PHRASES: Record<string, string[]> = {
  ResNet: [
    "We present a residual learning framework to ease the training of networks "
      + "that are substantially deeper than those used previously.",
    "denotes ReLU [29] and the biases are omitted for simplifying notations",
  ],
  Attention: [
    "We propose a new simple network architecture, the Transformer, based solely "
      + "on attention mechanisms, dispensing with recurrence and convolutions entirely.",
    "Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation "
      + "task, improving over the existing best results, including ensembles, by "
      + "over 2 BLEU.",
  ],
};


async function paper(file: string, name: string): Promise<void> {
  let bytes: ArrayBuffer;
  try {
    const res = await fetch(`/dev/papers/${file}`);
    if (!res.ok) throw new Error(String(res.status));
    bytes = await res.arrayBuffer();
  } catch {
    skipped(`${name}: reads a real paper`, `dev/papers/${file} is not on this machine`);
    return;
  }

  const t0 = performance.now();
  const doc = await build(file, bytes, { ocr: false });
  const took = Math.round(performance.now() - t0);

  say(`\n-- ${name}: ${doc.pages} pages, ${doc.blocks.length} blocks, ${took} ms --`);

  const perPage = Array.from({ length: doc.pages }, (_, i) => onPage(doc, i).length);
  ok(`${name}: the text layer alone is enough`, (doc.scanned?.length ?? 0) === 0,
    `OCR would be needed on pages ${(doc.scanned ?? []).join(", ")}`);
  ok(`${name}: every page produced text`, perPage.every((n) => n > 0), perPage.join(","));

  const before = spokenWords(doc);
  clean(doc, CLEAN);
  const after = spokenWords(doc);

  say(`   ${summary(doc)} -- ${before - after} of ${before} words dropped`);

  ok(`${name}: the furniture is dropped`, after < before, `${before} -> ${after}`);
  ok(`${name}: ...but most of the paper survives it`, after > before * 0.6,
    `kept ${Math.round((after / before) * 100)}%`);

  const whys = new Set(doc.blocks.filter((b) => b.skip).map((b) => b.why ?? ""));
  ok(`${name}: page numbers are recognised as page numbers`,
    [...whys].some((w) => /page number/i.test(w)), [...whys].join(" | "));

  const refs = doc.blocks.filter((b) => b.kind === "reference");
  ok(`${name}: the bibliography is found and skipped`,
    refs.length > 5 && refs.every((b) => b.skip), `${refs.length} reference blocks`);

  const twos = Array.from({ length: doc.pages }, (_, i) => i).filter((i) => twoColumn(doc, i));
  ok(`${name}: the paper really is two-column`, twos.length >= 2, `${twos.length} such pages`);

  const bad = twos.map((i) => ({ i, ...columnsGoDown(doc, i) })).filter((r) => !r.good);
  ok(`${name}: each column reads down its own page`, bad.length === 0,
    bad.map((b) => `p${b.i + 1} ${b.why}`).join("  "));

  // Per block, not across the joined document: two blocks meeting, the first
  // ending in a dash, is not a broken hyphen and never was.
  const limp = doc.blocks.filter((b) => !b.skip && /\w- \w/.test(b.text));
  ok(`${name}: hyphens at line ends are healed`, limp.length === 0,
    limp.slice(0, 3).map((b) => (/.{0,20}\w- \w.{0,20}/.exec(b.text) ?? [""])[0]).join(" | "));

  const said = spoken(doc);
  for (const phrase of PHRASES[name] ?? []) {
    ok(`${name}: "${phrase.slice(0, 44)}${phrase.length > 44 ? "..." : ""}"`,
      said.includes(phrase), "not found in what would be spoken");
  }

  const list = steps(doc);
  say(`   ${list.length} things to say. The first twelve:`);
  for (const s of list.slice(0, 12)) say(`     - ${stepText(doc, s)}`);

  const first = list[0] ? stepText(doc, list[0]) : "";
  ok(`${name}: it starts on the title, not on a page number`,
    first.length > 12 && !/^\d+$/.test(first.trim()), first);
}

// ── Report ──────────────────────────────────────────────────────────────────

(async () => {
  await paper("resnet.pdf", "ResNet");
  await paper("attention.pdf", "Attention");
})()
  .catch((e: unknown) => {
    fail++;
    console.log("FAIL", "the paper checks ran at all", " ", String(e));
  })
  .finally(() => {
    const line = `paper: ${pass} passed, ${fail} failed`;
    document.title = line;
    console.log(`%c${line}`, fail ? "color:#ff6b6b" : "color:#4ade80");
    const h = document.createElement("h2");
    h.textContent = line;
    h.style.cssText = `font:600 16px system-ui;color:${fail ? "#ff6b6b" : "#4ade80"}`;
    document.body.appendChild(h);
  });
