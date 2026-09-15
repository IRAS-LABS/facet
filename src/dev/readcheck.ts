/**
 * Checks read-aloud: what gets read, in what order, and the panel over it.
 *
 * The claim this feature has to defend is not "a voice comes out" — that is
 * the platform's job — but **the right words come out, in the right order, and
 * you can get back to the one you missed**. Those are four separable things
 * and each is checked on its own:
 *
 *   1. the text comes out of every route and ends at the same shape
 *   2. the furniture (running heads, page numbers, the bibliography) is
 *      dropped and the argument is not
 *   3. two columns are read down and not across, and a fix by hand survives
 *   4. the transport lands where it says it lands
 *
 * Most of it runs against a fake engine, deliberately. A check that waits for
 * real audio takes minutes and fails on a machine with no sound card, and none
 * of the four claims above is about audio. The real engines are exercised at
 * the end, and only when they are already present: downloading 88 MB is not
 * something a test suite may decide to do on somebody's behalf.
 *
 * Dev-only. Loaded by /dev/readcheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/readcheck.html
 */

import "../styles/base.css";
import "../styles/read.css";

import type { Box, OcrLine, OcrPage, OcrWord } from "@core/ocr/page";
import { CLEAN, clean, spoken, summary } from "@core/voice/cleanup";
import {
  fromBlocks,
  fromPages,
  fromText,
  readableText,
  spokenWords,
  steps,
  stepText,
  type ReadDoc,
} from "@core/voice/doc";
import {
  SILENT,
  type Engine,
  type SpeakCallbacks,
  type Speaking,
  type Utterance,
} from "@core/voice/engine";
import { apply, fingerprint, memoryOrder, OrderStore } from "@core/voice/order";
import { status as packStatus } from "@core/voice/pack";
import { byRule, normalise, sayNumber, tokenise } from "@core/voice/phonemes";
import { Player } from "@core/voice/player";
import { chunk, sentences } from "@core/voice/sentences";
import { grouped, kokoroInfo, kokoroVoices, type VoiceInfo } from "@core/voice/voices";
import { canRead, ReadView } from "@ui/read-view";

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

const skipped = (name: string, why: string): void => {
  console.log("skip", name, " ", why);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Building pages by hand ──────────────────────────────────────────────────

/** A word 8 px per character wide and 20 tall — near enough to a 12 pt face. */
const W = (text: string, x: number, y: number): OcrWord => ({
  text,
  box: { x, y, w: text.length * 8, h: 20 },
  confidence: 95,
});

const boxOf = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
};

/** A line of words laid left to right from `x`. */
function L(y: number, x: number, text: string): OcrLine {
  const words: OcrWord[] = [];
  let at = x;
  for (const t of text.split(" ")) {
    const word = W(t, at, y);
    words.push(word);
    at += word.box.w + 4;
  }
  return { words, box: boxOf(words.map((w) => w.box)), confidence: 95 };
}

const B = (lines: OcrLine[]): { lines: OcrLine[]; box: Box } => ({
  lines,
  box: boxOf(lines.map((l) => l.box)),
});

const P = (blocks: { lines: OcrLine[]; box: Box }[]): OcrPage => ({
  width: 1000,
  height: 1400,
  blocks,
  confidence: 95,
  angle: 0,
  language: "eng",
});

/**
 * Two columns with a wide gutter on a 1000 px page.
 *
 * The gutter is what the reading-order rule looks for, and this one is
 * comfortably over the 4% it needs. That is the point: this checks the rule
 * works, not that it works right at its own threshold.
 */
function columnPage(left: string[], right: string[]): OcrPage {
  return P([
    B(left.map((t, i) => L(240 + i * 30, 60, t))),
    B(right.map((t, i) => L(240 + i * 30, 560, t))),
  ]);
}

/**
 * A page of a journal: a running head, two columns, a page number at the foot.
 * The shape of nearly every paper anybody wants read to them.
 */
function paperPage(n: number, left: string, right: string): OcrPage {
  return P([
    B([L(40, 60, `Journal of Things ${2019 + n} Volume ${n}`)]),
    B([L(240, 60, left), L(270, 60, "carrying the same thought on.")]),
    B([L(240, 560, right), L(270, 560, "and finishing it off here.")]),
    B([L(1340, 480, String(n + 1))]),
  ]);
}

// ── 1. Getting the text out ─────────────────────────────────────────────────

function textChecks(): void {
  const doc = fromText("First paragraph here.\n\nSecond one follows.", "notes.txt");
  ok("a blank line starts a new block", doc.blocks.length === 2, String(doc.blocks.length));
  ok("whitespace is collapsed", doc.blocks[0]?.text === "First paragraph here.", doc.blocks[0]?.text);

  const md = fromText("# A heading\n\nBody text.", "notes.md");
  ok("a Markdown heading becomes a heading block", md.blocks[0]?.kind === "heading", md.blocks[0]?.kind);

  const empty = fromText("   \n\n  \n", "blank.txt");
  ok("a file of whitespace makes no blocks", empty.blocks.length === 0, String(empty.blocks.length));

  // Word offsets have to land exactly on the text, or the highlight sits one
  // word out for the whole document and nobody can say why.
  const one = fromText("Alpha beta gamma.", "w.txt").blocks[0];
  const sliced = one?.words.map((w) => one.text.slice(w.from, w.to)) ?? [];
  // Punctuation stays attached to the word it belongs to -- "gamma." and not
  // "gamma" -- so the highlight covers the stop rather than leaving it dark.
  ok("word offsets index their own block's text",
    sliced.join("|") === "Alpha|beta|gamma.", sliced.join("|"));
  ok("...and match the word text exactly",
    (one?.words ?? []).every((w, i) => sliced[i] === w.text),
    (one?.words ?? []).map((w) => w.text).join("|"));

  ok("sentences split on a full stop", sentences("One. Two. Three.").length === 3);
  ok("…but not on an abbreviation",
    sentences("Dr. Smith went home. He slept.").length === 2,
    String(sentences("Dr. Smith went home. He slept.").length));
  ok("…nor on a decimal",
    sentences("It was 3.5 metres long.").length === 1,
    String(sentences("It was 3.5 metres long.").length));

  const long = "word ".repeat(200).trim();
  const pieces = chunk(long, { from: 0, to: long.length }, 300);
  ok("a long sentence is cut into speakable pieces", pieces.length > 1, String(pieces.length));
  ok("…and the pieces cover all of it",
    pieces.map((p) => long.slice(p.from, p.to)).join(" ").replace(/\s+/g, " ").trim() === long);
  ok("…none of them longer than the limit", pieces.every((p) => p.to - p.from <= 300));

  ok("the reader offers every format it claims to",
    canRead("a.pdf") && canRead("b.PNG") && canRead("c.md") && canRead("d.htm") && !canRead("e.mp4"));
}

// ── 2. Reading the paper, not the furniture ─────────────────────────────────

function cleanupChecks(): void {
  // Four pages, because the running-head rule wants corroboration across pages
  // and refuses to guess from one.
  const pages = [0, 1, 2, 3].map((n) =>
    paperPage(n, `Page ${n + 1} opens the argument`, "The right hand column starts"),
  );
  const doc = clean(fromPages(pages, "paper.pdf"), CLEAN);

  const head = doc.blocks.find((b) => b.text.startsWith("Journal of Things"));
  ok("a running head repeated across pages is dropped", head?.skip === true, head?.why);
  ok("…and says why", Boolean(head?.why), head?.why);

  const number = doc.blocks.find((b) => /^\d+$/.test(b.text));
  ok("a bare page number is dropped", number?.skip === true, number?.why);

  const body = doc.blocks.find((b) => b.text.includes("opens the argument"));
  ok("the body text is not dropped", body?.skip === false, body?.why);

  ok("the panel can say in one line what it is leaving out",
    summary(doc).startsWith("Skipping"), summary(doc));
  ok("skipping furniture shortens what gets spoken",
    spokenWords(doc) < doc.blocks.reduce((n, b) => n + b.words.length, 0));

  // Switching a rule off must put its blocks back: the panel re-runs this on
  // the same document object every time a box is ticked.
  clean(doc, { ...CLEAN, headers: false, pageNumbers: false });
  ok("turning a rule off puts its blocks back",
    doc.blocks.find((b) => b.text.startsWith("Journal of Things"))?.skip === false);
  ok("…and nothing is left skipped", summary(doc) === "Reading everything", summary(doc));
  clean(doc, CLEAN);
  ok("…and turning it on again drops them again",
    doc.blocks.find((b) => b.text.startsWith("Journal of Things"))?.skip === true);

  const refs = clean(
    fromBlocks([
      { text: "The argument runs as follows and continues for some length." },
      { text: "References" },
      { text: "Smith, J. (2019). A paper about things. Journal of Things, 4, 1-20." },
      { text: "Jones, K. (2020). Another paper. Journal of Things, 5, 21-40." },
    ], "refs.pdf"),
    CLEAN,
  );
  ok("everything from the References heading on is dropped",
    refs.blocks.slice(1).every((b) => b.skip), refs.blocks.map((b) => String(b.skip)).join(","));
  ok("…but not the argument before it", refs.blocks[0]?.skip === false, refs.blocks[0]?.why);

  const caps = fromBlocks([
    { text: "Figure 3: the thing, measured over time." },
    { text: "Ordinary body text that goes on for a while and says something." },
  ], "cap.pdf");
  ok("a caption is kept by default",
    clean(caps, CLEAN).blocks[0]?.skip === false, caps.blocks[0]?.why);
  ok("…and skipped when asked",
    clean(caps, { ...CLEAN, captions: true }).blocks[0]?.skip === true, caps.blocks[0]?.why);

  const eq = clean(fromBlocks([{ text: "x = \\sum_{i=0}^{n} a_i b_i + \\epsilon" }], "eq.pdf"), CLEAN);
  ok("a displayed formula is announced rather than read",
    spoken(eq.blocks[0]!, CLEAN) === "equation", spoken(eq.blocks[0]!, CLEAN));
  ok("…and is read out when the switch is off",
    spoken(eq.blocks[0]!, { ...CLEAN, equations: false }).includes("sum"));

  // A manuscript's line-number gutter: a narrow strip of bare integers pinned
  // to the left edge, which is how a journal sets them and how OCR reads them.
  const lines = clean(
    fromBlocks([
      { text: "12 13 14 15 16", box: { x: 20, y: 300, w: 24, h: 150 } },
      { text: "The manuscript text under review, set at a readable width." },
    ], "ms.pdf", 1, [{ width: 1000, height: 1400 }]),
    CLEAN,
  );
  ok("a margin line-number gutter is dropped", lines.blocks[0]?.skip === true, lines.blocks[0]?.why);
  ok("…and the manuscript beside it is not", lines.blocks[1]?.skip === false, lines.blocks[1]?.why);
}

// ── 3. Reading order ────────────────────────────────────────────────────────

function orderChecks(): void {
  const page = columnPage(
    ["Left column first line", "Left column second line"],
    ["Right column first line", "Right column second line"],
  );

  const doc = fromPages([page], "two.pdf");
  const text = readableText(doc);
  ok("two columns are read down, not across",
    text.indexOf("Left column second") < text.indexOf("Right column first"),
    text.replace(/\n+/g, " / "));

  const store = new OrderStore(memoryOrder());
  const ids = doc.blocks.map((b) => b.id);
  const reversed = [...ids].reverse();
  store.put(doc, { order: reversed });

  const again = fromPages([page], "two.pdf");
  const fixed = apply(again, store.get(again)).blocks.map((b) => b.id).join(",");
  ok("a hand-made order is remembered for that document", fixed === reversed.join(","), fixed);

  const changed: ReadDoc = { ...again, blocks: again.blocks.slice(1) };
  ok("…and dropped when the document has changed underneath",
    store.get(changed) === null, fingerprint(changed));

  store.put(doc, { off: [ids[1] ?? ""] });
  const excluded = apply(fromPages([page], "two.pdf"), store.get(doc));
  ok("a block excluded by hand stays excluded", excluded.blocks[1]?.skip === true);
  ok("…and is marked as the user's own decision", excluded.blocks[1]?.byHand === true);

  // A rule must never overrule a correction: the whole reason `byHand` exists.
  ok("a cleanup rule does not overrule a hand correction",
    clean(excluded, CLEAN).blocks[1]?.skip === true);

  store.forget(doc);
  ok("resetting the order forgets it", store.get(fromPages([page], "two.pdf")) === null);

  // A saved order that predates a new paragraph must not swallow it.
  const grown = fromBlocks([{ text: "One." }, { text: "Two." }, { text: "Three." }], "g.txt");
  const out = apply(grown, {
    order: [grown.blocks[2]!.id, grown.blocks[0]!.id],
    print: fingerprint(grown),
    at: 0,
  });
  ok("a paragraph missing from a saved order is still read",
    out.blocks.length === 3 && out.blocks.some((b) => b.text === "Two."),
    out.blocks.map((b) => b.text).join("|"));
}

// ── 4. The transport ────────────────────────────────────────────────────────

/** An engine that remembers what it was asked to say and never makes a sound. */
class FakeEngine implements Engine {
  readonly id = "system" as const;
  readonly label = "Fake";
  said: string[] = [];
  /** Hold each utterance open instead of ending it, so steps can be counted. */
  hold = false;
  private open: (() => void) | null = null;

  ready(): Promise<boolean> {
    return Promise.resolve(true);
  }

  voices(): Promise<VoiceInfo[]> {
    return Promise.resolve([
      {
        id: "one",
        name: "One",
        detail: "Test",
        lang: "en-US",
        gender: "female",
        engine: "system",
        offline: true,
      },
    ]);
  }

  speak(u: Utterance, cb: SpeakCallbacks): Promise<Speaking> {
    this.said.push(u.text);
    if (this.hold) {
      this.open = () => cb.onEnd?.();
      return Promise.resolve({
        stop: () => {
          this.open = null;
        },
        pause: () => true,
        resume: () => true,
      });
    }
    // Asynchronously, so a player that recursed straight into the next sentence
    // inside `speak` would blow the stack here rather than on a 400-page book
    // in front of the user.
    setTimeout(() => cb.onEnd?.(), 0);
    return Promise.resolve(SILENT);
  }

  /** End the utterance being held. */
  finish(): void {
    const fn = this.open;
    this.open = null;
    fn?.();
  }
}

async function playerChecks(): Promise<void> {
  const doc = clean(fromBlocks([
    { text: "One. Two. Three." },
    { text: "Four. Five." },
    { text: "Six.", page: 1 },
  ], "p.txt", 2), CLEAN);

  ok("the play list is every sentence of every readable block",
    steps(doc).length === 6, String(steps(doc).length));
  ok("a step knows its own text",
    stepText(doc, steps(doc)[1]!) === "Two.", stepText(doc, steps(doc)[1]!));

  const engine = new FakeEngine();
  engine.hold = true;
  const player = new Player(engine);
  player.load(doc);

  await player.play();
  ok("play starts at the first sentence", engine.said[0] === "One.", engine.said[0]);
  ok("…and says it is playing", player.position().state === "playing", player.position().state);

  engine.finish();
  await sleep(0);
  ok("finishing a sentence moves to the next", engine.said[1] === "Two.", engine.said[1]);

  player.sentence(1);
  await sleep(0);
  ok("skip forward moves one sentence", engine.said.at(-1) === "Three.", engine.said.at(-1));

  player.paragraph(1);
  await sleep(0);
  ok("skip forward by paragraph lands on the next block's first sentence",
    engine.said.at(-1) === "Four.", engine.said.at(-1));

  player.page(1);
  await sleep(0);
  ok("skip by page lands on the next page", player.position().page === 1, String(player.position().page));

  player.seek(0);
  await sleep(0);
  ok("the scrubber lands where it is dragged", player.position().step === 0, String(player.position().step));
  ok("…and the highlight follows it", player.position().block === 0, String(player.position().block));

  player.startAtBlock(1);
  await sleep(0);
  ok("tapping a paragraph starts there", engine.said.at(-1) === "Four.", engine.said.at(-1));

  player.startAtWord(0, 2);
  await sleep(0);
  ok("tapping a word starts at its own sentence", engine.said.at(-1) === "Three.", engine.said.at(-1));

  player.pause();
  ok("pause says paused", player.position().state === "paused", player.position().state);
  player.toggle();
  await sleep(0);
  ok("…and toggling resumes", player.position().state === "playing", player.position().state);

  // Changing speed must not restart the sentence. Losing your place because you
  // nudged a slider is exactly the complaint this feature exists to fix.
  const before = engine.said.length;
  player.set({ rate: 1.5 });
  await sleep(0);
  ok("changing speed keeps the place",
    engine.said.length - before <= 1, String(engine.said.length - before));
  ok("…and the new speed sticks", player.opts.rate === 1.5, String(player.opts.rate));

  player.stop();
  ok("stop goes back to idle", player.position().state === "idle", player.position().state);
  player.dispose();

  // The end of a document, with repeat off and then on.
  const short = clean(fromBlocks([{ text: "Only." }], "s.txt"), CLEAN);

  const e2 = new FakeEngine();
  const p2 = new Player(e2);
  p2.load(short);
  await p2.play();
  await sleep(20);
  ok("the end of the document stops", p2.position().state === "idle", p2.position().state);
  p2.dispose();

  const e3 = new FakeEngine();
  e3.hold = true;
  const p3 = new Player(e3);
  p3.set({ repeat: true });
  p3.load(short);
  await p3.play();
  e3.finish();
  await sleep(0);
  ok("…unless repeat is on", e3.said.length === 2 && e3.said[1] === "Only.", e3.said.join("|"));
  p3.stop();
  p3.dispose();

  // A document with nothing readable left in it is not an error.
  const all = fromBlocks([{ text: "Nothing to see." }], "n.txt");
  all.blocks[0]!.skip = true;
  const p4 = new Player(new FakeEngine());
  p4.load(all);
  await p4.play();
  ok("a document with nothing to read does not throw",
    p4.position().steps === 0, String(p4.position().steps));
  p4.dispose();
}

// ── 5. Pronunciation ────────────────────────────────────────────────────────

function voiceChecks(): void {
  ok("numbers are said, not spelled",
    sayNumber(1999).includes("nineteen") || sayNumber(1999).includes("thousand"), sayNumber(1999));
  ok("…including zero", sayNumber(0) === "zero", sayNumber(0));
  ok("…and negatives", sayNumber(-5).startsWith("minus"), sayNumber(-5));

  const said = normalise("Dr. Smith spent $4.50 on 3 things, e.g. bread.");
  ok("abbreviations are expanded before speaking", !said.includes("e.g."), said);
  ok("…and money is read as money", /dollar/i.test(said), said);
  ok("…and the expansion is what a person would say",
    said.includes("for example") && said.startsWith("Doctor"), said);
  ok("…without a stop, where papers write it that way",
    normalise("see Fig 3 and Smith et al 2019").includes("figure")
      && normalise("see Fig 3 and Smith et al 2019").includes("and others"),
    normalise("see Fig 3 and Smith et al 2019"));

  // The reason the stopless form is restricted. "Ed" and "Tab" are names and
  // words, and reading somebody's name as "editor" is the worse error.
  const names = normalise("Ed and Tab met Ch in Sec");
  ok("…but a bare word that happens to be an abbreviation is left alone",
    names === "Ed and Tab met Ch in Sec", names);
  ok("…and a longer word starting with one is not eaten",
    normalise("the second edition") === "the second edition",
    normalise("the second edition"));

  ok("a word with no dictionary entry still gets sounds", byRule("zzyzx").length > 0, byRule("zzyzx"));
  const tokens = tokenise("həˈloʊ");
  ok("phonemes tokenise to something the model can take",
    tokens.length > 0 && tokens.every((n) => Number.isInteger(n) && n >= 0), tokens.join(","));

  ok("all 54 voices decode into something a person can pick from",
    kokoroVoices().length === 54, String(kokoroVoices().length));
  ok("…with a readable name", kokoroInfo("af_heart").name === "Heart", kokoroInfo("af_heart").name);
  ok("…and a language", kokoroInfo("jf_alpha").detail.includes("Japanese"), kokoroInfo("jf_alpha").detail);
  ok("…grouped by language for the picker",
    grouped(kokoroVoices()).length > 1, String(grouped(kokoroVoices()).length));
}

// ── 6. The panel ────────────────────────────────────────────────────────────

async function viewChecks(): Promise<void> {
  const body = [
    "The opening paragraph of a paper about something, long enough to have several sentences. It carries on for a bit. And then it stops.",
    "A second paragraph which continues the argument in the usual way.",
    "References",
    "Smith, J. (2019). A paper about things. Journal of Things, 4, 1-20.",
  ].join("\n\n");

  // One panel, one host whose answer is swapped between cases. Two panels would
  // both be in the document at once and every query below would hit the first.
  //
  // The paths carry a timestamp because the reader saves corrections per
  // document: a check that inherited last run's fixes would be checking
  // something other than what it says it is.
  const stamp = Date.now();
  let give: () => Promise<string> = () => Promise.reject(new Error("nothing set up"));
  const view = new ReadView({ fileUrl: () => give() });

  const q = <T extends HTMLElement>(sel: string): T | null => document.querySelector<T>(`.read ${sel}`);
  const noteOf = (): string => q(".read-note")?.textContent ?? "";
  const blocksOf = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".read .read-block")];
  const btnOf = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>(".read button")].find(
      (b) => b.textContent?.trim() === label || b.title.startsWith(label),
    );

  const text = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  give = () => Promise.resolve(text);
  await view.open(`/dev/paper-${stamp}.txt`);

  ok("the panel opens", view.isOpen);
  ok("…on the file it was given", view.openPath === `/dev/paper-${stamp}.txt`, String(view.openPath));
  ok("…and says how long it is", /words/.test(noteOf()), noteOf());
  ok("…with a paragraph per paragraph", blocksOf().length === 4, String(blocksOf().length));
  ok("…and every word as its own element",
    blocksOf()[0]!.querySelectorAll(".read-word").length > 10,
    String(blocksOf()[0]!.querySelectorAll(".read-word").length));

  ok("the bibliography is struck through rather than hidden",
    blocksOf()[3]?.classList.contains("read-off") === true, blocksOf()[3]?.className);
  ok("…and the panel says so where you can see it", q(".read-skipped")?.hidden === false);

  // Tapping something being skipped puts it back. It is the only sensible
  // reading of that tap, and it is how a rule that ate a real paragraph gets
  // undone by the one person who can tell that it did.
  blocksOf()[3]!.click();
  await sleep(10);
  ok("tapping a skipped paragraph puts it back",
    blocksOf()[3]?.classList.contains("read-off") === false, blocksOf()[3]?.className);

  // The order overlay.
  btnOf("Order")?.click();
  await sleep(10);
  ok("the order overlay numbers the paragraphs",
    blocksOf()[0]?.querySelector(".read-number")?.textContent === "1",
    blocksOf()[0]?.querySelector(".read-number")?.textContent ?? "");
  ok("…and makes them draggable", blocksOf()[0]?.draggable === true);
  btnOf("Order")?.click();
  await sleep(10);
  ok("…and turning it off takes the numbers away", !blocksOf()[0]?.querySelector(".read-number"));

  // Speed.
  const speed = q<HTMLSelectElement>(".read-speedsel");
  // Every 0.05 from a quarter speed to five times, which is what the picker
  // promises and what a saved preference has to be able to land on.
  ok("the speed picker offers the whole grid", speed?.options.length === 96, String(speed?.options.length));
  ok("…including the ones worth having",
    ["0.5", "0.75", "1", "1.05", "1.25", "1.5", "2"].every((v) => !!speed?.querySelector(`option[value="${v}"]`)));
  // Relative, not absolute: the speed is a saved preference, so where it
  // starts depends on what the machine was last left on. An absolute test here
  // passes on a clean profile and fails on a used one, which is the worst kind
  // of check to own.
  const before = Number(speed?.value);
  const want = before === 1.5 ? "1.25" : "1.5";
  if (speed) {
    speed.value = want;
    speed.dispatchEvent(new Event("change"));
  }
  await sleep(10);
  ok("picking a speed sets it", speed?.value === want, `${before} -> ${speed?.value ?? ""}`);
  if (speed) {
    speed.value = String(before);
    speed.dispatchEvent(new Event("change"));
  }
  await sleep(10);
  ok("…and putting it back sticks", Number(speed?.value) === before, speed?.value ?? "");

  // The scrubber. A control that moves the document and shows nothing for it
  // is the bug this checks against: the track paints its filled part from a
  // custom property, and on a phone that fill is the only feedback there is.
  const scrub = q<HTMLInputElement>(".read-scrub");
  if (scrub) {
    // Focused, because that is what a finger on the track does and because
    // `draw()` deliberately refuses to move a scrubber somebody is holding --
    // without the focus the paint is immediately corrected to the real
    // position and this tests the wrong half of the code.
    scrub.focus();
    scrub.value = "250";
    scrub.dispatchEvent(new Event("input"));
  }
  await sleep(10);
  ok("dragging the scrubber paints the track behind it",
    scrub?.style.getPropertyValue("--fct-scrub") === "25%",
    scrub?.style.getPropertyValue("--fct-scrub") ?? "");
  if (scrub) {
    scrub.value = "0";
    scrub.dispatchEvent(new Event("input"));
  }
  await sleep(10);
  ok("…and back to the start empties it",
    scrub?.style.getPropertyValue("--fct-scrub") === "0%",
    scrub?.style.getPropertyValue("--fct-scrub") ?? "");
  scrub?.blur();

  // Zoom. The reader is the one surface in the app whose whole job is reading
  // something, and until now it was the one surface with no way to make the
  // words bigger -- the app turns the browser's own zoom off everywhere so the
  // canvas can own gestures, and nothing gave it back here.
  //
  // The pane is found from a block rather than from the document, because the
  // harness has built more than one reader by this point and the first
  // `.read-page` in the document is not necessarily the one with words in it.
  const block = q<HTMLElement>(".read-block");
  const pane = block?.closest<HTMLElement>(".read-page") ?? null;
  const touch = pane ? getComputedStyle(pane).touchAction : "";
  // `manipulation` is the shorthand the browser normalises `pan-x pan-y
  // pinch-zoom` to; both spellings mean the second finger reaches the page.
  ok("the reading pane lets a second finger through",
    touch === "manipulation" || touch.includes("pinch-zoom"), touch);

  const size = (): number => (block ? parseFloat(getComputedStyle(block).fontSize) : 0);
  const plain = size();
  pane?.style.setProperty("--zoom", "2");
  ok("zooming in grows the type rather than stretching it",
    size() > plain * 1.8, `${plain} -> ${size()}`);
  ok("…and the column still wraps inside the pane",
    (block?.getBoundingClientRect().width ?? 0) <= (pane?.clientWidth ?? 0) + 1);
  pane?.style.removeProperty("--zoom");
  ok("…and letting go puts it back", Math.abs(size() - plain) < 0.5, String(size()));

  // Selecting and copying. The body turns selection off app-wide so a drag on
  // the grid is a lasso; the one pane made of words has to opt back in or a
  // long press on a paragraph does nothing at all.
  const sel = pane ? getComputedStyle(pane).userSelect : "";
  ok("the reading pane can be selected and copied", sel === "text" || sel === "auto", sel);

  // The second row of controls is behind a button and starts closed.
  ok("the extra controls start closed", q(".read-extra")?.hidden === true);
  btnOf("More…")?.click();
  await sleep(10);
  ok("…and open", q(".read-extra")?.hidden === false);
  ok("…with a switch for every skip rule",
    document.querySelectorAll(".read-skips .read-check").length === 8,
    String(document.querySelectorAll(".read-skips .read-check").length));

  // Reading a selection, with no file behind it at all (item 6).
  view.read("A sentence somebody selected by hand.", "Selected text");
  await sleep(10);
  ok("a selection can be read with no file behind it",
    blocksOf().length === 1, String(blocksOf().length));
  ok("…and is named as what it is", view.openPath === "Selected text", String(view.openPath));

  view.close();
  ok("closing closes", !view.isOpen);
  ok("…and empties the page", document.querySelectorAll(".read .read-block").length === 0);

  // A file that will not open is reported in words, not swallowed.
  give = () => Promise.reject(new Error("no such file"));
  await view.open(`/dev/nope-${stamp}.txt`);
  ok("a file that will not open says so in its own words", noteOf().includes("no such file"), noteOf());

  // A picture with nothing recognised in it yet: an offer, not an error.
  const png = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  give = () => Promise.resolve(png);
  await view.open(`/dev/scan-${stamp}.png`);
  ok("a picture offers recognition rather than failing",
    noteOf().includes("Recognise") && Boolean(btnOf("Recognise")), noteOf());

  view.close();
  view.dispose();
  URL.revokeObjectURL(text);
  URL.revokeObjectURL(png);
}

// ── 7. The real engines, when they are already here ─────────────────────────

/**
 * Item 39 asks for a check that runs the real thing. Two real engines exist
 * and they cost very different amounts, so they are treated differently.
 *
 * The system voices are already on the machine and cost nothing, so one short
 * utterance is actually spoken, at zero volume.
 *
 * Kokoro is an 88 MB download. A test suite may not decide to make that
 * download happen, so this runs only when the pack is already installed and
 * prints a skip line otherwise. That is the honest arrangement, and it means a
 * green run on a clean machine has *not* proven Kokoro speaks — the skip line
 * says so rather than letting the total imply otherwise.
 */
async function engineChecks(): Promise<void> {
  const voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
    const have = window.speechSynthesis?.getVoices() ?? [];
    if (have.length > 0) {
      resolve(have);
      return;
    }
    const timer = setTimeout(() => resolve(window.speechSynthesis?.getVoices() ?? []), 600);
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => {
        clearTimeout(timer);
        resolve(window.speechSynthesis.getVoices());
      };
    }
  });

  if (voices.length === 0) {
    skipped("the system voices speak", "no system voices on this machine");
  } else {
    const { SystemEngine } = await import("@core/voice/system");
    const engine = new SystemEngine();
    const listed = await engine.voices();
    ok("the system voices are listed", listed.length > 0, String(listed.length));

    const spoke = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      const done = (v: boolean): void => {
        clearTimeout(timer);
        resolve(v);
      };
      void engine.speak(
        { text: "Test.", voice: listed[0]?.id ?? "", rate: 2, pitch: 1, volume: 0 },
        { onEnd: () => done(true), onError: () => done(false) },
      );
    });
    ok("…and a real utterance runs to the end", spoke);
    engine.dispose?.();
  }

  const state = await packStatus();
  if (!state.installed) {
    skipped("the natural voices speak", "the voice pack is not downloaded on this machine");
    return;
  }

  const { KokoroEngine } = await import("@core/voice/kokoro");
  const kokoro = new KokoroEngine();
  try {
    ok("Kokoro reports itself ready when the pack is present", await kokoro.ready());
    const voice = state.voices[0] ?? "af_heart";
    const spoke = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 60_000);
      const done = (v: boolean): void => {
        clearTimeout(timer);
        resolve(v);
      };
      void kokoro.speak(
        { text: "Test.", voice, rate: 1, pitch: 1, volume: 0 },
        { onEnd: () => done(true), onError: () => done(false) },
      );
    });
    ok(`…and a real Kokoro utterance (${voice}) runs to the end`, spoke);
  } finally {
    kokoro.dispose?.();
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  textChecks();
  cleanupChecks();
  orderChecks();
  await playerChecks();
  voiceChecks();
  await viewChecks();
  await engineChecks();
}

void run()
  .catch((e: unknown) => {
    fail++;
    console.log("FAIL", "the checks themselves threw", " ", e instanceof Error ? e.message : String(e));
  })
  .then(() => {
    const line = `read: ${pass} passed, ${fail} failed`;
    console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
    document.title = line;
    const head = document.createElement("h2");
    head.textContent = line;
    head.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:999;margin:0;padding:8px 12px;background:#111;"
      + `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
    document.body.prepend(head);
  });
