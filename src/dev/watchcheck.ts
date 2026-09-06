/**
 * Checks the watch folders against the claims that justify them (item 27).
 *
 * A watch folder is the one feature in FACET that runs while nobody is looking,
 * which means every one of its failure modes is discovered late and by
 * accident: the rule that queued four hundred jobs the second it was switched
 * on, the rule that handed a half-copied 4 GB file to ffmpeg, the rename rule
 * that renamed its own output all night. None of those are visible by opening
 * the panel and none survive being written down as an assertion, so they are
 * all written down here.
 *
 * The filesystem is faked — a map of folder to entries the test mutates between
 * sweeps, which is exactly what a real folder does, only instantly. `sweep()`
 * is driven by hand rather than by the timer for the same reason.
 *
 * Dev-only. Loaded by /watchcheck.html, which is not a build input.
 *
 *   http://localhost:8183/watchcheck.html
 */

import "../styles/base.css";
import "../styles/watch.css";

import type { DirListing, FileEntry, FileKind } from "@core/explorer/types";
import {
  applyPattern,
  describe,
  describeFilter,
  isOurOutput,
  matches,
  taskFor,
  type TaskSpec,
  type WatchRule,
} from "@core/watch/rules";
import { WatchService } from "@core/watch/watcher";
import { WatchPanel } from "@ui/watch";

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log("ok  ", name); }
  else { fail++; console.log("FAIL", name, " ", detail); }
};

const tick = (n = 1): Promise<void> => new Promise((r) => setTimeout(r, n));

function fakeStore(): Pick<Storage, "getItem" | "setItem"> & { raw(): string | null } {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => { value = v; },
    raw: () => value,
  };
}

/** A folder you can drop files into between sweeps. */
function fakeFs(): {
  list(path: string): Promise<DirListing>;
  put(folder: string, name: string, size?: number, kind?: FileKind): void;
  drop(folder: string, name: string): void;
  break(folder: string): void;
  fix(folder: string): void;
} {
  const dirs = new Map<string, Map<string, FileEntry>>();
  const broken = new Set<string>();
  const dir = (folder: string): Map<string, FileEntry> => {
    let d = dirs.get(folder);
    if (!d) { d = new Map(); dirs.set(folder, d); }
    return d;
  };
  return {
    list: (path) => {
      if (broken.has(path)) return Promise.reject(new Error(`${path}: not reachable`));
      return Promise.resolve({ path, entries: [...dir(path).values()] });
    },
    put: (folder, name, size = 100, kind) => {
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
      dir(folder).set(`${folder}/${name}`, {
        path: `${folder}/${name}`,
        name,
        kind: kind ?? kindOf(ext),
        ext,
        size,
        modified: new Date(2026, 6, 4, 12, 0, 0).getTime(),
      });
    },
    drop: (folder, name) => { dir(folder).delete(`${folder}/${name}`); },
    break: (folder) => { broken.add(folder); },
    fix: (folder) => { broken.delete(folder); },
  };
}

function kindOf(ext: string): FileKind {
  if (["jpg", "png", "heic"].includes(ext)) return "image";
  if (["mov", "mp4", "avi"].includes(ext)) return "video";
  if (["wav", "mp3", "flac"].includes(ext)) return "audio";
  return "binary";
}

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return {
    path: `C:/w/${name}`,
    name,
    kind: kindOf(ext),
    ext,
    size: 1000,
    modified: new Date(2026, 6, 4, 12, 0, 0).getTime(),
    ...over,
  };
}

function rule(over: Partial<WatchRule> = {}): WatchRule {
  return {
    id: "r1",
    folder: "C:/w",
    enabled: true,
    kinds: [],
    exts: [],
    contains: "",
    minSize: 0,
    action: { type: "clean" },
    fired: 0,
    lastFired: 0,
    ...over,
  };
}

async function run(): Promise<void> {
  // ── Matching ──────────────────────────────────────────────────────────────
  {
    ok("an empty filter takes any file", matches(rule(), entry("a.jpg")));
    ok("a folder is never a trigger",
      !matches(rule(), entry("sub", { kind: "folder", ext: "" })));
    ok("a paused rule fires on nothing", !matches(rule({ enabled: false }), entry("a.jpg")));

    const images = rule({ kinds: ["image"] });
    ok("a kind filter admits its kind", matches(images, entry("a.jpg")));
    ok("and turns the rest away", !matches(images, entry("a.mov")));

    const movs = rule({ exts: ["mov", "avi"] });
    ok("an extension filter admits its extensions", matches(movs, entry("clip.avi")));
    ok("and turns the rest away", !matches(movs, entry("clip.mp4")));

    const named = rule({ contains: "scan" });
    ok("a name filter ignores case", matches(named, entry("SCAN_004.jpg")));
    ok("and turns the rest away", !matches(named, entry("holiday.jpg")));

    const big = rule({ minSize: 5000 });
    ok("a size floor turns away what is under it", !matches(big, entry("a.jpg", { size: 100 })));
    ok("and admits what is over it", matches(big, entry("a.jpg", { size: 9000 })));
    // A listing that has not stat'd yet must not be silently excluded by every
    // rule with a floor — an unknown size is not a small size.
    const unsized = entry("a.jpg");
    delete unsized.size;
    ok("an unknown size is not treated as a small one", matches(big, unsized));

    // The loop guard, at the matching level.
    ok("our own -converted output is never a trigger", isOurOutput("clip-converted.mp4"));
    ok("nor a stepped -clean-2", isOurOutput("photo-clean-2.jpg"));
    ok("nor -blurred", isOurOutput("face-blurred.png"));
    ok("but an ordinary name is", !isOurOutput("holiday-2.jpg"));
    ok("and a rule refuses to match its own output",
      !matches(rule(), entry("photo-clean.jpg")));
  }

  // ── What a match turns into ───────────────────────────────────────────────
  {
    const clean = taskFor(rule(), entry("a.jpg"));
    ok("clean queues meta.clean", clean?.kind === "meta.clean", String(clean?.kind));
    ok("as a copy, never in place", clean?.params["mode"] === "copy");
    // The runner picks the name at run time, when it can see the folder.
    ok("with the output left to the runner", clean?.output === "");

    const audio = taskFor(
      rule({ action: { type: "convert.audio", format: "mp3", bitrate: 192 } }),
      entry("song.wav"),
    );
    ok("an audio rule queues audio.convert", audio?.kind === "audio.convert");
    ok("carrying its format and bitrate",
      audio?.params["format"] === "mp3" && audio?.params["bitrate"] === 192);

    const video = taskFor(
      rule({ action: { type: "convert.video", format: "mp4", quality: 20 } }),
      entry("clip.mov"),
    );
    ok("a video rule queues video.convert", video?.kind === "video.convert");

    const move = taskFor(rule({ action: { type: "move", to: "C:/sorted" } }), entry("a.jpg"));
    ok("a move rule queues file.move", move?.kind === "file.move");
    ok("with a full destination path", move?.output === "C:/sorted/a.jpg", String(move?.output));
    // Pointed at the folder it watches, the honest answer is to do nothing.
    ok("a move onto its own folder does nothing",
      taskFor(rule({ action: { type: "move", to: "C:/w" } }), entry("a.jpg")) === null);

    const ren = taskFor(
      rule({ action: { type: "rename", pattern: "{yyyy}-{mm}-{dd} {name}.{ext}" } }),
      entry("holiday.jpg"),
    );
    ok("a rename applies the pattern",
      ren?.output === "C:/w/2026-07-04 holiday.jpg", String(ren?.output));
    ok("a rename to the name it already has does nothing",
      taskFor(rule({ action: { type: "rename", pattern: "{name}.{ext}" } }), entry("a.jpg")) === null);

    // The date comes off the file, not off today. A folder of photos dropped in
    // at once should be named for when they were taken.
    // Local time, not UTC: a photo taken at 11pm should be named for the day it
    // was taken where the person was standing, not for tomorrow in London.
    ok("date tokens read the file's own time, in local time",
      applyPattern("{yyyy}{mm}{dd}", entry("a.jpg", { modified: new Date(2001, 0, 9, 23, 30).getTime() })) === "20010109",
      applyPattern("{yyyy}{mm}{dd}", entry("a.jpg", { modified: new Date(2001, 0, 9, 23, 30).getTime() })));
    ok("a file with no date does not produce a NaN name",
      applyPattern("{yyyy}-{mm}", entry("a.jpg", { modified: undefined as unknown as number })) === "0000-00");
    ok("characters Windows would reject are stripped, not rejected",
      applyPattern("a:b*c?.{ext}", entry("x.jpg")) === "a_b_c_.jpg",
      applyPattern("a:b*c?.{ext}", entry("x.jpg")));

    ok("a rule says what it does in words",
      describe(rule({ action: { type: "move", to: "C:/sorted" } })) === "move to C:/sorted");
    ok("and an empty filter reads as everything",
      describeFilter(rule()) === "any new file", describeFilter(rule()));
    ok("and a real one reads as itself",
      describeFilter(rule({ kinds: ["video"], exts: ["mov"] })) === "video, .mov",
      describeFilter(rule({ kinds: ["video"], exts: ["mov"] })));
  }

  // ── Sweeping ──────────────────────────────────────────────────────────────
  {
    const fs = fakeFs();
    const queued: TaskSpec[] = [];
    fs.put("C:/w", "old-1.jpg");
    fs.put("C:/w", "old-2.jpg");

    const w = new WatchService({
      list: fs.list,
      enqueue: (s) => queued.push(s),
      storage: fakeStore(),
      settle: 2,
      now: () => 1,
    });
    w.addRule({ folder: "C:/w", enabled: true, kinds: [], exts: [], contains: "", minSize: 0,
      action: { type: "clean" } });

    // The single most important default in the whole feature.
    await w.sweep();
    ok("switching a rule on queues nothing for what is already there",
      queued.length === 0, String(queued.length));

    fs.put("C:/w", "new.jpg", 100);
    await w.sweep();
    ok("a brand-new file does not fire on the sweep that first sees it",
      queued.length === 0, String(queued.length));
    await w.sweep();
    ok("it fires once its size has held still", queued.length === 1, String(queued.length));
    ok("on the right file", queued[0]?.input === "C:/w/new.jpg", String(queued[0]?.input));

    await w.sweep();
    await w.sweep();
    ok("and never fires again", queued.length === 1, String(queued.length));

    // A file still being copied. This is the assertion that stands between the
    // user and a folder full of truncated encodes.
    queued.length = 0;
    fs.put("C:/w", "big.mov", 1);
    await w.sweep();
    fs.put("C:/w", "big.mov", 5_000_000);
    await w.sweep();
    fs.put("C:/w", "big.mov", 900_000_000);
    await w.sweep();
    ok("a file that is still growing is never handed over",
      queued.length === 0, String(queued.length));
    await w.sweep();
    await w.sweep();
    ok("and goes the moment it stops growing", queued.length === 1, String(queued.length));

    // Deleted and dropped back in is a new file, and re-dropping it is exactly
    // how someone asks for it to be done again.
    queued.length = 0;
    fs.drop("C:/w", "new.jpg");
    await w.sweep();
    fs.put("C:/w", "new.jpg");
    await w.sweep();
    await w.sweep();
    ok("a file removed and dropped back in fires again",
      queued.length === 1, String(queued.length));

    ok("the rule counts what it has done", (w.rules()[0]?.fired ?? 0) === 3,
      String(w.rules()[0]?.fired));
  }

  // ── The loop guard, end to end ────────────────────────────────────────────
  {
    // A rename rule whose output lands back in the folder it watches. Without
    // the produced-set this renames its own output forever and fills the disk.
    const fs = fakeFs();
    const queued: TaskSpec[] = [];
    const w = new WatchService({
      list: fs.list, enqueue: (s) => queued.push(s), storage: fakeStore(), settle: 1, now: () => 1,
    });
    w.addRule({ folder: "C:/w", enabled: true, kinds: [], exts: [], contains: "", minSize: 0,
      action: { type: "rename", pattern: "{yyyy}-{name}.{ext}" } });
    await w.sweep();

    fs.put("C:/w", "shot.jpg");
    await w.sweep();
    ok("the rename fires once", queued.length === 1, String(queued.length));

    // The rename lands. The watcher claimed the destination when it queued it.
    fs.drop("C:/w", "shot.jpg");
    fs.put("C:/w", "2026-shot.jpg");
    await w.sweep();
    await w.sweep();
    ok("and never fires on its own output", queued.length === 1, String(queued.length));

    // The same guard from the other side: a convert output carries a suffix and
    // is refused by `matches` even if the produced-set were somehow lost.
    const fs2 = fakeFs();
    const q2: TaskSpec[] = [];
    const w2 = new WatchService({
      list: fs2.list, enqueue: (s) => q2.push(s), storage: fakeStore(), settle: 1, now: () => 1,
    });
    w2.addRule({ folder: "C:/w", enabled: true, kinds: ["video"], exts: [], contains: "", minSize: 0,
      action: { type: "convert.video", format: "mp4" } });
    await w2.sweep();
    fs2.put("C:/w", "clip-converted.mp4");
    await w2.sweep();
    await w2.sweep();
    ok("a converted output is never re-converted", q2.length === 0, String(q2.length));
  }

  // ── Several rules, several folders ────────────────────────────────────────
  {
    const fs = fakeFs();
    const queued: TaskSpec[] = [];
    const w = new WatchService({
      list: fs.list, enqueue: (s) => queued.push(s), storage: fakeStore(), settle: 1, now: () => 1,
    });
    w.addRule({ folder: "C:/w", enabled: true, kinds: ["image"], exts: [], contains: "", minSize: 0,
      action: { type: "clean" } });
    w.addRule({ folder: "C:/w", enabled: true, kinds: [], exts: [], contains: "", minSize: 0,
      action: { type: "move", to: "C:/sorted" } });
    const off = w.addRule({ folder: "C:/w", enabled: false, kinds: [], exts: [], contains: "",
      minSize: 0, action: { type: "clean" } });
    w.addRule({ folder: "C:/other", enabled: true, kinds: [], exts: [], contains: "", minSize: 0,
      action: { type: "clean" } });

    ok("folders watched by several rules are listed once",
      w.watched().length === 2, String(w.watched()));

    await w.sweep();
    fs.put("C:/w", "a.jpg");
    fs.put("C:/other", "b.jpg");
    await w.sweep();
    ok("every matching rule on a folder fires", queued.length === 3, String(queued.length));
    ok("including the one watching the other folder",
      queued.some((s) => s.input === "C:/other/b.jpg"));
    ok("and the paused rule fired on nothing", (w.get(off.id)?.fired ?? -1) === 0);

    // An unplugged drive must not stop the folders that are still there.
    queued.length = 0;
    fs.break("C:/w");
    fs.put("C:/other", "c.jpg");
    await w.sweep();
    await w.sweep();
    ok("an unreachable folder is reported, not thrown", w.lastError.includes("not reachable"),
      w.lastError);
    ok("and the other folders still get swept",
      queued.some((s) => s.input === "C:/other/c.jpg"), String(queued.length));
    fs.fix("C:/w");
  }

  // ── Across a restart ──────────────────────────────────────────────────────
  {
    const store = fakeStore();
    const fs = fakeFs();
    fs.put("C:/w", "already.jpg");
    const queued: TaskSpec[] = [];

    const first = new WatchService({
      list: fs.list, enqueue: (s) => queued.push(s), storage: store, settle: 1, now: () => 1,
    });
    first.addRule({ folder: "C:/w", enabled: true, kinds: [], exts: [], contains: "", minSize: 0,
      action: { type: "convert.video", format: "mp4" } });
    await first.sweep();
    ok("nothing queued before the restart", queued.length === 0, String(queued.length));

    // A different instance over the same storage is a relaunched app.
    const second = new WatchService({
      list: fs.list, enqueue: (s) => queued.push(s), storage: store, settle: 1, now: () => 1,
    });
    ok("the rules come back", second.rules().length === 1, String(second.rules().length));
    ok("with their action intact",
      second.rules()[0]?.action.type === "convert.video", String(second.rules()[0]?.action.type));
    await second.sweep();
    // The failure this prevents: every launch re-queueing the whole folder.
    ok("and the folder it had already seen does not fire on relaunch",
      queued.length === 0, String(queued.length));

    fs.put("C:/w", "fresh.mp4");
    await second.sweep();
    ok("while a genuinely new file still does", queued.length === 1, String(queued.length));

    // Corrupt storage means no rules, not a broken app.
    const bad = { getItem: () => "{not json", setItem: () => {} };
    const third = new WatchService({ list: fs.list, enqueue: () => {}, storage: bad });
    ok("unreadable storage costs the rules, not the app", third.rules().length === 0);
  }

  // ── The backlog, on purpose ───────────────────────────────────────────────
  {
    const fs = fakeFs();
    const queued: TaskSpec[] = [];
    for (let i = 0; i < 5; i++) fs.put("C:/w", `old-${i}.jpg`);
    fs.put("C:/w", "clip.mov");
    const w = new WatchService({
      list: fs.list, enqueue: (s) => queued.push(s), storage: fakeStore(), settle: 1, now: () => 1,
    });
    const r = w.addRule({ folder: "C:/w", enabled: true, kinds: ["image"], exts: [], contains: "",
      minSize: 0, action: { type: "clean" } });
    await w.sweep();
    ok("adoption still queues nothing", queued.length === 0, String(queued.length));

    const n = await w.applyNow(r.id);
    ok("running it on the backlog queues the matches", n === 5, String(n));
    ok("and only the matches", queued.every((s) => s.input.endsWith(".jpg")));
    await w.sweep();
    ok("the backlog does not then fire a second time",
      queued.length === 5, String(queued.length));

    // The escape hatch for "it adopted files I wanted processed".
    queued.length = 0;
    w.reset("C:/w");
    await w.sweep();
    ok("resetting a folder makes everything in it new again",
      queued.length === 5, String(queued.length));

    w.removeRule(r.id);
    ok("removing a rule removes it", w.rules().length === 0);
    queued.length = 0;
    await w.sweep();
    ok("and it stops firing", queued.length === 0, String(queued.length));
  }

  // ── Overlapping sweeps ────────────────────────────────────────────────────
  {
    // A slow disk must not stack sweeps on top of each other; the second call
    // is dropped, not queued behind the first.
    let listing = 0;
    // Annotated with `as` rather than a type on the declaration: written only
    // inside the callback, TypeScript otherwise narrows it to `null` forever.
    let release = null as (() => void) | null;
    const w = new WatchService({
      list: () =>
        new Promise<DirListing>((res) => {
          listing++;
          release = (): void => res({ path: "C:/w", entries: [] });
        }),
      enqueue: () => {},
      storage: fakeStore(),
    });
    w.addRule({ folder: "C:/w", enabled: true, kinds: [], exts: [], contains: "", minSize: 0,
      action: { type: "clean" } });
    const a = w.sweep();
    const b = w.sweep();
    ok("a sweep that overlaps another is dropped", listing === 1, String(listing));
    release?.();
    await Promise.all([a, b]);
    ok("and the first one still finishes", listing === 1, String(listing));
  }

  // ── The sweep period is live (item 43) ────────────────────────────────────
  //
  // The setting exists because the interval is a cost on a network drive and a
  // wait on a local one, so it has to reach a service that is already
  // sweeping. The clamp matters as much as the change: the declared minimum is
  // two seconds, but nothing stops a stored file from holding 0, and a
  // zero-millisecond setInterval is a busy loop over somebody's disk.
  {
    const w = new WatchService({
      list: () => Promise.resolve({ path: "C:/w", entries: [] }),
      enqueue: () => {},
      storage: fakeStore(),
      interval: 4000,
    });
    ok("the interval is whatever it was built with", w.interval === 4000, String(w.interval));

    w.setInterval(30_000);
    ok("and follows the setting while stopped", w.interval === 30_000, String(w.interval));
    ok("changing it while stopped does not start it", !w.running);

    w.start();
    w.setInterval(9000);
    ok("a running service takes the new period", w.interval === 9000, String(w.interval));
    ok("and is still running afterwards", w.running);

    w.setInterval(0);
    ok("a nonsense period is clamped, never applied", w.interval === 1000, String(w.interval));
    w.stop();
    ok("stop still stops it", !w.running);
  }

  // ── The panel ─────────────────────────────────────────────────────────────
  {
    const fs = fakeFs();
    const w = new WatchService({
      list: fs.list, enqueue: () => {}, storage: fakeStore(), settle: 1, now: () => 1,
    });
    const said: string[] = [];
    const panel = new WatchPanel(w, {
      currentFolder: () => "C:/Users/me/Downloads",
      say: (m) => said.push(m),
    });
    panel.show();

    ok("an empty panel says so",
      (document.querySelector(".wf-empty") as HTMLElement | null)?.hidden === false);

    w.addRule({ folder: "C:/w", enabled: true, kinds: ["video"], exts: [], contains: "",
      minSize: 0, action: { type: "convert.video", format: "mp4" } });
    await tick();
    const row = document.querySelector(".wf-row");
    ok("a rule gets a row", row !== null);
    ok("that says what it does, in words",
      (row?.querySelector(".wf-line") as HTMLElement | null)?.textContent ===
        "video → convert to mp4",
      String((row?.querySelector(".wf-line") as HTMLElement | null)?.textContent));
    ok("and admits it has done nothing yet",
      (row?.querySelector(".wf-count") as HTMLElement | null)?.textContent === "nothing yet");

    const toggle = row?.querySelector(".wf-on") as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await tick();
    ok("the switch pauses the rule", w.rules()[0]?.enabled === false);
    ok("and the row dims rather than disappearing",
      (document.querySelector(".wf-row") as HTMLElement | null)?.dataset["on"] === "0");

    // "This folder" is the whole reason the command exists.
    panel.useCurrentFolder();
    ok("the form can take the folder you are looking at",
      (document.querySelector(".wf-input") as HTMLInputElement).value ===
        "C:/Users/me/Downloads");

    // Adding through the form, the way a person would.
    const action = [...document.querySelectorAll<HTMLSelectElement>(".wf-form select")][1];
    ok("the destination field is hidden for a rule that has no destination",
      (document.querySelectorAll(".wf-field")[7] as HTMLElement).hidden === true);
    if (action) {
      action.value = "move";
      action.dispatchEvent(new Event("change"));
    }
    ok("and appears for a move", (document.querySelectorAll(".wf-field")[7] as HTMLElement).hidden === false);

    // Reached through its own field rather than by counting `.wf-input`, which
    // also matches every select in the form.
    const target = document
      .querySelectorAll(".wf-field")[7]
      ?.querySelector<HTMLInputElement>("input");
    ok("the destination field is an input", target !== null && target !== undefined);
    if (target) target.value = "C:/sorted";
    (document.querySelector(".wf-form") as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await tick();
    ok("submitting adds the rule", w.rules().length === 2, String(w.rules().length));
    ok("with the destination typed into it",
      (w.rules()[1]?.action as { to?: string }).to === "C:/sorted",
      JSON.stringify(w.rules()[1]?.action));
    // Said out loud every time, because it is the one behaviour people are
    // surprised by afterwards.
    ok("and it warns that the folder's existing files are left alone",
      said.some((m) => m.includes("already in that folder")), said.join(" | "));

    ok("a rule with no folder is refused",
      (() => {
        const before = w.rules().length;
        (document.querySelector(".wf-input") as HTMLInputElement).value = "";
        (document.querySelector(".wf-form") as HTMLFormElement).dispatchEvent(
          new Event("submit", { cancelable: true }),
        );
        return w.rules().length === before;
      })());

    panel.hide();
    ok("closing the panel leaves the rules running", w.rules().length === 2);
  }

  console.log(`watch: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
}

void run().catch((e: unknown) => {
  console.error(`watch harness threw: ${String(e)}`);
});
