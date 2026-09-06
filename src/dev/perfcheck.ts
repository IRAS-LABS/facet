/**
 * Dev harness for the phone shell's speed work: the hot-pass merge, day-section
 * identity reuse, the swipe strip's paging arithmetic, and the store's
 * seed -> hot merge -> deferred persist sequence against a mock filesystem.
 *
 * Asserts that:
 * - `mergeHot` keeps unchanged objects, inserts new files newest-first, drops
 *   files the pass proved gone, and returns the same array when nothing moved.
 * - `reuseDays` hands back the previous section object for an unchanged day
 *   and a new one for a changed day or a changed label.
 * - `pageTarget` turns the page on distance or on a flick, springs back on a
 *   short slow drag, and never pages past either end; `stripOffset` resists
 *   at the ends only.
 * - `MediaStore` paints the cached index first, merges the hot pass without
 *   losing day identity, and does not write localStorage synchronously.
 * - The viewer's display copies: `displayBox` is the panel in device px, capped,
 *   `wantsOriginal` flips at `FULL_ZOOM`, the LRU revokes what it drops, and
 *   `DisplayCache` shrinks a big picture to the long edge in the worker, hands
 *   a small one back untouched, dedupes in-flight work and evicts past
 *   `DISPLAY_KEEP`.
 * - `edgeGestureCssPx` converts the back-gesture strip to CSS px: ~57 on the
  *   reference phone, never the raw device number that killed two thirds of the screen.
 */

import type { FileEntry } from "@core/explorer/types";
import type { RawMediaScan, TauriFs } from "@core/explorer/tauri-fs";
import type { DaySection, GalleryItem } from "@core/phone/gallery";
import { byDay, toCacheRow } from "@core/phone/gallery";
import { mergeHot, pageTarget, reuseDays, stripOffset } from "@core/phone/merge";
import { DISPLAY_KEEP, FULL_ZOOM, Lru, displayBox, wantsOriginal } from "@core/phone/display";
import { edgeGestureCssPx } from "@core/phone/env";
import { DisplayCache } from "@ui/phone/display";
import { MediaStore } from "@ui/phone/store";

let pass = 0;
let fail = 0;

function ok(title: string, condition: boolean, extra?: string): void {
  if (condition) {
    pass += 1;
    console.log(`[OK] ${title}`);
  } else {
    fail += 1;
    console.error(`[FAIL] ${title}${extra ? ` (${extra})` : ""}`);
  }
}

const HOUR = 3_600_000;
const NOW = Date.now();

function item(folder: string, name: string, modified: number, size = 1000): GalleryItem {
  return {
    path: `${folder}/${name}`,
    name,
    kind: "image",
    ext: "jpg",
    size,
    modified,
    folder,
    folderName: folder.slice(folder.lastIndexOf("/") + 1),
  };
}

const CAM = "/sdcard/DCIM/Camera";
const SHOT = "/sdcard/Pictures/Screenshots";

// ── mergeHot ─────────────────────────────────────────────────────────────

function checkMerge(): void {
  const a = item(CAM, "a.jpg", NOW - 30 * HOUR);
  const b = item(SHOT, "b.jpg", NOW - 26 * HOUR);
  const c = item(CAM, "c.jpg", NOW - 50 * HOUR);
  const indexed = [b, a, c];

  const same = mergeHot(indexed, [item(SHOT, "b.jpg", NOW - 26 * HOUR), item(CAM, "a.jpg", NOW - 30 * HOUR)]);
  ok("mergeHot: nothing changed returns the same array", same.everything === indexed);
  ok("mergeHot: nothing changed counts nothing", same.added === 0 && same.removed === 0);

  const fresh = item(SHOT, "new.jpg", NOW - HOUR);
  const merged = mergeHot(indexed, [fresh, item(SHOT, "b.jpg", NOW - 26 * HOUR)]);
  ok("mergeHot: a new file lands at the top", merged.everything[0] === fresh);
  ok("mergeHot: unchanged files keep their objects", merged.everything[1] === b && merged.everything[2] === a);
  ok("mergeHot: counts one added", merged.added === 1 && merged.removed === 0);
  ok("mergeHot: the folder the pass did not cover is untouched", merged.everything.includes(c));

  // The pass covered Camera down to 40h ago and did not return `a` (30h): gone.
  const gone = mergeHot(indexed, [item(CAM, "d.jpg", NOW - 40 * HOUR)]);
  ok("mergeHot: a covered file the pass omitted is removed", !gone.everything.includes(a) && gone.removed === 1);
  ok("mergeHot: a file older than the pass's floor survives", gone.everything.includes(c));

  const rewritten = mergeHot(indexed, [item(SHOT, "b.jpg", NOW - 26 * HOUR, 4321)]);
  ok("mergeHot: a rewritten file (new size) takes the fresh row", rewritten.everything[0] !== b && rewritten.added === 1);

  const order = mergeHot(indexed, [item(CAM, "mid.jpg", NOW - 28 * HOUR)]).everything.map((i) => i.name);
  ok("mergeHot: insertion keeps newest-first order", order.join(",") === "b.jpg,mid.jpg,a.jpg,c.jpg", order.join(","));
}

// ── reuseDays ────────────────────────────────────────────────────────────

function checkReuse(): void {
  const a = item(CAM, "a.jpg", NOW - 2 * HOUR);
  const y = item(CAM, "y.jpg", NOW - 30 * HOUR);
  const prev = byDay([a, y]);
  const next = byDay([item(CAM, "n.jpg", NOW - HOUR), a, y]);
  const out = reuseDays(prev, next);
  ok("reuseDays: an unchanged day keeps its object", out.some((d) => d === prev[1]));
  ok("reuseDays: a changed day is a new object", out[0] !== prev[0] && out[0]?.items.length === 2);
  ok("reuseDays: output length follows next", out.length === next.length);

  const relabelled: DaySection[] = prev.map((d) => ({ ...d, label: `${d.label}!` }));
  ok("reuseDays: a changed label defeats reuse", reuseDays(prev, relabelled).every((d, i) => d !== prev[i]));
  ok("reuseDays: empty prev copies next", reuseDays([], next).length === next.length);
}

// ── paging arithmetic ────────────────────────────────────────────────────

function checkPaging(): void {
  const W = 380;
  ok("pageTarget: far drag left goes next", pageTarget(-200, 0, W, true, true) === 1);
  ok("pageTarget: far drag right goes prev", pageTarget(200, 0, W, true, true) === -1);
  ok("pageTarget: short slow drag springs back", pageTarget(-40, -0.1, W, true, true) === 0);
  ok("pageTarget: short fast flick pages", pageTarget(-40, -1.2, W, true, true) === 1);
  ok("pageTarget: flick against the drag does not page", pageTarget(-40, 1.2, W, true, true) === 0);
  ok("pageTarget: tiny flick under 12px is a tap-ish, no page", pageTarget(-8, -2, W, true, true) === 0);
  ok("pageTarget: no next page clamps", pageTarget(-300, -2, W, true, false) === 0);
  ok("pageTarget: no prev page clamps", pageTarget(300, 2, W, false, true) === 0);

  ok("stripOffset: follows fully mid-roll", stripOffset(-100, true, true) === -100);
  ok("stripOffset: resists at the end", stripOffset(-100, true, false) === -30);
  ok("stripOffset: resists at the start", stripOffset(100, false, true) === 30);
  ok("stripOffset: only the blocked direction resists", stripOffset(100, true, false) === 100);
}

// ── MediaStore with a mock fs ────────────────────────────────────────────

const CACHE_KEY = "fct.phone.index.v1";

function scanOf(items: GalleryItem[]): RawMediaScan {
  return {
    hits: items.map((i) => ({
      name: i.name,
      path: i.path,
      size: i.size ?? 0,
      modified: i.modified ?? null,
      folder: i.folder,
      folderName: i.folderName,
    })),
    dirsVisited: 3,
    truncated: false,
    trash: [],
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

async function checkStore(): Promise<void> {
  const yesterday = item(CAM, "y1.jpg", NOW - 26 * HOUR);
  const older = item(CAM, "o1.jpg", NOW - 70 * HOUR);
  const cachedItems = [yesterday, older];
  localStorage.setItem(CACHE_KEY, JSON.stringify({ t: NOW, hits: cachedItems.map(toCacheRow), trash: [] }));

  const today = item(SHOT, "today.png", NOW - HOUR);
  // Only the full walk finds this one, so its name marks a write of the final index.
  const extra = item("/sdcard/Download", "extra.jpg", NOW - 90 * HOUR);
  let hotCalls = 0;
  let fullCalls = 0;
  let releaseFull: (() => void) | null = null;
  const fullGate = new Promise<void>((r) => { releaseFull = r; });

  const fs: Pick<TauriFs, "scanMedia" | "watchStamp" | "mediaQuery" | "mediaGeneration"> = {
    // A desktop: no media index, so the store walks exactly as it always has.
    mediaQuery: async () => null,
    mediaGeneration: async () => ({ gen: 0, changed: 0 }),
    scanMedia: async (_roots, _exts, opts) => {
      if ((opts?.maxDepth ?? 6) === 1) {
        hotCalls += 1;
        await wait(10);
        return scanOf([today, yesterday]);
      }
      fullCalls += 1;
      await fullGate;
      return scanOf([today, yesterday, older, extra]);
    },
    watchStamp: async () => "stamp",
  };

  const store = new MediaStore(fs, ["/sdcard"], [CAM, SHOT]);
  // Sampled inside the listener: whether the index had been written to
  // localStorage at the moment of each emit. The write is allowed later, in
  // idle time -- headless Chrome reaches idle almost at once -- but never
  // inside the emit itself, which is what used to stall the first paint.
  const seen: { items: number; partial: boolean; days: readonly DaySection[]; stored: string }[] = [];
  store.subscribe((snap) => seen.push({
    items: snap.items.length,
    partial: snap.partial,
    days: snap.days,
    stored: localStorage.getItem(CACHE_KEY) ?? "",
  }));

  // `subscribe` replays the idle snapshot first; the seed is the next one.
  const done = store.ensure();
  const seeded = seen.find((s) => s.items > 0);
  ok("store: cached index paints synchronously on ensure", seen.length >= 2 && seeded?.items === 2);
  ok("store: the seed is marked partial", seeded?.partial === true);

  await wait(80);
  ok("store: hot pass ran once", hotCalls === 1);
  ok("store: full scan started alongside", fullCalls === 1);
  const afterHot = seen.find((s) => s.items === 3);
  ok("store: hot pass merged today's file before the full scan", afterHot !== undefined, `snaps=${seen.map((s) => s.items).join(",")}`);
  ok("store: merged snapshot is still partial", afterHot?.partial === true);
  // By path: the seed holds objects parsed from the cache, not ours.
  const olderDayBefore = seeded?.days.find((d) => d.items.some((i) => i.path === older.path));
  const olderDayAfter = afterHot?.days.find((d) => d.items.some((i) => i.path === older.path));
  const why = olderDayBefore && olderDayAfter
    ? `before=${olderDayBefore.key}/${olderDayBefore.label}/${olderDayBefore.items.length} after=${olderDayAfter.key}/${olderDayAfter.label}/${olderDayAfter.items.length} sameItems=${olderDayBefore.items.every((x, i) => x === olderDayAfter.items[i])}`
    : `before=${String(olderDayBefore)} after=${String(olderDayAfter)}`;
  ok("store: untouched day keeps its section object across the merge", olderDayBefore !== undefined && olderDayBefore === olderDayAfter, why);
  ok("store: the merge emit did not write the index synchronously", afterHot !== undefined && !afterHot.stored.includes("today.png"));

  if (releaseFull) (releaseFull as () => void)();
  await done;
  const final = seen[seen.length - 1];
  ok("store: full scan lands complete", final?.partial === false && final?.items === 4);
  ok(
    "store: the full-scan emit did not write the index synchronously",
    final !== undefined && !final.stored.includes("extra.jpg"),
    seen.map((x) => `${x.items}${x.partial ? "p" : ""}:${x.stored.includes("extra.jpg") ? "E" : x.stored.includes("today.png") ? "T" : "-"}`).join(" "),
  );

  store.flushPersist();
  const now = localStorage.getItem(CACHE_KEY);
  ok("store: flushPersist writes the final index", now !== null && now.includes("today.png") && now.includes("extra.jpg"));
  localStorage.removeItem(CACHE_KEY);
}

// ── viewer display copies ────────────────────────────────────────────────

function checkDisplayMath(): void {
  const s21 = displayBox(384, 853, 2.8125);
  ok("displayBox: reference phone portrait is the panel, 1080x2400", s21.w === 1080 && s21.h === 2400, JSON.stringify(s21));
  const tab = displayBox(1024, 1366, 3);
  ok("displayBox: a 3x tablet is capped on the long edge, aspect kept", tab.h === 2400 && Math.abs(tab.w / tab.h - 1024 / 1366) < 0.002, JSON.stringify(tab));
  const tiny = displayBox(320, 480, 1);
  ok("displayBox: a small screen gets its own size, not a floor", tiny.w === 320 && tiny.h === 480);
  const bad = displayBox(1000, 1200, 0);
  ok("displayBox: a bad dpr is treated as 1", bad.w === 1000 && bad.h === 1200);
  const land = displayBox(853, 384, 2.8125);
  ok("displayBox: landscape is the rotated panel", land.w === 2400 && land.h === 1080, JSON.stringify(land));
  ok("wantsOriginal: at fit the copy is enough", !wantsOriginal(1));
  ok("wantsOriginal: at the threshold the copy is enough", !wantsOriginal(FULL_ZOOM));
  ok("wantsOriginal: past it the original is wanted", wantsOriginal(FULL_ZOOM + 0.01) && wantsOriginal(24));

  const dropped: string[] = [];
  const lru = new Lru<string>(2, (v) => dropped.push(v));
  lru.set("a", "A");
  lru.set("b", "B");
  ok("lru: touching a key keeps it", lru.get("a") === "A");
  lru.set("c", "C");
  ok("lru: the least recently used falls off", !lru.has("b") && lru.has("a") && lru.has("c"));
  ok("lru: what falls off is handed to onDrop", dropped.join() === "B");
  lru.set("a", "A2");
  ok("lru: replacing a value drops the old one", dropped.join() === "B,A" && lru.get("a") === "A2");
  lru.clear();
  ok("lru: clear drops everything", lru.size === 0 && dropped.length === 4);

  ok("edgeGestureCssPx: reference phone strip is ~57 CSS px, not 130", edgeGestureCssPx(2.8125) === 57, String(edgeGestureCssPx(2.8125)));
  ok("edgeGestureCssPx: never wider than the old value", edgeGestureCssPx(1) === 130 && edgeGestureCssPx(0.5) === 130);
  ok("edgeGestureCssPx: bad dpr falls back to 1", edgeGestureCssPx(Number.NaN) === 130);
}

function jpegUrl(w: number, h: number): Promise<string> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#4a6";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#c33";
    ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
  }
  return new Promise((r) => c.toBlob((b) => r(URL.createObjectURL(b ?? new Blob())), "image/jpeg", 0.8));
}

function natural(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((r) => {
    const im = new Image();
    im.onload = () => r({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => r(null);
    im.src = url;
  });
}

function fileEntry(path: string): FileEntry {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), kind: "image", ext: "jpg", size: 1, modified: NOW } as FileEntry;
}

async function checkDisplayCache(): Promise<void> {
  const urls = new Map<string, string>();
  urls.set("/big-l.jpg", await jpegUrl(3000, 2000));
  urls.set("/big-p.jpg", await jpegUrl(2000, 3000));
  urls.set("/small.jpg", await jpegUrl(400, 300));
  let urlCalls = 0;
  const cache = new DisplayCache({
    fileUrl: async (path) => {
      urlCalls += 1;
      const u = urls.get(path);
      if (!u) throw new Error("no such file");
      return u;
    },
  }, 1200);
  ok("display: a number is a square box of that side", cache.box.w === 1200 && cache.box.h === 1200);

  const big = fileEntry("/big-l.jpg");
  const p1 = cache.get(big);
  const p2 = cache.get(big);
  ok("display: a second ask while in flight shares the job", p1 === p2);
  const copyL = await p1;
  ok("display: a big landscape gets a copy of its own", copyL !== null && copyL.owned && copyL.display !== copyL.original);
  const dimsL = copyL ? await natural(copyL.display) : null;
  ok("display: landscape copy is the long edge wide", dimsL?.w === 1200 && dimsL.h === 800, JSON.stringify(dimsL));
  ok("display: one url resolve for two asks", urlCalls === 1);
  ok("display: peek finds it without work", cache.peek(big) === copyL);

  const copyP = await cache.get(fileEntry("/big-p.jpg"));
  const dimsP = copyP ? await natural(copyP.display) : null;
  ok("display: portrait copy is the long edge tall, not the width", dimsP?.h === 1200 && dimsP.w === 800, JSON.stringify(dimsP));

  const copyS = await cache.get(fileEntry("/small.jpg"));
  const dimsS = copyS ? await natural(copyS.display) : null;
  ok("display: a small picture is not upscaled", dimsS?.w === 400 && dimsS.h === 300, JSON.stringify(dimsS));

  const missing = await cache.get(fileEntry("/nope.jpg"));
  ok("display: a file with no url resolves null, never throws", missing === null);

  // Evict: `DISPLAY_KEEP` more distinct pictures push the first one out and
  // its blob URL is revoked, which an <img> reports as an error.
  const first = copyL?.display ?? "";
  for (let i = 0; i < DISPLAY_KEEP; i += 1) {
    const path = `/fill-${i}.jpg`;
    urls.set(path, await jpegUrl(64, 48));
    await cache.get(fileEntry(path));
  }
  ok("display: the first copy is evicted past DISPLAY_KEEP", cache.peek(big) === null);
  ok("display: an evicted copy's url is revoked", (await natural(first)) === null);

  // A portrait phone box: a landscape picture is limited by the width, so it
  // comes out narrower than the long edge, and rotating the box throws the
  // copies away.
  const phone = new DisplayCache({ fileUrl: async (path) => urls.get(path) ?? "" }, { w: 600, h: 1200 });
  const fit = await phone.get(big);
  const dimsF = fit ? await natural(fit.display) : null;
  ok("display: a landscape picture in a portrait box is fitted by width", dimsF?.w === 600 && dimsF.h === 400, JSON.stringify(dimsF));
  ok("display: fitTo with the same shape changes nothing", !phone.fitTo(600, 1200, 1) && phone.peek(big) === fit);
  ok("display: fitTo with a new shape clears the copies", phone.fitTo(1200, 600, 1) && phone.peek(big) === null && phone.box.w === 1200);
  ok("display: a cleared copy's url is revoked", fit !== null && (await natural(fit.display)) === null);
  phone.clear();
  cache.clear();
  for (const u of urls.values()) URL.revokeObjectURL(u);
}

async function run(): Promise<void> {
  console.log("Starting perf harness checks...");
  checkMerge();
  checkReuse();
  checkPaging();
  checkDisplayMath();
  try {
    await checkDisplayCache();
  } catch (err) {
    ok("display: harness ran without throwing", false, String(err));
  }
  try {
    await checkStore();
  } catch (err) {
    ok("store: harness ran without throwing", false, String(err));
  }
  const summary = `${pass} passed, ${fail} failed`;
  console.log(summary);
  document.title = summary;
  const out = document.createElement("pre");
  out.textContent = summary;
  document.body.append(out);
}

void run();
