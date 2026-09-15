/**
 * What a voice has to be able to do.
 *
 * Two engines implement this: the system voices the operating system already
 * has, and Kokoro, which the user downloads once and which sounds far better.
 * Everything above this line -- the player, the highlighter, the phone sheet --
 * is written against this interface and has no idea which one is speaking.
 *
 * The interface is shaped around the two things the player genuinely needs and
 * nothing else: tell me when you reach a word, and tell me when you stop. Word
 * reports are what drive the highlight and the tap-to-jump position, and they
 * are the one capability the two engines provide by completely different means
 * -- the system engine fires real boundary events from inside the synthesiser,
 * Kokoro has to estimate them against the audio clock. Hiding that difference
 * here is what keeps it out of everything else.
 */

/** A voice reached this point in the text it was given. */
export interface WordAt {
  /** Offset into the utterance's own text. */
  charIndex: number;
  length: number;
  /** True when the position is estimated rather than reported. */
  estimated: boolean;
}

export interface SpeakCallbacks {
  onWord?(at: WordAt): void;
  /** Reached the end of the text. Not called after `stop`. */
  onEnd?(): void;
  onError?(err: unknown): void;
}

export interface Utterance {
  text: string;
  /** Engine-specific voice id. */
  voice: string;
  /** 0.5 to 4. */
  rate: number;
  /** 0.5 to 2. Ignored by engines that cannot pitch-shift cleanly. */
  pitch: number;
  /** 0 to 1. */
  volume: number;
}

/** A single in-flight utterance. */
export interface Speaking {
  /** Stops immediately. `onEnd` is not called. Safe to call twice. */
  stop(): void;
  /** Pauses where possible; returns false when the engine cannot. */
  pause(): boolean;
  resume(): boolean;
}

export interface Engine {
  readonly id: "system" | "kokoro";
  /** Human name, for the engine switch. */
  readonly label: string;
  /** Can this engine speak right now, on this machine? */
  ready(): Promise<boolean>;
  voices(): Promise<import("./voices").VoiceInfo[]>;
  speak(u: Utterance, cb: SpeakCallbacks): Promise<Speaking>;
  /** Frees whatever the engine is holding. */
  dispose?(): void;
}

/** Nothing is speaking. Returned when a speak call is superseded before it starts. */
export const SILENT: Speaking = {
  stop() {},
  pause() {
    return false;
  },
  resume() {
    return false;
  },
};

/**
 * Estimate where in the text a voice has got to, from elapsed time.
 *
 * Used by any engine that produces audio in one piece and cannot report its
 * own progress. The estimate is proportional to characters, which is crude but
 * has the property that matters: it is monotonic, it starts at the first word
 * and it lands on the last word exactly when the audio ends, so the highlight
 * never runs ahead of the audio or stalls behind it for long.
 *
 * Word length is a better predictor than word count -- "the" and
 * "phosphorylation" do not take the same time -- and spaces are counted into
 * the word before them so that the gaps between words are attributed to
 * something rather than to nothing.
 */
export function wordSchedule(text: string): { at: number; charIndex: number; length: number }[] {
  const out: { at: number; charIndex: number; length: number }[] = [];
  const total = text.length || 1;
  let cursor = 0;

  for (const m of text.matchAll(/\S+/g)) {
    const charIndex = m.index;
    const length = m[0].length;
    out.push({ at: cursor / total, charIndex, length });
    cursor = charIndex + length;
  }

  return out;
}

/**
 * Drive word callbacks off a clock.
 *
 * Takes the schedule above and a function that reports how far through the
 * audio is, from 0 to 1, and fires each word once as the audio passes it.
 * Driving it off the audio's own clock rather than a timer is what keeps the
 * highlight in step when the audio starts late, stalls, or is paused: a timer
 * would drift apart from the sound on every one of those.
 */
export function followClock(
  schedule: readonly { at: number; charIndex: number; length: number }[],
  progress: () => number,
  onWord: (at: WordAt) => void,
): { stop(): void } {
  let next = 0;
  let live = true;

  const tick = (): void => {
    if (!live) return;
    const p = progress();
    while (next < schedule.length && (schedule[next] as { at: number }).at <= p) {
      const w = schedule[next] as { charIndex: number; length: number };
      onWord({ charIndex: w.charIndex, length: w.length, estimated: true });
      next++;
    }
    if (next < schedule.length) requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  return {
    stop() {
      live = false;
    },
  };
}
