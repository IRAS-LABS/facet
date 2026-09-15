/**
 * The player: what turns a document and a voice into someone reading to you.
 *
 * Everything the control bar does goes through here, and everything the
 * highlight shows comes out of here. The UI holds no playback state of its own
 * -- it draws what the player reports and calls what the user pressed -- which
 * is the only arrangement where the phone sheet and the desktop panel cannot
 * drift into disagreeing about what is playing.
 *
 * Two behaviours are worth explaining because they look like extra work and
 * are the difference between this feeling good and feeling cheap:
 *
 * **Changing speed does not start the sentence again.** Neither engine can
 * change the rate of audio already in flight, so the honest implementation is
 * to stop, and resume from the word that was being spoken -- not from the top
 * of the sentence. The user hears the speed change and keeps their place. The
 * naive version restarts the sentence, and after three taps on the speed
 * control you have heard the same clause four times.
 *
 * **The next sentence is prepared while this one is speaking.** Kokoro takes
 * a few hundred milliseconds to synthesise and rather longer on a phone.
 * Without the look-ahead there is a gap at every full stop, and a gap at every
 * full stop is what makes a reader sound like a machine reading a list rather
 * than a person reading a paragraph.
 */

import { spoken, type CleanOptions, CLEAN } from "./cleanup";
import type { Engine, Speaking } from "./engine";
import type { ReadBlock, ReadDoc, Step } from "./doc";
import { steps as stepsOf } from "./doc";
import { KokoroEngine } from "./kokoro";

export type PlayState = "idle" | "playing" | "paused" | "loading";

/** What the reader needs to draw itself. */
export interface Position {
  state: PlayState;
  /** Index into the play list. */
  step: number;
  steps: number;
  /** Which block and sentence, for the highlight. */
  block: number;
  sentence: number;
  /** Which word inside the block, or -1 before the first report arrives. */
  word: number;
  /** 0-1 through the whole document, by word count. */
  progress: number;
  page: number;
}

export interface PlayerOptions {
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
  /** Start again at the top when the end is reached (item 31). */
  repeat: boolean;
  clean: CleanOptions;
}

export const DEFAULTS: PlayerOptions = {
  voice: "",
  rate: 1,
  pitch: 1,
  volume: 1,
  repeat: false,
  clean: CLEAN,
};

type Listener = (p: Position) => void;

export class Player {
  private doc: ReadDoc | null = null;
  private list: Step[] = [];
  private at = 0;
  /** Word index within the current block, or -1. */
  private word = -1;
  /** Where in the current sentence to resume from after a settings change. */
  private resumeChar = 0;
  private state: PlayState = "idle";
  private current: Speaking | null = null;
  private listeners = new Set<Listener>();
  /** Bumped on every stop, so a late `onEnd` from a cancelled utterance is ignored. */
  private token = 0;
  private wordsBefore: number[] = [];

  opts: PlayerOptions = { ...DEFAULTS };

  constructor(private engine: Engine) {}

  // ── Wiring ────────────────────────────────────────────────────────────────

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const p = this.position();
    for (const fn of this.listeners) fn(p);
  }

  /** Swap the engine, keeping the place. */
  async setEngine(engine: Engine): Promise<void> {
    const wasPlaying = this.state === "playing";
    this.halt();
    this.engine.dispose?.();
    this.engine = engine;
    if (wasPlaying) await this.play();
    else this.emit();
  }

  get engineId(): string {
    return this.engine.id;
  }

  /**
   * Load a document.
   *
   * Resets the position rather than trying to keep it: the block indices of
   * the old document mean nothing in the new one, and a reader that resumes
   * halfway into a different paper is worse than one that starts at the top.
   */
  load(doc: ReadDoc): void {
    this.halt();
    this.doc = doc;
    this.rebuild();
    this.at = 0;
    this.word = -1;
    this.resumeChar = 0;
    this.state = "idle";
    this.emit();
  }

  /**
   * Recompute the play list after blocks were skipped, unskipped or moved.
   *
   * The current step is carried across by identity rather than by index -- the
   * block it pointed at keeps playing even if six blocks above it were just
   * excluded, which is what the user expects when they tick "skip captions"
   * mid-paragraph.
   */
  rebuild(): void {
    if (!this.doc) return;
    const was = this.list[this.at];
    this.list = stepsOf(this.doc);

    // A running total of words before each step, so progress is a single
    // lookup rather than a sum over the whole document on every word.
    this.wordsBefore = [];
    let total = 0;
    for (const step of this.list) {
      this.wordsBefore.push(total);
      const block = this.doc.blocks[step.block];
      const sentence = block?.sentences[step.sentence];
      total += sentence ? sentence.last - sentence.first + 1 : 0;
    }

    if (was) {
      const again = this.list.findIndex((s) => s.block === was.block && s.sentence === was.sentence);
      this.at = again >= 0 ? again : Math.min(this.at, Math.max(0, this.list.length - 1));
    }
  }

  // ── Where we are ──────────────────────────────────────────────────────────

  position(): Position {
    const step = this.list[this.at];
    const block = step ? this.doc?.blocks[step.block] : undefined;
    const before = this.wordsBefore[this.at] ?? 0;
    const total = this.totalWords();
    const inside = this.word >= 0 && block ? Math.max(0, this.word - (block.sentences[step?.sentence ?? 0]?.first ?? 0)) : 0;

    return {
      state: this.state,
      step: this.at,
      steps: this.list.length,
      block: step?.block ?? -1,
      sentence: step?.sentence ?? -1,
      word: this.word,
      progress: total > 0 ? Math.min(1, (before + inside) / total) : 0,
      page: block?.page ?? 0,
    };
  }

  private totalWords(): number {
    const last = this.wordsBefore[this.wordsBefore.length - 1] ?? 0;
    const step = this.list[this.list.length - 1];
    const block = step ? this.doc?.blocks[step.block] : undefined;
    const sentence = block?.sentences[step?.sentence ?? 0];
    return last + (sentence ? sentence.last - sentence.first + 1 : 0);
  }

  /** The text of the step at `i`, as it will be spoken. */
  private textAt(i: number): string {
    const step = this.list[i];
    const block = step ? this.doc?.blocks[step.block] : undefined;
    const sentence = block?.sentences[step?.sentence ?? 0];
    if (!block || !sentence) return "";
    // An equation is announced rather than read, and the substitution applies
    // to the whole block, so a sentence inside one is the block's stand-in.
    if (block.kind === "equation") return spoken(block, this.opts.clean);
    return block.text.slice(sentence.from, sentence.to);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  async play(): Promise<void> {
    if (!this.doc || this.list.length === 0) return;

    if (this.state === "paused" && this.current) {
      if (this.current.resume()) {
        this.state = "playing";
        this.emit();
        return;
      }
    }

    await this.speakFrom(this.at, this.resumeChar);
  }

  pause(): void {
    if (this.state !== "playing") return;
    if (this.current?.pause()) {
      this.state = "paused";
    } else {
      // An engine that cannot pause is stopped, and resumes by re-speaking
      // from the word it had reached.
      this.halt();
      this.state = "paused";
    }
    this.emit();
  }

  toggle(): void {
    if (this.state === "playing") this.pause();
    else void this.play();
  }

  stop(): void {
    this.halt();
    this.at = 0;
    this.word = -1;
    this.resumeChar = 0;
    this.state = "idle";
    this.emit();
  }

  /** Stop the engine without changing where we are. */
  private halt(): void {
    this.token++;
    this.current?.stop();
    this.current = null;
  }

  // ── Moving around (item 29) ───────────────────────────────────────────────

  /** Next or previous sentence. */
  sentence(delta: number): void {
    this.go(this.at + delta);
  }

  /** Next or previous paragraph: the first sentence of the adjacent block. */
  paragraph(delta: number): void {
    const here = this.list[this.at];
    if (!here) return;

    if (delta < 0) {
      // Going back from mid-paragraph returns to its start first, the way a
      // track-back button does. A second press goes to the paragraph before.
      if (here.sentence > 0) {
        this.go(this.at - here.sentence);
        return;
      }
      for (let i = this.at - 1; i >= 0; i--) {
        const s = this.list[i] as Step;
        if (s.block !== here.block && s.sentence === 0) return this.go(i);
      }
      this.go(0);
      return;
    }

    for (let i = this.at + 1; i < this.list.length; i++) {
      if ((this.list[i] as Step).block !== here.block) return this.go(i);
    }
    this.go(this.list.length);
  }

  /** Next or previous page. */
  page(delta: number): void {
    if (!this.doc) return;
    const here = this.list[this.at];
    const from = here ? (this.doc.blocks[here.block]?.page ?? 0) : 0;
    const want = Math.max(0, Math.min(this.doc.pages - 1, from + delta));

    const found = this.list.findIndex((s) => (this.doc?.blocks[s.block]?.page ?? 0) === want);
    this.go(found >= 0 ? found : delta > 0 ? this.list.length : 0);
  }

  /** Jump to a point in the play list. Used by the scrubber (item 30). */
  seek(fraction: number): void {
    const want = Math.round(fraction * Math.max(0, this.list.length - 1));
    this.go(want);
  }

  /** Start at a block the user tapped (item 18). */
  startAtBlock(blockIndex: number): void {
    const found = this.list.findIndex((s) => s.block === blockIndex);
    if (found >= 0) this.go(found);
  }

  /** Start at a word the user tapped (item 34). */
  startAtWord(blockIndex: number, wordIndex: number): void {
    const block = this.doc?.blocks[blockIndex];
    if (!block) return;

    const si = block.sentences.findIndex((s) => wordIndex >= s.first && wordIndex <= s.last);
    const found = this.list.findIndex((s) => s.block === blockIndex && s.sentence === Math.max(0, si));
    if (found < 0) return;

    // Resume from the tapped word rather than the start of its sentence.
    const sentence = block.sentences[Math.max(0, si)];
    const word = block.words[wordIndex];
    const offset = sentence && word ? Math.max(0, word.from - sentence.from) : 0;
    this.at = found;
    this.word = wordIndex;
    this.resumeChar = offset;
    void this.speakFrom(found, offset);
  }

  private go(index: number): void {
    if (!this.doc) return;

    if (index >= this.list.length) {
      if (this.opts.repeat && this.list.length > 0) {
        this.at = 0;
        this.word = -1;
        this.resumeChar = 0;
        void this.speakFrom(0, 0);
        return;
      }
      this.halt();
      this.at = Math.max(0, this.list.length - 1);
      this.word = -1;
      this.resumeChar = 0;
      this.state = "idle";
      this.emit();
      return;
    }

    const want = Math.max(0, index);
    const playing = this.state === "playing";
    this.at = want;
    this.word = -1;
    this.resumeChar = 0;

    if (playing) void this.speakFrom(want, 0);
    else {
      this.halt();
      this.emit();
    }
  }

  // ── Settings that apply live ──────────────────────────────────────────────

  /**
   * Change speed, voice, pitch or volume without losing the place (item 36).
   *
   * Nothing can change the audio already in flight, so if something is
   * playing it is restarted from the word currently being spoken. Small
   * enough that it reads as the setting taking effect, not as a restart.
   */
  set(changes: Partial<PlayerOptions>): void {
    const before = { ...this.opts };
    Object.assign(this.opts, changes);

    const matters =
      before.voice !== this.opts.voice ||
      before.rate !== this.opts.rate ||
      before.pitch !== this.opts.pitch ||
      before.volume !== this.opts.volume;

    if (matters && this.state === "playing") {
      void this.speakFrom(this.at, this.charOfWord());
    } else {
      this.emit();
    }
  }

  /** Where the current word starts, as an offset into the current sentence. */
  private charOfWord(): number {
    const step = this.list[this.at];
    const block = step ? this.doc?.blocks[step.block] : undefined;
    const sentence = block?.sentences[step?.sentence ?? 0];
    const word = this.word >= 0 ? block?.words[this.word] : undefined;
    if (!sentence || !word) return 0;
    return Math.max(0, word.from - sentence.from);
  }

  // ── Speaking ──────────────────────────────────────────────────────────────

  /**
   * Speak step `index`, starting `from` characters into it.
   *
   * The offset is what makes a speed change mid-sentence pick up where the
   * voice was rather than at the full stop before it. Word reports coming back
   * are shifted by the same offset, so the highlight lands on the right word
   * and not `from` characters earlier.
   */
  private async speakFrom(index: number, from: number): Promise<void> {
    if (!this.doc) return;

    if (index >= this.list.length) {
      this.go(index);
      return;
    }

    this.halt();
    const mine = ++this.token;
    const live = (): boolean => this.token === mine;

    this.at = index;
    this.resumeChar = from;

    const step = this.list[index] as Step;
    const block = this.doc.blocks[step.block] as ReadBlock;
    const sentence = block.sentences[step.sentence];
    const full = this.textAt(index);
    const text = from > 0 ? full.slice(from) : full;

    if (!text.trim()) {
      this.go(index + 1);
      return;
    }

    this.state = "loading";
    this.emit();

    // Ask the engine to get the next one ready while this one speaks.
    this.lookAhead(index);

    const speaking = await this.engine.speak(
      {
        text,
        voice: this.opts.voice,
        rate: this.opts.rate,
        pitch: this.opts.pitch,
        volume: this.opts.volume,
      },
      {
        onWord: (at) => {
          if (!live() || !sentence) return;
          const offset = sentence.from + from + at.charIndex;
          const found = block.words.findIndex((w) => w.from <= offset && w.to > offset);
          this.word = found >= 0 ? found : this.word;
          this.resumeChar = from + at.charIndex;
          this.emit();
        },
        onEnd: () => {
          if (!live()) return;
          this.go(index + 1);
        },
        onError: (err) => {
          if (!live()) return;
          this.halt();
          this.state = "idle";
          this.emit();
          this.onError?.(err);
        },
      },
    );

    if (!live()) {
      speaking.stop();
      return;
    }

    this.current = speaking;
    this.state = "playing";
    this.emit();
  }

  /** Warm the engine up on what comes next, where the engine can do that. */
  private lookAhead(index: number): void {
    const engine = this.engine;
    if (!(engine instanceof KokoroEngine)) return;
    const next = this.textAt(index + 1);
    if (next) engine.prepare(next, this.opts.voice, this.opts.rate);
  }

  /** Set by the reader to put a failure on screen. */
  onError?: (err: unknown) => void;

  dispose(): void {
    this.halt();
    this.listeners.clear();
    this.engine.dispose?.();
  }
}
