/**
 * Timing marks that survive a release build.
 *
 * `console.log` in the Android WebView does not reach `logcat` once the build
 * is packaged, so the marks that were supposed to explain a thirty-second cold
 * start produced nothing at all and the diagnosis went back to guessing from
 * screenshots. This goes through the native side, which does reach it:
 *
 *     adb logcat -d | grep FACET
 *
 * Fire-and-forget on purpose. A timing probe that makes the caller wait for the
 * IPC it is measuring is measuring itself.
 */

let sink: ((what: string) => void) | null = null;

export function markVia(fn: (what: string) => void): void {
  sink = fn;
}

export function mark(what: string): void {
  const line = `${Math.round(performance.now())}ms ${what}`;
  console.log(`[FACET] ${line}`);
  sink?.(line);
}

/**
 * A performance mark, distinguishable from the narrative ones above.
 *
 * `[fct-perf]` lines are what the "cold open shows yesterday for three
 * seconds" and "the Photos tab takes a second to come up" complaints are
 * measured against, so they carry the same `performance.now()` clock the
 * browser's own timeline uses and a fixed prefix a grep can pull out of a
 * logcat full of everything else. They also reach the native sink, for the
 * same reason `mark` does.
 */
export function perf(what: string): void {
  const line = `${performance.now().toFixed(1)}ms ${what}`;
  console.log(`[fct-perf] ${line}`);
  sink?.(`perf ${line}`);
}
