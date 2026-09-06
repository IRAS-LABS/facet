/**
 * Where the shell was when it stopped.
 *
 * Item 25 is "reopen where it died, with unsaved edits intact". The unsaved
 * edits are `./store.ts`; this is the "where". Two different promises, and they
 * want different handling:
 *
 *  - **Where you were** is not an emergency. Reopening in the folder you were
 *    last in is what every file manager does, and it should happen silently
 *    whether the last exit was clean or not. Announcing it would be noise.
 *  - **What you had open and unsaved** is. If the process died with edits on
 *    screen, saying nothing and dropping the user in a folder is how the work
 *    gets forgotten — the state is on disk, but nobody looks for what they were
 *    never told about.
 *
 * So the session record carries a "still running" flag. It is set on boot and
 * cleared on the way out; finding it still set on the next boot is the
 * definition of "died" used here.
 *
 * **This is deliberately localStorage and not IndexedDB**, which is the
 * opposite of the choice `./store.ts` makes, for the opposite reason. That
 * store holds megabytes of brush history and must never block a frame. This
 * holds a folder path. What it does need is to be writable at the exact moment
 * the window is being torn down, and IndexedDB cannot do that: the transaction
 * is aborted mid-flight and the write silently never lands. Measured, not
 * assumed — with the record in IndexedDB, every clean exit came back reading as
 * a crash, and moving the write earlier did not help, because on a real
 * teardown `pagehide` fires *before* `visibilitychange`, and both are already
 * too late. localStorage is synchronous, so a write from either handler is
 * simply done by the time it returns.
 *
 * The flag is a heuristic — a machine that loses power can leave it either way
 * — and it is only ever used to decide whether to *ask*. Nothing is restored or
 * discarded on the strength of it.
 */

/** The position record, as JSON. */
const KEY = "facet-session";

/** Present and "1" while a run is in progress. Absent means it ended. */
const RUNNING = "facet-running";

/**
 * The build that wrote the record.
 *
 * The flag above cannot tell a crash from an *update*. Installing over a
 * running app force-kills it, and a foreground kill fires neither `pagehide`
 * nor `visibilitychange` -- so the flag is still set on the next boot and the
 * shell announces a crash that never happened. Measured on a real sideload:
 * `am_kill ... due to deletePackageX` in the events log, nothing in the crash
 * buffer, flag set.
 *
 * A changed stamp settles it. The bundle cannot be rewritten underneath a
 * process that is running it, so a record written by a different build is a
 * record from a run that was ended by the thing that replaced the build.
 * The app's version number cannot do this job -- it stays put across two
 * sideloads of the same version, which is the common case.
 */
const BUILD = "facet-build";

/**
 * Epoch ms of the last moment this run was known to be on screen.
 *
 * The flag above answers "did the last run end without saying goodbye". On a
 * desktop that is nearly the same question as "did it crash". On a phone it is
 * not close at all: Android reaps backgrounded apps constantly and by design,
 * and a process killed while it is off screen never gets to run a handler, so
 * it leaves behind exactly what a crash leaves behind. Called a crash, that is
 * the app accusing itself of falling over every time the user switches away and
 * comes back -- which is what it did, on the phone, on every launch.
 *
 * What the flag is missing is *where the app was* when it stopped, and this is
 * that. It is refreshed on a timer while the document is visible and the timer
 * is stopped the moment it is not, so a run that was backgrounded leaves a
 * stamp already minutes old by the time the OS gets round to killing it, while
 * a run that fell over in front of the user leaves one from seconds ago. Only
 * the second is worth interrupting anyone about.
 */
const BEAT = "facet-beat";

/** How often the stamp above is refreshed, while the app is on screen. */
const BEAT_MS = 5000;

/**
 * How stale the stamp may be and still mean "on screen when it stopped".
 *
 * Generous against the interval, because the two mistakes do not cost the same:
 * a crash noticed a boot late is a missed offer to reopen, and a crash reported
 * that never happened is the thing this whole stamp exists to stop.
 */
const BEAT_STALE = 20000;

/**
 * Injected by Vite's `define`. Guarded rather than read bare because a bundle
 * produced by another config -- another app's, say -- leaves the
 * identifier undeclared, and that would be a ReferenceError at import time
 * instead of a missing stamp.
 */
const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

/** Coalescing window. Navigation fires in bursts while a folder settles. */
const DEBOUNCE = 400;

/**
 * Selected paths kept. Select-all in a camera roll is thousands of paths and
 * none of it is worth writing on every keystroke — the first screenful is what
 * makes the restored view look like the one that was left.
 */
const MAX_SELECTED = 200;

export interface OpenSurface {
  kind:
    | "viewer"
    | "vedit"
    | "aedit"
    | "player"
    | "scene"
    | "table"
    | "inspector"
    | "meta"
    | "quicklook";
  path: string;
}

export interface SessionState {
  /** The folder the shell was showing. */
  folder: string;
  /** Paths that were selected in it. Paths, not entries — entries go stale. */
  selected: string[];
  /** The surface that was up, if any. */
  surface: OpenSurface | null;
  at: number;
}

export interface Recalled {
  state: SessionState;
  /** The previous run ended without a clean shutdown, and was not replaced. */
  crashed: boolean;
  /**
   * The previous run was cut off by the app being reinstalled. Also an unclean
   * shutdown, but an explained one: worth mentioning only if there are unsaved
   * edits, and never worth calling a crash.
   */
  replaced: boolean;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let queued: SessionState | null = null;

/**
 * Set once `end` has run. Shutdown is not instant — a window closing still
 * fires the odd navigation and selection change on its way out, and every one
 * of those would otherwise re-arm the flag and turn a clean exit into a crash.
 */
let over = false;

/**
 * Every localStorage call is wrapped: it throws in private-browsing modes and
 * when the origin's quota is full, and a session note is never worth taking the
 * shell down over.
 */
function put(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch (e) { console.warn("facet: session", e); }
}

function drop(key: string): void {
  try { localStorage.removeItem(key); } catch (e) { console.warn("facet: session", e); }
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(state: SessionState): void {
  put(KEY, JSON.stringify(state));
}

/** Write anything still sitting in the debounce, now. */
function settle(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const s = queued;
  queued = null;
  if (s) write(s);
}

/**
 * Note where the shell is now. Cheap to call on every navigation and selection;
 * the write is coalesced and never awaited by the caller.
 */
export function remember(state: Omit<SessionState, "at">): void {
  if (over) return;
  queued = {
    ...state,
    selected: state.selected.slice(0, MAX_SELECTED),
    at: Date.now(),
  };
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(settle, DEBOUNCE);
}

/**
 * Read the previous run's last position, and say whether it ended cleanly.
 *
 * Called once, before anything is written, or the flag it is asking about would
 * be the one this run just set. Consumes the flag as it reads it: a crash is
 * reported to exactly one boot, not to every boot until the next crash.
 */
export function recall(): Recalled | null {
  const abrupt = read(RUNNING) === "1";
  // A record with no stamp predates this field; that is not evidence of a
  // replacement, so it reads as an ordinary unclean exit.
  const stamp = read(BUILD);
  const swapped = stamp !== null && stamp !== BUILD_ID;
  // Was it on screen when it stopped? A record written before this stamp
  // existed cannot say, and "cannot say" has to read as "not a crash": the
  // banner is an interruption and it has to earn the interruption.
  const beat = Number(read(BEAT) ?? "0");
  const onScreen = Number.isFinite(beat) && beat > 0 && Date.now() - beat < BEAT_STALE;
  drop(RUNNING);
  const raw = read(KEY);
  if (raw === null) return null;
  let state: SessionState;
  try {
    state = JSON.parse(raw) as SessionState;
  } catch {
    // A record that will not parse is a record from a build that wrote it
    // differently. Nothing here is precious enough to migrate.
    drop(KEY);
    return null;
  }
  if (typeof state.folder !== "string") return null;
  if (!Array.isArray(state.selected)) state.selected = [];
  return { state, crashed: abrupt && !swapped && onScreen, replaced: abrupt && swapped };
}

/**
 * Mark the current run as still going, and take over the window's lifecycle.
 *
 * Call once, right after `recall`. Everything about how a run ends is handled
 * from here rather than by the caller — there is one correct place to clear the
 * flag and it is not the obvious one, so it should not be something every entry
 * point has to remember to get right.
 */
export function begin(folder: string): void {
  arm();
  write({ folder, selected: [], surface: null, at: Date.now() });
}

let watching = false;
let beating: ReturnType<typeof setInterval> | null = null;

function offScreen(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Say, now, that the app is running and someone is looking at it. */
function pulse(): void {
  put(RUNNING, "1");
  put(BEAT, String(Date.now()));
}

function beatOn(): void {
  if (beating !== null) return;
  pulse();
  beating = setInterval(pulse, BEAT_MS);
}

function beatOff(): void {
  if (beating !== null) { clearInterval(beating); beating = null; }
}

/**
 * Mark the run as going and take over the window's lifecycle.
 *
 * Call this as early as the boot allows — straight after `recall`, before the
 * shell has listed anything. It used to be done from `begin`, and `begin` runs
 * at the end of the first navigation, which on a phone sits behind a storage
 * scan that can take the better part of a minute. Until it ran there was no
 * `visibilitychange` listener at all, so switching away during that window went
 * unrecorded, and `begin` then claimed the run from a screen that was already
 * off. The OS killed it there, and every launch afterwards opened on "FACET
 * closed unexpectedly."
 *
 * Which is also why the claim itself is conditional. A run is only ever
 * declared while the app is actually on screen; off screen there is nothing to
 * crash in front of, and the listener below picks it up when the app comes
 * back.
 */
export function arm(): void {
  over = false;
  put(BUILD, BUILD_ID);
  watch();
  if (offScreen()) beatOff();
  else beatOn();
}

function watch(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;

  // Both, because their order is not what anyone would guess: on a real
  // teardown `pagehide` comes first and `visibilitychange` follows it. Hidden
  // is also fired by a plain minimise, which is why it clears the flag but does
  // not call `end` — the run is still going, and the flag comes back the moment
  // the window does.
  window.addEventListener("pagehide", () => { end(); });
  document.addEventListener("visibilitychange", () => {
    if (over) return;
    // The heartbeat stops with the flag. A backgrounded WebView is not always
    // frozen — Android throttles some of them rather than stopping them — and a
    // timer still ticking off screen would keep the stamp fresh, which is the
    // one thing it must never be while nobody is looking.
    if (document.visibilityState === "hidden") { settle(); beatOff(); drop(RUNNING); }
    else beatOn();
  });
}

/**
 * Say goodbye properly.
 *
 * Writes whatever is queued and clears the flag, so the last thing on disk is
 * both current and marked clean. Anything less and a normal exit during a
 * pending debounce looks exactly like a crash on the next boot.
 */
export function end(): void {
  over = true;
  beatOff();
  settle();
  drop(RUNNING);
}

export function forget(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  queued = null;
  over = false;
  beatOff();
  drop(KEY);
  drop(RUNNING);
  drop(BUILD);
  drop(BEAT);
}
