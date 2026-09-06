/**
 * One scan, shared.
 *
 * Photos and Albums are two views of the same set of files, and Search is a
 * filter over it. If each tab ran its own `scan_media` the phone would walk the
 * card three times to draw the same twenty thousand entries, and the second and
 * third walks would be the ones the user is actually waiting on. So the scan
 * lives here, the tabs subscribe, and switching tabs after the first load is
 * instant because there is nothing left to do.
 *
 * The store is deliberately not a cache with an expiry — but it does keep the
 * last full index in localStorage. A cold launch paints the *complete* library
 * from that cache in one frame, and the walk that follows only touches the
 * screen if it found something different. That ordering is what killed the
 * whole family of "opens on the wrong date for a second" bugs: there is no
 * partial first paint left to be wrong.
 *
 * On the phone the authority is no longer the walk. It is MediaStore -- the
 * same index Samsung Gallery reads -- paged in through `mediaQuery`, with the
 * walk kept only for files the system has not indexed. A ContentObserver on
 * the Kotlin side bumps a counter every time that index changes; polling the
 * counter once a second is what makes a photo dropped into a folder this app
 * has never heard of appear on its own. The 2026-09-05 case: twenty-two
 * pictures arrived over a sync client into `/sdcard/Sync`, Samsung Gallery
 * showed them, and this app never did, because no hard-coded root list can
 * name a folder that did not exist when it was written.
 */

import type { MediaAccess, TauriFs } from "@core/explorer/tauri-fs";
import { mark, perf } from "@core/phone/mark";
import { mergeHot, mergeIndex, reuseDays } from "@core/phone/merge";
import {
  byAlbum,
  byDay,
  itemFromRow,
  isHiddenPath,
  itemsFromCache,
  scanGallery,
  toCacheRow,
  type Album,
  type CacheRow,
  type DaySection,
  type GalleryItem,
} from "@core/phone/gallery";

export type StoreState = "idle" | "scanning" | "ready" | "empty";

export interface StoreSnapshot {
  state: StoreState;
  /** Pictures and video only — the Photos roll, Albums and the viewer. */
  items: readonly GalleryItem[];
  days: readonly DaySection[];
  albums: readonly Album[];
  /**
   * The same scan, unfiltered: media plus documents, downloads, audio,
   * installs and archives. One walk feeds both — see `scanGallery`.
   */
  everything: readonly GalleryItem[];
  /** `everything`, grouped by day, for the All tab's roll. */
  allDays: readonly DaySection[];
  /** What the walk found inside `.facet-trash` folders, newest deletion first. */
  trash: readonly GalleryItem[];
  /** True when the walk hit its limit or its time budget — surfaced, not hidden. */
  truncated: boolean;
  /**
   * True while this snapshot is provisional — the cached index from last
   * launch, or the fast first pass — and the full walk is still running.
   * Distinct from `truncated`: truncated means "this is all you are getting",
   * partial means "there is more, it is coming".
   */
  partial: boolean;
  dirsVisited: number;
  /**
   * What the phone's media index let us see: everything, a user-picked
   * subset (Android 14's "select photos"), or nothing. `null` where there is
   * no such index (desktop) or before the first answer. The empty state words
   * itself from this instead of claiming the card is empty.
   */
  access: MediaAccess | null;
}

type Listener = (snap: StoreSnapshot) => void;

/** Where the last full index lives between launches. */
const CACHE_KEY = "fct.phone.index.v1";

/** Rows per `media_query` page. A 5k library is five round trips. */
const INDEX_PAGE = 1000;
/** Hard stop on paging: a hundred pages is a hundred thousand files. */
const INDEX_MAX_PAGES = 100;

/** How long a locally removed path stays barred from the index merge. */
const TOMBSTONE_MS = 90_000;

type IndexResult = { items: GalleryItem[]; access: MediaAccess; error: string | null };

export class MediaStore {
  private snap: StoreSnapshot = {
    state: "idle",
    items: [],
    days: [],
    albums: [],
    everything: [],
    allDays: [],
    trash: [],
    truncated: false,
    partial: false,
    dirsVisited: 0,
    access: null,
  };

  private listeners = new Set<Listener>();

  /** The in-flight scan, so four subscribers waking at once share one walk. */
  private inflight: Promise<void> | null = null;

  /** Content hash of the current lists — see `commit`. */
  private fp = "";
  private seeded = false;
  private lastScanAt = 0;

  /**
   * The calendar day the day-groups were last computed on.
   *
   * "Today" and "Yesterday" are relative words baked into the snapshot at
   * `split()` time. An Android process restored across midnight still holds
   * yesterday's snapshot, and the fingerprint short-circuit — same files, same
   * dates — would happily keep it forever: the app opened after midnight
   * showing yesterday under "Today" until something actually changed on disk.
   * Tracking the day the labels were minted lets both the short-circuit and
   * the wake-up age gate notice that the words, not the files, went stale.
   */
  private splitDay = "";

  /** Interval handle for the change watcher; 0 while not watching. */
  private watchTimer = 0;
  /** Last `watch_stamp` answer; "" until the baseline tick. */
  private watchLast = "";
  /** True while a tick's native call is out, so ticks never stack. */
  private watchBusy = false;

  /**
   * Whether this platform has a media index to page: `null` until the first
   * `mediaQuery` answers, then fixed for the session. Decides whether the walk
   * is the authority (desktop) or a fallback (phone).
   */
  private indexed: boolean | null = null;
  /**
   * Paths the walk found that the index did not have, as of the last full
   * reconcile. An index-only refresh keeps these; without the set it could
   * not tell "not indexed yet" from "deleted".
   */
  private walkOnly = new Set<string>();
  /** Paths removed locally (trashed, forgotten) and when, so a stale index row cannot resurrect them. */
  private tombstones = new Map<string, number>();

  /** Interval handle for the MediaStore change counter poll; 0 while idle. */
  private genTimer = 0;
  private genLast = 0;
  private genBusy = false;
  /** Interval handle for the slow full reconcile; 0 while idle. */
  private reconcileTimer = 0;
  /** An index-only refresh in flight, so bursts of notifications share one query. */
  private indexInflight: Promise<void> | null = null;
  /** A change arrived while a refresh was running: run the index again after. */
  private indexDirty = false;
  /** Debounce handle for coalescing a burst of change notices into one query. */
  private indexDebounce = 0;
  private onVisible: (() => void) | null = null;

  constructor(
    private readonly fs: Pick<TauriFs, "scanMedia" | "watchStamp" | "mediaQuery" | "mediaGeneration">,
    private readonly roots: readonly string[],
    /** Walked first, one level deep. Falls back to the roots themselves. */
    private readonly hot: readonly string[] = roots,
  ) {
    // The index write is deferred to idle time (see `persist`); an app being
    // swiped away or backgrounded may never reach idle, and the next launch
    // would seed from a stale index. Hiding is the last reliable moment.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden && this.persistTimer) this.flushPersist();
      });
    }
  }

  get(): StoreSnapshot {
    return this.snap;
  }

  /**
   * Subscribe, and receive the current snapshot immediately.
   *
   * The synchronous first call matters: a tab that mounts mid-scan needs to
   * paint its spinner from the same code path that later paints its grid, and
   * making the caller special-case "before my first event" is how tabs end up
   * with two different empty states.
   */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** Scan if we never have. Cheap and idempotent — call it from every tab. */
  ensure(): Promise<void> {
    if (this.snap.state === "ready" || this.snap.state === "empty") return Promise.resolve();
    return this.refresh();
  }

  /**
   * Refresh, but only when the index is older than `maxAgeMs`.
   *
   * Wired to the app coming back to the foreground. The age gate is what stops
   * a user flicking between apps from paying a four-second walk per flick — a
   * scan that finished fifteen seconds ago cannot have missed anything worth
   * interrupting them for.
   */
  refreshIfStale(maxAgeMs: number): void {
    // A new calendar day voids the age gate outright: the labels on screen say
    // "Today" about yesterday, and no amount of recency makes that correct.
    if (this.splitDay === todayKey() && Date.now() - this.lastScanAt < maxAgeMs) return;
    void this.refresh();
  }

  /** Walk the card again. Coalesces with any scan already running. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;

    mark("refresh");
    // The persisted index first, exactly once per session. When it is there,
    // the first paint is the whole library from last time — complete and in
    // final order, so the walk below replaces it invisibly unless something
    // actually changed.
    const cached = this.seed();
    const haveGrid = this.snap.everything.length > 0;
    if (!cached) this.emit({ ...this.snap, state: "scanning" });

    this.inflight = (async () => {
      const scanStart = performance.now();

      // The phone's own index first. It answers in a few hundred milliseconds
      // for the whole library, so whatever it knows is on screen before the
      // walk has visited its first folder -- merged into the grid, not
      // painted over it.
      const index = await this.queryIndex();
      if (index) {
        perf(`index ${index.items.length} rows in ${Math.round(performance.now() - scanStart)}ms`);
        this.applyIndex(index, null, true);
      }

      // With something already on screen and no index to lean on, a *hot*
      // pass runs alongside the full walk: the five folders new files
      // actually land in, one level deep, a few hundred milliseconds. Its
      // result is merged by path into the index on screen -- not painted over
      // it -- so today's screenshot is in the grid seconds before the full
      // walk reports, and every day the pass did not touch keeps its tiles.
      // This is the fix for "opens on yesterday and sits there". The pass is
      // bounded and its failure is silent: the full walk behind it is the
      // authority either way. With the index answering, the pass would only
      // re-date pictures by mtime for a moment, so it is skipped.
      let hotDone = false;
      const hotPass = haveGrid && !index
        ? scanGallery(this.fs, this.hot, { maxDepth: 1, limit: 400, budgetMs: 1500 })
            .then((hot) => {
              if (hotDone) return;
              perf(`hot pass ${hot.items.length} items in ${Math.round(performance.now() - scanStart)}ms`);
              this.mergeHot(hot.items);
            })
            .catch(() => {})
        : Promise.resolve();

      // The fast first pass earns its keep only when there is nothing on
      // screen at all: a fresh install, or a localStorage that did not
      // survive. With a cached index up, a 300-file provisional paint would
      // be a step backwards — literally, it was the "opens on Friday, then
      // jumps to today" bug.
      if (!haveGrid && !cached && !index) {
        mark("quick scan start");
        const quick = await scanGallery(this.fs, this.hot, {
          maxDepth: 1,
          limit: 300,
          budgetMs: 800,
        });
        mark(`quick scan done ${quick.items.length} items ${quick.dirsVisited} dirs`);
        if (quick.items.length > 0) {
          this.emit({
            ...this.snap,
            state: "ready",
            ...this.freshSplit(quick.items),
            trash: this.snap.trash,
            truncated: quick.truncated,
            partial: true,
            dirsVisited: quick.dirsVisited,
          });
        }
      }

      const full = await scanGallery(this.fs, this.roots);
      hotDone = true;
      // A hot pass still in flight must not land on top of the full result.
      await hotPass;
      mark(`full scan done ${full.items.length} items ${full.dirsVisited} dirs`);
      perf(`full scan ${full.items.length} items ${full.dirsVisited} dirs in ${Math.round(performance.now() - scanStart)}ms`);
      this.lastScanAt = Date.now();

      if (index) {
        // The walk is the fallback here: it may only add files the index has
        // not caught up with. The index it is reconciled against is the one
        // from the start of this refresh; anything that changed since has
        // bumped the counter and is picked up by the pending index refresh.
        this.applyIndex(index, full, false, full.trash, full.truncated, full.dirsVisited);
        this.persist();
        return;
      }

      const fp = fingerprint(full.items, full.trash);
      if (fp === this.fp && this.snap.state !== "idle" && this.splitDay === todayKey()) {
        // Same files, same dates: the view on screen is already exact. Emit
        // only the flags — the day arrays keep their identity, which is what
        // lets the tabs skip rebuilding a grid the user may be mid-scroll in.
        mark("full scan unchanged");
        this.emit({
          ...this.snap,
          state: this.snap.everything.length > 0 ? "ready" : "empty",
          truncated: full.truncated,
          partial: false,
          dirsVisited: full.dirsVisited,
        });
        // The merge already persisted anything the hot pass changed; the
        // fingerprint says the disk agrees, so there is nothing to write.
        return;
      }

      this.fp = fp;
      this.emit({
        ...this.snap,
        state: full.items.length > 0 ? "ready" : "empty",
        ...this.freshSplit(full.items),
        trash: full.trash,
        truncated: full.truncated,
        partial: false,
        dirsVisited: full.dirsVisited,
      });
      this.persist();
    })().finally(() => {
      this.inflight = null;
      if (this.indexDirty) {
        this.indexDirty = false;
        void this.refreshIndex();
      }
    });

    return this.inflight;
  }

  /**
   * Re-read the phone's index and fold it into what is on screen. No walk.
   *
   * This is what a change notice triggers: a few hundred milliseconds of
   * paging, then `mergeIndex`, which keeps every untouched file as the same
   * object so the days it lives in keep their identity and the grid leaves
   * their tiles alone. Files the walk found and the index still lacks are
   * carried across untouched (`walkOnly`), because their absence from the
   * index proves nothing.
   */
  refreshIndex(): Promise<void> {
    if (this.indexed === false) return Promise.resolve();
    if (this.inflight) {
      this.indexDirty = true;
      return this.inflight;
    }
    if (this.indexInflight) {
      this.indexDirty = true;
      return this.indexInflight;
    }
    this.indexInflight = (async () => {
      const t0 = performance.now();
      const index = await this.queryIndex();
      if (!index) return;
      const before = this.snap.everything;
      this.applyIndex(index, null, this.snap.partial);
      if (this.snap.everything !== before) {
        perf(`index refresh changed the roll in ${Math.round(performance.now() - t0)}ms`);
        this.persist();
      }
    })().finally(() => {
      this.indexInflight = null;
      if (this.indexDirty && !this.inflight) {
        this.indexDirty = false;
        void this.refreshIndex();
      }
    });
    return this.indexInflight;
  }

  /**
   * Page the whole MediaStore index into gallery items, or `null` where there
   * is no index to page. Rows inside a `.facet-trash` folder and rows for
   * paths this session just removed are dropped: the first belong to the
   * trash list the walk owns, the second are the index lagging behind a
   * rename it has not seen yet.
   */
  private async queryIndex(): Promise<IndexResult | null> {
    if (this.indexed === false) return null;
    const items: GalleryItem[] = [];
    let access: MediaAccess = "full";
    let error: string | null = null;
    let before = 0;
    this.pruneTombstones();
    try {
      for (let page = 0; page < INDEX_MAX_PAGES; page += 1) {
        const got = await this.fs.mediaQuery(before, INDEX_PAGE);
        if (got === null) {
          if (page === 0) {
            this.indexed = false;
            return null;
          }
          break;
        }
        access = got.access;
        if (got.error) error = got.error;
        for (const row of got.rows) {
          const it = itemFromRow(row);
          if (!it) continue;
          if (it.path.includes("/.facet-trash/")) continue;
          if (this.tombstones.has(it.path)) continue;
          items.push(it);
        }
        // The cursor must move or the provider is misbehaving; either way
        // stop rather than loop.
        if (got.next < 0 || (before > 0 && got.next >= before)) break;
        before = got.next;
      }
    } catch {
      // An older binary without the command, or a provider mid-crash. The
      // walk carries the session; the next refresh asks again.
      if (this.indexed === null) this.indexed = false;
      return null;
    }
    this.indexed = true;
    if (items.length === 0 && (access !== "full" || error !== null)) {
      // Nothing visible and a reason for it -- the permission dialog is still
      // up, or the provider choked. An empty answer must not wipe the roll;
      // only the reason is surfaced, and the next tick asks again.
      if (this.snap.access !== access) this.emit({ ...this.snap, access });
      return null;
    }
    return { items, access, error };
  }

  /**
   * Make the index the authority for what is on screen.
   *
   * `walk` is the full walk when one just finished (its extras become the new
   * `walkOnly` set and its trash the trash list); `null` for an index-only
   * refresh, which carries the previous extras across by path.
   */
  private applyIndex(
    index: IndexResult,
    walk: { items: GalleryItem[]; trash: GalleryItem[] } | null,
    partial: boolean,
    trash: readonly GalleryItem[] = this.snap.trash,
    truncated = this.snap.truncated,
    dirsVisited = this.snap.dirsVisited,
  ): void {
    const indexed = new Set<string>();
    for (const it of index.items) indexed.add(it.path);

    let extras: GalleryItem[];
    if (walk) {
      extras = walk.items.filter((it) => !indexed.has(it.path));
      this.walkOnly = new Set(extras.map((it) => it.path));
    } else {
      extras = this.snap.everything.filter((it) => !indexed.has(it.path) && this.walkOnly.has(it.path));
    }

    const merged = mergeIndex(this.snap.everything, extras.length > 0 ? [...index.items, ...extras] : index.items);
    // A fresh walk hands over a new trash array every time; same contents
    // means the one on screen stays, so nothing downstream sees a change.
    const wanted = walk ? walk.trash : trash;
    const nextTrash = sameList(wanted, this.snap.trash) ? this.snap.trash : wanted;
    const flags = {
      truncated,
      partial,
      dirsVisited,
      access: index.access,
    };
    if (merged.everything === this.snap.everything && nextTrash === this.snap.trash) {
      // Nothing moved: emit only the flags so every day array keeps its
      // identity and no grid rebuilds under a finger.
      if (
        this.snap.state === "ready" || this.snap.state === "empty"
      ) {
        if (
          this.snap.truncated === flags.truncated
          && this.snap.partial === flags.partial
          && this.snap.dirsVisited === flags.dirsVisited
          && this.snap.access === flags.access
        ) return;
      }
      this.emit({
        ...this.snap,
        state: this.snap.everything.length > 0 ? "ready" : "empty",
        ...flags,
      });
      return;
    }
    perf(`index merge +${merged.added} -${merged.removed} ~${merged.changed}`);
    this.fp = fingerprint(merged.everything, nextTrash);
    this.emit({
      ...this.snap,
      state: merged.everything.length > 0 ? "ready" : "empty",
      ...this.freshSplit(merged.everything),
      trash: nextTrash,
      ...flags,
    });
  }

  /**
   * Notice new files without a button.
   *
   * Two signals, both cheap, both while the app is visible:
   *
   *  - The phone's MediaStore change counter, once a second. A ContentObserver
   *    on the Kotlin side bumps it the moment the system indexes a file,
   *    wherever that file is — a sync client's folder, a messenger's media
   *    directory, an SD card. This is the same push Samsung Gallery gets. A
   *    change coalesces a burst of notices into one index refresh.
   *  - Directory mtimes over the roots and the folders of the newest files,
   *    every few seconds, hashed natively in one call. Catches a file written
   *    before the indexer gets to it, and is the only signal on the desktop.
   *
   * Plus a slow full reconcile (walk and index) once a minute and on every
   * return to the foreground, so nothing that slips both signals stays
   * missing for long.
   */
  startWatch(intervalMs = 4000, generationMs = 1000, reconcileMs = 60_000): void {
    this.stopWatch();
    this.watchTimer = window.setInterval(() => void this.watchTick(), intervalMs);
    this.genTimer = window.setInterval(() => void this.genTick(), generationMs);
    this.reconcileTimer = window.setInterval(() => {
      if (document.hidden || this.inflight) return;
      mark("reconcile");
      void this.refresh();
    }, reconcileMs);
    this.onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Cheap and immediate: the index knows what changed while we were away
      // long before a walk would.
      void this.refreshIndex();
    };
    document.addEventListener("visibilitychange", this.onVisible);
  }

  stopWatch(): void {
    if (this.watchTimer) window.clearInterval(this.watchTimer);
    if (this.genTimer) window.clearInterval(this.genTimer);
    if (this.reconcileTimer) window.clearInterval(this.reconcileTimer);
    if (this.indexDebounce) window.clearTimeout(this.indexDebounce);
    this.watchTimer = 0;
    this.genTimer = 0;
    this.reconcileTimer = 0;
    this.indexDebounce = 0;
    if (this.onVisible) document.removeEventListener("visibilitychange", this.onVisible);
    this.onVisible = null;
  }

  private async watchTick(): Promise<void> {
    // Backgrounded, mid-scan, or last tick still out: skip. The screenshot
    // taken while we were hidden is caught by `refreshIfStale` on wake.
    if (document.hidden || this.inflight || this.watchBusy) return;
    this.watchBusy = true;
    try {
      const stamp = await this.fs.watchStamp(this.watchDirs());
      if (this.watchLast === "") {
        this.watchLast = stamp;
      } else if (stamp !== this.watchLast) {
        this.watchLast = stamp;
        mark("watch: change detected");
        // With an index, ask it first: it is the authority and answers in
        // milliseconds. The walk still runs on the next reconcile.
        if (this.indexed) void this.refreshIndex();
        else void this.refresh();
      }
    } catch {
      // A failed stat sweep costs one tick, nothing else.
    } finally {
      this.watchBusy = false;
    }
  }

  /** One poll of the MediaStore change counter. */
  private async genTick(): Promise<void> {
    if (document.hidden || this.genBusy) return;
    if (this.indexed === false) {
      // The walk already learned there is no index here: nothing to poll.
      if (this.genTimer) window.clearInterval(this.genTimer);
      this.genTimer = 0;
      return;
    }
    this.genBusy = true;
    try {
      const pulse = await this.fs.mediaGeneration();
      if (!pulse || pulse.gen <= 0) {
        // No index on this platform: stop asking.
        if (this.indexed !== true) {
          if (this.genTimer) window.clearInterval(this.genTimer);
          this.genTimer = 0;
        }
        return;
      }
      if (this.genLast === 0) {
        this.genLast = pulse.gen;
        return;
      }
      if (pulse.gen !== this.genLast) {
        this.genLast = pulse.gen;
        mark(`media generation ${pulse.gen} (${pulse.changed} notices)`);
        this.scheduleIndexRefresh();
      }
    } catch {
      // An older binary without the command: give up on this signal.
      if (this.genTimer) window.clearInterval(this.genTimer);
      this.genTimer = 0;
    } finally {
      this.genBusy = false;
    }
  }

  /**
   * A burst of change notices (twenty-two files landing at once) becomes one
   * query: wait a beat for the burst to settle, but never more than that.
   */
  private scheduleIndexRefresh(): void {
    if (this.indexDebounce) return;
    this.indexDebounce = window.setTimeout(() => {
      this.indexDebounce = 0;
      void this.refreshIndex();
    }, 350);
  }

  /**
   * The roots, plus the folders of the newest items — where the next
   * screenshot, download or camera shot will land. Capped so the sweep stays
   * a few dozen stats: deep cold folders are covered by the reconcile.
   */
  private watchDirs(): string[] {
    const dirs = [...this.roots];
    const seen = new Set(dirs);
    for (const it of this.snap.everything.slice(0, 300)) {
      if (dirs.length >= 60) break;
      if (!seen.has(it.folder)) {
        seen.add(it.folder);
        dirs.push(it.folder);
      }
    }
    return dirs;
  }

  /**
   * Drop one file from every derived view, without re-walking.
   *
   * Deleting a photo and watching the grid sit there with the tile still in it
   * until some refresh happens is the single most common way a gallery feels
   * broken, and an eight-second rescan to remove one row is not the fix.
   */
  forget(path: string): void {
    this.tombstones.set(path, Date.now());
    const everything = this.snap.everything.filter((it) => it.path !== path);
    if (everything.length === this.snap.everything.length) return;
    this.commit(everything, this.snap.trash);
  }

  /**
   * A file was just moved into a `.facet-trash` folder: out of the roll, into
   * the trash list, no walk. `dest` is where it landed.
   */
  noteTrashed(path: string, dest: string): void {
    this.tombstones.set(path, Date.now());
    const item = this.snap.everything.find((it) => it.path === path);
    const everything = this.snap.everything.filter((it) => it.path !== path);
    const folder = dest.slice(0, dest.lastIndexOf("/"));
    const trashed: GalleryItem | null = item
      ? { ...item, path: dest, folder, folderName: ".facet-trash" }
      : null;
    this.commit(everything, trashed ? [trashed, ...this.snap.trash] : this.snap.trash);
  }

  /** Files moved back out of the trash. `restored` carries their new paths. */
  noteRestored(trashPaths: readonly string[], restored: readonly GalleryItem[]): void {
    const gone = new Set(trashPaths);
    const trash = this.snap.trash.filter((it) => !gone.has(it.path));
    for (const it of restored) {
      this.tombstones.delete(it.path);
      // Until the index catches up with the move, the restored file is a
      // walk-only extra; otherwise the next index refresh would drop it.
      this.walkOnly.add(it.path);
    }
    // Re-sorted rather than merge-inserted: the list is newest-first and a
    // restore can land anywhere in it. A one-off sort of a few thousand rows
    // is microseconds, and it is the same ordering rule the scan applies.
    const everything = [...this.snap.everything, ...restored].sort(
      (a, b) => (b.modified ?? -Infinity) - (a.modified ?? -Infinity),
    );
    this.commit(everything, trash);
  }

  /** Files deleted from the trash for good. */
  noteEmptied(trashPaths: readonly string[]): void {
    const gone = new Set(trashPaths);
    this.commit(
      this.snap.everything,
      this.snap.trash.filter((it) => !gone.has(it.path)),
    );
  }

  private pruneTombstones(): void {
    if (this.tombstones.size === 0) return;
    const cutoff = Date.now() - TOMBSTONE_MS;
    for (const [path, t] of this.tombstones) {
      if (t < cutoff) this.tombstones.delete(path);
    }
  }

  /**
   * Fold the hot pass into the index on screen. Only emits when the pass
   * actually found something new or gone, and even then only the days it
   * touched get new section objects -- see `reuseDays` via `freshSplit`.
   */
  private mergeHot(hot: readonly GalleryItem[]): void {
    const merged = mergeHot(this.snap.everything, hot);
    if (merged.everything === this.snap.everything) {
      perf("hot pass: index already current");
      return;
    }
    perf(`hot pass: +${merged.added} -${merged.removed}, emitting`);
    this.fp = fingerprint(merged.everything, this.snap.trash);
    this.emit({
      ...this.snap,
      state: "ready",
      ...this.freshSplit(merged.everything),
      partial: true,
    });
    this.persist();
  }

  /** Both lists changed by a local mutation: recompute views, persist, emit. */
  private commit(everything: readonly GalleryItem[], trash: readonly GalleryItem[]): void {
    this.fp = fingerprint(everything, trash);
    this.emit({
      ...this.snap,
      state: everything.length > 0 ? "ready" : "empty",
      ...this.freshSplit(everything),
      trash,
    });
    this.persist();
  }

  /** Paint last launch's index, if there is one. True when something painted. */
  private seed(): boolean {
    if (this.seeded) return false;
    this.seeded = true;
    // The index may already have answered (a change notice before the first
    // refresh); last launch's rows must not paint over this launch's truth.
    if (this.snap.everything.length > 0) return false;
    try {
      const t0 = performance.now();
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw) as { hits?: CacheRow[]; trash?: CacheRow[] };
      // A cache written by a build that still showed `.nomedia` rows must not
      // paint them for the half second before the index answers.
      const items = itemsFromCache(data.hits ?? []).filter((it) => !isHiddenPath(it.path));
      if (items.length === 0) return false;
      const trash = itemsFromCache(data.trash ?? []);
      this.fp = fingerprint(items, trash);
      mark(`index cache seeded ${items.length} items`);
      this.emit({
        ...this.snap,
        state: "ready",
        ...this.freshSplit(items),
        trash,
        truncated: false,
        partial: true,
        dirsVisited: 0,
      });
      perf(`seed ${items.length} items parsed+split+emitted in ${Math.round(performance.now() - t0)}ms`);
      return true;
    } catch {
      // A corrupt cache is worth nothing: fall through to the scan and let a
      // good one be written over it.
      return false;
    }
  }

  /** Handle of the pending idle write; 0 when nothing is scheduled. */
  private persistTimer = 0;
  private persistIdle = false;

  /**
   * Ask for the index to be written -- later, when the main thread is idle.
   *
   * Serialising twenty thousand rows and handing them to localStorage is a
   * synchronous 30-80 ms on the phone, and it used to run at the exact moment
   * the full scan landed, which is also the moment the grid was rebuilding
   * and the user was scrolling the thing they had just opened. One frame
   * dropped for a write nobody needs until the *next* launch. Debounced, so
   * a burst of merges and a full-scan commit cost one write, and flushed
   * when the page hides so the next launch never seeds from a stale index.
   */
  private persist(): void {
    this.cancelPersist();
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === "function") {
      this.persistIdle = true;
      this.persistTimer = w.requestIdleCallback(() => this.flushPersist(), { timeout: 4000 });
    } else {
      this.persistIdle = false;
      this.persistTimer = window.setTimeout(() => this.flushPersist(), 1500);
    }
  }

  private cancelPersist(): void {
    if (!this.persistTimer) return;
    const w = window as Window & { cancelIdleCallback?: (id: number) => void };
    if (this.persistIdle && typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(this.persistTimer);
    else window.clearTimeout(this.persistTimer);
    this.persistTimer = 0;
  }

  /** Write the index now. Public so the shell can flush it on `pagehide`. */
  flushPersist(): void {
    this.cancelPersist();
    if (this.snap.everything.length === 0) return;
    try {
      const t0 = performance.now();
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          t: Date.now(),
          hits: this.snap.everything.map(toCacheRow),
          trash: this.snap.trash.map(toCacheRow),
        }),
      );
      perf(`index persisted ${this.snap.everything.length} rows in ${Math.round(performance.now() - t0)}ms`);
    } catch {
      // Quota or private mode. The cost is the next launch scanning cold,
      // which is exactly what every launch did before the cache existed.
    }
  }

  /**
   * `split`, with the mint-date recorded and unchanged days kept by identity.
   * Every snapshot rebuild uses this, so a grid comparing a section it drew
   * against the one in the new snapshot gets "same object" exactly when the
   * day's files are the same.
   */
  private freshSplit(everything: readonly GalleryItem[]): ReturnType<typeof split> {
    const day = todayKey();
    // Labels are relative to the day they were minted; across midnight nothing
    // may be reused, or "Today" would name yesterday.
    const reusable = this.splitDay === day;
    this.splitDay = day;
    const next = split(everything);
    if (!reusable) return next;
    return {
      ...next,
      days: reuseDays(this.snap.days, next.days),
      allDays: reuseDays(this.snap.allDays, next.allDays),
    };
  }

  private emit(next: StoreSnapshot): void {
    this.snap = next;
    for (const fn of this.listeners) fn(next);
  }
}

/** Same files in the same order, by path and version. */
function sameList(a: readonly GalleryItem[], b: readonly GalleryItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x !== y && (x.path !== y.path || x.modified !== y.modified || x.size !== y.size)) return false;
  }
  return true;
}

/** The calendar day, as an identity — what "Today" was true of when written. */
function todayKey(): string {
  return new Date().toDateString();
}

/**
 * One scan result → both views of it.
 *
 * The scan returns everything; Photos, Albums and the viewer want only the
 * media, and the All tab wants the lot. Deriving both here, in one place, is
 * what keeps `refresh` and `forget` from disagreeing about what a snapshot's
 * fields mean.
 */
function split(everything: readonly GalleryItem[]): Pick<
  StoreSnapshot,
  "items" | "days" | "albums" | "everything" | "allDays"
> {
  const media = everything.filter((it) => it.kind === "image" || it.kind === "video");
  return {
    items: media,
    days: byDay(media),
    albums: byAlbum(media),
    everything,
    allDays: byDay(everything),
  };
}

/**
 * A cheap content hash over both lists — FNV-1a on path and mtime.
 *
 * This is what decides whether a finished walk repaints the screen. Size is
 * deliberately not hashed: an edit changes the mtime anyway, and mtime alone
 * keeps the loop to one multiply per character. Order matters and is included
 * for free, since the walk always hands the lists over newest-first.
 */
function fingerprint(
  items: readonly GalleryItem[],
  trash: readonly GalleryItem[],
): string {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const it of items) mix(`${it.path}|${it.modified ?? 0};`);
  mix("//");
  for (const it of trash) mix(`${it.path}|${it.modified ?? 0};`);
  return `${items.length}:${trash.length}:${h >>> 0}`;
}
