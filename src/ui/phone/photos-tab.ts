/**
 * Photos — the roll.
 *
 * Everything on the card that is a picture or a video, newest first, grouped by
 * day, four across, edge to edge. Mixed rather than split: a clip you shot
 * between two photographs belongs between those two photographs, and a build
 * that files it under a separate Videos tab makes you remember which one a
 * memory was before you can find it.
 *
 * Two things here are load-bearing:
 *
 * **Chunked append, not full render.** A camera roll is tens of thousands of
 * files, and building that many tiles up front costs seconds of frozen white.
 * Sections are appended a few hundred items at a time as a sentinel near the
 * bottom comes into view. The trade is that a very long scroll accumulates DOM;
 * tiles are three elements each and the thumbnail LRU keeps the bitmaps bounded,
 * so what accumulates is cheap. Full row virtualisation is the next step, and it
 * is not free to combine with sticky day headers, which is why it is not here
 * yet.
 *
 * **Pinch changes the column count.** Not the zoom level — the columns. Pinching
 * a photo grid is how every phone gallery changes density, and pinch is one of
 * the few multi-touch gestures Android's navigation does not claim, unlike the
 * horizontal drag.
 */

import { byDay, formatDuration, type DaySection, type GalleryItem } from "@core/phone/gallery";
import { el, fill, tileCaption } from "./dom";
import { icon } from "./icons";
import { isFav } from "./favorites";
import { mark, perf } from "@core/phone/mark";
import { ThumbLoader } from "./thumbs";
import { FlingModel } from "./fling";
import type { PhoneShell, PhoneTab, TabId } from "./shell";
import type { StoreSnapshot } from "./store";

/**
 * Tiles asked for before the grid mounts on a cold launch: about two and a
 * half screens at four columns. See `Thumbs.prefetch`.
 */
const PREFETCH = 60;

/** Column counts a pinch steps through. */
const STEPS = [2, 3, 4, 5, 7] as const;
const DEFAULT_STEP = 2; // four across

/** Items appended per chunk. About eight screens at four columns. */
const CHUNK = 320;

/**
 * What makes one roll differ from another.
 *
 * The Photos tab and the All tab are the same screen — the same chunked
 * append, the same reconcile, the same pinch — over a different slice of the
 * store. Everything that distinguishes them fits in this record, so the second
 * roll is a second instance rather than a second seven-hundred-line file that
 * drifts out of date the first time the first one is fixed.
 */
export interface RollSpec {
  id: TabId;
  label: string;
  icon: string;
  /** The header title, and the noun in the empty state. */
  name: string;
  pick: (snap: StoreSnapshot) => readonly DaySection[];
  emptyTitle: string;
  emptyBody: string;
  scanningBody: string;
  /**
   * Filter chips over the roll, when the roll is mixed enough to need them.
   * `source` is the flat list the chips filter — required alongside `chips`,
   * because a chip's day sections are regrouped from it rather than filtered
   * per-day, which would leave empty headers standing.
   */
  chips?: readonly ChipSpec[];
  source?: (snap: StoreSnapshot) => readonly GalleryItem[];
}

/** One chip. `pred` absent means "no filter" — the All chip. */
export interface ChipSpec {
  id: string;
  label: string;
  pred?: (item: GalleryItem) => boolean;
}

const PHOTOS_SPEC: RollSpec = {
  id: "photos",
  label: "Photos",
  icon: "image",
  name: "Photos",
  pick: (snap) => snap.days,
  emptyTitle: "No photos found",
  emptyBody:
    "Facet looked in DCIM, Pictures, Movies, Downloads and your messaging apps' media folders. If your photos live elsewhere, browse to them under Files.",
  scanningBody: "Reading DCIM, Pictures, Movies, Downloads and app media folders.",
};

/**
 * The whole card, one stream. Photos and clips exactly as the Photos tab has
 * them, with the downloads, documents, audio, installs and archives from the
 * same folders slotted in between at their own dates — because "the PDF from
 * Tuesday" and "the picture from Tuesday" are the same question, and answering
 * one chronologically and the other through a category browser makes the user
 * remember which kind of file a memory was before they can find it.
 */
export const EVERYTHING_SPEC: RollSpec = {
  id: "all",
  label: "All",
  icon: "grid",
  name: "Everything",
  pick: (snap) => snap.allDays,
  emptyTitle: "Nothing found",
  emptyBody:
    "Facet looked in DCIM, Pictures, Movies, Downloads, Documents and your messaging apps' media folders. If your files live elsewhere, browse to them under Files.",
  scanningBody: "Reading DCIM, Pictures, Movies, Downloads, Documents and app media folders.",
  source: (snap) => snap.everything,
  // Kind groupings, not raw kinds: "tabular" and "document" are one idea to a
  // person looking for "that file someone sent me", and installers have no
  // kind of their own (an .apk is "binary" to the explorer) so they go by
  // extension. Media stays a chip too — this tab exists precisely because
  // media and files interleave, but some days that is the noise.
  chips: [
    { id: "all", label: "All" },
    { id: "media", label: "Media", pred: (it) => it.kind === "image" || it.kind === "video" },
    { id: "docs", label: "Docs", pred: (it) => it.kind === "document" || it.kind === "tabular" },
    { id: "audio", label: "Audio", pred: (it) => it.kind === "audio" },
    {
      id: "installs",
      label: "Installs",
      pred: (it) => it.ext === "apk" || it.ext === "exe" || it.ext === "msi",
    },
    { id: "archives", label: "Archives", pred: (it) => it.kind === "archive" },
  ],
};

export class PhotosTab implements PhoneTab {
  readonly id: TabId;
  readonly label: string;
  readonly icon: string;
  readonly el: HTMLElement;

  private stream: HTMLElement;
  private sentinel: HTMLElement;
  private loader: ThumbLoader;
  private more: IntersectionObserver;

  private days: readonly DaySection[] = [];
  /** How many items of `days` are on screen. */
  private drawn = 0;
  private step = DEFAULT_STEP;

  /** `spec.pick`'s last result, by reference — the render guard's memory. */
  private baseDays: readonly DaySection[] | null = null;
  private lastSnap: StoreSnapshot | null = null;
  /** Active chip id, when the spec has chips. */
  private chip = "all";
  private chipBar: HTMLElement | null = null;

  private selection = new Set<string>();
  private selecting = false;

  private unsubscribe: (() => void) | null = null;
  private onScroll: (() => void) | null = null;
  private scrollQueued = false;
  /** The items each drawn `.ph-grid` holds, so an emptied one can be rebuilt. */
  private gridItems = new WeakMap<HTMLElement, readonly GalleryItem[]>();
  /**
   * The header and grids drawn for each day section, by the section object
   * itself. The store keeps a section's identity when its files did not
   * change, so a new snapshot can be walked against this map and every
   * untouched day keeps the nodes -- and the decoded tiles -- it already has.
   */
  private dayNodes = new Map<DaySection, HTMLElement[]>();
  /**
   * The `section.ph-daysec` wrapping each drawn day. A sticky header sticks
   * within its containing block, and with header and grids as bare siblings
   * of the stream that block was the whole roll: every header ever scrolled
   * past stayed stuck at the top, and the next day's header slid *over* the
   * stuck one instead of pushing it out -- two dates half-covering each other
   * whenever a scroll came to rest inside that hand-over. With one wrapper
   * per day the header lets go at its own day's last row.
   */
  private daySecs = new Map<DaySection, HTMLElement>();
  /** Sections whose every item has been drawn; only those can be reused whole. */
  private dayDone = new Set<DaySection>();
  /** The item list the thumbnail warm pass was last pointed at. */
  private warmedFor: readonly GalleryItem[] | null = null;
  private prefetched = false;
  /** A rebuild deferred to idle time because the tab was not showing. */
  private idleRebuild = 0;
  private idleIsIdleCb = false;
  /** Every drawn `.ph-grid`, in document order. */
  private grids: HTMLElement[] = [];
  private gridIndex = new WeakMap<HTMLElement, number>();
  /** Indices of the sections that currently hold their cells. */
  private mounted = new Set<number>();
  /** Last section known to be under the viewport, to start the fallback walk. */
  private lastVp = 0;
  private settle = 0;
  private evicted = 0;
  private refilled = 0;
  /** Where the current fling will stop, and how many tiles were asked for early. */
  private fling = new FlingModel(window.devicePixelRatio || 1);
  private aimed = 0;
  private statAt = 0;
  private scrolls = 0;
  private heartbeat = 0;
  /** What the last reconcile found under the viewport, for the stats line. */
  private vpNote = "-";

  constructor(
    private readonly shell: PhoneShell,
    private readonly spec: RollSpec = PHOTOS_SPEC,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.icon = spec.icon;
    this.stream = el("div.ph-stream");
    this.sentinel = el("div.ph-sentinel", { "aria-hidden": true });
    this.el = el("div.ph-screen", {}, this.stream, this.sentinel);

    // The chip bar sits outside `stream` on purpose: every render empties the
    // stream wholesale, and the chips must survive that or they would lose
    // focus and flicker on each rescan.
    if (spec.chips && spec.chips.length > 0) {
      this.chipBar = el("div.ph-chips", { role: "tablist" });
      for (const c of spec.chips) {
        const b = el<"button">("button.ph-chip", {
          type: "button",
          text: c.label,
          "data-chip": c.id,
          "aria-pressed": c.id === this.chip ? "true" : "false",
        });
        b.addEventListener("click", () => this.setChip(c.id));
        this.chipBar.append(b);
      }
      this.el.prepend(this.chipBar);
    }

    this.loader = new ThumbLoader(shell.thumbs, shell.scroller);
    this.more = new IntersectionObserver(
      (records) => {
        if (!records.some((r) => r.isIntersecting)) return;
        // Keep drawing while the sentinel is still in range, rather than one
        // chunk per callback. A fling covers several thousand pixels between
        // two observer notifications, so a single 320-item chunk left the
        // scroller in territory with no tiles mounted at all -- a day header
        // with nothing under it, which reads as a broken gallery rather than a
        // slow one. Bounded so a short list cannot spin.
        this.fill();
      },
      { root: shell.scroller, rootMargin: "1200px 0px" },
    );
    this.more.observe(this.sentinel);

    // The observer alone is not enough, and this is the bug behind "a whole
    // screen of nothing after a hard fling". An IntersectionObserver only
    // reports a *change*: outrun the sentinel and it stops being intersecting,
    // and once the scroll is past it nothing ever brings it back into view --
    // so `drawMore` is never called again and the pagination is dead for the
    // rest of the session. Every further swipe travels through content that
    // will now never be mounted. Reproduced on the build before this one, so
    // it is not new; it just took a long enough scroll to reach.
    //
    // A scroll listener has no such state. It is passive and coalesced to one
    // frame, so the cost is a rect read per frame while the finger is moving.
    this.onScroll = () => {
      // The last `scroll` event is not the settled position. Momentum keeps the
      // scroller moving after the final event has been coalesced away, and the
      // frame we reconcile on is therefore several thousand pixels short of
      // where the finger left it. One more pass once it is quiet costs nothing
      // and is what guarantees the resting viewport is the one that is mounted.
      window.clearTimeout(this.settle);
      this.settle = window.setTimeout(() => this.settled(), 120);
      if (this.scrollQueued) return;
      this.scrollQueued = true;
      requestAnimationFrame(() => {
        this.scrollQueued = false;
        this.scrolls += 1;
        try {
          const root = this.shell.scroller;
          if (root) this.fling.sample(performance.now(), root.scrollTop);
          this.fill();
        } catch (err) {
          // Loud on purpose. A throw in here used to be silent, and a silent
          // throw in the one function that mounts tiles looks exactly like a
          // slow decode from the outside.
          mark(`fill threw ${String(err)}`);
        }
      });
    };
    shell.scroller?.addEventListener("scroll", this.onScroll, { passive: true });
    // Chrome 114+ says when the momentum is actually over; that is up to a
    // frame after the last coalesced event, against the 120 ms guess above.
    shell.scroller?.addEventListener("scrollend", () => {
      window.clearTimeout(this.settle);
      this.settled();
    }, { passive: true });

    this.restoreStep();
    this.wirePinch();
  }

  title(): string {
    if (this.selecting) return `${this.selection.size} selected`;
    return this.spec.name;
  }

  actions(): HTMLElement[] {
    if (this.selecting) {
      return [
        iconBtn("✕", "Cancel selection", () => this.endSelect()),
        iconBtn("🌫", "Blur selected", () => this.blurSelected()),
        iconBtn("↗", "Share selected", () => this.shareSelected()),
        iconBtn("🗑", "Delete selected", () => void this.deleteSelected()),
      ];
    }
    // No rescan button: the store watches directory mtimes and refreshes on
    // its own — see `MediaStore.startWatch`. A button for it would be a lie
    // about how the gallery works.
    return [
      iconBtn("🗑", "Trash", () => this.shell.openTrash()),
      iconBtn("☰", "Select photos", () => this.beginSelect()),
    ];
  }

  back(): boolean {
    if (this.selecting) {
      this.endSelect();
      return true;
    }
    return false;
  }

  activate(): void {
    const t0 = performance.now();
    // A heartbeat, so that a silent stats line means something definite. Without
    // it, "no line for forty seconds" could equally be a dead reconcile or a
    // scroller that simply stopped moving, and those want opposite fixes. It
    // stays quiet while the tab is hidden -- see `stats`.
    if (!this.heartbeat) this.heartbeat = window.setInterval(() => this.stats(), 2000);

    // Subscribed once, for the life of the tab. Re-subscribing on every
    // activation re-ran `render` synchronously on the switch -- and if the
    // store had moved on while another tab was showing, that was a full grid
    // rebuild between the tap and the first paint. Now a hidden tab takes
    // snapshots as they come and rebuilds in idle time, so what a switch
    // finds is a grid that is already current.
    if (!this.unsubscribe) {
      this.unsubscribe = this.shell.store.subscribe((snap) => this.render(snap));
    } else if (this.idleRebuild) {
      // A rebuild is owed and idle time never came. After the first paint,
      // not before it: the stale grid for one frame beats a blank one.
      this.cancelIdle();
      requestAnimationFrame(() => {
        if (this.lastSnap) this.rebuild(this.lastSnap);
      });
    }
    void this.shell.store.ensure();

    // The scroller's position is restored by the shell right after this, and
    // the mounted band has to follow it. A scroll event usually fires and does
    // that; when the position is unchanged none does, so ask once.
    requestAnimationFrame(() => {
      this.fill();
      perf(`${this.id} tab activate -> first frame ${Math.round(performance.now() - t0)}ms`);
    });
  }

  /** Is the tab off screen -- detached, or parked with `hidden` by the shell? */
  private get hidden(): boolean {
    return this.el.hidden || !this.el.isConnected;
  }

  private cancelIdle(): void {
    if (!this.idleRebuild) return;
    const w = window as Window & { cancelIdleCallback?: (id: number) => void };
    if (this.idleIsIdleCb && typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(this.idleRebuild);
    else window.clearTimeout(this.idleRebuild);
    this.idleRebuild = 0;
  }

  /** Rebuild when the main thread has nothing better to do. */
  private rebuildWhenIdle(): void {
    this.cancelIdle();
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    const run = (): void => {
      this.idleRebuild = 0;
      if (this.lastSnap) this.rebuild(this.lastSnap);
    };
    if (typeof w.requestIdleCallback === "function") {
      this.idleIsIdleCb = true;
      this.idleRebuild = w.requestIdleCallback(run, { timeout: 2000 });
    } else {
      this.idleIsIdleCb = false;
      this.idleRebuild = window.setTimeout(run, 250);
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private render(snap: StoreSnapshot): void {
    this.lastSnap = snap;
    // The full walk is in. Everything the user might scroll to is known, so the
    // clips can start filling the disk cache now rather than at the moment
    // someone scrolls onto them -- see `Thumbs.warm`. Once per list, and off
    // the render path: both Photos and All receive every snapshot, and each
    // used to re-filter the whole roll on every activation.
    if (!snap.partial && snap.items.length > 0 && this.warmedFor !== snap.items) {
      this.warmedFor = snap.items;
      const items = snap.items;
      window.setTimeout(() => this.shell.thumbs.warm(items), 500);
    }
    // The first screens, asked for the moment the store has anything to show
    // -- the seed snapshot included, which on a cold launch arrives about half
    // a second before the tiles exist. A batch round trip happens while the
    // grid is still laying out, and the tiles mount onto pictures already in
    // hand. Once per tab; the loader takes over from here.
    if (!this.prefetched && snap.items.length > 0) {
      this.prefetched = true;
      this.shell.thumbs.prefetch(snap.items.slice(0, PREFETCH));
    }

    if (snap.state === "scanning" && snap.items.length === 0) {
      fill(
        this.stream,
        el("div.ph-scanbar", { "aria-label": "Scanning storage" }),
        this.scanningNote(),
      );
      this.days = [];
      this.drawn = 0;
      this.forgetGrids();
      return;
    }

    if (snap.state === "empty") {
      fill(this.stream, this.emptyNote());
      this.days = [];
      this.drawn = 0;
      this.baseDays = null;
      this.forgetGrids();
      return;
    }

    // Same sections by *reference* means the store found nothing new — it
    // keeps the day arrays' identity across a no-change rescan precisely so
    // this line can hold. Skipping the rebuild is what keeps a background
    // refresh (app resumed, pull-to-rescan) from yanking a grid the user is
    // mid-scroll in back to the top for no visible difference.
    if (this.spec.pick(snap) === this.baseDays && this.stream.childElementCount > 0) return;

    this.baseDays = this.spec.pick(snap);
    // Not showing: the work can wait for a quiet moment, and must, or the tab
    // the user *is* looking at pays for a grid nobody can see.
    if (this.hidden) {
      this.rebuildWhenIdle();
      return;
    }
    this.cancelIdle();
    this.rebuild(snap);
  }

  /**
   * Rebuild the stream from `baseDays` through the active chip -- reusing
   * every day whose section object is one already drawn.
   *
   * This is what makes a snapshot landing on a live grid cheap. The hot pass
   * and the full walk both hand over lists in which only the days that changed
   * are new objects, so the common cold-open case -- one new screenshot under
   * Today -- rebuilds Today and moves everything else into place untouched:
   * same nodes, same decoded tiles, no observer churn. A prior version emptied
   * the stream and redrew three hundred and twenty tiles for that.
   */
  private rebuild(snap: StoreSnapshot): void {
    const t0 = performance.now();
    const root = this.shell.scroller;
    const wasDrawn = this.drawn;
    const oldNodes = this.dayNodes;
    const oldSecs = this.daySecs;
    const oldDone = this.dayDone;
    const oldGrids = this.grids;

    this.days = this.applyChip(snap);
    this.drawn = 0;
    this.forgetGrids();
    this.dayNodes = new Map();
    this.daySecs = new Map();
    this.dayDone = new Set();
    this.truncNote = null;

    // Scroll anchoring: whichever reused section is first under the viewport
    // keeps its screen position, so a day inserted above it does not shove the
    // grid the user is reading. At the very top no anchor is wanted -- a new
    // day above Today is exactly what should appear there.
    const anchor = root && root.scrollTop > 0 ? this.anchorIn(root, oldNodes, oldDone) : null;

    // Reuse as far as the old drawing reached (at least one chunk), in order.
    const target = Math.max(CHUNK, wasDrawn);
    const nodes: HTMLElement[] = [];
    // The grids that live on: compared against `oldGrids` below, so it must
    // hold *grids*, not sections. It once held the section nodes, which
    // matched no grid, so every reused day had its tiles "forgotten" by the
    // loader while the cells stayed on screen: unobserved and unretained, the
    // blob under each `<img>` was revoked as the cache turned over and the
    // tile went blank with nothing left to ask for it again. Whole days
    // stopped "loading" on every launch -- the unchanged ones near the top,
    // since a changed day is redrawn with fresh cells and never noticed.
    const keptGrids = new Set<HTMLElement>();
    let reused = 0;
    for (const day of this.days) {
      if (this.drawn >= target) break;
      const have = oldNodes.get(day);
      const sec = oldSecs.get(day);
      if (have && sec && oldDone.has(day)) {
        for (const n of have) {
          if (n.classList.contains("ph-grid")) {
            this.registerGrid(n, n.childElementCount > 0);
            keptGrids.add(n);
          }
        }
        this.dayNodes.set(day, have);
        this.daySecs.set(day, sec);
        this.dayDone.add(day);
        nodes.push(sec);
        this.drawn += day.items.length;
        reused += 1;
        continue;
      }
      // A changed day among unchanged ones -- one picture landed under Today
      // while the user is reading March -- is drawn whole, in place, so every
      // day below it keeps its nodes and the anchor below holds. Stopping here
      // instead used to redraw the entire roll for that one picture, which is
      // exactly the grid-rebuilt-under-a-finger a live library must not do.
      if (day.items.length <= CHUNK) {
        nodes.push(this.drawDay(day));
        continue;
      }
      // A giant changed day: `drawMore` below takes over at `this.drawn` and
      // draws in chunks, so it is never built in one go.
      break;
    }

    // Anything drawn before that is not carried over releases its tiles. The
    // old code let `replaceChildren` drop them while the loader kept observing
    // and the cache kept a retain count for each -- a leak per rebuild.
    for (const grid of oldGrids) {
      if (!keptGrids.has(grid)) this.dropGrid(grid);
    }

    this.stream.replaceChildren(...nodes);
    if (this.drawn < target) this.drawMore();

    if (anchor && root) {
      const now = anchor.node.getBoundingClientRect().top;
      const delta = now - anchor.top;
      if (Math.abs(delta) > 0.5) root.scrollTop += delta;
    }
    perf(`${this.id} rebuild ${this.days.length} days, reused ${reused}, drawn ${this.drawn} in ${Math.round(performance.now() - t0)}ms`);

    // Not while the fast first pass is on screen: "Showing the newest 900" is a
    // statement about the card, and two seconds later it would have been a lie.
    if (snap.truncated && !snap.partial && this.chip === "all") {
      // Say so. A gallery that silently stopped at twenty thousand files, in an
      // app whose job is finding a specific picture, is one you will conclude
      // has lost things.
      this.truncNote = el("p.ph-note-body.ph-truncated", {
        text: `Showing the newest ${snap.items.length.toLocaleString()}. Use Search to reach older files.`,
      });
      this.stream.append(this.truncNote);
    } else {
      this.truncNote = null;
    }
  }

  private applyChip(snap: StoreSnapshot): readonly DaySection[] {
    const spec = this.spec.chips?.find((c) => c.id === this.chip);
    const pred = spec?.pred;
    if (!pred || !this.spec.source) return this.baseDays ?? [];
    return byDay(this.spec.source(snap).filter(pred));
  }

  private setChip(id: string): void {
    if (id === this.chip) return;
    this.chip = id;
    for (const b of this.chipBar?.children ?? []) {
      b.setAttribute("aria-pressed", b.getAttribute("data-chip") === id ? "true" : "false");
    }
    this.shell.scroller?.scrollTo({ top: 0 });
    if (this.lastSnap) this.rebuild(this.lastSnap);
  }

  /** Append the next chunk of day sections. */
  /** The "showing the newest N" line, kept so later chunks can go above it. */
  private truncNote: HTMLElement | null = null;

  /** Is the end of the drawn list still within a fling of the viewport? */
  private sentinelNear(): boolean {
    const root = this.shell.scroller;
    if (!root) return false;
    return this.sentinel.getBoundingClientRect().top - root.getBoundingClientRect().bottom < 1200;
  }

  /**
   * Draw chunks until the end of the list is out of reach again.
   *
   * Bounded: a fling covers several thousand pixels between two frames, and one
   * 320-item chunk does not cover that -- but an unbounded loop would mount the
   * whole gallery the moment somebody flicked hard, which is its own stall.
   */
  private fill(): void {
    // The scroller is shared with the tabs parked behind this one, and their
    // scroll events reach here too. A hidden sentinel has an empty rect that
    // reads as "near", and a hit-test would land on another tab's grids; both
    // must be ignored until this tab is showing again.
    if (this.hidden) return;
    for (let i = 0; i < 3 && this.sentinelNear(); i += 1) {
      const before = this.drawn;
      this.drawMore();
      if (this.drawn === before) break;
    }
    this.reconcile();

    // Keep going on a timer if the end of the list is still within reach.
    //
    // Drawing is driven by scrolling, and at the bottom of the drawn content
    // there is no more scrolling to drive it: the fling hits the end, the
    // scroller pins, `scroll` stops firing, and the sentinel is already
    // intersecting so the observer -- which reports changes -- has nothing new
    // to say. The gallery stops growing with thousands of files still to come.
    // Measured as a forty-five second gap in the stats line during a fling that
    // was still running. Three chunks a pass and a rearm is enough to walk out
    // of it without mounting the whole roll in one frame.
    if (this.sentinelNear() && this.drawn < this.totalItems()) {
      window.clearTimeout(this.settle);
      this.settle = window.setTimeout(() => this.fill(), 120);
    }
  }

  /** The scroller came to rest: close the fling's books and mount where it is. */
  private settled(): void {
    const root = this.shell.scroller;
    if (root) this.fling.settle(performance.now(), root.scrollTop);
    // The fling is over: whatever was pinned for its landing has either been
    // asked for or is now just a band near the viewport like any other.
    this.shell.thumbs.unpin();
    this.fill();
  }

  private forgetGrids(): void {
    this.grids = [];
    this.gridIndex = new WeakMap<HTMLElement, number>();
    this.mounted.clear();
    this.lastVp = 0;
  }

  /** Put a grid on the register, mounted or evicted as it currently stands. */
  private registerGrid(grid: HTMLElement, mounted: boolean): void {
    const i = this.grids.length;
    this.gridIndex.set(grid, i);
    if (mounted) this.mounted.add(i);
    this.grids.push(grid);
  }

  /** A grid is leaving for good: stop observing its tiles, release their thumbs. */
  private dropGrid(grid: HTMLElement): void {
    for (const cell of Array.from(grid.children)) this.loader.forget(cell as HTMLElement);
  }

  /**
   * The first reused section under the viewport, and where its top is now.
   * Read before the DOM changes; compared after.
   */
  private anchorIn(
    root: HTMLElement,
    nodes: ReadonlyMap<DaySection, HTMLElement[]>,
    done: ReadonlySet<DaySection>,
  ): { node: HTMLElement; top: number } | null {
    const rootTop = root.getBoundingClientRect().top;
    // Only sections the new snapshot still holds by identity, drawn whole, can
    // anchor -- those are the ones the rebuild will carry over unchanged.
    const live = new Set<DaySection>(this.days);
    for (const [day, list] of nodes) {
      if (!live.has(day) || !done.has(day)) continue;
      const head = list[0];
      if (!head || !head.isConnected) continue;
      const r = head.getBoundingClientRect();
      const last = list[list.length - 1];
      const bottom = last ? last.getBoundingClientRect().bottom : r.bottom;
      if (bottom > rootTop) return { node: head, top: r.top };
    }
    return null;
  }

  /**
   * Mount what the viewport is sitting on; unmount what is far from it.
   *
   * Driven entirely from geometry, on every scroll frame and once more when the
   * scroll settles. The two attempts before this one were driven from an
   * IntersectionObserver and both failed the same way: an observer reports a
   * *change*, and a fling of a hundred thousand pixels moves a section in and
   * out of the margin between two computed frames. The record that arrives says
   * "left the viewport" about a section the finger has since come to rest on,
   * the eviction lands after the refill, and the screen is left holding a
   * section that contains nothing but its own height. Measured with live=156
   * cells in the document and not one of them on screen, then again at 420.
   *
   * Position has no such state. Whatever the scroll did in between, one pass
   * over the register puts the band around the viewport back to correct.
   *
   * That band is measured in screens rather than in sections, because a section
   * is a day: it can be five pictures or six hundred, so a fixed neighbour
   * count is either half a screen of cover or ten thousand cells of work.
   */
  private reconcile(): void {
    const root = this.shell.scroller;
    if (!root || this.grids.length === 0) return;
    const box = root.getBoundingClientRect();

    // Hit-tests down the viewport find the sections under it in constant time.
    // Walking the register instead would be hundreds of rect reads a frame, and
    // the register is the one thing here that grows without bound.
    let lo = Infinity;
    let hi = -Infinity;
    const x = box.left + box.width / 2;
    for (const frac of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      const y = box.top + box.height * frac;
      for (const hit of document.elementsFromPoint(x, y)) {
        const grid = (hit as HTMLElement).closest(".ph-grid");
        if (!(grid instanceof HTMLElement)) continue;
        const i = this.gridIndex.get(grid);
        if (i === undefined) continue;
        if (i < lo) lo = i;
        if (i > hi) hi = i;
        break;
      }
    }

    if (hi < lo) {
      // Every sample landed on a day header, or on nothing at all. Rare, but
      // rare here means the gallery stays blank until the next touch, so there
      // is a fallback: a bounded walk out from wherever the viewport last was.
      const i = this.walkTo(box);
      if (i < 0) {
        this.vpNote = "miss";
        this.stats();
        return;
      }
      lo = i;
      hi = i;
      this.vpNote = `walk${i}`;
    } else {
      this.vpNote = `${lo}-${hi}`;
    }
    this.lastVp = lo;

    // ── Measure, then mutate. Never both at once. ────────────────────────────
    //
    // The version before this one interleaved them -- refill a section, read
    // the next one's height, refill it, read again -- and every one of those
    // reads is a forced layout of the whole scroller. At three hundred sections
    // and a hundred thousand pixels of document that is milliseconds apiece, so
    // the cost of a pass grew with the gallery until the main thread simply
    // stopped answering: scroll callbacks dead, heartbeat dead, the app frozen
    // about twelve seconds into a fling. It looked exactly like slow decoding
    // from the outside, which is why it survived three builds.
    //
    // One read pass, bounded to a window around the viewport, then one write
    // pass. A reconcile is now a single forced layout whatever the roll size.
    const span = 24;
    const from = Math.max(0, lo - span);
    const to = Math.min(this.grids.length - 1, hi + span);

    const heights: number[] = [];
    for (let i = from; i <= to; i += 1) heights[i - from] = this.grids[i]?.offsetHeight ?? 0;

    const rects = new Map<number, DOMRect>();
    for (const i of this.mounted) {
      const grid = this.grids[i];
      if (grid) rects.set(i, grid.getBoundingClientRect());
    }

    // ── Decide, on numbers alone. ───────────────────────────────────────────
    const want = new Set<number>();
    for (let i = lo; i <= hi; i += 1) want.add(i);

    const reach = box.height * 2;
    let up = 0;
    for (let i = lo - 1; i >= from && up < reach; i -= 1) {
      want.add(i);
      up += heights[i - from] ?? 0;
    }
    let down = 0;
    for (let i = hi + 1; i <= to && down < reach; i += 1) {
      want.add(i);
      down += heights[i - from] ?? 0;
    }

    // Still in the read half: ask for the tiles at the fling's landing spot.
    this.aim(box, lo, hi);

    // ── Mutate. Evict first, so the peak is the band and not the band plus
    // whatever the fling left behind. ───────────────────────────────────────
    //
    // Three screens either side, down from four: the decoded tiles behind a
    // long scroll are what the GPU memory line is made of, and two screens of
    // scroll-back are still inside the mounted band, so nothing visible
    // reloads.
    const slack = box.height * 3;
    for (const i of Array.from(this.mounted)) {
      if (want.has(i)) continue;
      const r = rects.get(i);
      if (!r) {
        this.mounted.delete(i);
        continue;
      }
      if (r.bottom < box.top - slack || r.top > box.bottom + slack) this.evictAt(i, r.height);
    }
    for (const i of want) this.refillAt(i);

    this.stats();
  }

  /**
   * The section under the middle of `box`, searched outward from the last one
   * we knew about. Bounded, and it gives up rather than looping: a day header
   * sits between two sections, so the point can fall in a gap that no section
   * covers, and the search would otherwise oscillate across it forever.
   */
  /**
   * Ask for the tiles the fling is about to land on, before it lands.
   *
   * Runs on every scroll frame inside the read half of `reconcile`, so the
   * rect reads here cost no extra layout. The predicted resting viewport, a
   * half screen either side, is walked out from the sections under the live
   * viewport; the rows of each section that fall inside it are asked for
   * pinned -- first in the batch order and immune to the cancels the observer
   * issues for everything the fling streams past. Refreshed each frame, and
   * idempotent: what is cached or in flight is left alone.
   */
  private aim(box: DOMRect, lo: number, hi: number): void {
    const root = this.shell.scroller;
    if (!root) return;
    const dest = this.fling.predict();
    if (dest === null) return;
    const delta = dest - root.scrollTop;
    const h = box.height;
    // Under a screen away, the observer's own margin already has it.
    if (Math.abs(delta) < h) return;

    const down = delta > 0;
    const top = box.top - h / 2;
    const bottom = box.bottom + h / 2;
    const cols = Math.max(1, getComputedStyle(this.grids[lo] ?? this.stream).gridTemplateColumns.split(" ").length);
    const picked: GalleryItem[] = [];
    const LIMIT = 72;
    const MAX_WALK = 160;
    let i = down ? hi : lo;
    for (let n = 0; n < MAX_WALK && picked.length < LIMIT; n += 1, i += down ? 1 : -1) {
      const grid = this.grids[i];
      if (!grid) break;
      const r = grid.getBoundingClientRect();
      // Where this section will sit once the scroller has moved by `delta`.
      const gt = r.top - delta;
      const gb = r.bottom - delta;
      if (down ? gt > bottom : gb < top) break;
      if (gb < top || gt > bottom) continue;
      const items = this.gridItems.get(grid);
      if (!items || items.length === 0) continue;
      const rowH = Math.max(1, r.width / cols);
      const r0 = Math.max(0, Math.floor((top - gt) / rowH));
      const r1 = Math.ceil((bottom - gt) / rowH);
      for (const item of items.slice(r0 * cols, r1 * cols)) {
        if (picked.length >= LIMIT) break;
        picked.push(item);
      }
    }
    if (picked.length === 0) return;
    this.aimed += picked.length;
    this.shell.thumbs.prefetch(picked, true);
  }

  private walkTo(box: DOMRect): number {
    const mid = box.top + box.height / 2;
    let i = Math.max(0, Math.min(this.lastVp, this.grids.length - 1));
    let prev = -1;
    for (let step = 0; step < 500; step += 1) {
      const grid = this.grids[i];
      if (!grid) return -1;
      const r = grid.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return i;
      const next = r.bottom < mid ? i + 1 : i - 1;
      if (next < 0 || next >= this.grids.length || next === prev) return i;
      prev = i;
      i = next;
    }
    return i;
  }

  /**
   * One whole day, header and grid, drawn now. Used by `rebuild` for a day
   * that changed in the middle of days that did not; the chunked `drawMore`
   * path handles everything past the last reusable day.
   */
  private drawDay(day: DaySection): HTMLElement {
    const head = el("h2.ph-day", {},
      el("span", { text: day.label }),
      el("span.ph-day-count", { text: String(day.items.length) }),
    );
    const sec = el("section.ph-daysec", {}, head);
    const grid = el("div.ph-grid");
    grid.style.contain = "layout paint style";
    for (const item of day.items) grid.append(this.cell(item));
    this.gridItems.set(grid, day.items);
    this.registerGrid(grid, true);
    sec.append(grid);
    this.dayNodes.set(day, [head, grid]);
    this.daySecs.set(day, sec);
    this.dayDone.add(day);
    this.drawn += day.items.length;
    return sec;
  }

  private drawMore(): void {
    if (this.drawn >= this.totalItems()) return;

    const frag = document.createDocumentFragment();
    let added = 0;
    let seen = 0;

    for (const day of this.days) {
      // Skip whole sections already on screen without touching their items.
      if (seen + day.items.length <= this.drawn) {
        seen += day.items.length;
        continue;
      }

      const from = Math.max(0, this.drawn - seen);
      const take = day.items.slice(from, from + (CHUNK - added));

      // A section is only re-headed if this chunk starts it. Splitting a day
      // across two chunks must not print the date twice.
      const owned = this.dayNodes.get(day) ?? [];
      let sec = this.daySecs.get(day);
      if (from === 0 || !sec) {
        const head = el("h2.ph-day", {},
          el("span", { text: day.label }),
          el("span.ph-day-count", { text: String(day.items.length) }),
        );
        owned.push(head);
        sec = el("section.ph-daysec", {}, head);
        this.daySecs.set(day, sec);
        frag.append(sec);
      }

      const grid = el("div.ph-grid");
      // Each grid is its own layout and paint island: a tile decoding in one
      // day cannot invalidate the layout of the three hundred around it.
      grid.style.contain = "layout paint style";
      for (const item of take) grid.append(this.cell(item));
      this.gridItems.set(grid, take);
      this.registerGrid(grid, true);
      owned.push(grid);
      this.dayNodes.set(day, owned);
      if (from + take.length >= day.items.length) this.dayDone.add(day);
      // Into the day's own section -- which is either in `frag` (started this
      // chunk) or already in the stream (a day split across two chunks).
      sec.append(grid);

      added += take.length;
      seen += day.items.length;
      if (added >= CHUNK) break;
    }

    this.drawn += added;
    this.stats();
    // Before the note, not after it. `render` appends the note once, straight
    // after the FIRST chunk; every chunk the infinite scroll adds later used to
    // go on the end, which left "Showing the newest 9,883" stranded in the
    // middle of the grid with hundreds of photos below it -- reading as if the
    // gallery had ended there and then started again.
    if (this.truncNote?.isConnected) this.stream.insertBefore(frag, this.truncNote);
    else this.stream.append(frag);
  }

  /** Periodic shape-of-the-DOM line, to tell a decode problem from a paint one. */
  private stats(): void {
    // Two rolls (Photos and All) each own a heartbeat; the hidden one has
    // nothing to say and two `querySelectorAll`s a second is not free.
    if (this.hidden) return;
    const now = performance.now();
    if (now - this.statAt < 2000) return;
    this.statAt = now;
    const live = this.stream.querySelectorAll(".ph-cell").length;
    const grids = this.stream.querySelectorAll(".ph-grid").length;
    // `vp` and `mnt` are the point of this line: they say whether a blank screen
    // is a mounting failure -- nothing under the viewport -- or a painting one,
    // where the cells are there and the compositor dropped them.
    mark(
      `grid drawn=${this.drawn} live=${live} grids=${grids}` +
        ` vp=${this.vpNote} mnt=${this.mounted.size} scr=${this.scrolls}` +
        ` tot=${this.totalItems()} near=${this.sentinelNear() ? 1 : 0}` +
        ` evict=${this.evicted} refill=${this.refilled} aim=${this.aimed}` +
        ` h=${Math.round(this.stream.scrollHeight)}`,
    );
  }

  /**
   * Drop a far-off section's cells, holding its place with a fixed height.
   *
   * The height is passed in rather than measured here: this runs inside the
   * write half of `reconcile`, and a measurement here would put a forced layout
   * back in the middle of a run of mutations, which is the thing that froze the
   * main thread.
   */
  private evictAt(i: number, h: number): void {
    this.mounted.delete(i);
    const grid = this.grids[i];
    if (!grid || grid.childElementCount === 0) return;
    if (h <= 0) return;
    grid.style.height = `${h}px`;
    for (const cell of Array.from(grid.children)) {
      this.loader.forget(cell as HTMLElement);
    }
    grid.replaceChildren();
    this.evicted += 1;
  }

  /** Put a section's cells back. */
  private refillAt(i: number): void {
    const grid = this.grids[i];
    if (!grid) return;
    this.mounted.add(i);
    if (grid.childElementCount > 0) return;
    const items = this.gridItems.get(grid);
    if (!items) return;
    const frag = document.createDocumentFragment();
    for (const item of items) frag.append(this.cell(item));
    grid.append(frag);
    grid.style.removeProperty("height");
    this.refilled += 1;
  }

  private totalItems(): number {
    let n = 0;
    for (const day of this.days) n += day.items.length;
    return n;
  }

  private cell(item: GalleryItem): HTMLElement {
    const img = el<"img">("img", { alt: "", decoding: "async", loading: "lazy" });
    const cell = el<"button">("button.ph-cell", {
      type: "button",
      "aria-label": item.name,
      // Read from the live selection rather than hard-coded false: a section
      // that was emptied while off screen is rebuilt from scratch, and a
      // selected picture must not come back unselected.
      "aria-selected": this.selection.has(item.path) ? "true" : "false",
    }, img);

    if (item.kind === "video") {
      cell.append(el("span.ph-cell-play", { "aria-hidden": true }, icon("play")));
      const dur = formatDuration(item.duration);
      if (dur) cell.append(el("span.ph-cell-dur", { text: dur }));
    }

    // Favourites carry their star on the tile, the way Samsung Gallery does —
    // the alternative is that the star only exists inside the viewer, and the
    // Favorites album fills with pictures nothing on the grid explains.
    if (isFav(item.path)) {
      cell.append(el("span.ph-cell-fav", { "aria-hidden": true }, icon("star")));
    }

    // The fallback is what a tile shows while it has no picture, and now
    // only while: every non-picture file gets a drawn page from `docThumb`,
    // so this is the brief moment before it arrives and the rare file that
    // defeated even the card. It carries the extension rather than a generic
    // file glyph, because "DNG" says why there is nothing to see.
    cell.append(el("span.ph-cell-fallback", {},
      el("span", { text: item.ext.toUpperCase() || "FILE" }),
    ));

    // The name, over the preview, for everything that is not a photograph.
    const cap = tileCaption(item.kind, item.name);
    if (cap) cell.append(cap);
    cell.append(el("span.ph-cell-check", { text: "✓", "aria-hidden": true }));

    cell.addEventListener("click", () => {
      if (this.selecting) this.toggle(item, cell);
      else this.shell.open(item, this.flat());
    });

    // Long-press enters selection, the way a phone gallery does. The
    // `contextmenu` event is what a WebView reports a long-press as.
    cell.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (!this.selecting) this.beginSelect();
      this.toggle(item, cell);
    });

    this.loader.observe(cell, item);
    return cell;
  }

  private emptyNote(): HTMLElement {
    const noteIcon = el("span.ph-note-icon", { "aria-hidden": true });
    noteIcon.append(icon(this.spec.icon));
    return el("div.ph-note", {},
      noteIcon,
      el("p.ph-note-title", { text: this.spec.emptyTitle }),
      el("p.ph-note-body", {
        text: this.shell.native
          ? accessNote(this.shell.store.get().access) ?? this.spec.emptyBody
          : "Storage is only readable in the installed app.",
      }),
      btn("Scan again", () => void this.shell.store.refresh()),
    );
  }

  private scanningNote(): HTMLElement {
    return el("div.ph-note", {},
      el("p.ph-note-title", { text: "Looking for your files" }),
      el("p.ph-note-body", { text: this.spec.scanningBody }),
    );
  }

  // ── Selection ───────────────────────────────────────────────────────────

  private beginSelect(): void {
    this.selecting = true;
    this.el.classList.add("selecting");
    this.shell.refreshChrome(this.id);
  }

  private endSelect(): void {
    this.selecting = false;
    this.selection.clear();
    this.el.classList.remove("selecting");
    for (const cell of this.el.querySelectorAll('[aria-selected="true"]')) {
      cell.setAttribute("aria-selected", "false");
    }
    this.shell.refreshChrome(this.id);
  }

  private toggle(item: GalleryItem, cell: HTMLElement): void {
    if (this.selection.has(item.path)) {
      this.selection.delete(item.path);
      cell.setAttribute("aria-selected", "false");
    } else {
      this.selection.add(item.path);
      cell.setAttribute("aria-selected", "true");
    }
    this.shell.refreshChrome(this.id);
  }

  private flat(): GalleryItem[] {
    return this.days.flatMap((d) => d.items);
  }

  private selected(): GalleryItem[] {
    return this.flat().filter((it) => this.selection.has(it.path));
  }

  private shareSelected(): void {
    const paths = this.selected().map((it) => it.path);
    if (paths.length === 0) return;
    // Say so when it fails. The single-file paths in the viewer and the editor
    // both do; this one swallowed the error, so a share sheet that never
    // appeared was indistinguishable from a tap that never registered.
    void this.shell.fs.shareFiles(paths).catch(() => {
      this.shell.flash("Nothing available to share to");
    });
  }

  /**
   * Move the selection to trash. No confirm dialog: the move is reversible
   * from the Trash screen, and a confirmation in front of a reversible action
   * teaches people to click through confirmations.
   */
  private async deleteSelected(): Promise<void> {
    const items = this.selected();
    if (items.length === 0) return;
    this.endSelect();
    let failed = 0;
    for (const it of items) if (!await this.shell.trashItem(it)) failed += 1;
    // `trashItem` returns false on a refusal -- a read-only volume, a file
    // already gone. Silently, a "Delete" that deleted nothing looked exactly
    // like one that worked.
    if (failed > 0) {
      this.shell.flash(failed === items.length
        ? (failed === 1 ? "Couldn't move it to Trash" : `Couldn't move any of the ${failed} to Trash`)
        : `${failed} of ${items.length} couldn't be moved to Trash`);
    }
  }

  /**
   * Blur a whole selection in one go.
   *
   * Opens the first one straight into the blur sheet with the rest queued, which
   * is the two-tap path from a roll to a redacted set — the thing the app is
   * for, and the thing that previously took a file manager, a viewer, an editor
   * and a guess at which glyph was blur.
   */
  private blurSelected(): void {
    // Pictures only. `enterEdit` returns immediately for anything else, so an
    // unfiltered selection opened the viewer on a video and then did nothing
    // at all -- a dead tap with no message. Videos have their own blur, in the
    // vedit panel, reached from the viewer's own Edit button.
    const items = this.selected().filter((it) => it.kind === "image");
    const first = items[0];
    if (!first) {
      this.shell.flash("Blur works on photos. Open a video and use Edit.");
      return;
    }
    const skipped = this.selection.size - items.length;
    this.shell.viewer.open(first, items, { tool: "blur.shape.full" });
    this.endSelect();
    if (skipped > 0) {
      this.shell.flash(skipped === 1 ? "Skipped 1 that isn't a photo" : `Skipped ${skipped} that aren't photos`);
    }
  }

  // ── Pinch ───────────────────────────────────────────────────────────────

  /**
   * Two fingers, one axis: distance.
   *
   * Deliberately not a continuous zoom. Tiles snap between column counts, so the
   * grid is always a whole number across and never leaves a ragged strip down
   * the right-hand side. A 35% change in finger distance is one step — loose
   * enough that a clumsy pinch does not jump two.
   */
  private wirePinch(): void {
    let base = 0;
    let startStep = this.step;

    this.el.addEventListener("touchstart", (ev) => {
      if (ev.touches.length !== 2) return;
      base = spread(ev.touches);
      startStep = this.step;
    }, { passive: true });

    this.el.addEventListener("touchmove", (ev) => {
      if (ev.touches.length !== 2 || base === 0) return;
      const ratio = spread(ev.touches) / base;
      // Pinch in (ratio < 1) means more, smaller tiles.
      const delta = ratio > 1.35 ? -1 : ratio < 0.74 ? 1 : 0;
      if (delta !== 0) this.setStep(startStep + delta);
    }, { passive: true });

    this.el.addEventListener("touchend", () => { base = 0; }, { passive: true });
  }

  private setStep(next: number): void {
    const clamped = Math.max(0, Math.min(STEPS.length - 1, next));
    if (clamped === this.step) return;
    this.step = clamped;
    this.applyStep();
    try {
      localStorage.setItem("fct.phone.cols", String(clamped));
    } catch { /* private mode; the column count is not worth failing over */ }
  }

  private applyStep(): void {
    this.el.style.setProperty("--ph-cols", String(STEPS[this.step]));
  }

  /**
   * The saved column count, if there is one.
   *
   * Read as a string and rejected before parsing, because `Number(null)` and
   * `Number("")` are both `0` — a valid-looking step that happens to be the
   * densest one. Parsing first therefore turned "no preference has ever been
   * saved", the state of every fresh install, into `STEPS[0]`: two columns of
   * 190 px tiles, which is a gallery showing you four photographs at a time.
   */
  private restoreStep(): void {
    try {
      const raw = localStorage.getItem("fct.phone.cols");
      if (raw !== null && raw.trim() !== "") {
        const saved = Number(raw);
        if (Number.isInteger(saved) && saved >= 0 && saved < STEPS.length) this.step = saved;
      }
    } catch { /* ignore */ }
    this.applyStep();
  }
}

function spread(touches: TouchList): number {
  const a = touches[0];
  const b = touches[1];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** A header action: a glyph with a real `aria-label`, since the header has no
 *  room for text but a screen reader and a long-press both need the word. */
/**
 * A header action: glyph over word.
 *
 * The word is not decoration. "🌫" alone is the single least guessable control
 * in the app — it is the blur, the thing this build exists to make reachable —
 * and a header of bare glyphs is rule 2 broken in the one place the user looks
 * first. Two or three of these fit a 384 px header beside an ellipsised title;
 * beyond that the tab is asking for a sheet, not another icon.
 *
 * `title` stays as well: the same helper renders on a desktop-width window
 * during development, where hovering is how you check you labelled it right.
 */
export function iconBtn(glyph: string, label: string, onClick: () => void): HTMLElement {
  const iconWrap = el("span.ph-act-icon", { "aria-hidden": true });
  iconWrap.append(icon(glyph));
  const b = el<"button">("button.ph-act", {
    type: "button",
    "aria-label": label,
    title: label,
  },
    iconWrap,
    el("span.ph-act-label", { text: shortAction(label) }),
  );
  b.addEventListener("click", onClick);
  return b;
}

/**
 * "Blur selected" -> "Blur". The header has room for a word, not a phrase, and
 * the noun is already on screen: the title beside it reads "3 selected".
 */
function shortAction(label: string): string {
  const head = label.split(/\s+/)[0] ?? label;
  return head.length > 8 ? `${head.slice(0, 7)}…` : head;
}

export function btn(text: string, onClick: () => void): HTMLElement {
  const b = el<"button">("button.ph-note-btn", { type: "button", text });
  b.addEventListener("click", onClick);
  return b;
}

/**
 * When the phone's media index says why it showed us nothing, say that
 * instead of claiming the card is empty. `null` when it is not the reason.
 */
function accessNote(access: "full" | "partial" | "none" | null): string | null {
  if (access === "none") {
    return "FACET is not allowed to read your photos yet. Allow photo and video access in Settings, or turn on all-files access.";
  }
  if (access === "partial") {
    return "Only the photos you picked are visible. Allow all photos in Settings to see everything, the way your gallery does.";
  }
  return null;
}
