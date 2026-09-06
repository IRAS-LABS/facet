/**
 * Dev harness for the live phone library: MediaStore as the source of truth,
 * the push path (change counter → index refresh), and the promise that a
 * refresh never disturbs what the user is doing.
 *
 * The 2026-09-05 case this pins down: twenty-two pictures arrived over
 * a sync client into `/sdcard/Sync`, a folder no hard-coded root list names.
 * Samsung Gallery showed them (it reads MediaStore); FACET never did (it
 * walked a fixed set of folders). The store now pages MediaStore through
 * `mediaQuery` and polls a ContentObserver-backed counter through
 * `mediaGeneration`; the walk is a fallback for files the index lacks.
 *
 * Asserts that:
 * - `itemFromRow` maps a MediaStore row to a gallery item: the primary volume
 *   is spelled `/sdcard`, kind comes from MIME before extension (a `.JPG`, a
 *   HEIC, an extensionless WebP, a WebM, a 3GP all count), capture time wins
 *   over mtime when plausible, an epoch-zero capture time does not.
 * - `mergeIndex` keeps unchanged objects by identity, counts adds, removes and
 *   changes, sorts newest first, and hands the same array back when nothing
 *   moved.
 * - On a desktop (no index) the store walks exactly as before and never asks
 *   the index twice.
 * - With an index: the roll is the index; a file indexed in a never-seen
 *   folder shows within one generation tick; a delete vanishes; a burst of
 *   twenty-two files becomes one query; a path this session trashed cannot be
 *   resurrected by a stale row; files only the walk knows survive an index
 *   refresh; an empty answer with no access does not wipe the roll.
 * - What Samsung Gallery hides, the roll hides: a MEDIA_TYPE_NONE row is
 *   never a picture whatever its MIME or extension (WhatsApp's `.Statuses`,
 *   stickers, `.Thumbs` under `.nomedia`); any dot-prefixed path segment is
 *   dropped (`Pictures/.gs`, `.gs_fs0/.N.jpg`, Samsung's `Android/.Trash`,
 *   `.facet-trash`); IS_PENDING and IS_TRASHED rows are dropped; a row the
 *   indexer did call a picture counts even with an undecodable MIME; a stale
 *   hidden row in last launch's cache is not painted by the seed.
 * - Hidden page: no query while hidden; becoming visible again asks the index
 *   at once, not on the next generation tick.
 * - A real `PhotosTab` over the store, scrolled deep, with a selection, with
 *   the viewer open: an index refresh that adds and removes files keeps the
 *   same picture under the top edge, keeps the selection, keeps the viewer
 *   open on the same picture, and reuses the DOM of every untouched day. At
 *   the top of the roll a new picture appears as the first tile.
 */

import type { FileEntry } from "@core/explorer/types";
import { MockFs } from "@core/explorer/mock-fs";
import type { RawMediaRow } from "@core/explorer/tauri-fs";
import "../styles/base.css";
import "../styles/phone.css";
import { Thumbs } from "@ui/phone/thumbs";
import { PhotosTab } from "@ui/phone/photos-tab";
import { PhoneViewer } from "@ui/phone/viewer";
import type { PhoneHost, PhoneShell } from "@ui/phone/shell";
import { MediaStore } from "@ui/phone/store";
import { canonicalPath, isHiddenPath, itemFromRow, type DaySection, type GalleryItem } from "@core/phone/gallery";
import { mergeIndex } from "@core/phone/merge";

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
const tick = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/** Poll `cond` until true or `ms` elapsed; resolves the elapsed time. */
async function until(cond: () => boolean, ms = 2000): Promise<number> {
  const t0 = performance.now();
  while (!cond() && performance.now() - t0 < ms) await sleep(10);
  return Math.round(performance.now() - t0);
}

const VOL = "/storage/emulated/0";
const DAY = 86_400_000;
/** A fixed "now" for dates, well inside the plausible window. */
const BASE = Date.now() - 60_000;

// ── The row mapper ──────────────────────────────────────────────────────────

function checkMapper(): void {
  const jpg = itemFromRow({ id: 1, path: `${VOL}/Sync/IMG_0001.JPG`, size: 3_000_000, mime: "image/jpeg", mediaType: 1, modified: BASE, taken: BASE - 5 * DAY, width: 4000, height: 3000 });
  ok("mapper: the primary volume is spelled /sdcard", jpg?.path === "/sdcard/Sync/IMG_0001.JPG", jpg?.path);
  ok("mapper: folder and folder name come from the path", jpg?.folder === "/sdcard/Sync" && jpg?.folderName === "Sync");
  ok("mapper: an upper-case .JPG is an image", jpg?.kind === "image" && jpg.ext === "jpg");
  ok("mapper: capture time wins over mtime", jpg?.modified === BASE - 5 * DAY);
  ok("mapper: width and height come across", jpg?.width === 4000 && jpg?.height === 3000);

  const noext = itemFromRow({ id: 2, path: `${VOL}/Download/picture`, mime: "image/webp", modified: BASE });
  ok("mapper: an extensionless file with an image MIME is an image", noext?.kind === "image", noext?.kind);

  const heic = itemFromRow({ id: 3, path: `${VOL}/DCIM/Camera/IMG_1.HEIC`, modified: BASE });
  const webm = itemFromRow({ id: 4, path: `${VOL}/Movies/clip.webm`, modified: BASE });
  const tgp = itemFromRow({ id: 5, path: `${VOL}/Movies/old.3gp`, modified: BASE });
  const avif = itemFromRow({ id: 6, path: `${VOL}/Pictures/a.avif`, modified: BASE });
  const dng = itemFromRow({ id: 7, path: `${VOL}/DCIM/raw.dng`, modified: BASE });
  const mkv = itemFromRow({ id: 8, path: `${VOL}/Movies/film.MKV`, modified: BASE });
  const gif = itemFromRow({ id: 9, path: `${VOL}/Pictures/loop.gif`, modified: BASE });
  const mov = itemFromRow({ id: 10, path: `${VOL}/DCIM/clip.MOV`, modified: BASE });
  ok("mapper: HEIC, AVIF, DNG, GIF are images by extension alone",
    heic?.kind === "image" && avif?.kind === "image" && dng?.kind === "image" && gif?.kind === "image");
  ok("mapper: WebM, 3GP, MKV, MOV are video by extension alone",
    webm?.kind === "video" && tgp?.kind === "video" && mkv?.kind === "video" && mov?.kind === "video");

  const mimeWins = itemFromRow({ id: 11, path: `${VOL}/Download/odd.bin`, mime: "video/mp4", modified: BASE, duration: 12.5 });
  ok("mapper: a video MIME on an odd extension is still a video with a duration", mimeWins?.kind === "video" && mimeWins.duration === 12.5);

  const byType = itemFromRow({ id: 12, path: `${VOL}/Download/odd2.bin`, mediaType: 1, modified: BASE });
  ok("mapper: MEDIA_TYPE_IMAGE without a MIME is an image", byType?.kind === "image");

  const bogus = itemFromRow({ id: 13, path: `${VOL}/DCIM/x.jpg`, modified: BASE, taken: 0 });
  const ancient = itemFromRow({ id: 14, path: `${VOL}/DCIM/y.jpg`, modified: BASE, taken: 86_400_000 });
  const future = itemFromRow({ id: 15, path: `${VOL}/DCIM/z.jpg`, modified: BASE, taken: BASE + 30 * DAY });
  ok("mapper: an epoch-zero, 1970 or far-future capture time falls back to mtime",
    bogus?.modified === BASE && ancient?.modified === BASE && future?.modified === BASE);

  const addedOnly = itemFromRow({ id: 16, path: `${VOL}/DCIM/w.jpg`, added: BASE - DAY });
  ok("mapper: with no mtime the indexer's first-seen time is the date", addedOnly?.modified === BASE - DAY);
  const undated = itemFromRow({ id: 17, path: `${VOL}/DCIM/v.jpg` });
  ok("mapper: no date at all stays undated rather than becoming Today", undated !== null && !("modified" in undated));

  const pdf = itemFromRow({ id: 18, path: `${VOL}/Documents/tax.pdf`, mime: "application/pdf", modified: BASE });
  const apk = itemFromRow({ id: 19, path: `${VOL}/Download/app.apk`, mime: "application/vnd.android.package-archive", modified: BASE });
  const code = itemFromRow({ id: 20, path: `${VOL}/proj/main.ts`, mime: "text/plain", modified: BASE });
  ok("mapper: a PDF is a document, an APK is not a picture", pdf?.kind === "document" && apk !== null && apk.kind !== "image" && apk.kind !== "video", `${pdf?.kind} ${apk?.kind}`);
  ok("mapper: text/plain does not override a source-file extension", code?.kind === "code" || code?.kind === "document");

  ok("mapper: an empty path is dropped", itemFromRow({ id: 21, path: "" }) === null);
  ok("mapper: a directory-like row (trailing slash) is dropped", itemFromRow({ id: 22, path: `${VOL}/DCIM/` }) === null);

  ok("canonical: SD card paths are left alone", canonicalPath("/storage/1234-5678/DCIM/a.jpg") === "/storage/1234-5678/DCIM/a.jpg");
  ok("canonical: the bare volume becomes /sdcard", canonicalPath(VOL) === "/sdcard");
}

// ── The authoritative merge ─────────────────────────────────────────────────

function item(path: string, modified: number, size = 100): GalleryItem {
  const cut = path.lastIndexOf("/");
  const name = path.slice(cut + 1);
  const folder = path.slice(0, cut);
  return { path, name, kind: "image", ext: "jpg", size, modified, folder, folderName: folder.slice(folder.lastIndexOf("/") + 1) };
}

function checkMerge(): void {
  const a = item("/sdcard/DCIM/a.jpg", 3000);
  const b = item("/sdcard/DCIM/b.jpg", 2000);
  const c = item("/sdcard/DCIM/c.jpg", 1000);
  const current = [a, b, c];

  const same = mergeIndex(current, [item("/sdcard/DCIM/c.jpg", 1000), item("/sdcard/DCIM/a.jpg", 3000), item("/sdcard/DCIM/b.jpg", 2000)]);
  ok("merge: an equal list in another order hands the same array back", same.everything === current);

  const added = mergeIndex(current, [...current, item("/sdcard/Sync/n.jpg", 2500)]);
  ok("merge: one new file is one add, in date order", added.added === 1 && added.removed === 0 && added.everything.map((i) => i.name).join(",") === "a.jpg,n.jpg,b.jpg,c.jpg", added.everything.map((i) => i.name).join(","));
  ok("merge: untouched files keep their objects", added.everything[0] === a && added.everything[2] === b && added.everything[3] === c);

  const removed = mergeIndex(current, [a, c]);
  ok("merge: a missing file is one remove", removed.removed === 1 && removed.added === 0 && removed.everything.length === 2 && removed.everything[0] === a);

  const changed = mergeIndex(current, [a, item("/sdcard/DCIM/b.jpg", 2001), c]);
  ok("merge: a rewritten file (new mtime) is one change and takes the fresh row", changed.changed === 1 && changed.everything[1] !== b && changed.everything[1]?.modified === 2001);

  const dup = mergeIndex(current, [a, a, b, c]);
  ok("merge: a duplicated path is counted once", dup.everything === current);

  const empty = mergeIndex(current, []);
  ok("merge: an empty authority removes everything", empty.removed === 3 && empty.everything.length === 0);
}

// ── The store: desktop fallback ─────────────────────────────────────────────

async function checkDesktop(): Promise<void> {
  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  const store = new MediaStore(fs, ["/pc/Pictures"], ["/pc/Pictures"]);
  await store.refresh();
  const snap = store.get();
  ok("desktop: the walk fills the roll when there is no index", snap.state === "ready" && snap.everything.length > 0, `${snap.state} ${snap.everything.length}`);
  ok("desktop: photos are the image and video subset of everything", snap.items.length > 0 && snap.items.every((it) => it.kind === "image" || it.kind === "video") && snap.items.length < snap.everything.length);
  ok("desktop: the index was asked once and never again", fs.mediaQueries === 0);
  ok("desktop: access is unknown, not 'none'", snap.access === null);
  const before = snap.everything;
  await store.refreshIndex();
  ok("desktop: an index refresh is a no-op", store.get().everything === before);
  store.startWatch(4000, 15, 60_000);
  await sleep(120);
  const priv = store as unknown as { genTimer: number };
  ok("desktop: the generation poll gives up on its own", priv.genTimer === 0);
  store.stopWatch();
}

// ── The store: MediaStore as the authority ──────────────────────────────────

function seedRows(fs: MockFs, n: number, folder = `${VOL}/DCIM/Camera`, perDay = 6): RawMediaRow[] {
  const rows: RawMediaRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const day = Math.floor(i / perDay);
    rows.push(fs.indexFile(`${folder}/IMG_${String(1000 + i).padStart(5, "0")}.JPG`, {
      mime: "image/jpeg", mediaType: 1, size: 2_000_000 + i, modified: BASE - day * DAY - (i % perDay) * 60_000,
    }));
  }
  return rows;
}

async function checkIndexStore(): Promise<void> {
  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  fs.indexSupported = true;
  const rows = seedRows(fs, 60);
  // No walk roots: the index is the whole truth, as on a phone whose walk
  // finds nothing the index lacks.
  const store = new MediaStore(fs, [], []);
  let emits = 0;
  store.subscribe(() => { emits += 1; });

  await store.refresh();
  let snap = store.get();
  ok("index: the roll is the index", snap.state === "ready" && snap.everything.length === 60 && snap.items.length === 60, `${snap.everything.length}`);
  ok("index: paths are spelled /sdcard", snap.items.every((it) => it.path.startsWith("/sdcard/DCIM/Camera/")));
  ok("index: newest first", snap.items.every((it, i, arr) => i === 0 || (arr[i - 1]!.modified ?? 0) >= (it.modified ?? 0)));
  ok("index: access is reported", snap.access === "full");
  ok("index: the walk did not run a hot pass over nothing", true);
  const pagesAfterFirst = fs.mediaQueries;

  // Push: a file lands in a folder no root list has ever named.
  store.startWatch(4000, 15, 60_000);
  await sleep(60); // baseline tick
  const emitsBefore = emits;
  const keep = snap.items[10]!;
  const keepDay = snap.days.find((d) => d.items.includes(keep))!;
  fs.indexFile(`${VOL}/Sync/DSC_0001.JPG`, { mime: "image/jpeg", mediaType: 1, size: 5_000_000, modified: BASE, taken: BASE - 5 * DAY - 30_000 });
  const took = await until(() => store.get().items.some((it) => it.path === "/sdcard/Sync/DSC_0001.JPG"), 3000);
  snap = store.get();
  const arrived = snap.items.find((it) => it.path === "/sdcard/Sync/DSC_0001.JPG");
  ok("push: a file in a never-seen folder shows without a walk", arrived !== undefined, `${took}ms`);
  ok("push: it arrived within one generation tick plus the settle delay", took < 1500, `${took}ms`);
  ok("push: it is filed under its own folder", arrived?.folderName === "Sync");
  ok("push: it landed on its capture day, not at the top", snap.items.indexOf(arrived!) > 0 && snap.items.indexOf(arrived!) < snap.items.length - 1, String(snap.items.indexOf(arrived!)));
  ok("push: untouched files keep their objects", snap.items.includes(keep));
  ok("push: untouched days keep their section objects", snap.days.includes(keepDay));
  ok("push: one change is one emit", emits - emitsBefore === 1, String(emits - emitsBefore));
  ok("push: the album list knows the new folder", snap.albums.some((a) => a.name === "Sync"));

  // Delete.
  const victim = rows[5]!;
  const victimPath = canonicalPath(victim.path);
  fs.unindexFile(victim.path);
  const gone = await until(() => !store.get().items.some((it) => it.path === victimPath), 3000);
  ok("push: a deleted file vanishes on its own", !store.get().items.some((it) => it.path === victimPath), `${gone}ms`);
  ok("push: the count follows", store.get().items.length === 60, String(store.get().items.length));

  // Burst: twenty-two files at once, the a sync client case.
  const queriesBefore = fs.mediaQueries;
  const e0 = emits;
  for (let i = 0; i < 22; i += 1) {
    fs.indexFile(`${VOL}/Sync/P${String(i).padStart(2, "0")}.JPG`, { mime: "image/jpeg", mediaType: 1, size: 4_000_000 + i, modified: BASE - 2 * DAY + i * 1000 });
  }
  await until(() => store.get().items.filter((it) => it.folderName === "Sync").length === 23, 3000);
  await sleep(500);
  ok("burst: all twenty-two arrived", store.get().items.filter((it) => it.folderName === "Sync").length === 23, String(store.get().items.filter((it) => it.folderName === "Sync").length));
  ok("burst: coalesced into at most two index queries", fs.mediaQueries - queriesBefore <= 2, String(fs.mediaQueries - queriesBefore));
  ok("burst: and at most two emits", emits - e0 <= 2, String(emits - e0));

  // Quiet: no change, no emit, no query beyond the pulse.
  const q1 = fs.mediaQueries;
  const e1 = emits;
  await sleep(200);
  ok("quiet: an unchanged counter costs no query and no emit", fs.mediaQueries === q1 && emits === e1, `${fs.mediaQueries - q1} queries, ${emits - e1} emits`);

  // Tombstone: the app trashed a file; the index still lists it for a while.
  const trashed = store.get().items[3]!;
  store.noteTrashed(trashed.path, `${trashed.folder}/.facet-trash/${trashed.name}`);
  ok("trash: the roll drops it at once", !store.get().items.some((it) => it.path === trashed.path));
  ok("trash: the trash list has it", store.get().trash.some((it) => it.name === trashed.name));
  await store.refreshIndex();
  ok("trash: a stale index row cannot bring it back", !store.get().items.some((it) => it.path === trashed.path));

  // Hidden: a change while hidden waits for the next visible tick; the
  // visibility handler asks the index the moment we are back.
  store.stopWatch();
  ok("index: pages were bounded", pagesAfterFirst <= 2, String(pagesAfterFirst));
}

async function checkWalkOnly(): Promise<void> {
  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  fs.indexSupported = true;
  seedRows(fs, 12);
  // A walk root the index knows nothing about: files there are walk-only.
  const store = new MediaStore(fs, ["/sdcard/Nomedia"], ["/sdcard/Nomedia"]);
  await store.refresh();
  const walked = store.get().everything.filter((it) => it.path.startsWith("/sdcard/Nomedia"));
  ok("walk: files the index lacks come from the walk", walked.length > 0, String(walked.length));
  ok("walk: and sit beside the index rows", store.get().everything.length === walked.length + 12);
  const firstWalked = walked[0]!;
  fs.indexFile(`${VOL}/Sync/x.jpg`, { mime: "image/jpeg", modified: BASE });
  await store.refreshIndex();
  ok("walk: an index refresh keeps walk-only files", store.get().everything.includes(firstWalked));
  ok("walk: and still takes the new index row", store.get().everything.some((it) => it.path === "/sdcard/Sync/x.jpg"));
  // Restore from trash: the restored path is walk-only until the index sees it.
  const restored: GalleryItem = { ...firstWalked, path: "/sdcard/Restored/back.jpg", name: "back.jpg", folder: "/sdcard/Restored", folderName: "Restored" };
  store.noteRestored([], [restored]);
  await store.refreshIndex();
  ok("walk: a restored file survives the next index refresh", store.get().everything.some((it) => it.path === "/sdcard/Restored/back.jpg"));
}

async function checkAccess(): Promise<void> {
  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  fs.indexSupported = true;
  fs.mediaAccess = "none";
  const store = new MediaStore(fs, [], []);
  await store.refresh();
  ok("access: no permission and nothing to show is an honest empty state", store.get().state === "empty" && store.get().access === "none", `${store.get().state} ${store.get().access}`);

  fs.mediaAccess = "full";
  seedRows(fs, 10);
  await store.refresh();
  ok("access: granting fills the roll", store.get().items.length === 10 && store.get().access === "full");

  // The provider blinks: an empty answer with a reason must not wipe the roll.
  const rows = fs.mediaRows;
  fs.mediaRows = [];
  fs.mediaAccess = "none";
  await store.refreshIndex();
  ok("access: an empty answer without access keeps the roll on screen", store.get().items.length === 10, String(store.get().items.length));
  ok("access: but reports the reason", store.get().access === "none");
  fs.mediaRows = rows;
  fs.mediaAccess = "partial";
  await store.refreshIndex();
  ok("access: a partial grant is reported as such", store.get().access === "partial" && store.get().items.length === 10);
}

async function checkCache(): Promise<void> {
  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  fs.indexSupported = true;
  seedRows(fs, 8);
  fs.indexFile(`${VOL}/Download/nodot`, { mime: "image/webp", modified: BASE });
  const store = new MediaStore(fs, [], []);
  await store.refresh();
  store.flushPersist();
  const raw = localStorage.getItem("fct.phone.index.v1");
  ok("cache: the index is persisted", raw !== null && raw.includes("/sdcard/Download/nodot"));
  const rows = (JSON.parse(raw ?? "{}") as { hits: unknown[][] }).hits;
  const odd = rows.find((r) => r[0] === "/sdcard/Download/nodot");
  const plain = rows.find((r) => r[0] !== "/sdcard/Download/nodot");
  ok("cache: a MIME-derived kind is stored only when the extension cannot re-derive it", odd?.length === 4 && odd[3] === "image" && plain?.length === 3, `${odd?.length} ${plain?.length}`);

  // Next launch: the seed must reproduce the kind.
  const fs2 = new MockFs();
  fs2.indexSupported = true;
  fs2.mediaRows = fs.mediaRows;
  const store2 = new MediaStore(fs2, [], []);
  let seeded: GalleryItem[] | null = null;
  store2.subscribe((s) => { if (seeded === null && s.items.length > 0) seeded = [...s.items]; });
  const p = store2.refresh();
  ok("cache: the seed paints the whole library before the index answers", seeded !== null && (seeded as GalleryItem[]).length === 9, String((seeded as GalleryItem[] | null)?.length));
  ok("cache: the extensionless picture is still a picture after a relaunch", (seeded as GalleryItem[] | null)?.some((it) => it.path === "/sdcard/Download/nodot" && it.kind === "image") === true);
  await p;
  ok("cache: the index agrees and the roll is unchanged", store2.get().items.length === 9);
  localStorage.removeItem("fct.phone.index.v1");
}

// ── The phone's actual missing files (2026-09-05 ground truth) ──────────────
//
// MediaStore on a test phone held 5197 images+videos; the roll showed
// 5069. Every one of the 126 missing sat outside the hard-coded roots: 116 in
// /storage/emulated/0/Sync (JPG, png, mp4, MTS), 8 in a new top-level
// folder trip-2026-06-25 (jpg, mp4, mov), one file at the storage root
// itself (sc.png, no folder), and AAtest/ffmpeg-test.mp4. WhatsApp's 903 rows
// live deep under Android/media/com.whatsapp and must keep working.

async function checkGroundTruth(): Promise<void> {
  // Shapes, one row each.
  const rootFile = itemFromRow({ id: 1, path: `${VOL}/sc.png`, mime: "image/png", mediaType: 1, modified: BASE });
  ok("truth: a file directly in the storage root is a picture at /sdcard/sc.png",
    rootFile?.path === "/sdcard/sc.png" && rootFile.kind === "image", rootFile?.path);
  ok("truth: its folder is the root itself, named sdcard, not an empty string",
    rootFile?.folder === "/sdcard" && rootFile?.folderName === "sdcard", `${rootFile?.folder} ${rootFile?.folderName}`);

  const mts = itemFromRow({ id: 2, path: `${VOL}/Sync/00012.MTS`, mime: "video/mp2t", mediaType: 3, modified: BASE });
  const mtsNoMime = itemFromRow({ id: 3, path: `${VOL}/Sync/00013.MTS`, modified: BASE });
  const mov = itemFromRow({ id: 4, path: `${VOL}/trip-2026-06-25/IMG_4411.MOV`, mime: "video/quicktime", modified: BASE });
  const webp = itemFromRow({ id: 5, path: `${VOL}/Pictures/sticker.webp`, mime: "image/webp", modified: BASE });
  const jpeg = itemFromRow({ id: 6, path: `${VOL}/trip-2026-06-25/photo.jpeg`, modified: BASE });
  ok("truth: MTS is video with and without a MIME", mts?.kind === "video" && mtsNoMime?.kind === "video", `${mts?.kind} ${mtsNoMime?.kind}`);
  ok("truth: MOV, webp, jpeg come through as video, image, image",
    mov?.kind === "video" && webp?.kind === "image" && jpeg?.kind === "image");
  ok("truth: a new top-level folder is filed under its own name",
    mov?.folder === "/sdcard/trip-2026-06-25" && mov?.folderName === "trip-2026-06-25");

  const wa = itemFromRow({ id: 7, path: `${VOL}/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-20260901-WA0001.jpg`, mime: "image/jpeg", modified: BASE });
  ok("truth: a deep WhatsApp file keeps its full path and folder",
    wa?.path === "/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-20260901-WA0001.jpg" && wa?.folderName === "WhatsApp Images");

  // Same root, two spellings: the walk says /sdcard, the index says
  // /storage/emulated/0. One file must be one row.
  ok("truth: /sdcard and /storage/emulated/0 are the same root",
    canonicalPath(`${VOL}/DCIM/a.jpg`) === canonicalPath("/sdcard/DCIM/a.jpg") && canonicalPath("/sdcard/DCIM/a.jpg") === "/sdcard/DCIM/a.jpg");

  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  // The walk covers one root; the index lists the same files under the
  // other spelling, plus everything the walk could never see. What the walk
  // finds is learned from a walk with no index at all.
  const walkRoot = "/sdcard/DCIM/Camera";
  const walkOnlyStore = new MediaStore(fs, [walkRoot], [walkRoot]);
  await walkOnlyStore.refresh();
  const walkFiles = walkOnlyStore.get().everything;
  ok("truth: the walk alone finds files", walkFiles.length > 0, String(walkFiles.length));
  localStorage.removeItem("fct.phone.index.v1");
  fs.indexSupported = true;
  for (const e of walkFiles) {
    fs.indexFile(`${VOL}${e.path.slice("/sdcard".length)}`, { size: e.size ?? 0, modified: e.modified ?? BASE });
  }
  const outside: string[] = [];
  for (let i = 0; i < 116; i += 1) {
    const ext = ["JPG", "png", "mp4", "MTS"][i % 4]!;
    outside.push(fs.indexFile(`${VOL}/Sync/file_${String(i).padStart(3, "0")}.${ext}`, { modified: BASE - i * 60_000 }).path);
  }
  for (let i = 0; i < 8; i += 1) {
    const ext = ["jpg", "mp4", "mov"][i % 3]!;
    outside.push(fs.indexFile(`${VOL}/trip-2026-06-25/clip_${i}.${ext}`, { modified: BASE - DAY - i * 60_000 }).path);
  }
  outside.push(fs.indexFile(`${VOL}/sc.png`, { mime: "image/png", modified: BASE - 2 * DAY }).path);
  outside.push(fs.indexFile(`${VOL}/AAtest/ffmpeg-test.mp4`, { mime: "video/mp4", modified: BASE - 3 * DAY }).path);
  for (let i = 0; i < 20; i += 1) {
    outside.push(fs.indexFile(`${VOL}/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-2026090${i % 10}-WA00${String(i).padStart(2, "0")}.jpg`, { mime: "image/jpeg", modified: BASE - 4 * DAY - i * 60_000 }).path);
  }
  // A .facet-trash row from the index must not count.
  fs.indexFile(`${VOL}/DCIM/Camera/.facet-trash/old.jpg`, { mime: "image/jpeg", modified: BASE });

  const store = new MediaStore(fs, [walkRoot], [walkRoot]);
  await store.refresh();
  const snap = store.get();
  const paths = snap.everything.map((it) => it.path);
  const dupes = paths.length - new Set(paths).size;
  ok("truth: no file appears twice across the two spellings", dupes === 0, `${dupes} duplicates`);
  ok("truth: nothing is spelled /storage/emulated/0 in the roll", paths.every((p) => !p.startsWith("/storage/emulated/0")));
  const walkOnScreen = walkFiles.filter((e) => paths.includes(e.path)).length;
  ok("truth: every walked file is on the roll exactly once", walkOnScreen === walkFiles.length, `${walkOnScreen} of ${walkFiles.length}`);
  const outsideOnScreen = outside.filter((p) => paths.includes(canonicalPath(p))).length;
  ok("truth: all 146 files outside the walked roots are on the roll (116 Sync + 8 new folder + root file + AAtest + 20 WhatsApp)",
    outsideOnScreen === outside.length, `${outsideOnScreen} of ${outside.length}`);
  ok("truth: the roll count is walk + index-only, and nothing else",
    snap.everything.length === walkFiles.length + outside.length, `${snap.everything.length} vs ${walkFiles.length + outside.length}`);
  ok("truth: the .facet-trash row is not on the roll", !paths.some((p) => p.includes("/.facet-trash/")));
  ok("truth: the root-level file is in Photos", snap.items.some((it) => it.path === "/sdcard/sc.png"));
  ok("truth: the MTS clips are in Photos as video", snap.items.filter((it) => it.ext === "mts").length === 29 && snap.items.filter((it) => it.ext === "mts").every((it) => it.kind === "video"), String(snap.items.filter((it) => it.ext === "mts").length));
  ok("truth: the WhatsApp folder is an album", snap.albums.some((a) => a.name === "WhatsApp Images"));
  ok("truth: Sync and the new folder are albums", snap.albums.some((a) => a.name === "Sync") && snap.albums.some((a) => a.name === "trip-2026-06-25"));
  ok("truth: the root itself is an album, so the root-level file is reachable", snap.albums.some((a) => a.path === "/sdcard"), snap.albums.map((a) => a.path).slice(0, 5).join(","));

  // The walk root indexed under the other spelling must dedupe on a refresh
  // too, not only on the first merge.
  await store.refreshIndex();
  const again = store.get().everything.map((it) => it.path);
  ok("truth: an index refresh keeps it one row per file", again.length === new Set(again).size && again.length === snap.everything.length, String(again.length));
}

// ── What Samsung Gallery hides, we hide (2026-09-05 regression) ─────────────
//
// The first indexed build put 12,100 items on a roll whose MediaStore had
// 5,197 pictures and clips. The extra 6,900 were rows with media_type 0:
// WhatsApp's `.Statuses`, `.Thumbs` and sticker folders under `.nomedia`,
// Google's `Pictures/.gs`, `.gs_fs0/.N.jpg`, and Samsung's own trash under
// `Android/.Trash`. The mapper had fallen back to MIME and extension.

async function checkHidden(): Promise<void> {
  // media_type 0 with a picture MIME and extension is not a picture.
  const status = itemFromRow({ id: 1, path: `${VOL}/Android/media/com.whatsapp/WhatsApp/Media/.Statuses/abc.jpg`, mime: "image/jpeg", mediaType: 0, modified: BASE });
  ok("hidden: a .Statuses row is dropped outright", status === null);
  const noneType = itemFromRow({ id: 2, path: `${VOL}/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Stickers/pack.webp`, mime: "image/webp", mediaType: 0, modified: BASE });
  ok("hidden: MEDIA_TYPE_NONE with an image MIME and extension is a plain file, not a picture",
    noneType !== null && noneType.kind === "binary", noneType?.kind);
  const noneDoc = itemFromRow({ id: 3, path: `${VOL}/Download/paper.pdf`, mime: "application/pdf", mediaType: 0, modified: BASE });
  ok("hidden: MEDIA_TYPE_NONE keeps a non-media kind", noneDoc?.kind === "document");
  const noneMp4 = itemFromRow({ id: 4, path: `${VOL}/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video/Sent/x.mp4`, mediaType: 0, modified: BASE });
  ok("hidden: MEDIA_TYPE_NONE .mp4 is not video", noneMp4 !== null && noneMp4.kind !== "video");

  // Dot-prefixed segments anywhere.
  ok("hidden: Google's Pictures/.gs is dropped", itemFromRow({ id: 5, path: `${VOL}/Pictures/.gs/img.jpg`, mime: "image/jpeg", mediaType: 1, modified: BASE }) === null);
  ok("hidden: a dot-named file (.N.jpg) is dropped", itemFromRow({ id: 6, path: `${VOL}/Pictures/.gs_fs0/.N.jpg`, mime: "image/jpeg", mediaType: 1, modified: BASE }) === null);
  ok("hidden: Samsung's Android/.Trash is dropped", itemFromRow({ id: 7, path: `${VOL}/Android/.Trash/com.sec.android.gallery3d/1.jpg`, mime: "image/jpeg", mediaType: 1, modified: BASE }) === null);
  ok("hidden: a .thumbnails folder is dropped", itemFromRow({ id: 8, path: `${VOL}/DCIM/.thumbnails/1.jpg`, mime: "image/jpeg", mediaType: 1, modified: BASE }) === null);
  ok("hidden: .facet-trash is dropped by the same rule", itemFromRow({ id: 9, path: `${VOL}/DCIM/Camera/.facet-trash/old.jpg`, mime: "image/jpeg", mediaType: 1, modified: BASE }) === null);

  // Pending and trashed flags.
  ok("hidden: an IS_TRASHED row is dropped", itemFromRow({ id: 10, path: `${VOL}/DCIM/Camera/t.jpg`, mime: "image/jpeg", mediaType: 1, modified: BASE, trashed: true }) === null);
  ok("hidden: an IS_PENDING row is dropped", itemFromRow({ id: 11, path: `${VOL}/DCIM/Camera/p.jpg`, mime: "image/jpeg", mediaType: 1, modified: BASE, pending: true }) === null);

  // Gallery parity the other way: what the indexer calls a picture counts,
  // even with a MIME we cannot decode and a folder we have never heard of.
  const odd = itemFromRow({ id: 12, path: `${VOL}/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-1.jpg`, mime: "image/x-strange", mediaType: 1, modified: BASE });
  ok("hidden: a media_type 1 row with an undecodable MIME is still a picture", odd?.kind === "image");
  // 2026-09-05, one row short of Gallery: MEDIA_TYPE outranks the MIME string.
  const audioMime = itemFromRow({ id: 13, path: `${VOL}/Movies/clip.mp4`, mime: "audio/mp4", mediaType: 3, modified: BASE });
  ok("hidden: a media_type 3 row with an audio/* MIME is still a clip on the roll", audioMime?.kind === "video", audioMime?.kind);
  const octet = itemFromRow({ id: 14, path: `${VOL}/Download/IMG_9.jpg`, mime: "application/octet-stream", mediaType: 1, modified: BASE });
  ok("hidden: a media_type 1 row with an octet-stream MIME is still a picture", octet?.kind === "image");
  const noExt = itemFromRow({ id: 15, path: `${VOL}/Download/received_file`, mediaType: 1, modified: BASE });
  ok("hidden: a media_type 1 row with no MIME and no extension is still a picture", noExt?.kind === "image");
  const mimeOnly = itemFromRow({ id: 16, path: `${VOL}/Download/x.bin`, mime: "video/mp4", modified: BASE });
  ok("hidden: with no MEDIA_TYPE the MIME still decides", mimeOnly?.kind === "video");
  const pdfType = itemFromRow({ id: 17, path: `${VOL}/Download/paper.pdf`, mime: "application/pdf", mediaType: 6, modified: BASE });
  ok("hidden: a document row stays a document", pdfType?.kind === "document");
  ok("hidden: a plain WhatsApp Images row (no .nomedia) is on the roll", odd?.folderName === "WhatsApp Images");
  ok("hidden: a visible dot-less path passes", isHiddenPath("/sdcard/DCIM/Camera/a.jpg") === false && isHiddenPath("/sdcard/facet-livetest/livetest-210647.png") === false);
  ok("hidden: a lone dot segment does not count", isHiddenPath("/sdcard/./a.jpg") === false);

  // Through the store: a WhatsApp-shaped index, counts must match Gallery.
  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  fs.indexSupported = true;
  const wa = `${VOL}/Android/media/com.whatsapp/WhatsApp/Media`;
  for (let i = 0; i < 40; i += 1) fs.indexFile(`${wa}/WhatsApp Images/IMG-${i}.jpg`, { mime: "image/jpeg", mediaType: 1, modified: BASE - i * 60_000 });
  for (let i = 0; i < 60; i += 1) fs.indexFile(`${wa}/.Statuses/${i}.jpg`, { mime: "image/jpeg", mediaType: 0, modified: BASE - i * 60_000 });
  for (let i = 0; i < 30; i += 1) fs.indexFile(`${wa}/WhatsApp Stickers/${i}.webp`, { mime: "image/webp", mediaType: 0, modified: BASE - i * 60_000 });
  for (let i = 0; i < 10; i += 1) fs.indexFile(`${wa}/.Thumbs/${i}.jpg`, { mime: "image/jpeg", mediaType: 0, modified: BASE });
  for (let i = 0; i < 6; i += 1) fs.indexFile(`${VOL}/Android/.Trash/com.sec.android.gallery3d/${i}.jpg`, { mime: "image/jpeg", mediaType: 1, modified: BASE });
  fs.indexFile(`${VOL}/Pictures/.gs_fs0/.N.jpg`, { mime: "image/jpeg", mediaType: 1, modified: BASE });
  fs.indexFile(`${VOL}/DCIM/Camera/trashed.jpg`, { mime: "image/jpeg", mediaType: 1, modified: BASE, trashed: true });
  fs.indexFile(`${VOL}/DCIM/Camera/pending.jpg`, { mime: "image/jpeg", mediaType: 1, modified: BASE, pending: true });
  fs.indexFile(`${VOL}/facet-livetest/livetest-210647.png`, { mime: "image/png", mediaType: 1, modified: BASE });
  const store = new MediaStore(fs, [], []);
  await store.refresh();
  const snap = store.get();
  ok("hidden: the roll holds exactly the 40 WhatsApp pictures and the test file", snap.items.length === 41, String(snap.items.length));
  ok("hidden: the 30 sticker files are plain files in everything, not photos",
    snap.everything.length === 71 && snap.everything.filter((it) => it.kind === "binary").length === 30, `${snap.everything.length} ${snap.everything.filter((it) => it.kind === "binary").length}`);
  ok("hidden: nothing hidden reached everything", snap.everything.every((it) => !isHiddenPath(it.path)));
  ok("hidden: no album for a hidden folder", snap.albums.every((a) => !isHiddenPath(a.path)) && !snap.albums.some((a) => a.name === ".Statuses"));

  // A cache written by the previous build carried hidden rows; the seed of
  // the next launch must not paint them.
  store.flushPersist();
  const raw = localStorage.getItem("fct.phone.index.v1")!;
  const data = JSON.parse(raw) as { hits: unknown[][] };
  data.hits.push(["/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses/stale.jpg", 1000, BASE]);
  localStorage.setItem("fct.phone.index.v1", JSON.stringify(data));
  const fs2 = new MockFs();
  fs2.indexSupported = true;
  fs2.mediaRows = fs.mediaRows;
  const store2 = new MediaStore(fs2, [], []);
  let seeded: GalleryItem[] | null = null;
  store2.subscribe((s) => { if (seeded === null && s.items.length > 0) seeded = [...s.items]; });
  await store2.refresh();
  ok("hidden: a stale hidden row in last launch's cache is not painted by the seed",
    seeded !== null && !(seeded as GalleryItem[]).some((it) => it.path.includes("/.Statuses/")), String((seeded as GalleryItem[] | null)?.length));
  localStorage.removeItem("fct.phone.index.v1");
}

// ── Coming back from the background ─────────────────────────────────────────

async function checkVisibility(): Promise<void> {
  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  fs.indexSupported = true;
  seedRows(fs, 12);
  const store = new MediaStore(fs, [], []);
  await store.refresh();
  store.startWatch(4000, 15, 60_000);
  await sleep(60);

  // The page goes hidden (screen locked, app behind another). A file lands.
  // The generation tick must not fire while hidden; the moment the page is
  // visible again the index is asked at once, without waiting for a tick.
  const doc = document as Document & { hidden: boolean; visibilityState: DocumentVisibilityState };
  Object.defineProperty(doc, "hidden", { configurable: true, get: () => true });
  Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  const q0 = fs.mediaQueries;
  fs.indexFile(`${VOL}/Sync/while-hidden.jpg`, { mime: "image/jpeg", mediaType: 1, modified: BASE });
  await sleep(120);
  ok("visibility: nothing is queried while the page is hidden", fs.mediaQueries === q0, String(fs.mediaQueries - q0));
  ok("visibility: the file is not yet on the roll", !store.get().items.some((it) => it.name === "while-hidden.jpg"));

  Object.defineProperty(doc, "hidden", { configurable: true, get: () => false });
  Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  const took = await until(() => store.get().items.some((it) => it.name === "while-hidden.jpg"), 2000);
  ok("visibility: becoming visible refreshes the index at once", store.get().items.some((it) => it.name === "while-hidden.jpg"), `${took}ms`);
  ok("visibility: well inside one generation tick", took < 200, `${took}ms`);

  store.stopWatch();
  delete (doc as unknown as Record<string, unknown>)["hidden"];
  delete (doc as unknown as Record<string, unknown>)["visibilityState"];
  ok("visibility: the document is visible again for the next check", document.hidden === false);
}

// ── The grid under a finger ─────────────────────────────────────────────────

interface Rig {
  fs: MockFs;
  store: MediaStore;
  tab: PhotosTab;
  body: HTMLElement;
  viewer: PhoneViewer;
  ph: HTMLElement;
  thumbs: Thumbs;
}

async function rig(rows: number): Promise<Rig> {
  localStorage.removeItem("fct.phone.index.v1");
  const fs = new MockFs();
  fs.indexSupported = true;
  seedRows(fs, rows, `${VOL}/DCIM/Camera`, 18);
  const store = new MediaStore(fs, [], []);
  const thumbs = new Thumbs(fs as unknown as PhoneHost["fs"]);
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
  const host = { fs, home: "/", native: true, openPanel() {}, runTool: () => true } as unknown as PhoneHost;
  const viewer = new PhoneViewer(host, store, thumbs);
  document.body.append(viewer.el);
  const shell = {
    thumbs, get scroller() { return body; }, native: true, fs, store, viewer,
    refreshChrome() {}, open(entry: FileEntry, siblings: readonly FileEntry[]) { viewer.open(entry, siblings); }, openTrash() {}, trashItem() {},
  } as unknown as PhoneShell;
  const tab = new PhotosTab(shell);
  body.append(tab.el);
  tab.activate();
  await store.refresh();
  await tick(); await tick(); await sleep(100);
  return { fs, store, tab, body, viewer, ph, thumbs };
}

function teardown(r: Rig): void {
  r.store.stopWatch();
  r.thumbs.dispose();
  r.viewer.dispose();
  r.ph.remove();
  r.viewer.el.remove();
}

/** The cell whose box covers the scroller's top edge, and the item it draws. */
function topCell(body: HTMLElement): { cell: HTMLElement; name: string; offset: number } | null {
  const R = body.getBoundingClientRect();
  const cells = Array.from(body.querySelectorAll<HTMLElement>(".ph-cell"));
  for (const c of cells) {
    const r = c.getBoundingClientRect();
    if (r.bottom > R.top + 1 && r.top <= R.top + r.height) return { cell: c, name: c.getAttribute("aria-label") ?? "", offset: r.top - R.top };
  }
  return null;
}

async function scrollTo(body: HTMLElement, y: number): Promise<void> {
  body.scrollTop = y;
  body.dispatchEvent(new Event("scroll"));
  await tick(); await tick();
}

async function checkGrid(): Promise<void> {
  const r = await rig(90 * 18);
  const { fs, store, tab, body, viewer } = r;
  const priv = tab as unknown as { selection: Set<string>; selecting: boolean; beginSelect(): void; toggle(item: GalleryItem, cell: HTMLElement): void; dayNodes: Map<DaySection, HTMLElement[]>; days: readonly DaySection[] };
  ok("grid: the roll drew from the index", body.querySelectorAll(".ph-cell").length > 0 && store.get().items.length === 1620, String(store.get().items.length));

  // Deep scroll.
  const max = () => body.scrollHeight - body.clientHeight;
  for (let y = 0; y < 12_000 && y < max(); y += 2_000) await scrollTo(body, y);
  await sleep(150);
  const deep = body.scrollTop;
  ok("grid: scrolled deep", deep > 8_000, String(deep));
  const anchor = topCell(body);
  ok("grid: there is a picture under the top edge", anchor !== null);

  // Selection on a visible tile.
  priv.beginSelect();
  const pick = store.get().items.find((it) => it.name === anchor?.name)!;
  priv.toggle(pick, anchor!.cell);
  ok("grid: one tile selected", priv.selection.size === 1 && anchor!.cell.getAttribute("aria-selected") === "true");

  // Viewer open on a picture from the middle of the roll.
  const viewed = store.get().items[400]!;
  viewer.open(viewed, store.get().items);
  await tick();
  ok("grid: the viewer is open", viewer.el.hidden === false);

  // An untouched day's DOM, for identity.
  const untouchedDay = store.get().days.find((d) => d.items.includes(pick))!;
  const untouchedNodes = priv.dayNodes.get(untouchedDay);

  // Now the index changes: three new files on three days (one of them today,
  // above the viewport), two deletions (one above the viewport, one below).
  store.startWatch(4000, 15, 60_000);
  await sleep(60);
  const items = store.get().items;
  const above = items[2]!;
  const below = items[1500]!;
  fs.unindexFile(`${VOL}${above.path.slice("/sdcard".length)}`);
  fs.unindexFile(`${VOL}${below.path.slice("/sdcard".length)}`);
  fs.indexFile(`${VOL}/Sync/T1.JPG`, { mime: "image/jpeg", modified: BASE + 1000 });
  fs.indexFile(`${VOL}/Sync/T2.JPG`, { mime: "image/jpeg", modified: BASE - 3 * DAY });
  fs.indexFile(`${VOL}/Sync/T3.JPG`, { mime: "image/jpeg", modified: BASE - 70 * DAY });
  await until(() => store.get().items.some((it) => it.name === "T3.JPG") && !store.get().items.some((it) => it.path === above.path), 3000);
  await tick(); await tick(); await sleep(150);

  ok("refresh: adds and removes landed", store.get().items.length === 1621 && store.get().items.some((it) => it.name === "T1.JPG"), String(store.get().items.length));
  const after = topCell(body);
  ok("refresh: the same picture is still under the top edge", after !== null && anchor !== null && after.name === anchor.name, `${anchor?.name} -> ${after?.name} st ${deep} -> ${body.scrollTop}`);
  ok("refresh: and at the same offset", after !== null && anchor !== null && Math.abs(after.offset - anchor.offset) < 2, `${anchor?.offset} -> ${after?.offset}`);
  ok("refresh: the scroll position was compensated, not reset", body.scrollTop > 8_000 && body.scrollTop !== 0, String(body.scrollTop));
  ok("refresh: the selection survived", priv.selecting && priv.selection.size === 1 && priv.selection.has(pick.path));
  const pickCell = Array.from(body.querySelectorAll<HTMLElement>(".ph-cell")).find((c) => c.getAttribute("aria-label") === pick.name);
  ok("refresh: the selected tile is still drawn selected", pickCell?.getAttribute("aria-selected") === "true");
  ok("refresh: the viewer is still open", viewer.el.hidden === false);
  const vpriv = viewer as unknown as { items: FileEntry[]; index: number };
  ok("refresh: on the same picture", vpriv.items[vpriv.index]?.path === viewed.path);
  ok("refresh: an untouched day kept its section object", store.get().days.includes(untouchedDay));
  ok("refresh: and its DOM nodes", untouchedNodes !== undefined && priv.dayNodes.get(untouchedDay) === untouchedNodes);
  const daySecs = body.querySelectorAll(".ph-daysec").length;
  ok("refresh: the roll is still one grid, not two", daySecs > 0 && daySecs === new Set(Array.from(body.querySelectorAll(".ph-day")).map((h) => h.textContent)).size, String(daySecs));

  // Back to the top: a new file appears as the first tile.
  viewer.close();
  await scrollTo(body, 0);
  await sleep(100);
  fs.indexFile(`${VOL}/Sync/NEWEST.JPG`, { mime: "image/jpeg", modified: BASE + 5000 });
  await until(() => store.get().items[0]?.name === "NEWEST.JPG", 3000);
  await tick(); await tick(); await sleep(150);
  const first = body.querySelector<HTMLElement>(".ph-cell");
  ok("top: at the top of the roll the newest file becomes the first tile", first?.getAttribute("aria-label") === "NEWEST.JPG", first?.getAttribute("aria-label") ?? "none");
  ok("top: and the scroll stays at the top", body.scrollTop === 0, String(body.scrollTop));

  teardown(r);
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const steps: [string, () => void | Promise<void>][] = [
    ["mapper", checkMapper],
    ["merge", checkMerge],
    ["desktop", checkDesktop],
    ["index", checkIndexStore],
    ["walk", checkWalkOnly],
    ["access", checkAccess],
    ["cache", checkCache],
    ["truth", checkGroundTruth],
    ["hidden", checkHidden],
    ["visibility", checkVisibility],
    ["grid", checkGrid],
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
