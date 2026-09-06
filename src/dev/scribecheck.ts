/**
 * Checks the transcript model — windowing, stitching, speakers, prose (item 30).
 *
 * No model is loaded here and none needs to be. The claims worth defending
 * about transcription are not "does Whisper hear words" — it does, and if it
 * mishears one there is nothing this file can do about it. They are the claims
 * about the seams, and every one of them is arithmetic:
 *
 *   * every second of the recording is covered by some window, and
 *   * every second is *owned* by exactly one window, so the stitched transcript
 *     neither drops a word at a boundary nor says it twice, and
 *   * a sentence that lands on a handover is attributed by who actually said
 *     it, not by who was talking longest.
 *
 * The third is the one that matters most, because its failure mode is the only
 * one a reader cannot detect: a missing word looks like a missing word, but a
 * correct sentence under the wrong name reads as a quote, and it is wrong.
 *
 * The stand-in for the model is a plain function over intervals — `heard()`
 * below returns whatever "words" fall inside a window. That makes the whole
 * pipeline deterministic, so a stitch that loses a word fails here rather than
 * on somebody's meeting six months from now.
 *
 * Dev-only. Loaded by /scribecheck.html, which is not a build input.
 *
 *   http://localhost:8183/scribecheck.html
 */

import "../styles/base.css";
import "../styles/transcribe.css";

import {
  assignSpeakers,
  clockOf,
  clusterSpeakers,
  mergeTurns,
  mergeWindows,
  planWindows,
  speechRegions,
  transcriptText,
  type LocalTurns,
  type Segment,
  type Turn,
  type Voiced,
  type Window,
  type WindowResult,
} from "@core/speech/transcript";
import {
  TranscribeView,
  type TranscribeEngine,
  type TranscribeHost,
} from "@ui/transcribe-view";

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

// ── A recording, as numbers ─────────────────────────────────────────────────

/**
 * The thing being transcribed: one word per second, each named for the second
 * it was said in. A transcript of it is therefore trivially checkable — the
 * right answer for a 90-second recording is w0 … w89, in order, once each.
 */
const WORDS = Array.from({ length: 90 }, (_, i) => ({
  start: i,
  end: i + 0.9,
  text: `w${i}`,
}));

/**
 * The stand-in model. Returns the words that fall inside a window, in that
 * window's own time base — which is the convention `mergeWindows` expects and
 * the one real ASR output actually uses.
 *
 * A word is heard if its middle is inside the window. That is deliberately not
 * "if it overlaps": a word cut in half by the edge of a window is heard by a
 * real model as a fragment or not at all, and pretending otherwise would test
 * a stitcher against an input it will never see.
 */
function heard(w: Window): WindowResult {
  const segments: Segment[] = WORDS.filter((word) => {
    const centre = (word.start + word.end) / 2;
    return centre >= w.start && centre < w.end;
  }).map((word) => ({
    start: word.start - w.start,
    end: word.end - w.start,
    text: word.text,
    words: [{ start: word.start - w.start, end: word.end - w.start, text: word.text }],
    speaker: null,
  }));
  return { window: w, segments };
}

const said = (segs: readonly Segment[]): string[] => segs.map((s) => s.text.trim());

function pureChecks(): void {
  // ── Planning ──────────────────────────────────────────────────────────────
  {
    ok("nothing to transcribe plans nothing", planWindows(0).length === 0);
    ok("…and a nonsense duration is nothing rather than a hang",
      planWindows(NaN).length === 0 && planWindows(-5).length === 0);

    const short = planWindows(12);
    ok("a file shorter than one window is one window",
      short.length === 1 && short[0]?.start === 0 && short[0]?.end === 12,
      JSON.stringify(short));

    const plan = planWindows(90);
    ok("a long file is cut into windows", plan.length > 1, `${plan.length}`);
    ok("…none longer than the encoder can hold",
      plan.every((w) => w.end - w.start <= 30 + 1e-9),
      JSON.stringify(plan.map((w) => +(w.end - w.start).toFixed(2))));
    ok("…the first starts at the beginning and the last ends at the end",
      plan[0]?.start === 0 && plan[plan.length - 1]?.end === 90,
      JSON.stringify(plan));
    ok("…each reaching back into the one before it",
      plan.every((w, i) => i === 0 || w.start < (plan[i - 1]?.end ?? 0)),
      JSON.stringify(plan));
    /* The claim that matters: no gap. A window plan with a hole in it loses
       whatever was said in the hole, and nothing downstream can notice — the
       transcript simply reads as though nobody spoke. */
    ok("…and leaving no second of the recording unheard",
      plan.every((w, i) => i === 0 || w.start <= (plan[i - 1]?.end ?? 0)),
      JSON.stringify(plan));
    ok("…indexed in the order they will be transcribed",
      plan.every((w, i) => w.index === i));

    // A tail of a second or two is 29 seconds of padding in a 30-second
    // window, and Whisper's response to near-silence is to invent a sentence.
    const runt = planWindows(51);
    ok("a sliver at the end is folded back rather than given its own window",
      runt.every((w) => w.end - w.start >= 2) && runt[runt.length - 1]?.end === 51,
      JSON.stringify(runt.map((w) => [w.start, w.end])));

    const tight = planWindows(90, { window: 10, overlap: 2 });
    ok("the window and overlap are settings, not constants",
      tight.every((w) => w.end - w.start <= 10) && tight.length > 9,
      `${tight.length}`);
    ok("…and an overlap as long as the window is clamped instead of looping forever",
      planWindows(90, { window: 10, overlap: 10 }).length > 1);
  }

  // ── Stitching ─────────────────────────────────────────────────────────────
  {
    const plan = planWindows(90);
    const merged = mergeWindows(plan.map(heard));
    const words = said(merged);
    const want = WORDS.map((w) => w.text);

    ok("the stitched transcript is the recording, word for word",
      words.join(" ") === want.join(" "),
      `got ${words.length}: ${words.slice(0, 8).join(" ")} …`);
    ok("…with nothing said twice at a seam",
      new Set(words).size === words.length,
      JSON.stringify(words.filter((w, i) => words.indexOf(w) !== i)));
    ok("…and nothing lost at one",
      words.length === want.length, `${words.length} of ${want.length}`);
    ok("…in order", merged.every((s, i) => i === 0 || s.start >= (merged[i - 1]?.start ?? 0)));
    ok("…on the recording's clock, not each window's",
      merged[merged.length - 1]?.start === 89,
      `${merged[merged.length - 1]?.start}`);
    ok("…and word timings moved with it",
      merged.every((s) => s.words.every((w) => Math.abs(w.start - s.start) < 1e-9)));

    // Windows come back from a worker pool out of order as a matter of course.
    const shuffled = [...plan].reverse().map(heard);
    ok("windows that come back out of order stitch the same",
      said(mergeWindows(shuffled)).join(" ") === words.join(" "));

    // A different overlap must not change what was said, only where the seams
    // fall. If it does, the stitch depends on a tuning constant.
    const wide = mergeWindows(planWindows(90, { overlap: 12 }).map(heard));
    ok("a wider overlap costs time, not words",
      said(wide).join(" ") === want.join(" "),
      `${said(wide).length} words`);

    ok("no windows is an empty transcript, not a crash", mergeWindows([]).length === 0);
  }

  // ── Turns ─────────────────────────────────────────────────────────────────
  {
    const raw: Turn[] = [
      { start: 0, end: 2, speaker: "Speaker 1" },
      { start: 2, end: 4, speaker: "Speaker 1" },
      { start: 4.3, end: 6, speaker: "Speaker 1" },
      { start: 6, end: 9, speaker: "Speaker 2" },
      { start: 9, end: 10, speaker: "Speaker 1" },
    ];
    const turns = mergeTurns(raw);
    ok("a sentence chopped into frames becomes one turn",
      turns.length === 3, JSON.stringify(turns));
    ok("…and a breath inside it does not end it",
      turns[0]?.start === 0 && turns[0]?.end === 6, JSON.stringify(turns[0]));
    ok("…but a change of speaker does",
      turns[1]?.speaker === "Speaker 2" && turns[2]?.speaker === "Speaker 1");
    ok("zero-length regions are dropped rather than kept as instants",
      mergeTurns([{ start: 3, end: 3, speaker: "Speaker 1" }]).length === 0);
    ok("…and unsorted input still comes back in order",
      mergeTurns([...raw].reverse()).map((t) => t.start).join() === turns.map((t) => t.start).join());
  }

  // ── One region per moment, whatever the windows did ───────────────────────
  {
    /*
     * Two people alternating every ten seconds across a 90-second recording,
     * as the segmentation model would report it: each window labels them 0 and
     * 1 with no idea who 0 was last time. Here the model numbers them by who
     * spoke first in each window, which is exactly the behaviour that makes a
     * naive concatenation swap the names — and the reason nothing downstream
     * is allowed to believe these labels.
     */
    const plan = planWindows(90);
    const alternating = (t: number): "A" | "B" => (Math.floor(t / 10) % 2 === 0 ? "A" : "B");

    const perWindow: LocalTurns[] = plan.map((w) => {
      const regions: Turn[] = [];
      for (let t = Math.floor(w.start / 10) * 10; t < w.end; t += 10) {
        const start = Math.max(w.start, t);
        const end = Math.min(w.end, t + 10);
        if (end <= start) continue;
        regions.push({ start: start - w.start, end: end - w.start, speaker: alternating(t) });
      }
      const order: string[] = [];
      for (const r of regions) if (!order.includes(r.speaker)) order.push(r.speaker);
      return {
        window: w,
        turns: regions.map((r) => ({ ...r, speaker: String(order.indexOf(r.speaker)) })),
      };
    });

    const regions = speechRegions(perWindow);
    ok("the whole recording is covered by speech regions",
      regions[0]?.start === 0 && regions[regions.length - 1]?.end === 90,
      JSON.stringify([regions[0], regions[regions.length - 1]]));
    ok("…with the shared seconds claimed once, not twice",
      regions.every((r, i) => i === 0 || r.start >= (regions[i - 1]?.end ?? 0) - 1e-9),
      JSON.stringify(regions.map((r) => [+r.start.toFixed(1), +r.end.toFixed(1)])));
    ok("…and every boundary in the recording still present",
      regions.length >= 9, `${regions.length} regions`);
    /* The labels are namespaced by window precisely so that nothing can
       accidentally treat window 0's "0" and window 1's "0" as one person. */
    ok("…and no label is reused across two windows by accident",
      regions.every((r) => /^\d+:/.test(r.speaker)),
      JSON.stringify([...new Set(regions.map((r) => r.speaker))]));

    ok("silence throughout is no regions, not a crash",
      speechRegions([{ window: { index: 0, start: 0, end: 30 }, turns: [] }]).length === 0);
    ok("nothing at all is nothing", speechRegions([]).length === 0);
  }

  // ── Telling voices apart ──────────────────────────────────────────────────
  {
    /*
     * Stand-in voice prints. Two people, three dimensions, with a little
     * wobble per region so no two are identical — which is the realistic case
     * and the one where a clusterer that only handles exact matches falls over.
     */
    const A = [1, 0, 0];
    const B = [0, 1, 0];
    const C = [0, 0, 1];
    const wobble = (v: number[], n: number): number[] =>
      v.map((x, i) => x + ((((n * 7 + i * 13) % 11) - 5) / 100));

    const voiced = (parts: Array<[number, number, number[]]>): Voiced[] =>
      parts.map(([start, end, e], i) => ({ start, end, embedding: wobble(e, i), speaker: `x${i}` }));

    const two = voiced([
      [0, 10, A], [10, 20, B], [20, 30, A], [30, 40, B], [40, 50, A],
    ]);
    const named = clusterSpeakers(two);
    ok("two voices are two speakers", new Set(named.map((t) => t.speaker)).size === 2,
      JSON.stringify(named.map((t) => [t.start, t.speaker])));
    ok("…named for who spoke first",
      named[0]?.speaker === "Speaker 1" && named[1]?.speaker === "Speaker 2",
      JSON.stringify(named.map((t) => t.speaker)));
    ok("…and the same voice gets the same name every time it returns",
      named.filter((t) => t.speaker === "Speaker 1").length === 3,
      JSON.stringify(named.map((t) => [t.start, t.speaker])));

    /*
     * The case that broke the window-matching approach this replaced: somebody
     * silent for a long stretch. Nothing about clustering cares how long ago
     * they last spoke, because it is comparing voices and not neighbours.
     */
    const late = clusterSpeakers(voiced([
      [0, 10, A], [10, 20, B], [600, 610, A],
    ]));
    ok("a voice that goes quiet for ten minutes is still the same person",
      late[2]?.speaker === late[0]?.speaker,
      JSON.stringify(late.map((t) => [t.start, t.speaker])));

    const threeVoices = voiced([[0, 10, A], [10, 20, B], [20, 30, C], [30, 40, A]]);
    const three = clusterSpeakers(threeVoices);
    ok("three voices are three speakers",
      new Set(three.map((t) => t.speaker)).size === 3,
      JSON.stringify(three.map((t) => t.speaker)));

    ok("one person talking to themselves is one speaker",
      new Set(clusterSpeakers(voiced([[0, 10, A], [10, 20, A], [20, 30, A]]))
        .map((t) => t.speaker)).size === 1);
    ok("…and their consecutive regions become one turn",
      clusterSpeakers(voiced([[0, 10, A], [10, 20, A]])).length === 1);

    /* Knowing how many people were in the room beats any threshold, in both
       directions — it forces a merge that the threshold would not make… */
    const forced = clusterSpeakers(voiced([[0, 10, A], [10, 20, B], [20, 30, C]]), { speakers: 2 });
    ok("a known head count merges past the threshold",
      new Set(forced.map((t) => t.speaker)).size === 2,
      JSON.stringify(forced.map((t) => t.speaker)));
    // …and stops one it would have made.
    const held = clusterSpeakers(voiced([[0, 10, A], [10, 20, A], [20, 30, A]]), { speakers: 2 });
    ok("…and holds one apart that the threshold would have joined",
      new Set(held.map((t) => t.speaker)).size === 2,
      JSON.stringify(held.map((t) => t.speaker)));

    ok("a strict threshold splits rather than merges",
      new Set(clusterSpeakers(two, { threshold: 0.999 }).map((t) => t.speaker)).size > 2);
    ok("…and a loose one puts everyone together",
      new Set(clusterSpeakers(threeVoices, { threshold: -1 }).map((t) => t.speaker)).size === 1);

    ok("an embedding of silence clusters alone rather than dividing by zero",
      Number.isFinite(
        clusterSpeakers([
          { start: 0, end: 5, speaker: "a", embedding: [0, 0, 0] },
          { start: 5, end: 10, speaker: "b", embedding: A },
        ]).length,
      ));
    ok("no regions is no speakers", clusterSpeakers([]).length === 0);
    ok("a region with no embedding is dropped, not guessed at",
      clusterSpeakers([{ start: 0, end: 5, speaker: "a", embedding: [] }]).length === 0);
  }

  // ── Who said it ───────────────────────────────────────────────────────────
  {
    const turns: Turn[] = [
      { start: 0, end: 10, speaker: "Speaker 1" },
      { start: 10, end: 20, speaker: "Speaker 2" },
    ];

    const plain: Segment[] = [
      { start: 1, end: 4, text: "morning all", words: [], speaker: null },
      { start: 12, end: 15, text: "morning", words: [], speaker: null },
      { start: 30, end: 32, text: "who is that", words: [], speaker: null },
    ];
    const named = assignSpeakers(plain, turns);
    ok("a segment inside one turn is that speaker's",
      named[0]?.speaker === "Speaker 1" && named[1]?.speaker === "Speaker 2",
      JSON.stringify(named.map((s) => s.speaker)));
    ok("…and a segment nobody was speaking over stays unattributed",
      named[2]?.speaker === null);
    ok("no turns at all leaves the transcript alone rather than inventing a speaker",
      assignSpeakers(plain, []).every((s) => s.speaker === null));

    /*
     * The case this whole function exists for. One segment of five words spans
     * the handover at t=10: three words before it, two after. A vote over the
     * segment as a whole would put all five in Speaker 1's mouth.
     */
    const straddle: Segment[] = [
      {
        start: 8,
        end: 13,
        text: "so that is settled then yes",
        words: [
          { start: 8, end: 8.8, text: "so" },
          { start: 8.9, end: 9.4, text: "that" },
          { start: 9.5, end: 9.9, text: "is" },
          { start: 10.4, end: 11.2, text: "settled" },
          { start: 11.3, end: 12.9, text: "then yes" },
        ],
        speaker: null,
      },
    ];
    const split = assignSpeakers(straddle, turns);
    ok("a sentence spanning a handover is split at it, not handed to one side",
      split.length === 2, JSON.stringify(split.map((s) => [s.speaker, s.text])));
    ok("…with the words before the handover under the first speaker",
      split[0]?.speaker === "Speaker 1" && split[0]?.text === "so that is",
      JSON.stringify(split[0]));
    ok("…and the words after it under the second",
      split[1]?.speaker === "Speaker 2" && split[1]?.text === "settled then yes",
      JSON.stringify(split[1]));
    ok("…and no word went missing in the split",
      `${split[0]?.text} ${split[1]?.text}` === straddle[0]?.text);
    ok("…and the two halves still cover the original span",
      split[0]?.start === 8 && split[split.length - 1]?.end === 12.9,
      JSON.stringify(split.map((s) => [s.start, s.end])));

    /*
     * The opposite error. Segmentation boundaries land a beat early all the
     * time, so one word poking into the next turn is far more likely to be a
     * misplaced boundary than a real interjection — and promoting it to its
     * own line reads as somebody butting in, which did not happen.
     */
    const graze: Segment[] = [
      {
        start: 6,
        end: 10.3,
        text: "and then we all went home",
        words: [
          { start: 6, end: 6.6, text: "and" },
          { start: 6.7, end: 7.2, text: "then" },
          { start: 7.3, end: 7.9, text: "we" },
          { start: 8, end: 8.6, text: "all" },
          { start: 8.7, end: 9.4, text: "went" },
          { start: 10.05, end: 10.3, text: "home" },
        ],
        speaker: null,
      },
    ];
    const grazed = assignSpeakers(graze, turns);
    ok("one word over the line is a boundary that slipped, not an interruption",
      grazed.length === 1 && grazed[0]?.speaker === "Speaker 1",
      JSON.stringify(grazed.map((s) => [s.speaker, s.text])));
    ok("…and it keeps the word",
      grazed[0]?.text === "and then we all went home", grazed[0]?.text);
  }

  // ── Reading it ────────────────────────────────────────────────────────────
  {
    const segs: Segment[] = [
      { start: 0, end: 2, text: "Morning.", words: [], speaker: "Speaker 1" },
      { start: 2, end: 4, text: "Everyone here?", words: [], speaker: "Speaker 1" },
      { start: 4, end: 6, text: "Almost.", words: [], speaker: "Speaker 2" },
      { start: 6, end: 8, text: "Right, let's start.", words: [], speaker: "Speaker 1" },
    ];

    const prose = transcriptText(segs, { speakers: true });
    ok("consecutive segments by one person are one paragraph",
      prose.split("\n\n").length === 3, JSON.stringify(prose));
    ok("…run together rather than stacked as fragments",
      prose.includes("Morning. Everyone here?"), prose);
    ok("…and each paragraph is labelled",
      prose.startsWith("Speaker 1: ") && prose.includes("Speaker 2: Almost."), prose);
    ok("the same speaker twice apart gets a label each time",
      (prose.match(/Speaker 1:/g) ?? []).length === 2, prose);

    ok("labels are optional",
      !transcriptText(segs).includes("Speaker"), transcriptText(segs));
    ok("…and timestamps are too",
      transcriptText(segs, { timestamps: true }).startsWith("[0:00] "),
      transcriptText(segs, { timestamps: true }).slice(0, 20));

    ok("an unattributed transcript is still readable",
      transcriptText(
        segs.map((s) => ({ ...s, speaker: null })),
        { speakers: true },
      ) === "Morning. Everyone here? Almost. Right, let's start.");
    ok("empty segments do not leave empty paragraphs",
      transcriptText([{ start: 0, end: 1, text: "   ", words: [], speaker: null }]) === "");
    ok("nothing said is an empty transcript", transcriptText([]) === "");

    ok("the clock drops an hour it does not have", clockOf(65) === "1:05");
    ok("…and shows one it does, zero-padding the minutes",
      clockOf(3725) === "1:02:05", clockOf(3725));
    ok("…and does not go backwards on a bad number",
      clockOf(-4) === "0:00" && clockOf(NaN) === "0:00");
  }
}

// ── The panel ───────────────────────────────────────────────────────────────

/**
 * The surface, driven with a stub in place of the three models.
 *
 * The engine is injected for exactly this reason: the panel's job is to show
 * progress, let a speaker be renamed everywhere at once, save, and not lose the
 * partial transcript when Stop is pressed — and none of those claims needs half
 * a gigabyte of ONNX to check. The stub emits the same shapes a real run does,
 * one window at a time, so the panel is tested against the sequence it will
 * really see rather than against a finished array.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/*
 * Every query is scoped to the panel that is *open*, not to the first one in
 * the document. A closed panel stays in the DOM hidden — which is the right
 * behaviour and also the reason a bare `.scribe .scribe-text` reads three
 * lines out of a panel that was closed two blocks ago and calls a partial
 * transcript finished. That mistake cost twenty minutes here; it would have
 * cost rather more as a green harness over a broken Stop button.
 */
const LIVE = ".scribe:not([hidden])";
const all = <T extends HTMLElement>(sel: string): T[] =>
  [...document.querySelectorAll<T>(`${LIVE} ${sel}`)];
const $ = <T extends HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(`${LIVE} ${sel}`);
const click = (sel: string): void => $<HTMLElement>(sel)?.click();

/** What the panel is saying about itself, right now. */
const statusOf = (): string => $(".scribe-note")?.textContent ?? "";
const linesOf = (): string[] => all(".scribe-text").map((n) => n.textContent ?? "");
const namesOf = (): string[] => all(".scribe-who").map((n) => n.textContent ?? "");

interface Written { path: string; text: string }

function stubEngine(script: readonly Segment[], slow = 0): TranscribeEngine {
  return {
    decode: () => Promise.resolve(new Float32Array(16_000 * 12)),
    async run(_samples, _opts, onProgress, signal) {
      const out: Segment[] = [];
      for (const seg of script) {
        if (signal?.aborted) break;
        out.push(seg);
        onProgress({ note: `Listening — ${out.length}`, done: out.length / script.length, segments: [...out] });
        if (slow > 0) await sleep(slow);
      }
      return out;
    },
    close() {
      /* nothing to free */
    },
  };
}

const SCRIPT: Segment[] = [
  { start: 0, end: 3, text: "Morning, everyone.", words: [], speaker: "Speaker 1" },
  { start: 3, end: 6, text: "Morning.", words: [], speaker: "Speaker 2" },
  { start: 6, end: 9, text: "Shall we start?", words: [], speaker: "Speaker 1" },
];

async function viewChecks(): Promise<void> {
  const disk: Written[] = [];
  const host: TranscribeHost = {
    fileUrl: () => Promise.resolve("data:audio/wav;base64,UklGRg=="),
    writeFile: (path, bytes) => {
      disk.push({ path, text: new TextDecoder().decode(bytes) });
      return Promise.resolve(path);
    },
    refresh: () => undefined,
    engine: stubEngine(SCRIPT),
    // Asserted both ways below: the estimate is the only thing standing between
    // the user and an hour of unexplained waiting on a machine with no GPU.
    device: () => Promise.resolve("wasm"),
  };

  const view = new TranscribeView(host);

  // ── Opening ───────────────────────────────────────────────────────────────
  {
    await view.open("C:/takes/standup.m4a");
    ok("the panel opens on a recording", view.isOpen && view.openPath === "C:/takes/standup.m4a");
    ok("…titled with the file, not the path",
      $(".scribe-title")?.textContent === "standup.m4a", $(".scribe-title")?.textContent ?? "");
    ok("…with a suggested name that is not the recording's",
      ($<HTMLInputElement>(".scribe-name")?.value ?? "") === "standup.txt",
      $<HTMLInputElement>(".scribe-name")?.value ?? "");
    /* A CPU-only machine takes roughly real time. Saying so before the user
       commits is the difference between a slow feature and a broken one. */
    ok("…and says out loud that there is no GPU",
      statusOf().includes("no GPU"), statusOf());
    ok("nothing is offered for export before there is a transcript",
      $(".scribe-export")?.hidden === true);
  }

  // ── A run ─────────────────────────────────────────────────────────────────
  {
    click(".scribe-go");
    await sleep(120);
    ok("every line of the transcript is shown", linesOf().length === 3, JSON.stringify(linesOf()));
    ok("…in the order they were said",
      linesOf()[0] === "Morning, everyone.", JSON.stringify(linesOf()));
    ok("…each stamped with when it starts",
      $(".scribe-at")?.textContent === "0:00", $(".scribe-at")?.textContent ?? "");
    ok("…and each attributed",
      namesOf().join(",") === "Speaker 1,Speaker 2,Speaker 1", namesOf().join(","));
    ok("the progress bar goes away when it finishes",
      $(".scribe-progress")?.hidden === true);
    ok("…and the count is reported",
      statusOf().includes("3 lines") && statusOf().includes("2 voices"), statusOf());
    ok("export appears once there is something to export",
      $(".scribe-export")?.hidden === false);
  }

  // ── Renaming ──────────────────────────────────────────────────────────────
  {
    const chip = $<HTMLElement>(".scribe-who");
    chip?.click();
    const box = $<HTMLInputElement>(".scribe-rename");
    ok("clicking a speaker offers an edit rather than a dialog", box !== null);
    if (box) {
      box.value = "Alex";
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    /* The whole point: one rename is a rename of the person. Doing it line by
       line on a two-hour meeting is not a feature. */
    ok("renaming a speaker renames every line they said",
      namesOf().join(",") === "Alex,Speaker 2,Alex", namesOf().join(","));
    ok("…and leaves everybody else alone", namesOf()[1] === "Speaker 2");
  }

  // ── Finding ───────────────────────────────────────────────────────────────
  {
    const find = $<HTMLInputElement>(".scribe-find");
    if (find) {
      find.value = "start";
      find.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const dimmed = all(".scribe-line").map((n) =>
      n.classList.contains("scribe-dim"),
    );
    /* Dimmed, not hidden: a hit is read with the line before it, and removing
       the surroundings takes the answer away with the noise. */
    ok("a search dims the misses and keeps them on screen",
      dimmed.join(",") === "true,true,false", dimmed.join(","));
    ok("…and clearing it brings everything back", (() => {
      if (find) {
        find.value = "";
        find.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return all(".scribe-line").every(
        (n) => !n.classList.contains("scribe-dim"),
      );
    })());
  }

  // ── Saving ────────────────────────────────────────────────────────────────
  {
    click(".scribe-export .scribe-go");
    await sleep(60);
    ok("saving writes one file beside the recording",
      disk.length === 1 && disk[0]?.path === "C:/takes/standup.txt",
      JSON.stringify(disk.map((d) => d.path)));
    ok("…with the names the user gave, not the model's",
      (disk[0]?.text ?? "").includes("Alex:") && !(disk[0]?.text ?? "").includes("Speaker 1"),
      disk[0]?.text ?? "");
    ok("…and the timestamps that were ticked",
      (disk[0]?.text ?? "").includes("[0:00]"), disk[0]?.text ?? "");

    const times = $<HTMLInputElement>(".scribe-export input[type=checkbox]");
    if (times) {
      times.checked = false;
      times.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const nameBox = $<HTMLInputElement>(".scribe-name");
    if (nameBox) nameBox.value = "plain.txt";
    click(".scribe-export .scribe-go");
    await sleep(60);
    ok("unticking the times leaves them out",
      disk.length === 2 && !(disk[1]?.text ?? "").includes("[0:00]"), disk[1]?.text ?? "");

    if (nameBox) nameBox.value = "  ";
    click(".scribe-export .scribe-go");
    await sleep(60);
    ok("a blank name is refused rather than written as one",
      disk.length === 2 && statusOf().includes("name"), statusOf());
  }

  // ── Stopping ──────────────────────────────────────────────────────────────
  {
    view.close();
    const slow = new TranscribeView({ ...host, engine: stubEngine(SCRIPT, 80) });
    await slow.open("C:/takes/long.m4a");
    click(".scribe-go");
    await sleep(140);
    const partial = linesOf().length;
    ok("the transcript fills in while it runs, not at the end",
      partial > 0 && partial < 3, String(partial));
    click(".scribe-stop");
    await sleep(300);
    /* Stop must mean "keep what you have". Ten minutes of a meeting already
       transcribed is worth more than a clean slate, and a Stop that discards it
       is a Stop nobody dares press. */
    ok("stopping keeps what was transcribed so far",
      linesOf().length === partial && linesOf().length > 0, String(linesOf().length));
    ok("…and offers it for export like any other transcript",
      $(".scribe-export")?.hidden === false);
    slow.close();
    ok("closing puts the panel away", !slow.isOpen);
  }

  // ── A machine with a GPU ──────────────────────────────────────────────────
  {
    const fast = new TranscribeView({ ...host, device: () => Promise.resolve("webgpu") });
    await fast.open("C:/takes/standup.m4a");
    ok("a GPU machine is not warned about the CPU", !statusOf().includes("no GPU"), statusOf());
    fast.close();
  }

  // ── When it goes wrong ────────────────────────────────────────────────────
  {
    const broken = new TranscribeView({
      ...host,
      engine: {
        decode: () => Promise.reject(new Error("this file has no audio in it")),
        run: () => Promise.resolve([]),
        close: () => undefined,
      },
    });
    await broken.open("C:/takes/silent.mp4");
    click(".scribe-go");
    await sleep(80);
    /* The message has to name the file's problem, not the stack's: "failed"
       alone sends somebody to a bug report for a video with no soundtrack. */
    ok("a file that cannot be decoded says why",
      statusOf().includes("no audio"), statusOf());
    ok("…and the setup is offered again rather than a dead panel",
      $(".scribe-setup")?.hidden === false);
    broken.close();
  }
}

// ── Go ──────────────────────────────────────────────────────────────────────

pureChecks();
void viewChecks().then(() => {
  const line = `scribe: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  document.title = line;
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
});
