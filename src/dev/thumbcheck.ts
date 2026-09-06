/**
 * Dev harness for the batched thumbnail path: the wire format `thumb_batch`
 * answers in, and the `Thumbs` class's batching, ordering, cancellation and
 * memory bound against a mock filesystem.
 *
 * Asserts that:
 * - `splitBatch` turns `[u32 LE len][record]...` into records in order, reads
 *   flag / key / orientation / JPEG out of each, gives null for a zero length,
 *   pads a short reply with nulls and stops at a truncated tail instead of
 *   throwing.
 * - `Thumbs.get` called for a screenful in one task makes one `thumbBatch`
 *   round trip, not one per tile; on-screen tiles go first, then by distance.
 * - A tile cancelled before the flush never reaches the native side and
 *   resolves SKIPPED (not null), so the loader retries it.
 * - An exact batch hit resolves to a blob URL and a second ask is a cache hit
 *   with the same URL; a miss on an undecodable file resolves null, never
 *   rejects.
 * - No more than `BATCHES` round trips are in flight at once, and a big burst
 *   is chunked at `BATCH`.
 * - `prefetch` asks once per entry and leaves in-flight and cached ones alone.
 * - `warm` sends `bytes: false` batches once the grid is quiet.
 * - A pinned band (the fling's landing spot) goes out first and survives the
 *   cancels the observer issues while the fling streams past it.
 * - `FlingModel` replays a recorded reference-phone fling: predicts within the first
 *   100 ms, is within 40 % of the remaining travel at 300 ms, tightens as it
 *   decays, and adapts
 *   `K` boundedly on settle.
 * - Pins are capped at one batch and a new landing band releases the old
 *   one, so under a compound fling the on-screen tiles go out right behind
 *   the current band and a stale band's tiles never reach the native side.
 * - A real `PhotosTab` over a tall roll, scrolled deep and back through the
 *   evict/refill band: at every scroll position exactly one day header sits
 *   on the scroller's top edge (the stuck one is pushed out by the next, not
 *   slid under it), no two headers overlap, and the stuck header's top is the
 *   scroller's top -- below the app bar, never under it.
 * - The LRU stays at `CACHE_MAX` after well over `CACHE_MAX` distinct hits.
 */

import type { FileEntry } from "@core/explorer/types";
import type { CachedThumb, PhoneFs } from "@core/explorer/tauri-fs";
import { splitBatch } from "@core/explorer/tauri-fs";
import "../styles/base.css";
import "../styles/phone.css";
import { Thumbs } from "@ui/phone/thumbs";
import { FlingModel, FLING_K } from "@ui/phone/fling";
import { PhotosTab } from "@ui/phone/photos-tab";
import type { PhoneShell } from "@ui/phone/shell";
import type { StoreSnapshot } from "@ui/phone/store";
import { byDay, type GalleryItem } from "@core/phone/gallery";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Wire format ──────────────────────────────────────────────────────────

/** The smallest thing that is unmistakably a JPEG: SOI, EOI. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function record(exact: boolean, key: string, orientation: number, jpeg: Uint8Array | null): Uint8Array {
  const body = jpeg ?? new Uint8Array(0);
  const out = new Uint8Array(18 + body.length);
  out[0] = exact ? 1 : 0;
  out.set(new TextEncoder().encode(key), 1);
  out[17] = orientation;
  out.set(body, 18);
  return out;
}

function frame(records: (Uint8Array | null)[]): Uint8Array {
  const total = records.reduce((n, r) => n + 4 + (r?.length ?? 0), 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const r of records) {
    view.setUint32(at, r?.length ?? 0, true);
    at += 4;
    if (r) out.set(r, at);
    at += r?.length ?? 0;
  }
  return out;
}

async function checkWire(): Promise<void> {
  const buf = frame([
    record(true, "0123456789abcdef", 1, JPEG),
    record(false, "fedcba9876543210", 6, null),
    null,
  ]);
  const got = splitBatch(buf, 3);
  ok("wire: three records in order", got.length === 3);
  ok("wire: exact hit carries flag, key and blob",
    got[0]?.exact === true && got[0]?.key === "0123456789abcdef" && got[0]?.blob?.size === 4);
  ok("wire: EXIF miss carries orientation and no blob",
    got[1]?.exact === false && got[1]?.orientation === 6 && got[1]?.blob === null);
  ok("wire: zero length is null", got[2] === null);
  const first = got[0];
  if (first?.blob) {
    const bytes = new Uint8Array(await first.blob.arrayBuffer());
    ok("wire: blob bytes are the JPEG, not the header", bytes[0] === 0xff && bytes[3] === 0xd9);
  }

  const padded = splitBatch(frame([record(true, "0123456789abcdef", 1, JPEG)]), 4);
  ok("wire: a short reply is padded with nulls", padded.length === 4 && padded[3] === null);

  const truncated = splitBatch(buf.subarray(0, buf.length - 3), 3);
  ok("wire: a truncated tail ends the list, keeps the rest",
    truncated.length === 3 && truncated[0] !== null && truncated[2] === null);

  ok("wire: empty reply, no throw", splitBatch(new Uint8Array(0), 2).every((r) => r === null));
}

// ── Thumbs against a mock fs ─────────────────────────────────────────────

interface Call {
  entries: FileEntry[];
  bytes: boolean;
}

function entry(i: number, kind: "image" | "video" = "image"): FileEntry {
  return {
    path: `/roll/IMG_${String(i).padStart(5, "0")}.${kind === "video" ? "mp4" : "jpg"}`,
    name: `IMG_${i}`,
    kind,
    ext: kind === "video" ? "mp4" : "jpg",
    size: 1000 + i,
    modified: 1_700_000_000_000 + i * 1000,
  };
}

class MockFs {
  calls: Call[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** Paths the mock has a picture for; everything else is a miss. */
  hits = new Set<string>();
  delay = 5;

  async thumbBatch(entries: FileEntry[], _px: number, bytes = true): Promise<(CachedThumb | null)[]> {
    this.calls.push({ entries: [...entries], bytes });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await sleep(this.delay);
    this.inFlight -= 1;
    return entries.map((e) => {
      if (!this.hits.has(e.path)) return { exact: false, key: "0000000000000000", orientation: 1, blob: null };
      return {
        exact: true,
        key: "0123456789abcdef",
        orientation: 1,
        blob: bytes ? new Blob([JPEG], { type: "image/jpeg" }) : null,
      };
    });
  }
  async thumbCached(): Promise<CachedThumb | null> { return null; }
  async thumbStore(): Promise<void> {}
  async thumbnail(): Promise<string | null> { return null; }
  async frameAt(): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error("ffmpeg could not be started");
  }
  async fileUrl(): Promise<string> { return ""; }
  async readHead(): Promise<number[]> { return []; }
  async readRange(): Promise<number[]> { return []; }
  async readTail(): Promise<[number[], number]> { return [[], 0]; }

  asFs(): PhoneFs {
    return this as unknown as PhoneFs;
  }
}

async function checkBatching(): Promise<void> {
  const fs = new MockFs();
  const thumbs = new Thumbs(fs.asFs());
  const items = Array.from({ length: 12 }, (_, i) => entry(i));
  for (const e of items) fs.hits.add(e.path);

  // A screenful asked for in one task: far tiles first, so ordering has to
  // be done by the flush and not by arrival.
  const promises = items.map((e, i) => thumbs.get(e, i < 4, i < 4 ? 0 : (12 - i) * 100));
  await sleep(1);
  ok("batch: twelve asks in one task made one round trip", fs.calls.length === 1, `${fs.calls.length}`);
  const sent = fs.calls[0]?.entries ?? [];
  ok("batch: the whole screen was in it", sent.length === 12, `${sent.length}`);
  const order = sent.map((e) => items.indexOf(e));
  ok("batch: on-screen tiles first", order.slice(0, 4).every((i) => i < 4), order.join(","));
  // Item 11 was given the smallest distance, item 4 the largest.
  ok("batch: then by distance, nearest first",
    order.slice(4).every((i, k, arr) => k === 0 || (arr[k - 1] ?? 0) > i) && order[4] === 11,
    order.join(","));

  const urls = await Promise.all(promises);
  ok("batch: exact hits resolve to blob URLs",
    urls.every((u) => typeof u === "string" && u.startsWith("blob:")));
  const again = await thumbs.get(items[3] as FileEntry, true);
  ok("batch: a second ask is a cache hit with the same URL", again === urls[3] && fs.calls.length === 1);

  // A miss on a file nothing can decode: null, no rejection, no second trip
  // for the batch itself.
  const miss = entry(99);
  let rejected = false;
  const got = await thumbs.get(miss, true).catch(() => { rejected = true; return null; });
  ok("batch: a miss resolves null rather than rejecting", got === null && !rejected);
  thumbs.dispose();
}

async function checkCancel(): Promise<void> {
  const fs = new MockFs();
  const thumbs = new Thumbs(fs.asFs());
  const keep = entry(1);
  const gone = entry(2);
  fs.hits.add(keep.path).add(gone.path);
  const pKeep = thumbs.get(keep, true);
  const pGone = thumbs.get(gone, false, 500);
  thumbs.cancel(gone);
  await sleep(1);
  ok("cancel: the cancelled tile never reached the native side",
    fs.calls.length === 1 && fs.calls[0]?.entries.length === 1 && fs.calls[0]?.entries[0] === keep);
  const [uKeep, uGone] = await Promise.all([pKeep, pGone]);
  ok("cancel: kept tile painted", typeof uKeep === "string");
  ok("cancel: cancelled tile is SKIPPED (a symbol), not null", typeof uGone === "symbol");
  // Back on screen: asks again, gets a picture.
  const back = await thumbs.get(gone, true);
  ok("cancel: asking again after it comes back paints it", typeof back === "string" && fs.calls.length === 2);
  thumbs.dispose();
}

async function checkConcurrency(): Promise<void> {
  const fs = new MockFs();
  fs.delay = 20;
  const thumbs = new Thumbs(fs.asFs());
  const items = Array.from({ length: 100 }, (_, i) => entry(i));
  for (const e of items) fs.hits.add(e.path);
  const all = Promise.all(items.map((e, i) => thumbs.get(e, false, i)));
  await sleep(1);
  ok("flight: no more than three batches out at once", fs.inFlight === 3, `${fs.inFlight}`);
  await all;
  ok("flight: never more than three in flight over the burst", fs.maxInFlight === 3, `${fs.maxInFlight}`);
  ok("flight: chunked at sixteen", fs.calls.every((c) => c.entries.length <= 16) && fs.calls.length >= 7,
    `${fs.calls.length} calls, max ${Math.max(...fs.calls.map((c) => c.entries.length))}`);
  ok("flight: every tile was asked for exactly once",
    fs.calls.reduce((n, c) => n + c.entries.length, 0) === 100);
  thumbs.dispose();
}

async function checkPrefetch(): Promise<void> {
  const fs = new MockFs();
  const thumbs = new Thumbs(fs.asFs());
  const items = Array.from({ length: 20 }, (_, i) => entry(i, i % 5 === 0 ? "video" : "image"));
  for (const e of items) fs.hits.add(e.path);
  thumbs.prefetch(items);
  thumbs.prefetch(items);
  await sleep(1);
  const asked = fs.calls.reduce((n, c) => n + c.entries.length, 0);
  ok("prefetch: each entry asked for once, second call a no-op", asked === 20, `${asked}`);
  const first = fs.calls[0]?.entries.map((e) => items.indexOf(e)) ?? [];
  ok("prefetch: top of the roll first", first[0] === 0 && first[1] === 1, first.join(","));
  await sleep(30);
  const hit = await thumbs.get(items[7] as FileEntry, true);
  ok("prefetch: a tile mounting afterwards is a cache hit",
    typeof hit === "string" && fs.calls.reduce((n, c) => n + c.entries.length, 0) === 20);
  thumbs.dispose();
}

async function checkWarm(): Promise<void> {
  const fs = new MockFs();
  const thumbs = new Thumbs(fs.asFs());
  const items = Array.from({ length: 30 }, (_, i) => entry(i));
  for (const e of items) fs.hits.add(e.path);
  thumbs.warm(items);
  // The warm pass waits for a quiet second before it touches anything.
  await sleep(1400);
  const warm = fs.calls.filter((c) => !c.bytes);
  ok("warm: round trips go out with bytes=false", warm.length >= 1 && fs.calls.every((c) => !c.bytes));
  ok("warm: chunked at a dozen", warm.every((c) => c.entries.length <= 12));
  ok("warm: whole list covered", warm.reduce((n, c) => n + c.entries.length, 0) === 30);
  thumbs.dispose();
}

async function checkPinned(): Promise<void> {
  const fs = new MockFs();
  const thumbs = new Thumbs(fs.asFs());
  const items = Array.from({ length: 40 }, (_, i) => entry(i));
  for (const e of items) fs.hits.add(e.path);
  // An on-screen tile asks first, then the fling predictor pins a band.
  const onScreen = thumbs.get(items[0] as FileEntry, true);
  const band = items.slice(20, 36);
  thumbs.prefetch(band, true);
  // The observer reports the band as gone (the fling streams past it).
  for (const e of band) thumbs.cancel(e);
  await sleep(1);
  const first = fs.calls[0]?.entries ?? [];
  ok("pinned: the landing band goes out ahead of the on-screen tile",
    first.length === 16 && first.every((e) => band.includes(e)), `${first.length}`);
  ok("pinned: cancel during the fling does not drop a pinned tile",
    fs.calls.reduce((n, c) => n + c.entries.length, 0) === 17);
  const paintedBand = await thumbs.get(band[3] as FileEntry, true);
  const paintedScreen = await onScreen;
  ok("pinned: landing tile is a cache hit on mount", typeof paintedBand === "string");
  ok("pinned: the on-screen tile still painted", typeof paintedScreen === "string");
  // Once answered, the pin is gone and an ordinary cancel works again.
  const pinned = (thumbs as unknown as { pinned: Set<string> }).pinned;
  ok("pinned: no pins left once the probes answered", pinned.size === 0, `${pinned.size}`);
  // Pinning something already in flight rescues it from an earlier cancel.
  const late = items[39] as FileEntry;
  const p = thumbs.get(late, false, 900);
  thumbs.cancel(late);
  thumbs.prefetch([late], true);
  ok("pinned: a cancelled in-flight probe is un-cancelled by a pin", typeof (await p) === "string");
  thumbs.dispose();
}

/**
 * Recorded on the reference phone: one 100 ms swipe, `[ms, scrollTop]` from a scroll
 * listener, thinned. The scroller came to rest at 70949.
 */
const FLING_TRACE: [number, number][] = [
  [0, 67869], [31, 67948], [79, 68176], [98, 68399], [116, 68475], [149, 68625], [162, 68698],
  [194, 68841], [220, 68910], [244, 69045], [261, 69110], [287, 69173], [311, 69295], [349, 69409],
  [378, 69518], [411, 69620], [427, 69668], [465, 69761], [496, 69848], [529, 69930], [561, 70006],
  [595, 70078], [627, 70145], [660, 70208], [695, 70266], [727, 70321], [760, 70373], [794, 70421],
  [828, 70466], [865, 70509], [904, 70548], [946, 70603], [994, 70652], [1045, 70696], [1097, 70735],
  [1144, 70770], [1196, 70802], [1246, 70830], [1295, 70854], [1349, 70875], [1396, 70893],
  [1446, 70908], [1496, 70921], [1546, 70931], [1597, 70938], [1645, 70944], [1697, 70947],
  [1730, 70949],
];
const FLING_END = 70949;

async function checkFling(): Promise<void> {
  const m = new FlingModel(2.8125);
  ok("fling: no prediction from a single sample", (m.sample(0, 100), m.predict() === null));
  const errAt = new Map<number, number>();
  let firstAt = -1;
  for (const [t, y] of FLING_TRACE) {
    m.sample(t, y);
    const dest = m.predict();
    if (dest === null) continue;
    if (firstAt < 0) firstAt = t;
    errAt.set(t, Math.abs(dest - FLING_END));
  }
  const e300 = errAt.get(311) ?? Infinity;
  const e600 = errAt.get(595) ?? Infinity;
  const e1000 = errAt.get(994) ?? Infinity;
  ok("fling: predicting within the first 100 ms of the gesture", firstAt >= 0 && firstAt <= 100, `${firstAt}`);
  // 1650 px still to go at 311 ms; the fit is good to ~35 % of that.
  const togo300 = FLING_END - 69295;
  ok("fling: 300 ms in, the landing spot is known to within 40 % of the distance still to travel",
    e300 < togo300 * 0.4, `${Math.round(e300)} of ${togo300}`);
  ok("fling: the error shrinks as the fling decays", e600 < e300 && e1000 < e600,
    `${Math.round(e300)} ${Math.round(e600)} ${Math.round(e1000)}`);
  ok("fling: near the end the prediction is inside a quarter screen", e1000 < 200, `${Math.round(e1000)}`);
  // A slow crawl predicts nothing.
  const slow = new FlingModel(2.8125);
  for (let i = 0; i < 6; i += 1) slow.sample(i * 16, i * 3);
  ok("fling: a slow drag is not a fling", slow.predict() === null);
  // Settling adapts K toward the observed curve, boundedly.
  const k0 = m.k;
  m.settle(1730, FLING_END);
  ok("fling: K moved after a real fling, by no more than sqrt(1.4)",
    m.k !== k0 && m.k / k0 <= Math.sqrt(1.4) + 1e-9 && m.k / k0 >= Math.sqrt(0.7) - 1e-9, `${k0} -> ${m.k}`);
  const k1 = m.k;
  m.settle(5000, 0);
  ok("fling: settling with nothing recorded leaves K alone", m.k === k1);
  // A gesture interrupted by a finger (opposite direction) must not swing K.
  const n = new FlingModel(2.8125);
  n.sample(0, 1000);
  n.sample(40, 1400);
  n.predict();
  n.settle(500, 900);
  ok("fling: a reversed gesture does not adapt K", n.k === FLING_K);
  // Stale samples are a new gesture.
  n.sample(2000, 1000);
  n.sample(2040, 1400);
  n.sample(2400, 1401);
  ok("fling: samples older than a gesture gap are discarded", Math.abs(n.velocity()) < 0.35);
}

async function checkPinCap(): Promise<void> {
  const fs = new MockFs();
  const thumbs = new Thumbs(fs.asFs());
  const items = Array.from({ length: 120 }, (_, i) => entry(i));
  for (const e of items) fs.hits.add(e.path);
  const priv = thumbs as unknown as { pinned: Set<string>; keyOf(e: FileEntry): string };
  const pinnedSet = priv.pinned;
  const isPinned = (e: FileEntry): boolean => pinnedSet.has(priv.keyOf(e));
  // Frame 1 of a fling: the predictor names band A (a whole aim() band of 40).
  const bandA = items.slice(40, 80);
  thumbs.prefetch(bandA, true);
  ok("pincap: a 40-tile band pins one batch, not the band", pinnedSet.size === 16, `${pinnedSet.size}`);
  // Frame 2: the fling is stronger than thought, band B is the new landing.
  const bandB = items.slice(80, 120);
  thumbs.prefetch(bandB, true);
  ok("pincap: naming a new band releases the old pins", pinnedSet.size === 16 &&
    bandA.every((e) => !isPinned(e)) && bandB.slice(0, 16).every((e) => isPinned(e)),
    `size=${pinnedSet.size} A=${bandA.filter((e) => isPinned(e)).length} B=${bandB.slice(0, 16).filter((e) => isPinned(e)).length} keys=${[...pinnedSet].slice(0, 3).join(",")}`);
  // A tile that is on screen right now asks, and the observer reports band A
  // as gone by (the fling streamed past it).
  const onScreen = thumbs.get(items[0] as FileEntry, true);
  for (const e of bandA) thumbs.cancel(e);
  await sleep(1);
  const sent = fs.calls.map((c) => c.entries);
  const first = sent[0] ?? [];
  const second = sent[1] ?? [];
  ok("pincap: the current band goes out first", first.length === 16 && first.every((e) => bandB.includes(e)));
  ok("pincap: the on-screen tile is at the head of the very next batch", second[0] === items[0]);
  ok("pincap: no stale-band tile reached the native side",
    sent.flat().every((e) => !bandA.includes(e)), `${sent.flat().filter((e) => bandA.includes(e)).length}`);
  ok("pincap: on-screen tile painted", typeof (await onScreen) === "string");
  thumbs.unpin();
  ok("pincap: unpin on settle leaves nothing pinned", pinnedSet.size === 0);
  thumbs.dispose();
}

/** A roll of `days` days, `perDay` pictures each, newest first, all hits. */
function roll(fs: MockFs, days: number, perDay: number): StoreSnapshot {
  const items: GalleryItem[] = [];
  const base = 1_800_000_000_000;
  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < perDay; i += 1) {
      const e = entry(d * perDay + i) as GalleryItem;
      e.modified = base - d * 86_400_000 - i * 1000;
      e.folder = "/roll";
      e.folderName = "roll";
      fs.hits.add(e.path);
      items.push(e);
    }
  }
  const sections = byDay(items, base + 1);
  return {
    state: "ready", items, days: sections, albums: [], everything: items, allDays: sections,
    trash: [], truncated: false, partial: false,
  } as unknown as StoreSnapshot;
}

const tick = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

async function checkHeaders(): Promise<void> {
  const fs = new MockFs();
  fs.delay = 1;
  const thumbs = new Thumbs(fs.asFs());
  // The shell's real DOM shape: a fixed app bar, then the one scroller.
  const head = document.createElement("div");
  head.className = "ph-head";
  head.style.height = "52px";
  const body = document.createElement("div");
  body.className = "ph-body";
  body.style.height = "700px";
  const ph = document.createElement("div");
  ph.className = "ph";
  ph.style.cssText = "left:0;top:0;right:auto;bottom:auto;width:400px;height:752px;visibility:hidden";
  ph.append(head, body);
  document.body.append(ph);
  const snap = roll(fs, 90, 18);
  const shell = {
    thumbs, get scroller() { return body; }, native: false, fs: fs.asFs(),
    store: { subscribe(fn: (s: StoreSnapshot) => void) { fn(snap); return () => {}; }, ensure: async () => {} },
    refreshChrome() {}, viewer: { open() {} }, open() {}, openTrash() {}, trashItem() {},
  } as unknown as PhoneShell;
  const tab = new PhotosTab(shell);
  body.append(tab.el);
  tab.activate();
  await tick(); await tick(); await sleep(200);

  ok("headers: every drawn day is wrapped in its own section",
    tab.el.querySelectorAll(".ph-daysec").length > 0 &&
      Array.from(tab.el.querySelectorAll(".ph-day, .ph-grid")).every((n) => n.parentElement?.classList.contains("ph-daysec")));

  const rootRect = () => body.getBoundingClientRect();
  const headers = () => Array.from(tab.el.querySelectorAll<HTMLElement>(".ph-day"));
  let overlaps = 0, notOne = 0, wrongTop = 0, checked = 0, worst = "";
  const audit = (where: string): void => {
    const R = rootRect();
    const vis = headers().map((h) => h.getBoundingClientRect()).filter((r) => r.bottom > R.top && r.top < R.bottom);
    for (let i = 0; i < vis.length; i += 1) for (let j = i + 1; j < vis.length; j += 1) {
      const a = vis[i]!, b = vis[j]!;
      if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) { overlaps += 1; worst = `${where}: ${a.top.toFixed(1)}-${a.bottom.toFixed(1)} vs ${b.top.toFixed(1)}-${b.bottom.toFixed(1)}`; }
    }
    // The header covering the row just under the top edge: the stuck one, or
    // the one that has just pushed it out. Never two, never none.
    const atTop = vis.filter((r) => r.top <= R.top + 0.5 && r.bottom > R.top + 0.5);
    if (atTop.length !== 1) {
      notOne += 1;
      if (!worst) {
        const near = headers().map((h) => h.getBoundingClientRect()).filter((r) => Math.abs(r.top - R.top) < 400)
          .map((r) => `${(r.top - R.top).toFixed(1)}..${(r.bottom - R.top).toFixed(1)}`).join(" ");
        worst = `${where}: ${atTop.length} at top; st=${body.scrollTop} near=[${near}]`;
      }
    }
    // A header fully stuck (not mid hand-over) sits exactly on the scroller's
    // top edge, i.e. right below the app bar.
    if (atTop.length === 1 && atTop[0]!.top < R.top - 0.5) {
      const next = vis.find((r) => r.top > R.top + 0.5 && r.top < R.top + atTop[0]!.height + 1);
      if (!next) wrongTop += 1;
    }
    checked += 1;
  };
  const scrollTo = async (y: number): Promise<void> => {
    body.scrollTop = y;
    body.dispatchEvent(new Event("scroll"));
    await tick(); await tick();
  };
  // Deep, so the evict/refill band has emptied and rebuilt sections behind
  // and ahead of the viewport, then a fine sweep back up through several
  // day boundaries, then a coarse sweep down again over refilled ground.
  const max = () => body.scrollHeight - body.clientHeight;
  const priv = tab as unknown as { drawn: number; days: unknown[]; totalItems(): number; sentinelNear(): boolean; hidden: boolean; scrolls: number };
  const dbg = () => ({ drawn: priv.drawn, days: priv.days.length, total: priv.totalItems(), near: priv.sentinelNear(), hidden: priv.hidden, scrolls: priv.scrolls, st: body.scrollTop, sh: body.scrollHeight, ch: body.clientHeight });
  for (let y = 0; y < 60_000 && y < max(); y += 2_500) await scrollTo(y);
  await sleep(200);
  const deep = Math.min(body.scrollTop, max());
  ok("headers: the roll is deep enough for the test to mean something", deep > 20_000,
    `${Math.round(deep)} of ${Math.round(max())} ${JSON.stringify(dbg())} secs=${tab.el.querySelectorAll(".ph-daysec").length} cells=${tab.el.querySelectorAll(".ph-cell").length} grids=${tab.el.querySelectorAll(".ph-grid").length}`);
  audit("deep");
  for (let y = deep; y > deep - 3_000 && y > 0; y -= 7) { await scrollTo(y); audit(`up@${y}`); }
  await sleep(200);
  for (let y = body.scrollTop; y < deep + 4_000 && y < max(); y += 61) { await scrollTo(y); audit(`down@${y}`); }
  await scrollTo(0);
  audit("top");
  ok("headers: no two day headers ever overlap", overlaps === 0, `${overlaps} of ${checked}: ${worst}`);
  ok("headers: exactly one header on the top edge at every position", notOne === 0, `${notOne} of ${checked}: ${worst}`);
  ok("headers: the stuck header sits on the scroller's top edge, below the app bar, not under it", wrongTop === 0, `${wrongTop}`);
  ok("headers: at the top, the first day's header is at the scroller's top edge",
    Math.abs(headers()[0]!.getBoundingClientRect().top - rootRect().top) < 0.5);
  ok("headers: the scroller starts below the app bar", rootRect().top >= 52);
  const emptied = Array.from(tab.el.querySelectorAll(".ph-grid")).filter((g) => g.childElementCount === 0).length;
  ok("headers: the sweep exercised eviction (some far sections are empty)", emptied > 0, `${emptied}`);
  ph.remove();
  thumbs.dispose();
}

async function checkLru(): Promise<void> {
  const fs = new MockFs();
  fs.delay = 0;
  const thumbs = new Thumbs(fs.asFs());
  const n = 1100;
  const items = Array.from({ length: n }, (_, i) => entry(i));
  for (const e of items) fs.hits.add(e.path);
  for (let i = 0; i < n; i += 50) {
    await Promise.all(items.slice(i, i + 50).map((e) => thumbs.get(e, true)));
  }
  const cache = (thumbs as unknown as { cache: Map<string, string> }).cache;
  ok("lru: bounded at CACHE_MAX after 1100 distinct hits", cache.size === 1024, `${cache.size}`);
  ok("lru: the newest tile is still held", cache.has(`${items[n - 1]?.path}|${items[n - 1]?.modified}|${items[n - 1]?.size}`));
  ok("lru: the oldest was evicted", !cache.has(`${items[0]?.path}|${items[0]?.modified}|${items[0]?.size}`));
  thumbs.dispose();
}

async function run(): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ["wire", checkWire],
    ["batch", checkBatching],
    ["cancel", checkCancel],
    ["flight", checkConcurrency],
    ["prefetch", checkPrefetch],
    ["warm", checkWarm],
    ["pinned", checkPinned],
    ["fling", checkFling],
    ["pincap", checkPinCap],
    ["headers", checkHeaders],
    ["lru", checkLru],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      ok(`${name}: harness ran without throwing`, false, String(err));
    }
  }
  const summary = `${pass} passed, ${fail} failed`;
  console.log(summary);
  document.title = summary;
  const out = document.createElement("pre");
  out.textContent = summary;
  document.body.append(out);
}

void run();
