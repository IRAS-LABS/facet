/**
 * Search — over what has already been scanned.
 *
 * Deliberately not a fresh walk per keystroke. The store already holds every
 * media file on the device with its name, folder and date, which is enough to
 * answer the questions people actually type into a gallery search — a folder
 * name, a date, "screenshot", part of a filename. Re-walking the card for each
 * letter would make the first character take eight seconds and every one after
 * it worse.
 *
 * The chips above the box exist because most gallery searching is not typing at
 * all. "Videos", "Screenshots", "This week" are three taps that cover most of
 * it, and a search screen that offers only an empty text box makes you invent a
 * query for a thing you were going to recognise on sight.
 */

import type { GalleryItem } from "@core/phone/gallery";
import { formatDuration } from "@core/phone/gallery";
import { el, fill, tileCaption } from "./dom";
import { icon } from "./icons";
import { ThumbLoader } from "./thumbs";
import type { PhoneShell, PhoneTab, TabId } from "./shell";

type ChipId = "photos" | "videos" | "screenshots" | "week" | "large";

const CHIPS: ReadonlyArray<readonly [ChipId, string]> = [
  ["photos", "Photos"],
  ["videos", "Videos"],
  ["screenshots", "Screenshots"],
  ["week", "This week"],
  ["large", "Large files"],
];

/** Cap the drawn results. Past this the grid is not a result, it is the roll. */
const MAX_HITS = 600;

export class SearchTab implements PhoneTab {
  readonly id: TabId = "search";
  readonly label = "Search";
  readonly icon = "search";
  readonly el: HTMLElement;

  private input: HTMLInputElement;
  private chipRow: HTMLElement;
  private results: HTMLElement;
  private loader: ThumbLoader;

  private query = "";
  private active = new Set<ChipId>();
  private debounce = 0;

  constructor(private readonly shell: PhoneShell) {
    this.input = el<"input">("input.ph-search", {
      type: "search",
      placeholder: "Search photos, videos and folders",
      "aria-label": "Search",
      enterkeyhint: "search",
      autocomplete: "off",
    });

    // Debounced, because filtering twenty thousand entries on every keystroke
    // on a phone CPU is a visible stutter in the text field itself.
    this.input.addEventListener("input", () => {
      window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => {
        this.query = this.input.value.trim().toLowerCase();
        this.run();
      }, 140);
    });

    // The chips wrap onto as many rows as they need. They are not a horizontal
    // scroller: the last chip in a scrolling row sits in Android's back-gesture
    // strip, and tapping it navigates back instead.
    this.chipRow = el("div.ph-chips");
    for (const [id, label] of CHIPS) {
      const chip = el<"button">("button.ph-chip", {
        type: "button",
        "aria-pressed": "false",
        text: label,
      });
      chip.addEventListener("click", () => {
        if (this.active.has(id)) this.active.delete(id);
        else this.active.add(id);
        chip.setAttribute("aria-pressed", this.active.has(id) ? "true" : "false");
        this.run();
      });
      this.chipRow.append(chip);
    }

    this.results = el("div.ph-results");
    this.el = el("div.ph-screen", {},
      el("div.ph-searchbar", {}, this.input),
      this.chipRow,
      this.results,
    );

    this.loader = new ThumbLoader(shell.thumbs, shell.scroller);
  }

  title(): string { return "Search"; }

  back(): boolean {
    if (this.query !== "" || this.active.size > 0) {
      this.query = "";
      this.input.value = "";
      this.active.clear();
      for (const chip of this.chipRow.children) chip.setAttribute("aria-pressed", "false");
      this.run();
      return true;
    }
    return false;
  }

  activate(): void {
    void this.shell.store.ensure().then(() => this.run());
    this.run();
  }

  private run(): void {
    const snap = this.shell.store.get();

    if (this.query === "" && this.active.size === 0) {
      fill(this.results, el("div.ph-note", {},
        el("span.ph-note-icon", { "aria-hidden": true }, icon("search")),
        el("p.ph-note-title", { text: "Search your device" }),
        el("p.ph-note-body", {
          text: snap.everything.length > 0
            ? `${snap.everything.length.toLocaleString()} files indexed, ${snap.items.length.toLocaleString()} of them photos and videos. Type a name, a folder, or tap a filter.`
            : "Nothing indexed yet — open Photos to scan.",
        }),
      ));
      return;
    }

    // Every file the index knows, not just the roll: a search for a PDF or
    // an APK by name must find it, the way the phone's own search does.
    const hits = this.filter(snap.everything);

    if (hits.length === 0) {
      fill(this.results, el("div.ph-note", {},
        el("p.ph-note-title", { text: "No matches" }),
        el("p.ph-note-body", { text: "Try part of a file name, or a folder like “Snapchat”." }),
      ));
      return;
    }

    const grid = el("div.ph-grid");
    for (const item of hits.slice(0, MAX_HITS)) grid.append(this.cell(item, hits));

    fill(this.results,
      el("p.ph-count", {
        text: hits.length > MAX_HITS
          ? `${hits.length.toLocaleString()} matches — showing the newest ${MAX_HITS}`
          : `${hits.length.toLocaleString()} ${hits.length === 1 ? "match" : "matches"}`,
      }),
      grid,
    );
  }

  private filter(items: readonly GalleryItem[]): GalleryItem[] {
    const week = Date.now() - 7 * 86_400_000;
    const terms = this.query.split(/\s+/).filter(Boolean);

    return items.filter((it) => {
      if (this.active.has("photos") && it.kind !== "image") return false;
      if (this.active.has("videos") && it.kind !== "video") return false;
      if (this.active.has("week") && (it.modified ?? 0) < week) return false;
      if (this.active.has("large") && (it.size ?? 0) < 25_000_000) return false;
      if (this.active.has("screenshots") && !/screen ?(shot|record)/i.test(`${it.folder}/${it.name}`)) {
        return false;
      }

      if (terms.length === 0) return true;
      // Folder name included in the haystack, so "snapchat" finds the album's
      // contents and not just files that happen to say snapchat.
      const hay = `${it.name} ${it.folderName} ${it.folder}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  private cell(item: GalleryItem, siblings: readonly GalleryItem[]): HTMLElement {
    const cell = el<"button">("button.ph-cell", {
      type: "button",
      "aria-label": item.name,
    },
      el<"img">("img", { alt: "", decoding: "async" }),
      el("span.ph-cell-fallback", { text: item.ext.toUpperCase() || "FILE" }),
    );

    const cap = tileCaption(item.kind, item.name);
    if (cap) cell.append(cap);

    if (item.kind === "video") {
      cell.append(el("span.ph-cell-play", { "aria-hidden": true }, icon("play")));
      const dur = formatDuration(item.duration);
      if (dur) cell.append(el("span.ph-cell-dur", { text: dur }));
    }

    cell.addEventListener("click", () => this.shell.open(item, siblings));
    this.loader.observe(cell, item);
    return cell;
  }
}
