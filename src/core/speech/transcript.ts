/**
 * A transcript: what was said, when, and by whom — and the arithmetic that
 * turns a pile of overlapping model outputs into one.
 *
 * Nothing here loads a model, decodes audio, or touches the DOM. The parts of
 * transcription that are hard to get right are not the parts that run the
 * network; they are the seams — where one thirty-second window ends and the
 * next begins, where one speaker stops and another starts, and where a run of
 * words has to become lines short enough to read. Those are all arithmetic on
 * numbers and strings, which means they can be checked exhaustively in a
 * harness without a 200 MB download. That is the whole reason this file exists
 * separately from the worker that calls it.
 *
 * **Why we do our own windowing.** transformers.js will chunk long audio
 * itself, given `chunk_length_s`. It wants the entire recording in memory as
 * one Float32Array first: at 16 kHz mono that is 64 KB per second, so a
 * two-hour meeting is about 460 MB of samples before the model has seen a
 * single frame — on top of the model. Planning the windows ourselves lets the
 * caller decode a minute, transcribe it, drop it, and move on, and it is what
 * makes a progress bar possible at all.
 */

/** One word, with the model's idea of when it was said. */
export interface Word {
  start: number;
  end: number;
  text: string;
}

/**
 * A run of speech the model emitted as a unit — typically a phrase or a
 * sentence, a few seconds long.
 *
 * `words` is empty rather than absent when the model was not asked for word
 * timings, so callers never branch on undefined. `speaker` is null rather than
 * absent for the same reason, and stays null when nobody asked for speaker
 * turns; an unlabelled transcript is a perfectly good transcript.
 */
export interface Segment {
  start: number;
  end: number;
  text: string;
  words: Word[];
  speaker: string | null;
}

/** A stretch of time one person was talking, from the segmentation model. */
export interface Turn {
  start: number;
  end: number;
  speaker: string;
}

/** One slice of audio to hand the model. */
export interface Window {
  index: number;
  start: number;
  end: number;
}

/** What the model gave back for one window, in that window's own time base. */
export interface WindowResult {
  window: Window;
  segments: Segment[];
}

export interface PlanOptions {
  /**
   * Seconds per window. Whisper's encoder is fixed at 30 s of mel frames —
   * shorter windows are padded, longer ones are truncated and the tail is
   * silently lost — so this is not a free parameter for Whisper models.
   */
  window?: number;
  /**
   * Seconds each window reaches back into the one before it. A word cut in
   * half by a boundary is mis-heard by both windows; the overlap means every
   * moment is heard once with a running start and once with a follow-through,
   * and `mergeWindows` keeps whichever reading had more context.
   */
  overlap?: number;
}

const WINDOW = 30;
const OVERLAP = 5;

/**
 * Anything shorter than this left over at the end is not worth its own window:
 * a second of audio in a thirty-second window is 29 seconds of padding, and
 * Whisper's response to mostly-silence is to invent something — usually the
 * subtitle credits from its training set.
 */
const RUNT = 2;

const clean = (n: number): number => (Number.isFinite(n) ? n : 0);

/**
 * Cuts a duration into overlapping windows.
 *
 * Always returns at least one window for a positive duration, so a caller can
 * loop over the result without a special case for very short files.
 */
export function planWindows(duration: number, opts: PlanOptions = {}): Window[] {
  const span = Math.max(0, clean(duration));
  const size = Math.max(1, clean(opts.window ?? WINDOW));
  // An overlap at or past the window size would never advance; clamped rather
  // than rejected so a bad setting is slow, not a hang.
  const lap = Math.min(Math.max(0, clean(opts.overlap ?? OVERLAP)), size - 0.5);
  const stride = size - lap;

  if (span <= 0) return [];
  if (span <= size) return [{ index: 0, start: 0, end: span }];

  const out: Window[] = [];
  for (let start = 0; start < span; start += stride) {
    const end = Math.min(span, start + size);
    out.push({ index: out.length, start, end });
    if (end >= span) break;
  }

  // Fold a runt tail back into its predecessor. It cannot make that window
  // longer than `size` — the runt is by definition shorter than the overlap
  // the two already share — so the encoder still gets a window it can hold.
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  if (out.length > 1 && last && prev && last.end - last.start < RUNT) {
    prev.end = last.end;
    out.pop();
  }
  return out;
}

/**
 * Stitches per-window results into one transcript.
 *
 * Where two windows overlap they both claim the same seconds, usually with
 * slightly different wording. The rule is the midpoint of the shared region:
 * everything before it comes from the earlier window, everything after it from
 * the later one. Both readings of the seam therefore come from a window that
 * had run-up on one side and follow-through on the other, which is exactly the
 * context a word needs to be heard correctly — and no word is dropped or said
 * twice, which a "take the first" or "take the longest" rule cannot promise.
 *
 * Segments are assumed to be in each window's own time base; the window's
 * start is added here. Callers that already offset their timestamps would
 * otherwise have to un-offset them, and one convention is better than two.
 */
export function mergeWindows(results: readonly WindowResult[]): Segment[] {
  const ordered = [...results].sort((a, b) => a.window.start - b.window.start);
  const out: Segment[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i];
    if (!r) continue;
    const before = ordered[i - 1];
    const after = ordered[i + 1];

    // Where this window starts owning the audio, and where it stops.
    const from = before ? midpoint(before.window, r.window) : -Infinity;
    const upto = after ? midpoint(r.window, after.window) : Infinity;

    for (const seg of r.segments) {
      const start = seg.start + r.window.start;
      const end = seg.end + r.window.start;
      // A segment belongs to the window that owns its middle. Judging by its
      // start alone loses a sentence that begins a moment before the seam and
      // runs well past it — the later window will have judged it too early to
      // be its own, and nobody keeps it.
      const centre = (start + end) / 2;
      if (centre < from || centre >= upto) continue;
      out.push({
        start,
        end,
        text: seg.text,
        words: seg.words.map((w) => ({
          start: w.start + r.window.start,
          end: w.end + r.window.start,
          text: w.text,
        })),
        speaker: seg.speaker,
      });
    }
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/** The middle of the region two consecutive windows share. */
function midpoint(a: Window, b: Window): number {
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  return hi > lo ? (lo + hi) / 2 : b.start;
}

/** One window's worth of segmentation output, in that window's own time base. */
export interface LocalTurns {
  window: Window;
  /** Labels are the model's, and mean nothing outside this window. */
  turns: Turn[];
}

/**
 * The stretches of the recording somebody was talking in, from per-window
 * segmentation output — deduplicated, on the recording's clock, and with the
 * model's own speaker labels reduced to what they are actually worth.
 *
 * A segmentation model asked about seconds 0–30 will say two people spoke and
 * call them 0 and 1. Asked about 25–55 it will again say 0 and 1, with no
 * promise that either 0 is the same person. So the labels are kept only as a
 * grouping *within* one window, namespaced by the window they came from, and
 * are never compared across windows. Deciding that two of these regions are
 * the same person is `clusterSpeakers`' job, and it does it by listening to
 * them rather than by assuming.
 *
 * Ownership is the same midpoint rule the words use, so the seconds two
 * windows share produce one region rather than two overlapping ones.
 */
export function speechRegions(perWindow: readonly LocalTurns[]): Turn[] {
  const ordered = [...perWindow].sort((a, b) => a.window.start - b.window.start);
  const out: Turn[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const w = ordered[i];
    if (!w) continue;
    const before = ordered[i - 1];
    const after = ordered[i + 1];
    const from = before ? midpoint(before.window, w.window) : -Infinity;
    const upto = after ? midpoint(w.window, after.window) : Infinity;

    for (const t of w.turns) {
      const start = Math.max(t.start + w.window.start, from === -Infinity ? -Infinity : from);
      const end = Math.min(t.end + w.window.start, upto);
      if (!(end > start)) continue;
      out.push({ start, end, speaker: `${w.window.index}:${t.speaker}` });
    }
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/** A speech region with the voice print of whoever was talking in it. */
export interface Voiced extends Turn {
  /** A speaker-embedding vector. Length is the model's; only its shape matters here. */
  embedding: readonly number[];
}

export interface ClusterOptions {
  /**
   * Cosine similarity above which two regions are the same voice.
   *
   * The one number in transcription that a person will actually want to
   * change. Too high and one person becomes three every time they raise their
   * voice; too low and a meeting becomes one speaker. The default suits the
   * wespeaker ResNet models, which put same-speaker pairs comfortably above
   * 0.7 and different-speaker pairs below 0.5 — 0.62 sits in the gap.
   */
  threshold?: number;
  /**
   * How many people were in the room, if the user says so. Given, the
   * clustering keeps merging past the threshold until it has this many, which
   * is much the stronger signal — a person who knows there were two of them
   * knows something no model does.
   */
  speakers?: number;
}

const THRESHOLD = 0.62;

/**
 * Groups speech regions by voice, and names the groups.
 *
 * Agglomerative clustering with average linkage over cosine similarity: start
 * with every region its own speaker, repeatedly merge the two most alike, stop
 * when the closest pair is no longer alike enough. Average linkage rather than
 * nearest-neighbour because nearest-neighbour chains — a sequence of pairs
 * each just similar enough drags two genuinely different voices into one
 * cluster — and rather than furthest-neighbour because that splits a speaker
 * over one bad three-word region.
 *
 * The point of doing it this way rather than by matching up neighbouring
 * windows is that it does not care about time at all. Somebody who says
 * nothing for ten minutes and then speaks again is recognised as themselves,
 * because what is being compared is their voice and not their proximity.
 *
 * Names are given in order of first appearance, so "Speaker 1" is whoever
 * spoke first — which is what a reader assumes, and is not what cluster
 * indices give you.
 */
export function clusterSpeakers(
  regions: readonly Voiced[],
  opts: ClusterOptions = {},
): Turn[] {
  const usable = regions.filter((r) => r.end > r.start && r.embedding.length > 0);
  if (usable.length === 0) return [];

  const unit = usable.map((r) => normalise(r.embedding));
  const want = opts.speakers && opts.speakers > 0 ? Math.floor(opts.speakers) : 0;
  const limit = opts.threshold ?? THRESHOLD;

  // Members of each live cluster, by index into `usable`.
  let groups: number[][] = usable.map((_, i) => [i]);

  while (groups.length > 1) {
    let best = -Infinity;
    let a = -1;
    let b = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const s = linkage(groups[i] as number[], groups[j] as number[], unit);
        if (s > best) {
          best = s;
          a = i;
          b = j;
        }
      }
    }
    if (a < 0 || b < 0) break;

    // A known head count outranks the threshold in both directions: keep
    // merging below it to reach the count, and stop at it even if two regions
    // still look alike.
    const merge = want > 0 ? groups.length > want : best >= limit;
    if (!merge) break;

    const ga = groups[a] as number[];
    const gb = groups[b] as number[];
    groups = groups.filter((_, i) => i !== a && i !== b);
    groups.push([...ga, ...gb]);
  }

  // Named by when each group is first heard, not by where it landed in the
  // merge order — which is an implementation detail nobody should be reading.
  const firstHeard = (g: number[]): number =>
    Math.min(...g.map((i) => (usable[i] as Voiced).start));
  groups.sort((x, y) => firstHeard(x) - firstHeard(y));

  const named = new Map<number, string>();
  groups.forEach((g, n) => {
    for (const i of g) named.set(i, `Speaker ${n + 1}`);
  });

  return mergeTurns(
    usable.map((r, i) => ({
      start: r.start,
      end: r.end,
      speaker: named.get(i) ?? "Speaker 1",
    })),
  );
}

/** Mean pairwise cosine similarity between two groups of unit vectors. */
function linkage(a: readonly number[], b: readonly number[], unit: number[][]): number {
  let sum = 0;
  for (const i of a) {
    for (const j of b) sum += dot(unit[i] as number[], unit[j] as number[]);
  }
  return sum / (a.length * b.length);
}

function dot(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/** Scaled to length 1, so a dot product *is* the cosine similarity. */
function normalise(v: readonly number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  // A zero vector means the embedding model was handed silence. Left as zeros:
  // it then has similarity 0 with everything and clusters alone, which is a
  // more honest outcome than dividing by nothing.
  return len > 0 ? Array.from(v, (x) => x / len) : Array.from(v, () => 0);
}

/**
 * Collapses a segmentation model's output into speaker turns.
 *
 * Two things to fix. Segmentation runs on its own short frames and emits one
 * region per frame, so a single uninterrupted sentence arrives as a dozen
 * abutting regions with the same label; and it puts a boundary in every breath,
 * so "…and then — we left" becomes two turns with a 300 ms hole. Both are
 * repaired by the same pass: adjacent same-speaker regions closer together
 * than `gap` become one.
 */
export function mergeTurns(turns: readonly Turn[], gap = 0.75): Turn[] {
  const ordered = [...turns]
    .filter((t) => t.end > t.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: Turn[] = [];
  for (const t of ordered) {
    const last = out[out.length - 1];
    if (last && last.speaker === t.speaker && t.start - last.end <= gap) {
      last.end = Math.max(last.end, t.end);
      continue;
    }
    out.push({ ...t });
  }
  return out;
}

/**
 * Labels each segment with whoever was talking through most of it.
 *
 * The two models do not agree on boundaries and never will — one is looking
 * for words and the other for voices — so this is an overlap vote rather than
 * a lookup: the speaker who holds the most of a segment's seconds gets it. A
 * segment nobody overlaps keeps a null speaker rather than being guessed at.
 *
 * Where word timings are available and a segment genuinely straddles a
 * handover, it is split at the boundary instead of being handed wholesale to
 * the loudest party — that is the case where a vote would put one person's
 * words in another person's mouth, which is the one error in a transcript that
 * is worse than a missing word.
 */
export function assignSpeakers(
  segments: readonly Segment[],
  turns: readonly Turn[],
): Segment[] {
  const said = mergeTurns(turns);
  if (said.length === 0) return segments.map((s) => ({ ...s }));

  const out: Segment[] = [];
  for (const seg of segments) {
    const parts = splitAcrossTurns(seg, said);
    for (const part of parts) out.push(part);
  }
  return out;
}

function splitAcrossTurns(seg: Segment, turns: readonly Turn[]): Segment[] {
  const whole = { ...seg, words: seg.words.map((w) => ({ ...w })) };
  const winner = bestSpeaker(seg.start, seg.end, turns);

  // Nothing to split without word timings: there is no honest place to cut the
  // text, and cutting it at a guessed character index would fabricate a quote.
  if (seg.words.length === 0) {
    whole.speaker = winner;
    return [whole];
  }

  const groups: Segment[] = [];
  for (const w of whole.words) {
    const who = bestSpeaker(w.start, w.end, turns) ?? winner;
    const last = groups[groups.length - 1];
    if (last && last.speaker === who) {
      last.end = Math.max(last.end, w.end);
      last.words.push(w);
      last.text = `${last.text} ${w.text.trim()}`.trim();
      continue;
    }
    groups.push({
      start: w.start,
      end: w.end,
      text: w.text.trim(),
      words: [w],
      speaker: who,
    });
  }

  if (groups.length <= 1) {
    whole.speaker = groups[0]?.speaker ?? winner;
    return [whole];
  }

  /*
   * A single word attributed to the other party is far more likely to be a
   * boundary that landed a beat early than a real interjection, and promoting
   * it to its own line reads as an interruption that did not happen. Fold
   * those back into whichever neighbour is longer and keep the rest.
   */
  return absorbSingletons(groups, winner);
}

function absorbSingletons(groups: Segment[], fallback: string | null): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g) continue;
    const alone = g.words.length === 1 && groups.length > 1;
    const prev = out[out.length - 1];
    const next = groups[i + 1];
    if (alone && (prev || next)) {
      const host =
        prev && next
          ? prev.words.length >= next.words.length
            ? prev
            : next
          : (prev ?? next);
      if (host === prev && prev) {
        prev.end = Math.max(prev.end, g.end);
        prev.words.push(...g.words);
        prev.text = `${prev.text} ${g.text}`.trim();
        continue;
      }
      if (next) {
        next.start = Math.min(next.start, g.start);
        next.words.unshift(...g.words);
        next.text = `${g.text} ${next.text}`.trim();
        continue;
      }
    }
    out.push({ ...g, speaker: g.speaker ?? fallback });
  }
  return out;
}

/** Whoever holds the most of [start, end); null if nobody holds any of it. */
function bestSpeaker(
  start: number,
  end: number,
  turns: readonly Turn[],
): string | null {
  let who: string | null = null;
  let most = 0;
  for (const t of turns) {
    const shared = Math.min(end, t.end) - Math.max(start, t.start);
    if (shared > most) {
      most = shared;
      who = t.speaker;
    }
  }
  return most > 0 ? who : null;
}

export interface TextOptions {
  /** Prefix each change of speaker with their name. */
  speakers?: boolean;
  /** Prefix each paragraph with its start time. */
  timestamps?: boolean;
}

/**
 * The transcript as prose — one paragraph per speaker turn, which is how a
 * transcript is read when it is not being used as subtitles.
 *
 * Consecutive segments by the same speaker run together into a paragraph; a
 * change of speaker starts a new one. With no speakers assigned the whole
 * thing is one paragraph per segment run, which is the right shape for a
 * dictation or a voice memo.
 */
export function transcriptText(
  segments: readonly Segment[],
  opts: TextOptions = {},
): string {
  const paras: Array<{ start: number; speaker: string | null; text: string }> = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const last = paras[paras.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.text = `${last.text} ${text}`;
      continue;
    }
    paras.push({ start: seg.start, speaker: seg.speaker, text });
  }

  return paras
    .map((p) => {
      const head: string[] = [];
      if (opts.timestamps) head.push(`[${clockOf(p.start)}]`);
      if (opts.speakers && p.speaker) head.push(`${p.speaker}:`);
      return head.length ? `${head.join(" ")} ${p.text}` : p.text;
    })
    .join("\n\n");
}

/** `h:mm:ss`, dropping the hour when there isn't one. For reading, not for files. */
export function clockOf(seconds: number): string {
  const s = Math.max(0, Math.floor(clean(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
