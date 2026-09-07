/**
 * Checks that the shell knows how it stopped.
 *
 * Item 25 is "reopen where it died". Two claims live in that sentence and only
 * one of them is about position: the other is knowing that it *died* rather
 * than being closed. That distinction is a flag written by one run and read by
 * the next, so like the undo check this harness runs across real page reloads —
 * four phases, three reloads, each phase a different JavaScript realm reading
 * what the last one left behind.
 *
 * Phase two is reached by a simulated kill: the flag is pinned back on the way
 * out, from a listener registered after the module's own, which is what a
 * process that never got to run any handler at all leaves behind. Phase three
 * is reached by saying goodbye first. If the two came out the same the feature
 * would be a decoration.
 *
 * Phase four is the one that matters most and is the easiest to fake: goodbye
 * said by the window's own teardown, with nothing called from the test and
 * nothing awaiting it. That is the only version of it that ever runs in the
 * real app, and it is the assertion that caught the record being unwritable at
 * that moment — the failure that moved this module off IndexedDB.
 *
 * Dev-only. Loaded by /dev/sessioncheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/sessioncheck.html
 *
 * The page title and body become the score once all four phases have run.
 */

import { arm, begin, end, forget, recall, remember } from "@core/undo/session";

const PHASE = "sessioncheck-phase";
const TALLY = "sessioncheck-tally";

/** The module's own keys, poked directly where a phase has to fake a kill. */
const RUNNING = "facet-running";
const BEAT = "facet-beat";

const tally = JSON.parse(sessionStorage.getItem(TALLY) ?? '{"pass":0,"fail":0,"failed":[]}') as
  { pass: number; fail: number; failed: string[] };

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { tally.pass++; console.log("ok  ", name); }
  else {
    tally.fail++;
    // Carried across the reloads too: a failure two phases back is otherwise
    // only in a console the last realm no longer owns.
    tally.failed.push(`${name} — ${detail}`);
    console.log("FAIL", name, " ", detail);
  }
  sessionStorage.setItem(TALLY, JSON.stringify(tally));
};

/** Longer than the module's own 400 ms coalescing window. */
const settled = (): Promise<void> => new Promise((r) => window.setTimeout(r, 600));

const go = (phase: string): void => {
  sessionStorage.setItem(PHASE, phase);
  location.reload();
};

/**
 * Leave the flag the way a killed process would have left it.
 *
 * A reload is not a crash: it runs every handler the session module installed,
 * and two of those exist precisely to clear this flag. So it is put back from
 * listeners registered *after* the module's, which therefore run after them in
 * the same dispatch. What ends up in storage is what `taskkill /F` leaves
 * behind, which is the thing under test.
 */
function stageCrash(): void {
  const pin = (): void => { localStorage.setItem(RUNNING, "1"); };
  window.addEventListener("pagehide", pin);
  document.addEventListener("visibilitychange", pin);
}

// ── Phase one: start a run, then vanish ─────────────────────────────────────

async function first(): Promise<void> {
  forget();
  ok("a machine that has never run FACET has nothing to recall", recall() === null);

  begin("C:/Users/x/Pictures");
  const started = recall();
  ok("a run in progress records where it started",
    started?.state.folder === "C:/Users/x/Pictures", String(started?.state.folder));

  remember({
    folder: "C:/Users/x/Pictures/2024",
    selected: ["C:/Users/x/Pictures/2024/a.jpg", "C:/Users/x/Pictures/2024/b.jpg"],
    surface: { kind: "viewer", path: "C:/Users/x/Pictures/2024/a.jpg" },
  });
  await settled();

  // A selection of thousands is not worth carrying, and must not take the
  // record down with it either.
  remember({
    folder: "C:/Users/x/Pictures/2024",
    selected: Array.from({ length: 5000 }, (_, i) => `C:/Users/x/Pictures/2024/${i}.jpg`),
    surface: { kind: "viewer", path: "C:/Users/x/Pictures/2024/a.jpg" },
  });
  await settled();
  const big = recall();
  ok("an enormous selection is kept to something worth writing",
    (big?.state.selected.length ?? 0) > 0 && (big?.state.selected.length ?? 0) <= 200,
    String(big?.state.selected.length));

  // Back to the small one, so phase two has something legible to assert on.
  remember({
    folder: "C:/Users/x/Pictures/2024",
    selected: ["C:/Users/x/Pictures/2024/a.jpg", "C:/Users/x/Pictures/2024/b.jpg"],
    surface: { kind: "viewer", path: "C:/Users/x/Pictures/2024/a.jpg" },
  });
  await settled();

  // No end(), and the flag pinned back on the way out. This is the phase's
  // whole point: the next realm has to find a run that never finished.
  stageCrash();
  go("2");
}

// ── Phase two: the next run, after a death ──────────────────────────────────

async function second(): Promise<void> {
  const prior = recall();
  ok("the run that never said goodbye is reported as a crash",
    prior?.crashed === true, JSON.stringify(prior?.state));
  ok("it comes back at the folder it was last in, not the one it started in",
    prior?.state.folder === "C:/Users/x/Pictures/2024", String(prior?.state.folder));
  ok("with the selection it had", prior?.state.selected.length === 2,
    JSON.stringify(prior?.state.selected));
  ok("and knows which surface was up",
    prior?.state.surface?.kind === "viewer" &&
    prior.state.surface.path === "C:/Users/x/Pictures/2024/a.jpg",
    JSON.stringify(prior?.state.surface));
  // Reading is what consumes it. Otherwise one crash is reported at every boot
  // from now until the next one, which is how a warning becomes wallpaper.
  ok("and a crash is reported to one boot, not to every boot after it",
    recall()?.crashed === false);

  // Now the other half: a run that exits properly. The remember() below is
  // deliberately *not* given time to settle before end() is called — a normal
  // exit in the middle of the debounce window must not look like a crash on the
  // next boot, and must not lose the last thing that happened either.
  begin("C:/Users/x/Documents");
  remember({ folder: "C:/Users/x/Documents/notes", selected: [], surface: null });
  end();

  const afterEnd = recall();
  ok("saying goodbye clears the flag", afterEnd?.crashed === false,
    JSON.stringify(afterEnd?.state));
  ok("and does not lose a write that was still queued",
    afterEnd?.state.folder === "C:/Users/x/Documents/notes", String(afterEnd?.state.folder));

  await settled();
  go("3");
}

// ── Phase three: the next run, after a clean exit ───────────────────────────

async function third(): Promise<void> {
  const prior = recall();
  ok("a clean exit is not reported as a crash", prior?.crashed === false,
    JSON.stringify(prior?.state));
  ok("and the position still survived the restart",
    prior?.state.folder === "C:/Users/x/Documents/notes", String(prior?.state.folder));

  begin("C:/Users/x");
  ok("a new run re-arms the flag", recall()?.crashed === true);
  end();

  // remember() after end() is the shutdown race: a stray navigation as the
  // window closes must not resurrect the flag and turn a clean exit into a
  // reported crash.
  remember({ folder: "C:/Users/x/Downloads", selected: [], surface: null });
  await settled();
  ok("a write landing after goodbye still reports the exit as clean",
    recall()?.crashed === false);

  // ── The phone's bug, reproduced in a desktop realm ────────────────────────
  //
  // Android reaps backgrounded apps as a matter of routine, and a process it
  // kills off screen leaves behind exactly what a crash leaves behind: the flag
  // set, no handler having run. The only thing that tells the two apart is how
  // long ago the app was last known to be on screen, so that is what is faked
  // here — flag set, stamp old. Before this existed the shell opened on "FACET
  // closed unexpectedly." every single time the phone came back to it.
  begin("C:/Users/x/Videos");
  localStorage.setItem(RUNNING, "1");
  localStorage.setItem(BEAT, String(Date.now() - 5 * 60 * 1000));
  const reaped = recall();
  ok("a run the OS reaped in the background is not called a crash",
    reaped?.crashed === false, JSON.stringify(reaped));
  end();

  // The other half of the same bug, and the half that actually shipped: the
  // boot must not claim the run while the app is off screen. `begin` used to do
  // the claiming and on a phone it runs behind the first storage scan — minutes
  // after the window opened, and quite possibly after the user had switched
  // away and the screen had gone dark.
  forget();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  arm();
  const claimed = localStorage.getItem(RUNNING);
  ok("arming while the app is off screen does not claim a run",
    claimed === null, String(claimed));
  delete (document as unknown as Record<string, unknown>)["visibilityState"];
  ok("and the real visibility is back for the rest of the run",
    document.visibilityState === "visible", document.visibilityState);

  forget();
  ok("forget leaves nothing behind", recall() === null);

  // The goodbye that actually matters is the one nobody calls: the one the
  // window fires on its own way out. end() from a test and then a reload proves
  // nothing about it. Here nothing is called at all — begin() takes over the
  // lifecycle and the reload below is the only thing that happens.
  begin("C:/Users/x/Music");
  remember({ folder: "C:/Users/x/Music/live", selected: [], surface: null });
  go("4");
}

// ── Phase four: goodbye said by the teardown itself ─────────────────────────

function fourth(): void {
  sessionStorage.removeItem(PHASE);

  const prior = recall();
  ok("a goodbye written by the teardown itself lands before the page is gone",
    prior?.crashed === false, JSON.stringify(prior));
  // Not just the flag: the position queued in the debounce when the window went
  // away has to be there too, or a close mid-navigation reopens the wrong
  // folder. Nothing waited for that write — the teardown flushed it.
  ok("and it carries the last thing that happened, not the boot position",
    prior?.state.folder === "C:/Users/x/Music/live", String(prior?.state.folder));

  forget();

  const line = tally.fail === 0
    ? `session: ${tally.pass} passed`
    : `session: ${tally.fail} FAILED of ${tally.pass + tally.fail}`;
  console.log(line);
  document.title = line;
  document.body.textContent = [line, ...tally.failed].join("\n");
  document.body.style.whiteSpace = "pre-wrap";
  document.body.style.font = "13px ui-monospace, monospace";
  sessionStorage.removeItem(TALLY);
}

const phase = sessionStorage.getItem(PHASE);
if (phase === "4") fourth();
else void (phase === "3" ? third() : phase === "2" ? second() : first());
