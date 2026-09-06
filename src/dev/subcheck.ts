/**
 * Checks the subtitle model — cueing, wrapping, timing, and both file formats
 * (item 31).
 *
 * The claim a subtitle track has to defend is narrow and absolute: **every
 * word that was said appears, once, in order, while it is being said.** A
 * cueing algorithm that loses a word at a boundary is worse than useless,
 * because the failure is silent — the track plays, the timings look right, and
 * one sentence in a hundred is simply missing. That invariant is the first
 * block below and it is checked over the whole transcript, not spot-checked.
 *
 * Everything after it is craft rather than correctness: lines short enough,
 * few enough, held long enough, balanced rather than filled. Those are the
 * difference between subtitles a person reads without noticing and subtitles
 * a person notices, and they are all arithmetic, so they are all here.
 *
 * The formats are checked by round trip rather than against golden strings. A
 * golden string asserts that today's writer produces today's bytes, which is
 * true of a broken writer too; a round trip asserts that what we write, we can
 * read — and, with the hand-written fixtures further down, that what the rest
 * of the world writes, we can read as well.
 *
 * Dev-only. Loaded by /subcheck.html, which is not a build input.
 *
 *   http://localhost:8183/subcheck.html
 */

import "../styles/base.css";

import type { Segment, Word } from "@core/speech/transcript";
import {
  cueAt,
  cueChars,
  cueRate,
  cueText,
  cuesFromSegments,
  joinWords,
  mergeCues,
  parseSubtitles,
  parseTime,
  problems,
  removeCue,
  renumber,
  setCueText,
  setCueTime,
  shiftCues,
  splitCue,
  stretchCues,
  STYLE,
  timecode,
  toSRT,
  toSubtitles,
  toVTT,
  wordsOf,
  wrapLines,
  type Cue,
} from "@core/speech/subtitles";
import "../styles/subtitles.css";
import { SubtitleView, type SubtitleHost, type SubtitleJob } from "@ui/subtitle-view";

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

// ── A transcript, as numbers ────────────────────────────────────────────────

/**
 * Words at a steady four a second — fast for a person, which is the point.
 * A slow talker gives the cueing algorithm room it does not have to earn; a
 * fast one is where cues get too long, too wide, and too quick to read.
 */
function speak(
  text: string,
  from: number,
  speaker: string | null = null,
  each = 0.25,
): Segment {
  const words: Word[] = text
    .trim()
    .split(/\s+/)
    .map((t, i) => ({ start: from + i * each, end: from + i * each + each * 0.8, text: t }));
  return {
    start: from,
    end: words.length ? words[words.length - 1]!.end : from,
    text: text.trim(),
    words,
    speaker,
  };
}

const PROSE = [
  speak("The quick brown fox jumps over the lazy dog, and then it does it again.", 0),
  speak("Nobody has ever explained why the dog puts up with this, frankly.", 4.5),
  speak("It is a sentence about typing, not about dogs. That is the whole answer.", 9),
];

/** Every word in a transcript, in order, as bare text. */
const wordsIn = (segs: readonly Segment[]): string[] =>
  segs.flatMap((s) => s.words.map((w) => w.text.trim())).filter(Boolean);

/** Every word in a track, in order, as bare text. */
const wordsOut = (cues: readonly Cue[]): string[] =>
  cues.flatMap((c) => cueText(c).split(/\s+/)).filter(Boolean);

const near = (a: number, b: number, slop = 1e-6): boolean => Math.abs(a - b) <= slop;

// ── Nothing is lost ─────────────────────────────────────────────────────────
{
  const cues = cuesFromSegments(PROSE, { names: "never" });
  ok("prose becomes more than one cue", cues.length > 1, String(cues.length));
  ok("every word survives cueing, once, in order",
    wordsOut(cues).join(" ") === wordsIn(PROSE).join(" "),
    wordsOut(cues).join(" "));

  ok("cues are numbered from one, in order",
    cues.every((c, i) => c.index === i + 1));
  ok("cues are in time order",
    cues.every((c, i) => i === 0 || c.start >= cues[i - 1]!.start));
  ok("no cue is on screen while the next one starts",
    cues.every((c, i) => i === cues.length - 1 || c.end <= cues[i + 1]!.start + 1e-9));

  /* The gap is not decoration: two cues that touch exactly look to the eye
     like one cue whose text changed, and the reader restarts the line. */
  ok("consecutive cues are separated by a real gap",
    cues.every((c, i) => i === cues.length - 1 || cues[i + 1]!.start - c.end >= STYLE.gap - 1e-9));

  ok("no cue is wider than the line budget",
    cues.every((c) => c.lines.every((l) => [...l].length <= STYLE.chars)),
    cues.map((c) => c.lines.map((l) => l.length).join("/")).join(" "));
  ok("no cue has more lines than the budget",
    cues.every((c) => c.lines.length <= STYLE.lines));
  ok("no cue outstays the maximum",
    cues.every((c) => c.end - c.start <= STYLE.max + 1e-6));
  ok("no cue is a flash",
    cues.every((c) => c.end - c.start >= 0.2 - 1e-9),
    cues.map((c) => (c.end - c.start).toFixed(2)).join(" "));

  /* A cue may not appear before its first word is spoken. Late is a style
     choice; early gives away the line, which no amount of style fixes. */
  const starts = PROSE.flatMap((s) => s.words.map((w) => ({ text: w.text, at: w.start })));
  ok("no cue shows a word before it is spoken",
    cues.every((c) => {
      const firstWord = cueText(c).split(/\s+/)[0] ?? "";
      const said = starts.find((s) => s.text === firstWord);
      return !said || c.start <= said.at + 1e-6;
    }));
}

// ── An empty transcript ─────────────────────────────────────────────────────
{
  ok("nothing said is no cues", cuesFromSegments([]).length === 0);
  ok("…and a segment with no text is skipped, not emitted blank",
    cuesFromSegments([{ start: 0, end: 3, text: "   ", words: [], speaker: null }]).length === 0);
  ok("…and neither crashes on the way", true);
}

// ── Long enough to read ─────────────────────────────────────────────────────
{
  /* One word on its own gets the minimum hold. A model that gives a 0.3 s
     word a 0.3 s cue is technically accurate and unreadable. */
  const blip = cuesFromSegments([speak("Right.", 10)]);
  ok("a one-word cue is still held long enough to read",
    blip[0] !== undefined && blip[0].end - blip[0].start >= STYLE.min - 1e-9,
    String(blip[0] && blip[0].end - blip[0].start));

  /* And a dense one gets longer than the minimum, because the minimum is a
     floor for short text, not a target for all of it. */
  const dense = cuesFromSegments([speak(
    "Forty two characters is not very many when the person talking will not stop",
    0, null, 0.05,
  )]);
  ok("a dense cue is held for at least its reading time",
    dense.every((c) => c.end - c.start >= Math.min(STYLE.max, cueChars(c) / STYLE.rate) - 1e-6),
    dense.map((c) => `${cueChars(c)}c/${(c.end - c.start).toFixed(2)}s`).join(" "));
}

// ── Where cues break ────────────────────────────────────────────────────────
{
  const two = [
    speak("So that is the plan for the quarter, unless anybody objects to it.", 0, "Ada"),
    speak("I object to all of it, obviously, but go on.", 4.5, "Grace"),
  ];
  const cues = cuesFromSegments(two, { names: "never" });
  /* Containment rather than word membership: the two people here share half
     their vocabulary ("to", "it", "the"), so counting which words came from
     whom proves nothing. A cue that belongs to one speaker is a run of that
     speaker's sentence and nothing else, which is exactly a substring of it. */
  ok("a cue never holds two people's words",
    cues.every((c) => two.some((s) => s.text.includes(cueText(c).replace(/\n/g, " ")))),
    cues.map((c) => cueText(c)).join(" | "));
  ok("…and the speaker is carried onto the cue",
    cues.some((c) => c.speaker === "Ada") && cues.some((c) => c.speaker === "Grace"));

  /* A long silence ends a cue even mid-sentence: otherwise the words either
     side of the pause share a cue that sits on screen through the silence,
     which reads as the subtitle being three seconds late. */
  const around = [
    { ...speak("And the answer is", 0), speaker: null },
    { ...speak("absolutely not", 6), speaker: null },
  ];
  const split = cuesFromSegments(around);
  ok("a long silence ends a cue", split.length === 2, String(split.length));
  ok("…and the second cue starts when the talking does",
    split[1] !== undefined && near(split[1].start, 6, 0.01));
}

// ── Names ───────────────────────────────────────────────────────────────────
{
  const two = [
    speak("Morning.", 0, "Ada"),
    speak("Morning.", 2, "Grace"),
    speak("Shall we start?", 4, "Grace"),
  ];
  const change = cuesFromSegments(two, { names: "change" });
  ok("a name is written when the speaker changes",
    change[0]?.lines[0]?.startsWith("Ada: ") === true && change[1]?.lines[0]?.startsWith("Grace: ") === true,
    change.map((c) => cueText(c)).join(" | "));
  ok("…and not again while the same person keeps talking",
    change[2]?.lines[0]?.startsWith("Grace:") === false, cueText(change[2] ?? change[0]!));

  const always = cuesFromSegments(two, { names: "always" });
  ok("every cue can be named instead",
    always.every((c) => cueText(c).includes(":")));

  const never = cuesFromSegments(two, { names: "never" });
  ok("…or none of them",
    never.every((c) => !cueText(c).includes(":")));

  /* The name is text on screen, so it comes out of the line budget. A cue
     that fits at 42 characters and overflows once "Grace: " is prepended is
     the commonest way a wrapper that measures the wrong string is caught. */
  const long = cuesFromSegments(
    [speak("This line is exactly the sort of length that only just fits inside the budget", 0, "Grace")],
    { names: "always" },
  );
  ok("the name is counted against the line budget",
    long.every((c) => c.lines.every((l) => [...l].length <= STYLE.chars)),
    long.map((c) => c.lines.join("|")).join(" // "));
}

// ── Wrapping ────────────────────────────────────────────────────────────────
{
  ok("nothing wraps to nothing", wrapLines("", 42, 2).length === 0);
  ok("short text stays on one line", wrapLines("Yes, quite.", 42, 2).length === 1);

  const two = wrapLines("The quick brown fox jumps over the lazy dog and keeps going", 30, 2);
  ok("long text uses both lines", two.length === 2, JSON.stringify(two));
  ok("…and neither line is over budget", two.every((l) => l.length <= 30), JSON.stringify(two));

  /* Balanced, not filled. A greedy wrap of this at 40 leaves one word alone
     on the second line, which is legal, fits, and looks like a bug. */
  const balanced = wrapLines("Nobody has ever explained why the dog puts up with any of it", 40, 2);
  const spread = Math.abs((balanced[0]?.length ?? 0) - (balanced[1]?.length ?? 0));
  ok("lines are balanced rather than filled", spread <= 10, JSON.stringify(balanced));

  /* Breaking after a comma reads better than breaking in the middle of a
     clause, and is worth a few characters of imbalance to get. */
  const comma = wrapLines("If it rains tomorrow, the whole thing moves indoors", 34, 2);
  ok("a line break prefers punctuation", comma[0]?.endsWith(",") === true, JSON.stringify(comma));

  const huge = wrapLines("Supercalifragilisticexpialidocious", 10, 2);
  ok("a word longer than the line is left alone rather than cut",
    huge.length === 1 && huge[0] === "Supercalifragilisticexpialidocious", JSON.stringify(huge));

  const three = wrapLines("one two three four five six seven eight nine ten", 20, 3);
  ok("more lines are used when allowed", three.length === 3, JSON.stringify(three));

  /* Text that cannot fit is handed back over budget rather than silently
     truncated — the caller's `fits` check is what turns that into a smaller
     cue, and it can only do that if it can see the overflow. */
  const cramped = wrapLines("one two three four five six seven eight nine ten", 12, 2);
  ok("text that cannot fit comes back over budget rather than cut",
    cramped.join(" ") === "one two three four five six seven eight nine ten" && cramped.length > 2,
    JSON.stringify(cramped));
}

// ── Segments with no word timings ───────────────────────────────────────────
{
  const bare: Segment = {
    start: 10,
    end: 14,
    text: "A model that was not asked for word timings still has to be subtitled somehow",
    words: [],
    speaker: null,
  };
  const made = wordsOf(bare);
  ok("words are invented for a segment that has none", made.length === 15, String(made.length));
  ok("…spread across the segment's own span",
    made[0]!.start >= 10 - 1e-9 && made[made.length - 1]!.end <= 14 + 1e-6);
  ok("…in proportion to length, not equally",
    made[0]!.end - made[0]!.start < made[1]!.end - made[1]!.start,
    `${made[0]!.text} vs ${made[1]!.text}`);

  const cues = cuesFromSegments([bare]);
  ok("and it subtitles like anything else",
    cues.length >= 1 && wordsOut(cues).join(" ") === bare.text);
  ok("…inside the time it was actually said",
    cues[0]!.start >= 10 - 1e-9);
}

// ── Joining words ───────────────────────────────────────────────────────────
{
  const w = (text: string): Word => ({ start: 0, end: 1, text });
  ok("punctuation closes up against the word before it",
    joinWords([w(" Well"), w(","), w(" no"), w(".")]) === "Well, no.",
    joinWords([w(" Well"), w(","), w(" no"), w(".")]));
  ok("…and empty tokens do not leave double spaces",
    joinWords([w("one"), w("  "), w("two")]) === "one two");
}

// ── Measuring ───────────────────────────────────────────────────────────────
{
  const cue: Cue = { index: 1, start: 0, end: 2, lines: ["abcde", "fghij"], speaker: null };
  ok("characters on screen ignore the line break", cueChars(cue) === 10);
  ok("reading rate is characters over seconds", near(cueRate(cue), 5));
  ok("a zero-length cue is infinitely fast rather than a divide by zero",
    cueRate({ ...cue, end: 0 }) === Infinity);
  ok("cue text rejoins the lines", cueText(cue) === "abcde\nfghij");
}

// ── The linter ──────────────────────────────────────────────────────────────
{
  const kinds = (cues: Cue[]): string[] => problems(cues).map((p) => p.kind);
  const one = (start: number, end: number, lines: string[]): Cue =>
    ({ index: 1, start, end, lines, speaker: null });

  ok("a good cue has nothing wrong with it",
    problems([one(0, 3, ["Perfectly ordinary subtitle."])]).length === 0,
    JSON.stringify(problems([one(0, 3, ["Perfectly ordinary subtitle."])])));

  ok("a blank cue is flagged", kinds([one(0, 3, ["  "])]).includes("empty"));
  ok("a backwards cue is flagged", kinds([one(3, 1, ["x"])]).includes("order"));
  ok("a flash is flagged", kinds([one(0, 0.4, ["Hello there"])]).includes("short"));
  ok("an overstay is flagged", kinds([one(0, 12, ["Hello there"])]).includes("long"));
  ok("an unreadably quick cue is flagged",
    kinds([one(0, 1.1, ["Forty two characters of text in one second"])]).includes("fast"));
  ok("an over-wide line is flagged",
    kinds([one(0, 4, ["x".repeat(60)])]).includes("wide"));
  ok("too many lines is flagged",
    kinds([one(0, 4, ["a", "b", "c"])]).includes("lines"));
  ok("an overlap is flagged against the later cue",
    problems([one(0, 5, ["first"]), { ...one(3, 8, ["second"]), index: 2 }])
      .some((p) => p.kind === "overlap" && p.at === 1));

  /* Generated cues are the thing this linter exists to keep honest, so they
     had better pass it. If they ever stop, one of the two is wrong and this
     says so before a user finds out by reading. */
  ok("nothing generated by the cue builder trips the linter",
    problems(cuesFromSegments(PROSE)).length === 0,
    JSON.stringify(problems(cuesFromSegments(PROSE))));
}

// ── Timecodes ───────────────────────────────────────────────────────────────
{
  ok("zero is written in full", timecode(0) === "00:00:00,000", timecode(0));
  ok("a comma for SubRip", timecode(3661.5) === "01:01:01,500", timecode(3661.5));
  ok("a full stop for WebVTT", timecode(3661.5, true) === "01:01:01.500", timecode(3661.5, true));
  ok("milliseconds are rounded, not truncated",
    timecode(1.0009) === "00:00:01,001", timecode(1.0009));
  ok("a negative time is clamped rather than written with a minus",
    timecode(-5) === "00:00:00,000", timecode(-5));
  ok("hours past ten still parse back",
    near(parseTime(timecode(40_000)) ?? -1, 40_000, 0.001));

  ok("a comma decimal reads", near(parseTime("00:00:01,250") ?? -1, 1.25));
  ok("a full stop decimal reads", near(parseTime("00:00:01.250") ?? -1, 1.25));
  ok("a missing hour reads", near(parseTime("01:30.500") ?? -1, 90.5));
  ok("bare seconds read", near(parseTime("12.5") ?? -1, 12.5));
  ok("nonsense is null rather than NaN", parseTime("later") === null);
}

// ── SubRip ──────────────────────────────────────────────────────────────────
{
  const cues = cuesFromSegments(PROSE);
  const srt = toSRT(cues);

  ok("SubRip has no header", !srt.startsWith("WEBVTT"));
  ok("…numbers every cue", srt.startsWith("1\n"), srt.slice(0, 20));
  ok("…uses comma timecodes", /\d,\d{3} --> /.test(srt), srt.split("\n")[1] ?? "");
  ok("…separates cues with a blank line", srt.includes("\n\n"));

  const back = parseSubtitles(srt);
  ok("SubRip round trips the text",
    back.map(cueText).join("|") === cues.map(cueText).join("|"));
  ok("…and the timings, to the millisecond",
    back.every((c, i) => near(c.start, cues[i]!.start, 0.001) && near(c.end, cues[i]!.end, 0.001)));
  ok("…and the line breaks inside a cue",
    back.every((c, i) => c.lines.length === cues[i]!.lines.length));
}

// ── WebVTT ──────────────────────────────────────────────────────────────────
{
  const cues = cuesFromSegments(PROSE);
  const vtt = toVTT(cues);

  ok("WebVTT starts with its header", vtt.startsWith("WEBVTT\n\n"), vtt.slice(0, 12));
  ok("…uses full-stop timecodes", /\d\.\d{3} --> /.test(vtt));
  const back = parseSubtitles(vtt);
  ok("WebVTT round trips", back.map(cueText).join("|") === cues.map(cueText).join("|"));
  ok("…without swallowing the header as a cue", back.length === cues.length);

  ok("the format can be chosen by name",
    toSubtitles(cues, "vtt") === vtt && toSubtitles(cues, "srt") === toSRT(cues));
}

// ── Files written by other people ───────────────────────────────────────────
{
  /* Hand-written fixtures: none of these are what we emit, and all of them
     turn up. The parser's job is to open them, not to judge them. */
  const messy = [
    "WEBVTT - Some title",
    "",
    "NOTE",
    "This file was made by a tool that leaves comments.",
    "",
    "STYLE",
    "::cue { color: yellow }",
    "",
    "intro",
    "00:00:01.000 --> 00:00:03.000 line:90% align:middle",
    "Positioned, which we ignore.",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "No identifier at all.",
    "",
  ].join("\n");

  const cues = parseSubtitles(messy);
  ok("a WebVTT header with a title is not a cue", cues.length === 2, String(cues.length));
  ok("…nor is a NOTE block", !cues.some((c) => cueText(c).includes("comments")));
  ok("…nor is a STYLE block", !cues.some((c) => cueText(c).includes("::cue")));
  ok("cue settings after the end time are ignored",
    near(cues[0]!.end, 3) && cueText(cues[0]!) === "Positioned, which we ignore.",
    cueText(cues[0] ?? { lines: ["?"] } as Cue));
  ok("a cue with no identifier still reads", cueText(cues[1]!) === "No identifier at all.");

  const crlf = "1\r\n00:00:01,000 --> 00:00:02,000\r\nWindows line endings.\r\n\r\n";
  ok("carriage returns do not end up in the text",
    cueText(parseSubtitles(crlf)[0]!) === "Windows line endings.",
    JSON.stringify(cueText(parseSubtitles(crlf)[0]!)));

  const bom = "﻿1\n00:00:01,000 --> 00:00:02,000\nByte order mark.\n";
  ok("a byte order mark does not break the first cue",
    parseSubtitles(bom).length === 1, String(parseSubtitles(bom).length));

  const misnumbered = "7\n00:00:01,000 --> 00:00:02,000\nA\n\n7\n00:00:03,000 --> 00:00:04,000\nB\n";
  ok("duplicate numbering is rebuilt rather than refused",
    parseSubtitles(misnumbered).map((c) => c.index).join("") === "12");

  const backwards = "1\n00:00:05,000 --> 00:00:06,000\nB\n\n2\n00:00:01,000 --> 00:00:02,000\nA\n";
  ok("cues out of order are sorted on the way in",
    parseSubtitles(backwards).map(cueText).join("") === "AB");

  ok("garbage is no cues rather than an exception",
    parseSubtitles("this is not a subtitle file at all").length === 0);

  /* A name is a label that recurs. Ada speaks twice, so Ada is a person. */
  const named = [
    "1\n00:00:01,000 --> 00:00:03,000\nAda: Morning, all.",
    "2\n00:00:04,000 --> 00:00:06,000\nAda: Shall we start?",
  ].join("\n\n");
  ok("a name written into an imported cue is recognised",
    parseSubtitles(named).every((c) => c.speaker === "Ada"),
    JSON.stringify(parseSubtitles(named).map((c) => c.speaker)));

  const notName = "1\n00:00:01,000 --> 00:00:03,000\nNote: this is not a person.\n";
  ok("…but a one-off sentence with a colon is not a person",
    parseSubtitles(notName)[0]?.speaker === null,
    String(parseSubtitles(notName)[0]?.speaker));

  const numbered = "1\n00:00:01,000 --> 00:00:03,000\nSpeaker 2: Only says this once.\n";
  ok("…and a diarised label is a person the first time it appears",
    parseSubtitles(numbered)[0]?.speaker === "Speaker 2");

  const shouted = "1\n00:00:01,000 --> 00:00:03,000\nADA: In broadcast capitals.\n";
  ok("…as is a name in capitals", parseSubtitles(shouted)[0]?.speaker === "ADA");

  const dialogue = toSRT(cuesFromSegments([
    speak("Morning, all.", 0, "Ada"),
    speak("Morning. Shall we start?", 5, "Grace"),
    speak("We shall, in a moment.", 10, "Ada"),
  ]));
  ok("names we wrote ourselves survive a round trip",
    parseSubtitles(dialogue).filter((c) => c.speaker !== null).length >= 2,
    JSON.stringify(parseSubtitles(dialogue).map((c) => c.speaker)));

  /* The limit, stated rather than hidden: one person labelled exactly once in
     a whole file is indistinguishable from "Note:", and this reads it as
     text. It is the right trade — the sidecar keeps the words either way, and
     the alternative puts a stranger's name on the transcript. */
  const lonely = "1\n00:00:01,000 --> 00:00:03,000\nAda: The only line in the file.\n";
  ok("a name that appears exactly once is left as text",
    parseSubtitles(lonely)[0]?.speaker === null);
}

// ── Editing ─────────────────────────────────────────────────────────────────
{
  const base = renumber([
    { index: 1, start: 1, end: 3, lines: ["First line."], speaker: "Ada" },
    { index: 2, start: 4, end: 6, lines: ["Second line."], speaker: "Ada" },
    { index: 3, start: 7, end: 9, lines: ["Third line."], speaker: "Grace" },
  ]);

  const late = shiftCues(base, 2.5);
  ok("a shift moves everything by the same amount",
    late.every((c, i) => near(c.start, base[i]!.start + 2.5)));
  const early = shiftCues(base, -5);
  ok("a shift past zero clamps rather than dropping the first cue",
    early.length === 3 && early[0]!.start === 0);
  ok("…and the clamped cue is still on screen for a moment",
    early[0]!.end > early[0]!.start);

  const slower = stretchCues(base, 25 / 24);
  ok("a stretch scales every time", near(slower[1]!.start, 4 * (25 / 24)));
  ok("a nonsense factor leaves the track alone",
    stretchCues(base, 0)[1]!.start === 4);

  const joined = mergeCues(base, 0);
  ok("merging two cues leaves one", joined.length === 2);
  ok("…spanning both", near(joined[0]!.start, 1) && near(joined[0]!.end, 6));
  ok("…with both texts", cueText(joined[0]!).includes("First") && cueText(joined[0]!).includes("Second"));
  ok("merging the last cue with nothing is a no-op", mergeCues(base, 2).length === 3);

  const cut = splitCue(base, 0, 2);
  ok("splitting a cue leaves two", cut.length === 4);
  ok("…meeting at the cut", near(cut[0]!.end, 2) && cut[1]!.start >= 2);
  ok("…with the words divided, not duplicated",
    `${cueText(cut[0]!)} ${cueText(cut[1]!)}` === "First line.");
  ok("a split outside the cue is a no-op", splitCue(base, 0, 99).length === 3);
  ok("a one-word cue cannot be split",
    splitCue([{ index: 1, start: 0, end: 4, lines: ["Right"], speaker: null }], 0, 2).length === 1);

  const edited = setCueText(base, 1, "Something else entirely, at some length, so it wraps.");
  ok("a cue's words can be replaced", cueText(edited[1]!).startsWith("Something else"));
  ok("…and are re-wrapped to the style", edited[1]!.lines.every((l) => l.length <= STYLE.chars));
  ok("…without moving it", near(edited[1]!.start, 4) && near(edited[1]!.end, 6));

  const retimed = setCueTime(base, 2, 7.5, 7.6);
  ok("a cue's times can be set", near(retimed[2]!.start, 7.5));
  ok("…but not to nothing", retimed[2]!.end > retimed[2]!.start);

  ok("a cue can be removed", removeCue(base, 1).length === 2);
  ok("…and the rest renumber", removeCue(base, 1).map((c) => c.index).join("") === "12");
  ok("removing a cue that isn't there changes nothing", removeCue(base, 9).length === 3);

  ok("the cue on screen is found by time", cueAt(base, 5)?.index === 2);
  ok("…and between cues there is none", cueAt(base, 3.5) === null);
  ok("…and a cue ends before its end time, not after",
    cueAt(base, 3) === null && cueAt(base, 2.999)?.index === 1);
}

// ── The panel ───────────────────────────────────────────────────────────────

/*
 * Every query is scoped to the panel that is *open*. A closed panel stays in
 * the DOM hidden, and a bare `.subs-row` would read rows out of one that was
 * shut two blocks ago — the same mistake that cost twenty minutes in item 30's
 * harness, written down here so it costs nothing in this one.
 */
const LIVE = ".subs:not([hidden])";
const all = <T extends HTMLElement>(sel: string): T[] =>
  [...document.querySelectorAll<T>(`${LIVE} ${sel}`)];
const $ = <T extends HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(`${LIVE} ${sel}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A button by what it says, since that is how the user finds it too. */
const btn = (label: string): HTMLButtonElement | null =>
  all<HTMLButtonElement>("button").find((b) => b.textContent === label) ?? null;
const press = (label: string): void => btn(label)?.click();

const noteOf = (): string => $(".subs-note")?.textContent ?? "";
const statusOf = (): string => $(".subs-status")?.textContent ?? "";
const rows = (): HTMLElement[] => all(".subs-row");
const textsOf = (): string[] => all<HTMLTextAreaElement>(".subs-text").map((t) => t.value);
const captionOf = (): string => {
  const cap = $(".subs-caption");
  return cap && !cap.hidden ? (cap.textContent ?? "") : "";
};

/** Type into a cue the way a person does — one event, not a method call. */
function type(at: number, text: string): void {
  const field = all<HTMLTextAreaElement>(".subs-text")[at];
  if (!field) return;
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Put a time in a time field and commit it. */
function retime(at: number, which: 0 | 1, text: string): void {
  const field = all<HTMLInputElement>(".subs-row .subs-time")[at * 2 + which];
  if (!field) return;
  field.value = text;
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

const FILM = "C:/films/talk.mp4";

async function viewChecks(): Promise<void> {
  const disk: Array<{ path: string; text: string }> = [];
  const jobs: SubtitleJob[] = [];
  let stopped = 0;

  const host: SubtitleHost = {
    // Deliberately not a real video: nothing here needs pictures, and a fixture
    // that needs a decoder is a fixture that fails on somebody else's machine.
    fileUrl: () => Promise.resolve("data:video/mp4;base64,AAAAIGZ0eXBpc29t"),
    writeFile: (path, bytes) => {
      disk.push({ path, text: new TextDecoder().decode(bytes) });
      return Promise.resolve(path);
    },
    refresh: () => undefined,
    runJob: (job) => {
      jobs.push(job);
      return Promise.resolve(7);
    },
    cancelJob: (id) => {
      stopped = id;
      return Promise.resolve();
    },
    onProgress: () => () => undefined,
    onDone: () => () => undefined,
  };

  const view = new SubtitleView(host);

  // ── Opening on a transcript ───────────────────────────────────────────────
  {
    await view.open(FILM, { segments: PROSE });
    ok("the panel opens on the film", view.isOpen && view.openPath === FILM);
    ok("…titled with the file, not the path",
      $(".subs-title")?.textContent === "talk.mp4", $(".subs-title")?.textContent ?? "");
    ok("…with a row for every cue", rows().length === view.track.length && rows().length > 0);
    ok("…numbered from one", $(".subs-num-cell")?.textContent === "1");
    ok("…and the count said out loud", statusOf().startsWith(`${rows().length} cue`), statusOf());
    ok("nothing was said to be wrong with our own cueing",
      !statusOf().includes("to look at"), statusOf());
    ok("the picture is shown when there is one", $(".subs-stage")?.hidden === false);
  }

  // ── Typing ────────────────────────────────────────────────────────────────
  {
    const was = view.track.length;
    type(0, "Changed by hand.");
    ok("typing in a cue changes the track", cueText(view.track[0]!) === "Changed by hand.");
    ok("…without disturbing any other cue", view.track.length === was);
    /* The row is not rebuilt while it is being typed into. If it were, the
       caret would jump to the end on every keystroke — the single most
       irritating bug a text editor can have, and invisible to a test that only
       checks the model. */
    ok("…and without replacing the field under the caret",
      textsOf()[0] === "Changed by hand.", JSON.stringify(textsOf()[0]));

    type(1, "A break\nthe user chose.");
    ok("a hand-made line break is kept exactly as typed",
      view.track[1]?.lines.length === 2 && view.track[1]?.lines[0] === "A break");

    press("Tidy lines");
    ok("…until the track is tidied", view.track[1]?.lines.join(" ") === "A break the user chose.");
    ok("…which re-wraps rather than re-cues", view.track.length === was);
  }

  // ── Timings ───────────────────────────────────────────────────────────────
  {
    retime(0, 0, "0:02.500");
    ok("a start can be typed", near(view.track[0]!.start, 2.5), String(view.track[0]!.start));
    retime(0, 1, "nonsense");
    ok("…and nonsense is refused rather than swallowed",
      noteOf().includes("not a time"), noteOf());
    ok("…leaving the cue as it was", near(view.track[0]!.start, 2.5));

    const before = view.track.map((c) => c.start);
    press("+0.5s");
    ok("every cue can be nudged later",
      view.track.every((c, i) => near(c.start, (before[i] ?? 0) + 0.5)));
    press("-0.5s");
    ok("…and back", view.track.every((c, i) => near(c.start, before[i] ?? 0)));
  }

  // ── Structure ─────────────────────────────────────────────────────────────
  {
    const was = view.track.length;
    rows()[1]?.click();
    ok("clicking a row chooses it", rows()[1]?.classList.contains("subs-chosen") === true);

    all<HTMLElement>(".subs-row")[1]?.querySelectorAll<HTMLElement>(".subs-act")[1]?.click();
    ok("a cue can be joined to the next", view.track.length === was - 1);
    ok("…and the rows follow the model", rows().length === view.track.length);

    all<HTMLElement>(".subs-row")[0]?.querySelectorAll<HTMLElement>(".subs-act")[2]?.click();
    ok("a cue can be deleted", view.track.length === was - 2);
    ok("…and the rest renumber", $(".subs-num-cell")?.textContent === "1");
  }

  // ── What is wrong with a track ────────────────────────────────────────────
  {
    await view.open(FILM, {
      cues: [
        { index: 1, start: 0, end: 0.4, lines: ["Far too many words to read in four tenths of a second."], speaker: null },
        { index: 2, start: 5, end: 8, lines: ["This one is fine."], speaker: null },
      ],
    });
    ok("a cue nobody could read is flagged", rows()[0]?.classList.contains("subs-warn") === true);
    ok("…with the reason on the badge", ($(".subs-flag")?.title ?? "").length > 0);
    ok("…and counted in the status line", statusOf().includes("to look at"), statusOf());
    ok("a cue that is fine is not flagged",
      rows()[1]?.classList.contains("subs-warn") === false);
  }

  // ── Following the picture ─────────────────────────────────────────────────
  {
    /* No decoder in this fixture, so `currentTime` is only the default playback
       position — which is exactly what a seek writes, and enough to prove the
       overlay and the list are reading the same clock. */
    rows()[1]?.click();
    await sleep(20);
    ok("choosing a cue seeks to it",
      near($<HTMLVideoElement>(".subs-video")!.currentTime, 5));
    ok("…and the overlay shows that cue's words",
      captionOf() === "This one is fine.", captionOf());
    ok("…and the list marks where the film is",
      rows()[1]?.classList.contains("subs-now") === true);
  }

  // ── Out to a file ─────────────────────────────────────────────────────────
  {
    disk.length = 0;
    press("Save .srt");
    await sleep(20);
    ok("a sidecar is written beside the film, not over it",
      disk[0]?.path === "C:/films/talk.srt", disk[0]?.path ?? "");
    ok("…and reads back as the same track",
      parseSubtitles(disk[0]?.text ?? "").length === view.track.length);
    press("Save .vtt");
    await sleep(20);
    ok("WebVTT goes to its own extension", disk[1]?.path === "C:/films/talk.vtt");
    ok("…and says so on the first line",
      (disk[1]?.text ?? "").startsWith("WEBVTT"));
    ok("saving is reported, since nothing else on screen changes",
      noteOf().includes("talk.vtt"), noteOf());
  }

  // ── Burning in ────────────────────────────────────────────────────────────
  {
    jobs.length = 0;
    press("Burn in…");
    await sleep(20);
    ok("burning in starts a job", jobs.length === 1);
    ok("…on the film that is open", jobs[0]?.inputs[0] === FILM);
    ok("…writing a copy, never the original",
      jobs[0]?.output === "C:/films/talk (subtitled).mp4", jobs[0]?.output ?? "");
    ok("…and says so before it starts",
      noteOf().includes("original"), noteOf());
    ok("…carrying the cues as SubRip text",
      (jobs[0]?.subtitles.text ?? "").includes("-->") &&
      parseSubtitles(jobs[0]?.subtitles.text ?? "").length === view.track.length);
    ok("…and the look the user set",
      jobs[0]?.subtitles.size === 5.5 && jobs[0]?.subtitles.margin === 4);
    ok("the progress bar is up while it runs", $(".subs-progress")?.hidden === false);

    press("Stop");
    await sleep(20);
    ok("a burn can be stopped", stopped === 7);
    ok("…and the panel says the original is untouched",
      noteOf().includes("untouched"), noteOf());
    ok("…and puts the button back", btn("Burn in…") !== null);
  }

  // ── A sidecar opened on its own ───────────────────────────────────────────
  {
    const file = "1\n00:00:01,000 --> 00:00:03,000\nAda: One.\n\n2\n00:00:04,000 --> 00:00:06,000\nAda: Two.\n";
    await view.open("C:/films/orphan.srt", { text: file });
    ok("a subtitle file opens as itself", rows().length === 2);
    ok("…with no picture to check it against", $(".subs-stage")?.hidden === true);
    ok("…and says so rather than showing a black rectangle",
      noteOf().includes("No video"), noteOf());
    press("Burn in…");
    await sleep(20);
    ok("…and refuses to burn a subtitle file into itself",
      noteOf().includes("import"), noteOf());
    view.close();
    ok("the panel closes", !view.isOpen);
  }

  // ── Without the desktop app ───────────────────────────────────────────────
  {
    /* Everything but the encoder works in a plain browser tab, and the button
       that cannot work says why instead of being missing — a sidecar is the
       better answer most of the time anyway. */
    const web = new SubtitleView({
      fileUrl: host.fileUrl,
      writeFile: host.writeFile,
      refresh: () => undefined,
    });
    await web.open(FILM, { segments: PROSE });
    ok("the editor works with no encoder behind it", rows().length > 0);
    press("Burn in…");
    await sleep(20);
    ok("…and burning in explains what it needs",
      noteOf().includes("desktop app"), noteOf());
    web.close();
  }

  // ── Nothing at all ────────────────────────────────────────────────────────
  {
    await view.open(FILM);
    ok("an empty track is not an error", view.isOpen && rows().length === 0);
    ok("…and says what to do about it",
      ($(".subs-empty")?.textContent ?? "").includes("Import"),
      $(".subs-empty")?.textContent ?? "");
    press("Save .srt");
    await sleep(20);
    ok("…and refuses to write an empty file",
      noteOf().includes("nothing to save"), noteOf());
    view.close();
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

void viewChecks().then(() => {
  const line = `sub: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  document.title = line;
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
});
