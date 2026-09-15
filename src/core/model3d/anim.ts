/**
 * The playhead for a model's animation clips (item A10).
 *
 * three's `AnimationMixer` can keep time by itself, and the viewer deliberately
 * does not let it. The mixer's clock is a running sum of the deltas it is
 * handed, with looping, clamping and "finished" folded in as side effects on
 * the action — so "where is the playhead?" has no answer except asking an object
 * that also owns the pose, and a scrub bar dragged to 80 % has to be translated
 * into a delta from wherever the mixer happens to be. Every one of those
 * translations is a place for the bar and the model to disagree by a frame, and
 * the disagreement shows as a bar that jitters under the thumb.
 *
 * So the playhead is a plain value, stepped by pure functions, and the mixer is
 * only ever told "pose the model at this time". That makes the part that is
 * easy to get subtly wrong — the loop wrap, the stop at the end of a one-shot,
 * a zero-length clip — something the harness can assert without a GPU, a
 * model, or a clock.
 *
 * DOM-free and three-free.
 */

/** Where one clip's playback is. Immutable: every step returns a new one. */
export interface Playhead {
  /** Seconds into the clip, always inside `[0, duration]`. */
  time: number;
  duration: number;
  /** Multiplier on real time. Always positive — see `SPEEDS`. */
  speed: number;
  /** Wrap at the end, or stop there. */
  loop: boolean;
  playing: boolean;
}

/**
 * The speeds on offer.
 *
 * A short fixed list rather than a slider, because the question someone is
 * asking is "slow it down so I can see the foot plant", and 0.25 answers it
 * in one click where a slider needs a steady hand. No reverse: a reversed clip
 * is a different question and none of the formats here carry one.
 */
export const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2];

export function playhead(duration: number): Playhead {
  return {
    time: 0,
    // A clip with no keyframes has a duration of zero, or of NaN from a broken
    // exporter; either would make every division below an infinity.
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    speed: 1,
    loop: true,
    playing: false,
  };
}

/**
 * Move the playhead on by `dt` seconds of real time.
 *
 * **A loop wraps with a true modulo**, not with `if (t > d) t -= d`. A frame
 * that arrives late — the window was behind another one, the tab was hidden —
 * can carry a delta several clips long, and a single subtraction leaves the
 * playhead past the end, where the mixer holds the last pose and the bar sits
 * off its own track.
 *
 * **A one-shot stops *at* the end and says so**, with `playing` turned off, so
 * the play button changes back to ▶ by itself and pressing it again starts
 * from the top (see `play`) rather than doing nothing.
 */
export function advance(p: Playhead, dt: number): Playhead {
  if (!p.playing || p.duration <= 0 || !(dt > 0)) return p;
  const t = p.time + dt * p.speed;
  if (p.loop) return { ...p, time: wrap(t, p.duration) };
  if (t >= p.duration) return { ...p, time: p.duration, playing: false };
  return { ...p, time: t };
}

/**
 * Start playing. From the top if a one-shot had already run out, because a
 * play button that does nothing at the end of a clip looks broken.
 */
export function play(p: Playhead): Playhead {
  if (p.duration <= 0) return { ...p, playing: false };
  const ended = !p.loop && p.time >= p.duration;
  return { ...p, playing: true, time: ended ? 0 : p.time };
}

export function pause(p: Playhead): Playhead {
  return { ...p, playing: false };
}

/**
 * Jump to a fraction of the way through, from the scrub bar.
 *
 * Clamped, not wrapped: a scrub bar dragged past its end means "the end", and
 * wrapping it would snap the model back to frame one under the user's thumb.
 * Scrubbing does not change whether the clip is playing — dragging while it
 * plays and letting go carries on from there, the way every video player works.
 */
export function scrub(p: Playhead, fraction: number): Playhead {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return { ...p, time: f * p.duration };
}

export function withSpeed(p: Playhead, speed: number): Playhead {
  const nearest = SPEEDS.reduce((a, b) => (Math.abs(b - speed) < Math.abs(a - speed) ? b : a), 1);
  return { ...p, speed: nearest };
}

export function withLoop(p: Playhead, loop: boolean): Playhead {
  return { ...p, loop };
}

/** How far through, 0 to 1, for the scrub bar. */
export function progress(p: Playhead): number {
  return p.duration > 0 ? p.time / p.duration : 0;
}

/**
 * The time to hand the mixer.
 *
 * Not quite `time`: three's looping action treats a time of exactly `duration`
 * as the start of the *next* loop and shows frame one. A one-shot that has
 * stopped at its end would then be drawn at its beginning — the last pose is
 * the one that matters for a clip like a door swinging open. A hair short of the
 * end is the last pose.
 */
export function poseTime(p: Playhead): number {
  if (p.duration <= 0) return 0;
  return Math.min(p.time, p.duration * (1 - 1e-6));
}

/** `m:ss.t`, for the time readout. Tenths, because clips are often under a second. */
export function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const tenths = Math.floor(s * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const rest = tenths - m * 600;
  const whole = Math.floor(rest / 10);
  return `${m}:${String(whole).padStart(2, "0")}.${rest % 10}`;
}

function wrap(t: number, d: number): number {
  const r = t % d;
  return r < 0 ? r + d : r;
}
